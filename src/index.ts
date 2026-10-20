import dotenv from 'dotenv';
import { loadConfig } from './config';
import { initLogger, log, maskQQ } from './infra/logger';
import { OneBotAdapter, extractText, extractImages, isPureStickerMsg, type OneBotEvent, type NoticeEvent, type RequestEvent } from './adapter/onebot';
import { MessagePipeline } from './pipeline';
import { createSession, type Session } from './session';
import { PromptBuilder } from './brain/prompt';
import { LLMClient } from './brain/llm';
import { MemorySystem } from './memory';
import { PostProcessor, sleep } from './responder';
import { StickerLibrary } from './responder/stickers';
import { inferScene } from './responder/stickers';
import { StickerLearner, buildAskQuestion } from './responder/sticker-learner';
import { TtsClient, type VoiceConfig } from './tts';
import { Store } from './store/db';
import { startHttpServer } from './server/http';
import { ControlPanel } from './server/panel';
import { ProactiveScheduler } from './proactive';

dotenv.config();

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = initLogger(cfg.infra.log);
  logger.info({ app: cfg.app.name, scenario: cfg.app.scenario }, '启动 qq-netizen');

  // ── 存储 ────────────────────────────────────────────────
  const store = new Store(cfg.memory.db.path);

  // ── LLM ─────────────────────────────────────────────────
  const llm = new LLMClient(
    {
      baseURL: cfg.llm.baseURL,
      apiKey: cfg.llm.apiKey,
      model: cfg.llm.model,
      temperature: cfg.llm.temperature,
      topP: cfg.llm.topP,
      maxTokens: cfg.llm.maxTokens,
      timeoutMs: cfg.llm.timeoutMs,
      retries: cfg.llm.retries,
      retryDelayMs: cfg.llm.retryDelayMs,
      maxConcurrent: cfg.llm.maxConcurrent,
      requestsPerMinute: cfg.llm.requestsPerMinute,
    },
    logger,
  );

  // ── 会话 ────────────────────────────────────────────────
  const peerId = cfg.pipeline.filter.allowedUsers[0];
  if (!peerId) {
    logger.error('配置错误：pipeline.filter.allowedUsers 为空。请填入你自己的 QQ 号后重新启动。');
    process.exit(1);
  }

  const session: Session = createSession(
    { sessionId: `private:${peerId}`, peerId },
    {
      shortTermLimit: cfg.session.shortTermLimit,
      moodDecayPerHour: cfg.persona.moodDecayPerHour,
      moodFloor: cfg.persona.moodFloor,
      moodCeiling: cfg.persona.moodCeiling,
      intimacy: {
        enabled: cfg.persona.intimacy.enabled,
        perExchange: cfg.persona.intimacy.perExchange,
        decayPerDay: cfg.persona.intimacy.decayPerDay,
        decayAfterDays: cfg.persona.intimacy.decayAfterDays,
        max: cfg.persona.intimacy.max,
      },
    },
    store,
    cfg.persona.dir,
    cfg.persona.default,
    logger,
  );

  // ── 记忆 ────────────────────────────────────────────────
  const memory = new MemorySystem(
    store,
    llm,
    {
      enabled: cfg.memory.enabled,
      topK: cfg.memory.longTerm.topK,
      importanceThreshold: cfg.memory.longTerm.importanceThreshold,
      extractEveryNTurns: cfg.memory.longTerm.extractEveryNTurns,
      explicitKeywords: cfg.memory.longTerm.explicitKeywords,
      summaryEnabled: cfg.memory.summary.enabled,
      summaryMaxChars: cfg.memory.summary.maxSummaryChars,
    },
    logger,
  );

  // ── Prompt ──────────────────────────────────────────────
  const promptBuilder = new PromptBuilder({
    promptsDir: cfg.persona.promptsDir,
    memoryTopK: cfg.memory.longTerm.topK,
    retrieve: (q) => memory.retrieve(peerId, q),
    sleepState: () => sleepMachineRef.current?.describe() ?? '清醒',
    wakeCount: () => wakeCountRef.current?.() ?? 0,
  });

  // ── 后处理 ──────────────────────────────────────────────
  const stickers = new StickerLibrary(store, logger);
  const learner = new StickerLearner(store, logger);
  const post = new PostProcessor(cfg.responder, session.getPersona(), logger, stickers);
  const tts = new TtsClient(cfg.responder.voice as VoiceConfig, logger);

  // ── 管线 ────────────────────────────────────────────────
  const pipeline = new MessagePipeline(
    {
      mergeWindowMs: cfg.pipeline.mergeWindowMs,
      mergeMaxWaitMs: cfg.pipeline.mergeMaxWaitMs,
      dedup: cfg.pipeline.dedup,
      filter: cfg.pipeline.filter,
      throttle: cfg.throttle,    },
    logger,
  );

  for (const p of pipeline.selfCheck()) logger.warn(`配置提醒：${p}`);

  // ── 协议端 ──────────────────────────────────────────────
  const adapter = new OneBotAdapter(
    {
      transport: cfg.adapter.transport,
      listen: cfg.adapter.listen,
      url: cfg.adapter.url,
      accessToken: cfg.adapter.accessToken,
      selfId: cfg.adapter.selfId,
      heartbeatIntervalMs: cfg.adapter.heartbeatIntervalMs,
    },
    logger,
  );

  // 睡眠状态机的引用：promptBuilder 早于 proactive 创建，用 ref 打破循环依赖
  const sleepMachineRef: { current?: { describe(): string } } = {};
  const wakeCountRef: { current?: () => number } = {};

  const health = { adapterConnected: false, lastError: '' as string };

  // ── 主动开口调度器（先声明，供 reply 流程调用 onUserReplied） ──
  const proactive = new ProactiveScheduler(cfg.proactive as any, {
    session,
    store,
    llm,
    promptBuilder,
    logger,
    peerId,
  });
  // 把睡眠状态机挂到 ref 上，供 promptBuilder 读取
  sleepMachineRef.current = proactive.sleep;
  wakeCountRef.current = () => proactive.sleep.getWakeCount();

  // ── 核心：收到消息 → 决策 → 回复 ────────────────────────
  const handleReply = async (userId: string, text: string): Promise<void> => {
    const release = await session.acquireLock();
    try {
      session.recordUser(text);
      memory.captureExplicit(peerId, text);

      const messages = promptBuilder.build(session, text);
      let result = await llm.generate(messages);
      let processed = post.process(result.text);

      // 人格崩坏 → 重写一次
      if (processed.needRetry) {
        logger.warn({ reason: processed.reason }, '触发重写');
        const retryMessages = [
          ...messages,
          { role: 'assistant' as const, content: result.text },
          {
            role: 'user' as const,
            content: `你刚才那句不像她自己说的话（${processed.reason ?? '格式不对'}）。用{${session.getPersona().identity.name}}的口吻重说一遍，短一点，别像客服。只输出这句话本身。`,
          },
        ];
        result = await llm.generate(retryMessages, { temperature: 0.9 });
        processed = post.process(result.text);
      }

      if (!processed.text) {
        logger.warn('回复为空，放弃发送');
        session.recordAssistant('（走神了）');
        return;
      }

      // 打字延迟
      const delay = post.typingDelayMs(processed.text.length);
      logger.info(
        { user: maskQQ(userId), chars: processed.text.length, delayMs: delay, tokens: result.completionTokens },
        '准备回复',
      );
      await sleep(delay);

      // 分段发送（每段内部再解析出文字/表情消息段）
      const segments = post.split(processed.text);

      // 语音：只在「单条 + 短句 + 概率命中 + 不带小黄脸表情」时，用语音替代打字。
      // 带表情标记的句子不能转语音（voice 里放不下 face），直接照常打字。
      const singleSeg = segments.length === 1 ? segments[0] : null;
      const hasEmojiMarker = singleSeg ? /\[(?:表情|face)\s*[:：][^\]]+\]/.test(singleSeg) : false;
      let voiced = false;          // 语音是否已成功发出
      let voiceAttempted = false;  // 本次是否尝试过语音

      if (singleSeg && !hasEmojiMarker && tts.shouldVoice(singleSeg)) {
        voiceAttempted = true;
        logger.info({ chars: singleSeg.length }, '触发语音回复');
        const t0 = Date.now();
        const res = await tts.synthesize(singleSeg);
        if (res.ok && res.audio) {
          try {
            const vres = await adapter.sendPrivateVoice(userId, res.audio, 'wav');
            logger.info(
              { messageId: vres?.message_id, dur: res.duration, synthMs: Date.now() - t0 },
              '语音消息已发送',
            );
            voiced = true;
          } catch (err) {
            logger.warn({ err: (err as Error).message }, '发送语音失败，回退文字');
          }
        } else {
          logger.warn({ err: res.error }, '语音合成失败');
        }
      }

      // 决定要不要补文字：
      //   - 语音成功了 → 不补
      //   - 尝试语音但失败 → 按 fallbackToText 决定（默认补文字）
      //   - 根本没走语音 → 照常发文字
      const suppressText = voiceAttempted && !voiced && !tts.shouldFallbackToText();
      if (!voiced && !suppressText) {
        for (let i = 0; i < segments.length; i++) {
          if (i > 0) await sleep(post.segmentPauseMs());
          const msgSegments = post.toSegments(segments[i]);
          await adapter.sendPrivateMessageSegments(userId, msgSegments);
        }
      }

      // 短回复有概率附一张表情包（独立一条消息，像真人补图）
      const stickerCfg = cfg.responder.sticker;
      let stickerUrl: string | null = null;

      if (stickerCfg?.enabled !== false) {
        // 优先用「学会意思」的表情（按场景精准匹配）
        const scene = inferScene(processed.text.replace(/\[(?:表情|face)\s*[:：][^\]]+\]/g, ''));
        const learned = learner.pickByScene(scene);
        if (learned && Math.random() < 0.5) {
          stickerUrl = learned.url;
          logger.info({ scene, meaning: learned.meaning }, '使用学会的表情包');
        } else {
          // 回退到收藏库随机
          const picked = post.pickStickerFor(processed.text, stickerCfg?.probability ?? 0.25);
          stickerUrl = picked?.url ?? null;
        }
      }

      if (stickerUrl) {
        // 临时签名链接（multimedia.nt.qq.com.cn ... rkey=...）会过期，
        // 发出去会变成"该消息类型暂不支持查看"。这种不发，宁可少发一张。
        if (/rkey=|multimedia\.nt\.qq\.com\.cn\/download/.test(stickerUrl)) {
          logger.warn('表情包是临时链接，跳过发送（会显示"暂不支持查看"）');
          stickerUrl = null;
        }
      }

      if (stickerUrl) {
        await sleep(post.segmentPauseMs());
        try {
          const res = await adapter.sendPrivateMessageSegments(userId, [
            { type: 'image', data: { file: stickerUrl } } as any,
          ]);
          logger.info({ messageId: res?.message_id }, '表情包已发送');
        } catch (err) {
          logger.warn({ err: (err as Error).message }, '发送表情包失败');
        }
      }

      session.recordAssistant(processed.text, { tokens: result.completionTokens, latencyMs: result.latencyMs });
      pipeline.markReplied();
      session.persist(true);

      // 用户回复了 → 清除"被无视"计数
      proactive?.onUserReplied();

      // 后台记忆抽取（不阻塞）
      if (session.shouldExtract()) {
        session.markExtracted();
        void memory.extract(peerId, session.shortTerm.slice(-16).map((t) => ({ role: t.role, content: t.content })));
      }
    } catch (err) {
      logger.error({ err: (err as Error).message }, '生成回复失败');
    } finally {
      release();
    }
  };

  // ── 绑定主动开口的发送通道 ──────────────────────────────
  proactive.bindSender(async (text: string) => {
    const delay = post.typingDelayMs(text.length);
    logger.info({ chars: text.length, delayMs: delay }, '主动开口：准备发送');
    await sleep(delay);
    for (const seg of post.split(text)) {
      await adapter.sendPrivateMessageSegments(peerId, post.toSegments(seg));
      await sleep(post.segmentPauseMs());
    }
  });
  proactive.start();

  adapter.on('event', (event: OneBotEvent) => {
    try {
      if (event.post_type === 'message') {
        // 睡眠拦截：分三种情况
        //   1. 正常清醒 → 正常处理
        //   2. 刚被吵醒，还在迷糊 → 这条不回（但记下）
        //   3. 被吵醒过，缓过来了 → 正常处理，但会慢一点、带着起床气
        // ── 表情学习：优先处理 ──
        // 1) 用户发来表情包 → 不认识就问她
        // 2) 用户回了一句话，且有待确认的表情 → 试着解析成意思
        if ((event as any).message_type === 'private') {
          const segs = ((event as any).message ?? []) as any[];
          const text = extractText(segs);
          const images = extractImages(segs);
          const uid = String((event as any).user_id);

          // 1) 收到表情包
          if (images.length > 0) {
            const img = images[0];
            const verdict = learner.onReceivedImage(img.url, img.isSticker);
            logger.info({ isSticker: img.isSticker, verdict, known: learner.count() }, '收到图片');

            if (verdict === 'ask') {
              const question = buildAskQuestion(session.intimacy);
              learner.markAsked(img.url, question);
              // 直接发问，不走 LLM（这样最自然，也省 token）
              const delay = post.typingDelayMs(question.length);
              setTimeout(() => {
                void (async () => {
                  await sleep(delay);
                  for (const seg of post.split(question)) {
                    await adapter.sendPrivateMessageSegments(uid, post.toSegments(seg));
                  }
                  session.recordUser('[发了张表情]');
                  session.recordAssistant(question);
                  session.persist(true);
                })();
              }, 0);
              return;
            }

            // 纯表情且已经认识 → 可以正常聊；纯表情但不认识/问过了 → 不回
            if (isPureStickerMsg(segs)) {
              session.recordUser('[发了张表情]');
              return;
            }
          }

          // 2) 有未确认的表情，试着从这句话里学
          if (text && learner.hasPending()) {
            const learned = learner.tryLearnFromReply(text);
            if (learned) {
              logger.info({ meaning: learned.meaning, scenes: learned.scenes }, '学会表情含义');
            }
          }

          if (text) {
            const verdict = proactive.sleep.onUserMessage(text);
            if (!verdict.respond) {
              logger.info(
                { chars: text.length, reason: verdict.reason, phase: proactive.sleep.phase() },
                '她在睡觉/刚被吵醒，这条先不回',
              );
              return;
            }
            // 被吵醒后的回复要额外慢一点（人刚从睡梦里醒过来）
            if (verdict.delayMs > 0) {
              logger.info({ delayMs: verdict.delayMs }, '被吵醒，延迟回复');
              setTimeout(() => void handleReply(uid, text), verdict.delayMs);
              return;
            }
          }
        }

        pipeline.accept(event, (decision) => {
          if (decision.action === 'reply') {
            void handleReply(decision.userId, decision.text);
          }
        });
        return;
      }

      if (event.post_type === 'notice') {
        pipeline.handleNotice(event as NoticeEvent, (groupId) => adapter.leaveGroup(groupId));
        return;
      }

      if (event.post_type === 'request') {
        void pipeline
          .handleRequest(
            event as RequestEvent,
            {
              setFriendAddRequest: (flag, approve, remark) => adapter.setFriendAddRequest(flag, approve, remark),
              setGroupAddRequest: (flag, approve, reason) => adapter.setGroupAddRequest(flag, approve, reason),
            },
            {
              autoReject: cfg.guard.friendRequest.autoReject,
              autoAcceptWhitelisted: cfg.guard.friendRequest.autoAcceptWhitelisted,
              rejectReason: cfg.guard.friendRequest.rejectReason,
              autoRejectGroup: cfg.guard.groupRequest.autoReject,
            },
          )
          .catch((err) => logger.error({ err: (err as Error).message }, '处理请求事件失败'));
        return;
      }
    } catch (err) {
      logger.error({ err: (err as Error).message }, '事件处理异常');
    }
  });

  adapter.on('disconnected', () => {
    health.adapterConnected = false;
  });

  await adapter.start();
  health.adapterConnected = true;

  // 协议端连上后，拉一次收藏表情（失败不影响启动）
  void stickers
    .refresh(adapter)
    .then((n) => {
      if (n > 0) logger.info({ count: n }, '收藏表情包已加载');
      else logger.warn('未拉到收藏表情，将只发 QQ 小黄脸');
    })
    .catch(() => void 0);

  // ── 控制面板 ────────────────────────────────────────────
  const panel = new ControlPanel(
    {
      tts: {
        python: cfg.control.tts.python,
        script: cfg.control.tts.script,
        workdir: cfg.control.tts.workdir,
        port: cfg.control.tts.port,
      },
      lagrange: {
        exe: cfg.control.lagrange.exe,
        workdir: cfg.control.lagrange.workdir,
        bundleExtractBase: cfg.control.lagrange.bundleExtractBase,
      },
      signServer: {
        container: cfg.control.signServer.container,
        port: cfg.control.signServer.port,
      },
    },
    logger,
  );

  // ── 管理接口 ────────────────────────────────────────────
  const http = await startHttpServer(
    { host: cfg.infra.server.host, port: cfg.infra.server.port, authToken: cfg.infra.server.authToken },
    {
      isAdapterConnected: () => adapter.isConnected(),
      getSession: () => ({ intimacy: session.intimacy, mood: session.mood, turns: session.shortTerm.length }),
      callApi: (action, params) => adapter.call(action, params),
      getSleepState: () => proactive.sleep.describe(),
      getLlmStats: () => llm.stats(),
      stickerAdmin: {
        list: () => stickers.list().map((s) => ({ url: s.url, usedCount: s.usedCount, tags: s.tags })),
        keepOnly: (urls) => stickers.keepOnly(urls),
        refresh: () => stickers.refresh(adapter),
      },
      panel,
    },
    logger,
  );

  logger.info(
    { port: cfg.infra.server.port, peer: maskQQ(peerId) },
    '就绪：只回应白名单内的私聊',
  );

  // ── 优雅退出 ────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info({ signal }, '正在关闭');
    proactive.stop();
    session.persist(true);
    pipeline.stop();
    panel.dispose();
    await http.close();
    await adapter.stop();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // 定期持久化关系状态
  setInterval(() => session.persist(), cfg.session.persistIntervalMs);
}

main().catch((err) => {
  log().error({ err: (err as Error).message, stack: (err as Error).stack }, '启动失败');
  process.exit(1);
});
