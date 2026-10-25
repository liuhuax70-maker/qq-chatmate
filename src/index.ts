import dotenv from 'dotenv';
import { loadConfig } from './config';
import { initLogger, log, maskQQ } from './infra/logger';
import { OneBotAdapter, extractText, extractImages, isPureStickerMsg, type OneBotEvent, type NoticeEvent, type RequestEvent } from './adapter/onebot';
import { MessagePipeline } from './pipeline';
import { createSession, type Session } from './session';
import { PromptBuilder } from './brain/prompt';
import { LLMClient } from './brain/llm';
import { MemorySystem } from './memory';
import { parseSkillCalls } from './responder/skills';
import type { SkillCall } from './responder/skills';
import { QqSkills } from './adapter/qq-skills';
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

/**
 * 从她的回复里提取歌词行。
 *
 * 她会用换行把歌词分行写（prompt 里要求了）。这里按行拆、去掉标记和空行，
 * 只保留可念的中文。如果她没分行（写成一段），就按标点拆成短句。
 */
function extractLyrics(text: string): string[] {
  let lines = text
    .replace(/\[(?:表情|face)\s*[:：][^\]]+\]/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // 只有一行且较长 → 按标点拆，不然一口气念太长
  if (lines.length === 1 && lines[0].length > 12) {
    const parts = lines[0]
      .split(/[，,。.！!？?；;~～]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (parts.length > 1) lines = parts;
  }

  // 每行别太长（一首歌的分行），超了按标点再拆
  const out: string[] = [];
  for (const l of lines.slice(0, 8)) {
    if (l.length <= 12) {
      out.push(l);
    } else {
      const sub = l.split(/[，,。.！!？?；;]+/).map((s) => s.trim()).filter(Boolean);
      out.push(...sub.slice(0, 4));
    }
  }
  return out.slice(0, 8);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = initLogger(cfg.infra.log);
  logger.info({ app: cfg.app.name, scenario: cfg.app.scenario }, '启动 qq-netizen');

  // ── 存储 ────────────────────────────────────────────────
  const store = new Store(cfg.memory.db.path);

  // 启动时清理过期对话日志（只保留 90 天），并每 24 小时跑一次。
  // chat_logs 只增不删的话，跑几个月会变成几十万行，占磁盘也让查询变慢。
  // memories 表不动——那是提炼过的长期信息。
  try {
    const pruned = store.pruneChatLogs(90);
    if (pruned > 0) logger.info({ rows: pruned }, '已清理 90 天前的对话日志');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '清理对话日志失败（不影响启动）');
  }
  const pruneTimer = setInterval(() => {
    try {
      const n = store.pruneChatLogs(90);
      if (n > 0) logger.info({ rows: n }, '定期清理对话日志');
    } catch { /* 忽略 */ }
  }, 24 * 3_600_000);
  pruneTimer.unref();

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
      ttlDays: (cfg.memory.longTerm as any).ttlDays,
      maxMemories: (cfg.memory.longTerm as any).maxMemories,
    },
    logger,
  );

  // 记忆维护：启动时清一次过期/超限记忆，之后每 24 小时一次。
  // 不清理的话检索噪音会越来越大，该被想起的事会被埋掉。
  const runMemoryMaintenance = () => {
    try {
      const ttl = (cfg.memory.longTerm as any).ttlDays as number | undefined;
      if (ttl) {
        const n = store.pruneMemoriesOlderThan(ttl);
        if (n > 0) logger.info({ rows: n, ttlDays: ttl }, '已清理过期记忆');
      }
      const r = memory.prune(peerId);
      if (r.overflow > 0) logger.info({ rows: r.overflow }, '已淘汰低权重记忆');
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '记忆维护失败（不影响运行）');
    }
  };
  runMemoryMaintenance();
  const memTimer = setInterval(runMemoryMaintenance, 24 * 3_600_000);
  memTimer.unref();

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
  const learner = new StickerLearner(store, logger, llm);

  // 最近发过的表情包（跨轮次），用于避免短时间内重复同一张。
  // 这是"人机感"的主要来源之一：库里只有几张时，不复用就会露馅。
  let recentStickers: Array<{ url: string; at: number }> = [];

  // 学会的表情数量（实时读取，学新表情后会变）
  const getLearnedCount = (): number => (learner.count ? learner.count() : 0);
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
  // QQ 技能执行器。destructive 技能（删好友/退群）不开放给模型，
  // 那种操作必须由代码层基于明确规则判断。
  const skills = new QqSkills(adapter, logger, cfg.adapter.selfId);

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

  // ── 技能动作执行 ────────────────────────────────────────
  // 把 LLM 写的标记翻译成真实 QQ 操作。
  //
  // 设计约束：
  //   · 每个动作独立 try——戳失败了不能影响发图
  //   · 动作之间有小间隔，像真人在连着点
  //   · 不执行 destructive 技能（模型没权限删好友/退群）
  const runSkillActions = async (actions: SkillCall[]): Promise<void> => {
    for (const action of actions) {
      try {
        switch (action.kind) {
          case 'poke': {
            const r = await skills.poke(peerId);
            logger.info({ ok: r.ok, err: r.error }, '技能：戳一戳');
            break;
          }
          case 'like': {
            const r = await skills.sendLike(peerId, 1);
            logger.info({ ok: r.ok, err: r.error }, '技能：点赞');
            break;
          }
          case 'image': {
            const r = await skills.sendImage(peerId, action.file);
            logger.info({ ok: r.ok, err: r.error }, '技能：发图片');
            break;
          }
          case 'sticker': {
            // 复用现有的收藏表情库
            const picked = post.pickStickerFor('', 1);
            if (picked?.url && !/rkey=|multimedia\.nt\.qq\.com\.cn\/download/.test(picked.url)) {
              const r = await skills.sendSticker(peerId, picked.url);
              logger.info({ ok: r.ok, err: r.error }, '技能：发表情包');
            } else {
              logger.debug('没有可用的表情包，跳过');
            }
            break;
          }
          case 'recall': {
            const r = await skills.recallMsg(peerId);
            logger.info({ ok: r.ok, err: r.error }, '技能：撤回消息');
            break;
          }
          case 'forward': {
            const r = await skills.forwardMsg(peerId, action.messages);
            logger.info({ ok: r.ok, err: r.error }, '技能：合并转发');
            break;
          }
        }
      } catch (err) {
        // 单个动作失败不影响其它
        logger.warn({ kind: action.kind, err: (err as Error).message }, '技能执行异常（已忽略）');
      }
      // 动作之间留点间隔，像真人在操作
      await sleep(300);
    }
  };
  // ── 核心：收到消息 → 决策 → 回复 ────────────────────────
  /**
   * 针对单条消息生成一句简短回应（用于引用回复）。
   *
   * 场景：你连发几条，她挑其中一条引用并回一句。
   * 这句要短、要贴那条消息本身，不能是空洞的"嗯"。
   *
   * 失败返回空字符串，调用方会跳过这条引用。
   */
  const buildShortReplyTo = async (msgText: string): Promise<string> => {
    try {
      const prompt = [
        '你在跟恋人聊天。他刚才发了这一条：',
        `「${msgText}」`,
        '',
        '针对这一条，回一句简短的话（10 字以内）。',
        '要求：',
        '- 直接回应这一条的具体内容，不要泛泛而谈',
        '- 口语化，像一个真人的即时反应',
        '- 不要写引号、不要解释、不要多余的话',
        '- 只输出这一句',
      ].join('\n');

      const res = await llm.generate(
        [
          {
            role: 'system',
            content: `你叫${session.getPersona().identity.name}，${session.getPersona().identity.selfClaim}。用她的口吻说话。`,
          },
          { role: 'user', content: prompt },
        ],
        { temperature: 0.9, maxTokens: 40 },
      );

      const out = res.text.trim().replace(/^["「『]|["」』]$/g, '').slice(0, 30);
      // 过滤掉明显失败的情况
      if (!out || /^(嗯|哦|好|知道了)$/.test(out)) return out || '';
      return out;
    } catch (err) {
      logger.debug({ err: (err as Error).message }, '生成引用回复失败');
      return '';
    }
  };
  const handleReply = async (
    userId: string,
    text: string,
    replyTo?: number | string,
    /**
     * 需要单独引用回复的消息。
     * 多条消息时挑几个重要的分别引用回，单条消息时为空数组。
     */
    quotable: Array<{ text: string; messageId?: number | string }> = [],
  ): Promise<void> => {
    // 正常回复本身不带引用——引用只用于"单独回应某几条重点"
    const effectiveReplyTo = undefined as number | string | undefined;
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

      // 内容安全闸：命中禁用话题就不发，改成一句安全的中性反应。
      // 配置里写了 forbiddenTopics 就必须真的生效，否则是假的保护。
      if (processed.text) {
        const topics = (cfg.proactive as any)?.safety?.forbiddenTopics as string[] | undefined;
        const hit = topics?.find((t) => t && processed.text.includes(t));
        if (hit) {
          logger.warn({ topic: hit }, '回复命中禁用话题，替换为中性反应');
          const safe = ['嗯', '这个不聊', '换个话题', '说点别的'];
          processed = { ...processed, text: safe[Math.floor(Math.random() * safe.length)] };
        }
      }

      if (!processed.text) {
        // 兜底：绝不能因为模型返回空就"消失"。至少回一个短反应，保证用户一定有回应。
        logger.warn('回复为空，走兜底');
        const fallbacks = ['嗯', '在', '6', '干嘛', '说', '听着呢', '嗯嗯'];
        const fb = fallbacks[Math.floor(Math.random() * fallbacks.length)];
        session.recordAssistant(fb);
        try {
          for (const seg of post.split(fb)) {
            await adapter.sendPrivateMessageSegments(userId, post.toSegments(seg), effectiveReplyTo);
          }
        } catch { /* 发送失败也无所谓，至少记录过了 */ }
        return;
      }

      // 打字延迟
      const delay = post.typingDelayMs(processed.text.length);
      logger.info(
        { user: maskQQ(userId), chars: processed.text.length, delayMs: delay, tokens: result.completionTokens },
        '准备回复',
      );
      await sleep(delay);

      // ── 技能标记解析 ──────────────────────────────────────
      // LLM 会在回复里写 [戳] [表情包] [图:xxx] 这类标记。
      // 必须先从文本里剥离再发送，否则会把 "[戳]" 当成话发出去。
      const parsedReply = parseSkillCalls(processed.text);
      if (parsedReply.actions.length > 0) {
        logger.info(
          { actions: parsedReply.actions.map((a) => a.kind) },
          '回复中检测到技能动作',
        );
      }
      // 技能标记剥完后可能只剩空白 → 用原文兜底（至少发点什么）
      const replyText = parsedReply.text || processed.text.replace(/\[[^\]]+\]/g, '').trim() || '嗯';
      // ── 逐条引用回复重点消息 ──────────────────────────────
      // 需求：多条消息时，挑几个重要的分别引用回，而不是笼统回一句。
      //
      // 顺序很重要：先逐条回应，再发主回复。
      // 真人也是这样——看到你发一串，先挑两句回，再补一句总的。
      if (quotable.length > 0) {
        for (const q of quotable) {
          if (q.messageId === undefined) continue;
          try {
            // 针对这条消息的简短回应
            const shortReply = await buildShortReplyTo(q.text);
            if (!shortReply) continue;
            await sleep(post.typingDelayMs(shortReply.length));
            await adapter.sendPrivateMessageSegments(
              userId,
              post.toSegments(shortReply),
              q.messageId,
            );
            logger.info(
              { quoted: q.text.slice(0, 20), reply: shortReply.slice(0, 20) },
              '已引用回复一条重点消息',
            );
            // 两条引用之间留间隔，像真人一条条回
            await sleep(post.segmentPauseMs() + 400);
          } catch (err) {
            logger.warn({ err: (err as Error).message }, '引用回复失败（已忽略）');
          }
        }
      }


      // 分段发送（每段内部再解析出文字/表情消息段）
      const segments = post.split(replyText);

      // 语音：只在「单条 + 短句 + 概率命中 + 不带小黄脸表情」时，用语音替代打字。
      // 带表情标记的句子不能转语音（voice 里放不下 face），直接照常打字。
      const singleSeg = segments.length === 1 ? segments[0] : null;
      const hasEmojiMarker = singleSeg ? /\[(?:表情|face)\s*[:：][^\]]+\]/.test(singleSeg) : false;
      let voiced = false;          // 语音是否已成功发出
      let voiceAttempted = false;  // 本次是否尝试过语音

      // ── 唱歌（念歌词）────────────────────────────────────
      // 触发：你要求她唱，或她自己想唱。
      // 不是真唱——是用她的音色有节奏地把歌词念出来。
      const wantSong = tts.shouldSing(text, processed.text);
      const wantVoice = !wantSong && singleSeg && !hasEmojiMarker && tts.shouldVoice(singleSeg);
      // 只有在真的要发语音/唱歌时，才做一次秒级探测。
      // TTS 没启动的话直接跳过，避免傻等 60 秒超时。
      const ttsReady = (wantSong || wantVoice) ? await tts.isServerReady() : false;
      if ((wantSong || wantVoice) && !ttsReady) {
        logger.warn('TTS 服务不可用，本次不发语音');
      }

      if (wantSong && ttsReady) {
        voiceAttempted = true;
        const lyrics = extractLyrics(processed.text);
        if (lyrics.length > 0) {
          logger.info({ lines: lyrics.length, text: processed.text.slice(0, 30) }, '触发表演唱歌');
          const t0 = Date.now();
          const res = await tts.synthesizeSong(lyrics.join('\n'), { speed: 1.0, gapMs: 350 });
          if (res.ok && res.audio) {
            try {
              const vres = await adapter.sendPrivateVoice(userId, res.audio, 'wav');
              logger.info(
                { messageId: vres?.message_id, dur: res.duration, synthMs: Date.now() - t0 },
                '唱歌语音已发送',
              );
              voiced = true;
            } catch (err) {
              logger.warn({ err: (err as Error).message }, '发送唱歌语音失败，回退文字');
            }
          } else {
            logger.warn({ err: res.error }, '唱歌合成失败');
          }
        }
      }

      // ── 普通语音 ─────────────────────────────────────────
      if (!voiced && ttsReady && wantVoice) {
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
          // 只有第一段带 reply 引用——多段都带会变成连环引用，很怪
          await adapter.sendPrivateMessageSegments(
            userId,
            msgSegments,
            i === 0 ? effectiveReplyTo : undefined,
          );
        }
      }

      // 短回复有概率附一张表情包（独立一条消息，像真人补图）
      //
      // ⚠️ 这里最容易"人机感"。真实情况是：库里只有 2 张，
      // 而 learner 又有 50% 概率选中它们，结果同一张反复出现。
      // 三重防护：池子太小就少发、刚发过的硬性跳过、跨轮次记最近发过的。
      const stickerCfg = cfg.responder.sticker;
      let stickerUrl: string | null = null;

      if (stickerCfg?.enabled !== false) {
        const scene = inferScene(replyText.replace(/\[(?:表情|face)\s*[:：][^\]]+\]/g, ''));

        // 池子健康度：太小就少发，别硬凑
        const learnedPool = getLearnedCount();
        const healthy = learnedPool >= 5;
        const baseProb = stickerCfg?.probability ?? 0.25;
        const probScale = healthy ? 1 : 0.35;
        const effectiveProb = baseProb * probScale;

        // 最近发过的 URL（30 分钟内不重复）
        const nowTs = Date.now();
        const RECENT_MS = 30 * 60_000;
        recentStickers = recentStickers.filter((r) => nowTs - r.at < RECENT_MS);
        const recentUrls = new Set(recentStickers.map((r) => r.url));

        const learned = learner.pickByScene(scene);
        if (learned && !recentUrls.has(learned.url) && Math.random() < 0.5 * probScale) {
          stickerUrl = learned.url;
          logger.info({ scene, meaning: learned.meaning, pool: learnedPool }, '使用学会的表情包');
        } else {
          const picked = post.pickStickerFor(replyText, effectiveProb);
          stickerUrl = picked?.url && !recentUrls.has(picked.url) ? picked.url : null;
        }

        if (stickerUrl) {
          recentStickers.push({ url: stickerUrl, at: nowTs });
          if (recentStickers.length > 10) recentStickers.shift();
        } else if (!healthy) {
          logger.debug({ pool: learnedPool }, '表情池太小，本轮不发表情包');
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

      // ── 执行技能动作 ──────────────────────────────────────
      // 顺序：先让文字到达，再做小动作。
      // 比如"想你了 [戳]"——先看到字，再被戳，节奏才对。
      // 全部包在 try 里：技能失败绝不能影响这条回复已经发出的事实。
      if (parsedReply.actions.length > 0) {
        await runSkillActions(parsedReply.actions);
      }

      session.recordAssistant(replyText, { tokens: result.completionTokens, latencyMs: result.latencyMs });
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
      // ⚠️ 绝不能让异常变成"已读不回"。至少发一个短反应。
      try {
        const fb = ['嗯', '在', '刚走神了', '你说', '6'];
        const pick = fb[Math.floor(Math.random() * fb.length)];
        await adapter.sendPrivateMessageSegments(userId, post.toSegments(pick), effectiveReplyTo);
      } catch { /* 发送也失败就真的没办法了 */ }
    } finally {
      release();
    }
  };

  // ── 绑定主动开口的发送通道 ──────────────────────────────
  proactive.bindSender(async (text: string) => {
    // 主动开口是"锦上添花"：协议端没连、发送失败都不该拖垮整个程序。
    // 之前没兜底，协议端恰好掉线时这里抛错 → 未捕获 rejection → 进程直接退出。
    if (!adapter.isConnected()) {
      logger.warn('协议端未连接，跳过本次主动开口');
      return;
    }
    // 并发保护：她正在回复你的时候别插话。
    // 主动开口和被动回复共用同一条发送通道，同时发会出现两条消息交错的诡异现象。
    // 这里用非阻塞取锁——拿不到就跳过这一轮，不排队（排队可能等很久）。
    if (!session.tryAcquireLock()) {
      logger.debug('正在回复中，跳过本次主动开口');
      return;
    }
    try {
      const delay = post.typingDelayMs(text.length);
      logger.info({ chars: text.length, delayMs: delay }, '主动开口：准备发送');
      await sleep(delay);
      for (const seg of post.split(text)) {
        await adapter.sendPrivateMessageSegments(peerId, post.toSegments(seg));
        await sleep(post.segmentPauseMs());
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '主动开口发送失败（已忽略，不影响运行）');
    } finally {
      session.releaseLockPublic();
    }
  });
  proactive.start();

  adapter.on('event', (event: OneBotEvent) => {
    // 注意：这里保持同步签名，内部需要的异步逻辑各自用 IIFE 包，
    // 表情学习那段因为是 await，单独包一层（见下）
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
          const evMsgId = (event as any).message_id as number | string | undefined;

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
                  const qSegs = post.split(question);
                  for (let i = 0; i < qSegs.length; i++) {
                    await adapter.sendPrivateMessageSegments(
                      uid,
                      post.toSegments(qSegs[i]),
                      i === 0 ? evMsgId : undefined,
                    );
                  }
                  session.recordUser('[发了张表情]');
                  session.recordAssistant(question);
                  session.persist(true);
                })();
              }, 0);
              return;
            }

            // 纯表情且已经认识 → 正常聊；纯表情但不认识/问过了 → 也要给个反应，不能不回
            if (isPureStickerMsg(segs)) {
              session.recordUser('[发了张表情]');
              // 已经问过但没学到的表情：给她一个短反应，保证用户一定有回应
              if (text) {
                const verdict = proactive.sleep.onUserMessage(text);
                if (verdict.respond) {
                  void handleReply(uid, '[发了张表情]', evMsgId, []);
                }
              }
              return;
            }
          }
          // 2) 有未确认的表情，试着从这句话里学
          //    LLM 理解是异步的，用 IIFE 包起来不阻塞主流程。
          if (text && learner.hasPending()) {
            void (async () => {
              try {
                const learned = await learner.tryLearnFromReply(text);
                if (learned) {
                  logger.info(
                    { meaning: learned.meaning, scenes: learned.scenes },
                    '学会表情含义（LLM 理解）',
                  );
                }
              } catch (err) {
                logger.warn({ err: (err as Error).message }, '学习表情失败');
              }
            })();
          }

          if (text) {
            const verdict = proactive.sleep.onUserMessage(text);
            if (!verdict.respond) {
              // 理论上不会走到这（睡眠机制已改为必回），保留兜底：绝不静默
              logger.warn(
                { chars: text.length, reason: verdict.reason, phase: proactive.sleep.phase() },
                '睡眠判定为不回（不应发生），强制回复',
              );
              void handleReply(uid, text, evMsgId, []);
              return;
            }
            // 被吵醒后慢一点，但最多 10 秒——不能让你干等一两分钟
            if (verdict.delayMs > 0) {
              const wait = Math.min(verdict.delayMs, 10_000);
              logger.info({ delayMs: verdict.delayMs, actualWaitMs: wait }, '被吵醒，稍慢回复');
              setTimeout(
                () =>
                  void handleReply(
                    uid,
                    text,
                    evMsgId,
                    [],
                  ),
                wait,
              );
              return;
            }
          }
        }

        pipeline.accept(event, (decision) => {
          if (decision.action === 'reply') {
            void handleReply(decision.userId, decision.text, decision.messageId, decision.quotable);
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

    // 1) 先停主动开口和管线，不再接新任务
    proactive.stop();
    pipeline.stop();

    // 2) 等在途回复发完（最多 10 秒）。
    //    直接 process.exit 会把她正在打的字掐断，用户那边就是"说到一半人没了"。
    const deadline = Date.now() + 10_000;
    while (session.inflightCount > 0 && Date.now() < deadline) {
      logger.info({ inflight: session.inflightCount }, '等待在途回复完成…');
      await sleep(200);
    }
    if (session.inflightCount > 0) {
      logger.warn({ inflight: session.inflightCount }, '等待超时，强制退出（可能有回复被截断）');
    }

    // 3) 收尾
    session.persist(true);
    panel.dispose();
    await http.close();
    await adapter.stop();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // 全局兜底：任何未捕获的异步异常都只记日志，不让整个程序退出。
  // 这是个 7x24 长期在线的服务，"某一次发送失败"绝不该等于"服务挂掉"。
  process.on('unhandledRejection', (reason) => {
    logger.error(
      { err: (reason as Error)?.message ?? String(reason) },
      '未捕获的 Promise rejection（已忽略，程序继续运行）',
    );
  });
  process.on('uncaughtException', (err) => {
    logger.error({ err: err.message, stack: err.stack }, '未捕获异常（已忽略，程序继续运行）');
  });

  // 定期持久化关系状态
  setInterval(() => session.persist(), cfg.session.persistIntervalMs);
}

main().catch((err) => {
  log().error({ err: (err as Error).message, stack: (err as Error).stack }, '启动失败');
  process.exit(1);
});
