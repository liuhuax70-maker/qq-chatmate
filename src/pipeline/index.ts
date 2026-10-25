import type { Logger } from 'pino';
import type { OneBotEvent, PrivateMessageEvent, NoticeEvent, RequestEvent } from '../adapter/onebot';
import { extractText } from '../adapter/onebot';

export interface PipelineConfig {
  /** 静默多久算“说完了” */
  mergeWindowMs: number;
  /** 从第一条消息算起，最多等多久就强制处理（防止极端情况一直等下去） */
  mergeMaxWaitMs: number;
  dedup: { enabled: boolean; windowMs: number };
  filter: { allowedUsers: string[]; blockedUsers: string[]; dropSelf: boolean; dropGroupEvents: boolean };
  throttle: {
    burstWindowSeconds: number;
    burstMaxReplies: number;
    burstSkipProbability: number;
    floodWindowSeconds: number;
    floodThreshold: number;
    floodSkipProbability: number;
    cooldownAfterSkipSeconds: number;
  };
}

export type PipelineDecision =
  | {
      action: 'reply';
      userId: string;
      text: string;
      mergedCount: number;
      messageId?: number | string;
      /**
       * 需要「单独引用回复」的消息列表。
       *
       * 需求：不是"长消息就引用"，而是多条消息时挑几个重要的分别回。
       *   · 单条消息 → 空数组（直接回，不引用）
       *   · 连发多条 → 挑 1-3 条重要的，每条单独引用回复
       *
       * 挑选规则见 pickQuotable()。
       */
      quotable: Array<{ text: string; messageId?: number | string }>;
    }
  | { action: 'drop'; reason: string };

/** 合并缓冲里的单条消息 */
interface BufferedMsg {
  text: string;
  messageId?: number | string;
  at: number;
}

interface BufferEntry {
  userId: string;
  /** 逐条保存原文和 id——只有这样才能"挑几条分别引用回复" */
  msgs: BufferedMsg[];
  timer: NodeJS.Timeout;
  firstAt: number;
}

/**
 * 消息管线。
 *
 * 职责：把原始 OneBot 事件收敛成"该不该回、回什么内容"的决策。
 *
 * 关键点：
 *  - 群消息在**最前面**丢弃，不进后续任何环节
 *  - 非白名单私聊在**调 LLM 之前**丢弃，不污染上下文、不烧 token
 *  - 分片合并：同一人连发多条，等静默期后合并成一段
 *  - 连发节流：对方刷屏时降低回复率
 */
export class MessagePipeline {
  private cfg: PipelineConfig;
  private logger: Logger;
  private allowedUsers: Set<string>;
  private blockedUsers: Set<string>;

  private seen = new Map<string, number>();
  private buffers = new Map<string, BufferEntry>();
  private recentReplyTimes: number[] = [];
  private recentUserMessageTimes: number[] = [];
  /** 上次因节流而跳过的时刻，用于冷却期判断 */
  private lastSkipAt = 0;

  constructor(cfg: PipelineConfig, logger: Logger) {
    this.cfg = cfg;
    this.logger = logger;
    this.allowedUsers = new Set(cfg.filter.allowedUsers.map(String));
    this.blockedUsers = new Set(cfg.filter.blockedUsers.map(String));

    if (this.allowedUsers.size === 0) {
      this.logger.warn('⚠️ allowedUsers 为空——将拒绝所有私聊。请在 config/default.yaml 里填入你的 QQ 号。');
    }
  }

  isAllowed(userId: string | number): boolean {
    const id = String(userId);
    if (this.blockedUsers.has(id)) return false;
    return this.allowedUsers.has(id);
  }

  /**
   * 处理一条消息事件。返回 null 表示静默丢弃（不回复）。
   * 实际回复由回调在合并窗口结束后触发。
   */
  accept(event: OneBotEvent, onReady: (decision: PipelineDecision) => void): void {
    // ① 群消息：无论配置如何，一律丢弃
    if ((event as any).message_type === 'group') {
      const e = event as any;
      this.logger.warn(
        { group: e.group_id, user: e.user_id },
        '收到群消息，已丢弃（本项目为纯私聊场景）',
      );
      onReady({ action: 'drop', reason: 'group-message' });
      return;
    }

    const msg = event as PrivateMessageEvent;
    if (msg.post_type !== 'message' || msg.message_type !== 'private') {
      onReady({ action: 'drop', reason: 'not-private-message' });
      return;
    }

    const userId = String(msg.user_id);

    // ② 自己的消息
    if (this.cfg.filter.dropSelf && userId === String(msg.self_id)) {
      onReady({ action: 'drop', reason: 'self' });
      return;
    }

    // ③ 去重
    if (this.cfg.dedup.enabled) {
      const key = `${userId}:${msg.message_id}`;
      const now = Date.now();
      const prev = this.seen.get(key);
      if (prev && now - prev < this.cfg.dedup.windowMs) {
        onReady({ action: 'drop', reason: 'duplicate' });
        return;
      }
      this.seen.set(key, now);
      this.gcSeen(now);
    }

    // ④ 白名单 —— 关键拦截点，必须在调用 LLM 之前
    if (!this.isAllowed(userId)) {
      this.logger.warn({ user: userId }, '非白名单私聊，已丢弃（不回复、不进上下文）');
      onReady({ action: 'drop', reason: 'not-allowed' });
      return;
    }

    // ⑤ 提取文本
    const text = extractText(msg.message ?? []);
    const messageId = msg.message_id;
    if (!text) {
      // 纯表情/纯图片：不带文本也要往下走，让上层处理
      // （上层会走表情学习流程或给一个短反应，绝不能在这里静默丢弃）
      onReady({ action: 'reply', userId, text: '', mergedCount: 1, messageId, quotable: [] });
      return;
    }

    // ⑥ 分片合并缓冲
    this.enqueue(userId, text, onReady, messageId);
  }

  private enqueue(
    userId: string,
    text: string,
    onReady: (d: PipelineDecision) => void,
    messageId?: number | string,
  ): void {
    const existing = this.buffers.get(userId);
    const now = Date.now();

    if (existing) {
      existing.msgs.push({ text, messageId, at: now });
      clearTimeout(existing.timer);

      // 关键改动：静默期可以"续期"，但总时长有上限。
      //
      // 原来：固定 1.5 秒，到点就发——你说慢一点就会被拆成两次对话。
      // 现在：每来一条新消息就重新计时，但不让总等待超过 maxWaitMs。
      // 这样"慢慢说完整一件事"会被合并，又不会因为她迟迟不回而卡死。
      const elapsed = now - existing.firstAt;
      const maxWait = this.cfg.mergeMaxWaitMs ?? this.cfg.mergeWindowMs * 4;
      const remaining = Math.min(this.cfg.mergeWindowMs, maxWait - elapsed);

      if (remaining <= 0) {
        // 已经等够久了，立刻处理
        this.buffers.delete(userId);
        clearTimeout(existing.timer);
        void this.flushNow(existing, onReady);
        return;
      }

      existing.timer = setTimeout(() => this.flush(userId, onReady), remaining);
      return;
    }

    const entry: BufferEntry = {
      userId,
      msgs: [{ text, messageId, at: now }],
      firstAt: now,
      timer: setTimeout(() => this.flush(userId, onReady), this.cfg.mergeWindowMs),
    };
    this.buffers.set(userId, entry);
  }

  private flushNow(entry: BufferEntry, onReady: (d: PipelineDecision) => void): void {
    this.processMerged(entry.userId, entry.msgs, onReady);
  }

  private flush(userId: string, onReady: (d: PipelineDecision) => void): void {
    const entry = this.buffers.get(userId);
    if (!entry) return;
    this.buffers.delete(userId);
    this.processMerged(userId, entry.msgs, onReady);
  }

  /**
   * 判断这条消息值不值得引用回复。
   *
   * 直觉：引用是"我专门针对你说的这件事回"。
   *   · 一句"在吗""嗯""哈哈" → 不需要引用，直接接话更自然
  /**
   * 挑出需要「单独引用回复」的消息。
   *
   * 需求澄清：不是"长消息就引用"，而是**多条消息时挑几个重要的分别回**。
   * 你连发几条、信息量很大时，她挑其中最有内容的分别引用回复，
   * 而不是笼统回一句。单条消息永远不引用。
   *
   * 规则：
   *   · msgs.length < 2     → 不引用
   *   · 带问号              → 优先（他在问事）
   *   · 字数多              → 次优先
   *   · <= 3 字的           → 排除（"在吗""嗯"不值得单独引用）
   *   · 最多挑 3 条，2 条消息时只挑 1 条
   */
  pickQuotable(msgs: BufferedMsg[]): BufferedMsg[] {
    if (msgs.length < 2) return [];

    const scored = msgs
      .map((m) => {
        const len = m.text.replace(/\s/g, '').length;
        const isQuestion = /[?？]/.test(m.text);
        const tooShort = len <= 3;
        let score = len;
        if (isQuestion) score += 20;
        if (tooShort) score -= 100;
        return { m, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) return [];

    const maxPick = msgs.length === 2 ? 1 : Math.min(3, scored.length);
    const picked: BufferedMsg[] = [];
    const usedTexts: string[] = [];

    for (const s of scored) {
      if (picked.length >= maxPick) break;
      const dup = usedTexts.some(
        (t) => t.includes(s.m.text.slice(0, 6)) || s.m.text.includes(t.slice(0, 6)),
      );
      if (dup) continue;
      picked.push(s.m);
      usedTexts.push(s.m.text);
    }

    // 按原始时间顺序返回
    return picked.sort((a, b) => a.at - b.at);
  }

  /** 合并后的处理主逻辑 */
  private processMerged(
    userId: string,
    msgs: BufferedMsg[],
    onReady: (d: PipelineDecision) => void,
  ): void {
    const texts = msgs.map((m) => m.text);
    const merged = texts.join('\n');
    const count = texts.length;
    const now = Date.now();

    // 频率记录（仅日志观察用，不再用于丢消息）
    const floodWindow = this.cfg.throttle.floodWindowSeconds * 1000;
    for (let i = 0; i < count; i++) this.recentUserMessageTimes.push(now);
    this.recentUserMessageTimes = this.recentUserMessageTimes.filter((t) => now - t < floodWindow);

    // 挑出要单独引用的那几条
    const quotable = this.pickQuotable(msgs);

    onReady({
      action: 'reply',
      userId,
      text: merged,
      mergedCount: count,
      messageId: msgs[0]?.messageId,
      quotable: quotable.map((q) => ({ text: q.text, messageId: q.messageId })),
    });
  }

  markReplied(): void {
    this.recentReplyTimes.push(Date.now());
  }

  private gcSeen(now: number): void {
    if (this.seen.size < 500) return;
    for (const [k, t] of this.seen) {
      if (now - t > this.cfg.dedup.windowMs * 10) this.seen.delete(k);
    }
  }

  /**
   * 处理 notice 事件：被拉进群 → 立即退群。
   */
  handleNotice(event: NoticeEvent, leave: (groupId: string) => Promise<void>): void {
    if (event.notice_type === 'group_increase' && String(event.user_id) === String(event.self_id)) {
      const groupId = String(event.group_id);
      this.logger.warn({ group: groupId }, '⚠️ 被拉进群，执行自动退群');
      void leave(groupId).catch((err) => {
        this.logger.error({ err: (err as Error).message, group: groupId }, '自动退群失败');
      });
      return;
    }
    if (event.notice_type === 'group_recall' || event.notice_type === 'group_upload') {
      this.logger.debug({ notice_type: event.notice_type }, '忽略群 notice 事件');
    }
  }

  /**
   * 处理 request 事件：好友请求 → 非白名单自动拒绝。
   */
  async handleRequest(
    event: RequestEvent,
    actions: {
      setFriendAddRequest: (flag: string, approve: boolean, remark?: string) => Promise<void>;
      setGroupAddRequest: (flag: string, approve: boolean, reason?: string) => Promise<void>;
    },
    opts: { autoReject: boolean; autoAcceptWhitelisted: boolean; rejectReason: string; autoRejectGroup: boolean },
  ): Promise<void> {
    if (event.request_type === 'friend') {
      const userId = String(event.user_id);
      const allowed = this.isAllowed(userId);

      if (allowed && opts.autoAcceptWhitelisted) {
        this.logger.info({ user: userId }, '白名单内好友请求，自动同意');
        await actions.setFriendAddRequest(event.flag, true, '');
        return;
      }
      if (opts.autoReject) {
        this.logger.warn({ user: userId }, '⚠️ 非白名单好友请求，自动拒绝');
        await actions.setFriendAddRequest(event.flag, false, opts.rejectReason);
      }
      return;
    }

    if (event.request_type === 'group') {
      if (opts.autoRejectGroup) {
        this.logger.warn({ group: String(event.group_id), user: String(event.user_id) }, '⚠️ 收到群邀请，自动拒绝');
        await actions.setGroupAddRequest(event.flag, false, '');
      }
    }
  }

  /** 启动前自检：是否存在明显的配置错误 */
  selfCheck(): string[] {
    const problems: string[] = [];
    if (this.cfg.filter.allowedUsers.length === 0) {
      problems.push('pipeline.filter.allowedUsers 为空：所有私聊都会被拒绝');
    }
    if (!this.cfg.filter.dropGroupEvents) {
      problems.push('pipeline.filter.dropGroupEvents 为 false，但本项目只支持私聊——已强制忽略该配置');
    }
    return problems;
  }

  stop(): void {
    for (const b of this.buffers.values()) clearTimeout(b.timer);
    this.buffers.clear();
  }
}
