import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Logger } from 'pino';
import type { Store } from '../store/db';
import type { Session } from '../session';
import type { LLMClient } from '../brain/llm';
import type { PromptBuilder } from '../brain/prompt';
import { SleepStateMachine, type SleepConfig } from './sleep';

export interface ProactiveConfig {
  enabled: boolean;
  quietHours: [number, number];
  maxPerDay: number;
  maxPerHour: number;
  minGapMinutes: number;
  ignoreBackoff: {
    enabled: boolean;
    factor: number;
    maxMultiplier: number;
    resetAfterReply: boolean;
  };
  triggers: {
    silence: { enabled: boolean; idleHours: number; probability: number; topicsFile?: string };
    share: {
      enabled: boolean;
      idleHours: number;
      probability: number;
      topicsFile?: string;
      fromMemory: boolean;
    };
    care: {
      enabled: boolean;
      idleHours: number;
      probability: number;
      fromMemory: boolean;
    };
    morning: {
      enabled: boolean;
      wakeWindow: [number, number];
      lateWake: { probability: number; window: [number, number] };
      delayMinutes: [number, number];
      skipProbability: number;
      pauseAfterIgnores: number;
      pauseDays: number;
    };
    night: {
      enabled: boolean;
      sleepWindow: [number, number];
      awakeAfterGoodnightMinutes: number;
      hardSleep: boolean;
      mentionNightMessages: { enabled: boolean };
      /** 问候发出后用户多久没回，她会撒娇催一下（分钟）。0 = 不撒娇 */
      teaseAfterIgnoredMinutes: number;
      /** 被吵醒后需要多久才能回消息（分钟区间） */
      wakeUpDelayMinutes: [number, number];
      /** 被吵醒后能聊多久，然后重新睡着（分钟） */
      stayAwakeMinutes: number;
      skipProbability: number;
      pauseAfterIgnores: number;
      pauseDays: number;
    };
    promise: { enabled: boolean; horizonHours: number };
  };
  safety: { maxChars: number; forbiddenTopics: string[] };
}

interface DailyState {
  /** 今天的起床时刻（当天 0 点起的分钟数）。每天只决定一次。 */
  wakeMinuteOfDay: number | null;
  /** 今晚道晚安的具体时刻（分钟数）。每天只决定一次。 */
  nightTargetMinute: number | null;
  /** 今天的早安是否已发 */
  morningSent: boolean;
  /** 今天的晚安是否已发 */
  nightSent: boolean;
  /** 今天主动开口次数 */
  count: number;
  /** 连续被无视次数 */
  ignoreStreak: number;
  /** 暂停到什么时候 */
  pausedUntil: number;
  /** 日期标记（YYYY-MM-DD），跨天就重置 */
  day: string;
  /**
   * 已发出但还没被回复的问候（早安/晚安）。
   * 用户没回的话，过一会儿她会撒娇催一下。
   */
  awaitingReply: { kind: 'morning' | 'night'; sentAt: number; teased: boolean } | null;
}

const STORAGE_KEY = 'proactive_daily_state';

/**
 * 主动开口调度器。
 *
 * 设计原则：**不是定时打卡，是一个有作息的人。**
 *
 * - 起床时间每天随机，且偶尔因为熬夜而晚起
 * - 起床后不是立刻发「早」，而是隔 5-40 分钟才想起来
 * - 有 25% 的日子根本想不到要发
 * - 连续两次被无视，就停几天不发（她也会觉得没意思）
 * - 晚安会跟着用户的作息往后拖（你还在聊，她不先睡）
 */
export class ProactiveScheduler {
  private cfg: ProactiveConfig;
  private session: Session;
  private store: Store;
  private llm: LLMClient;
  private promptBuilder: PromptBuilder;
  private logger: Logger;
  private peerId: string;

  private state: DailyState;
  private lastProactiveAt = 0;
  private hourlyCount = 0;
  private hourlyResetAt = 0;
  private timer?: NodeJS.Timeout;
  private sender?: (text: string) => Promise<void>;
  /** 本地话题库缓存（启动时加载一次） */
  private topics: string[] = [];

  /** 睡眠状态机：控制"睡着后不回消息" */
  readonly sleep: SleepStateMachine;

  constructor(
    cfg: ProactiveConfig,
    deps: {
      session: Session;
      store: Store;
      llm: LLMClient;
      promptBuilder: PromptBuilder;
      logger: Logger;
      peerId: string;
    },
  ) {
    this.cfg = cfg;
    this.session = deps.session;
    this.store = deps.store;
    this.llm = deps.llm;
    this.promptBuilder = deps.promptBuilder;
    this.logger = deps.logger;
    this.peerId = deps.peerId;
    this.state = this.loadState();

    // 醒来时间参照早安窗口的下界
    this.sleep = new SleepStateMachine(
      {
        sleepWindow: cfg.triggers.night.sleepWindow,
        awakeAfterGoodnightMinutes: cfg.triggers.night.awakeAfterGoodnightMinutes,
        hardSleep: cfg.triggers.night.hardSleep,
        wakeUpDelayMinutes: cfg.triggers.night.wakeUpDelayMinutes ?? [2, 8],
        stayAwakeMinutes: cfg.triggers.night.stayAwakeMinutes ?? 15,
      } as SleepConfig,
      deps.store,
      deps.logger,
    );

    // 加载本地话题库（分享触发器的素材）
    this.topics = this.loadTopics();
  }

  /** 加载话题库（YAML 里的 topics 数组）。失败不影响启动。 */
  private loadTopics(): string[] {
    const file = this.cfg.triggers.share.topicsFile ?? this.cfg.triggers.silence.topicsFile;
    if (!file) return [];
    try {
      const p = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
      if (!fs.existsSync(p)) return [];
      const parsed = parseYaml(fs.readFileSync(p, 'utf8')) as { topics?: unknown };
      if (Array.isArray(parsed?.topics)) {
        const list = parsed.topics.filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
        if (list.length > 0) this.logger.info({ count: list.length, file }, '话题库已加载');
        return list;
      }
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, '话题库加载失败');
    }
    return [];
  }

  /** 设置发送函数（由 main 注入） */
  bindSender(fn: (text: string) => Promise<void>): void {
    this.sender = fn;
  }

  start(): void {
    if (!this.cfg.enabled) {
      this.logger.info('主动开口未启用');
      return;
    }
    // 每分钟检查一次。主动开口本来就是低频事件，没必要跑更勤。
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.logger.info(
      {
        wakeWindow: this.cfg.triggers.morning.wakeWindow,
        sleepWindow: this.cfg.triggers.night.sleepWindow,
      },
      '主动开口调度器已启动（早/晚安 + 冷场）',
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ── 状态持久化 ──────────────────────────────────────────

  private todayKey(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  private loadState(): DailyState {
    const fresh: DailyState = {
      wakeMinuteOfDay: null,
      nightTargetMinute: null,
      morningSent: false,
      nightSent: false,
      count: 0,
      ignoreStreak: 0,
      pausedUntil: 0,
      day: this.todayKey(),
      awaitingReply: null,
    };
    try {
      const row = this.store.getKv(STORAGE_KEY);
      if (!row) return fresh;
      const saved = JSON.parse(row) as DailyState;
      if (saved.day !== fresh.day) {
        // 跨天：保留 ignoreStreak 和 pausedUntil，重置当天计数
        return { ...fresh, ignoreStreak: saved.ignoreStreak ?? 0, pausedUntil: saved.pausedUntil ?? 0 };
      }
      return { ...fresh, ...saved };
    } catch {
      return fresh;
    }
  }

  private saveState(): void {
    this.state.day = this.todayKey();
    this.store.setKv(STORAGE_KEY, JSON.stringify(this.state));
  }

  // ── 主循环 ──────────────────────────────────────────────

  private async tick(): Promise<void> {
    const now = new Date();
    const hour = now.getHours();

    // 跨天重置
    if (this.state.day !== this.todayKey()) {
      this.state = {
        ...this.state,
        day: this.todayKey(),
        morningSent: false,
        nightSent: false,
        count: 0,
        wakeMinuteOfDay: null,
        nightTargetMinute: null,
        awaitingReply: null,
      };
      this.saveState();
    }

    // 深夜禁言（晚安窗口除外，所以晚安在禁言之前判断）
    // 先给晚安一个机会：它的窗口是 00:00-02:00，正好在禁言区之前
    if (this.state.pausedUntil <= Date.now() && this.state.count < this.cfg.maxPerDay) {
      if (await this.tryNight(now)) return;
    }

    // 睡着中：什么主动行为都不做
    if (this.sleep.isSleeping()) return;

    if (this.inQuietHours(hour)) return;

    // 暂停中
    if (this.state.pausedUntil > Date.now()) return;

    // 每日上限
    if (this.state.count >= this.cfg.maxPerDay) return;

    // 每小时上限
    if (Date.now() - this.hourlyResetAt > 3_600_000) {
      this.hourlyCount = 0;
      this.hourlyResetAt = Date.now();
    }
    if (this.hourlyCount >= this.cfg.maxPerHour) return;

    // 最小间隔（含被无视后退避）
    const gapMs = this.cfg.minGapMinutes * 60_000 * this.backoffMultiplier();
    if (Date.now() - this.lastProactiveAt < gapMs) return;

    // 依次尝试各个触发器（晚安已在上面处理）
    // 优先级：撒娇（等回复）> 早安 > share/care/silence > 守约
    if (await this.tryTease(now)) return;
    if (await this.tryMorning(now)) return;
    if (await this.tryShareOrCare(now)) return;
    if (await this.trySilence(now)) return;
    if (await this.tryPromise(now)) return;
  }

  private backoffMultiplier(): number {
    if (!this.cfg.ignoreBackoff.enabled) return 1;
    const m = Math.pow(this.cfg.ignoreBackoff.factor, this.state.ignoreStreak);
    return Math.min(m, this.cfg.ignoreBackoff.maxMultiplier);
  }

  private inQuietHours(hour: number): boolean {
    const [start, end] = this.cfg.quietHours;
    // 支持跨零点区间，如 [23, 7]
    if (start <= end) return hour >= start && hour < end;
    return hour >= start || hour < end;
  }

  // ── 触发器 0：问候没被回 → 撒娇催一下 ──────────────────

  /**
   * 早安/晚安发出去之后，用户一直没回。
   * 她会撒娇催一下——这是"等回复"的自然反应，不是话痨。
   * 每条问候只撒娇一次（teased 标记），撒娇完还是不理，就按无视处理。
   */
  private async tryTease(now: Date): Promise<boolean> {
    const pending = this.state.awaitingReply;
    if (!pending || pending.teased) return false;

    const cfgTease = this.cfg.triggers.night.teaseAfterIgnoredMinutes;
    if (cfgTease <= 0) return false;

    const waitedMin = (Date.now() - pending.sentAt) / 60_000;
    if (waitedMin < cfgTease) return false;

    // 深夜的晚安不被回，她撒娇完就要睡了，不纠缠
    if (pending.kind === 'night' && this.sleep.isSleeping()) {
      this.state.awaitingReply = null;
      this.saveState();
      return false;
    }

    const text = await this.generate('tease', [], [], [], pending.kind);
    if (!text) return false;

    await this.emit(text);
    this.state.awaitingReply = { ...pending, teased: true };
    this.saveState();
    this.logger.info({ text, kind: pending.kind, waitedMin: waitedMin.toFixed(0) }, '问候没被回，撒娇催一下');
    return true;
  }

  // ── 触发器 1：早安 ──────────────────────────────────────

  private async tryMorning(now: Date): Promise<boolean> {
    const c = this.cfg.triggers.morning;
    if (!c.enabled || this.state.morningSent) return false;

    // 如果她还在睡，说明还没醒，早安当然发不了
    if (this.sleep.isSleeping()) return false;

    // 起床时间的来源优先级：
    //   1) 昨晚睡过觉 → 用睡眠机算出的醒来时间（她自己决定的）
    //   2) 没睡过（比如昨晚没道晚安）→ 按窗口随机一个
    const wakeAtMs = this.sleep.getWakeAt();
    let wakeMinuteOfDay: number;
    if (wakeAtMs > 0 && this.isToday(wakeAtMs)) {
      const d = new Date(wakeAtMs);
      wakeMinuteOfDay = d.getHours() * 60 + d.getMinutes();
      if (this.state.wakeMinuteOfDay === null) {
        this.state.wakeMinuteOfDay = wakeMinuteOfDay;
        this.saveState();
        this.logger.info({ wakeAt: this.formatMinute(wakeMinuteOfDay) }, '按昨晚睡眠时长推算的起床时间');
      }
    } else {
      if (this.state.wakeMinuteOfDay === null) {
        this.state.wakeMinuteOfDay = this.decideWakeMinute();
        this.saveState();
        this.logger.info({ wakeAt: this.formatMinute(this.state.wakeMinuteOfDay) }, '今天她的起床时间已决定');
      }
      wakeMinuteOfDay = this.state.wakeMinuteOfDay;
    }

    const nowMinute = now.getHours() * 60 + now.getMinutes();
    if (nowMinute < wakeMinuteOfDay) return false;

    // 起床后要隔一会儿才想起来
    const delay = c.delayMinutes[0] + Math.random() * (c.delayMinutes[1] - c.delayMinutes[0]);
    if (nowMinute < wakeMinuteOfDay + delay) return false;

    // 27% 的日子根本不发
    if (Math.random() < c.skipProbability) {
      this.state.morningSent = true;
      this.saveState();
      this.logger.debug('今天她想不起来发早安，跳过');
      return false;
    }

    // 连续被无视 → 停几天
    if (this.shouldPause(c.pauseAfterIgnores, c.pauseDays)) {
      this.state.morningSent = true;
      this.saveState();
      return false;
    }

    // 昨晚睡着之后你发的消息 → 她醒来可能提一嘴
    const nightMsgs = this.sleep.drainNightMessages();
    const text = await this.generate('morning', nightMsgs.map((m) => m.text));
    if (!text) return false;

    await this.emit(text);
    this.state.morningSent = true;
    this.state.awaitingReply = { kind: 'morning', sentAt: Date.now(), teased: false };
    this.saveState();
    this.logger.info({ text }, '发送早安');
    return true;
  }

  /** 决定今天的起床时间（分钟数，从 0 点算） */
  private decideWakeMinute(): number {
    const c = this.cfg.triggers.morning;
    // 熬夜 → 晚起
    const window =
      Math.random() < c.lateWake.probability ? c.lateWake.window : c.wakeWindow;
    const [startH, endH] = window;
    const startMin = startH * 60;
    const endMin = endH * 60;
    return Math.floor(startMin + Math.random() * (endMin - startMin));
  }

  // ── 触发器 2：晚安 ──────────────────────────────────────

  private async tryNight(now: Date): Promise<boolean> {
    const c = this.cfg.triggers.night;
    if (!c.enabled || this.state.nightSent) return false;
    // 已经睡着或已经道过晚安了，不再重复
    if (this.sleep.isSleeping()) return false;

    // 时间窗口：00:00-02:00（支持跨零点区间）
    if (!this.inWindow(now.getHours(), c.sleepWindow)) return false;

    // 窗口内随机一个时刻才发，不是一进窗口就发
    // 用「窗口总分钟数 × 随机」决定当天夜晚的具体时刻
    const [startH, endH] = c.sleepWindow;
    const startMin = startH * 60;
    const endMin = endH <= startH ? (endH + 24) * 60 : endH * 60;
    const targetMin = this.state.nightTargetMinute ?? Math.floor(startMin + Math.random() * (endMin - startMin));
    if (this.state.nightTargetMinute === null) {
      this.state.nightTargetMinute = targetMin;
      this.saveState();
      this.logger.info({ at: this.formatMinute(targetMin % 1440) }, '今晚的晚安时刻已决定');
    }
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const adjustedNow = nowMin < startMin ? nowMin + 1440 : nowMin;
    if (adjustedNow < targetMin) return false;

    if (Math.random() < c.skipProbability) {
      this.state.nightSent = true;
      this.saveState();
      return false;
    }

    if (this.shouldPause(c.pauseAfterIgnores, c.pauseDays)) {
      this.state.nightSent = true;
      this.saveState();
      return false;
    }

    const text = await this.generate('night');
    if (!text) return false;

    await this.emit(text);
    this.state.nightSent = true;
    this.state.awaitingReply = { kind: 'night', sentAt: Date.now(), teased: false };
    this.saveState();
    // 通知睡眠状态机：进入半睡半醒期
    this.sleep.onGoodnightSent();
    this.logger.info({ text, bufferMin: c.awakeAfterGoodnightMinutes }, '发送晚安，进入半睡半醒期');
    return true;
  }

  /** 判断时间戳是否是今天 */
  private isToday(ts: number): boolean {
    const d = new Date(ts);
    const n = new Date();
    return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  }

  /** 判断小时是否在窗口内，支持跨零点（如 [0,2]、[22,2]） */
  private inWindow(hour: number, window: [number, number]): boolean {
    const [s, e] = window;
    if (s <= e) return hour >= s && hour < e;
    return hour >= s || hour < e;
  }

  // ── 触发器 3：冷场 ──────────────────────────────────────

  private async trySilence(now: Date): Promise<boolean> {
    const c = this.cfg.triggers.silence;
    if (!c.enabled) return false;

    const idleHours = (Date.now() - this.session.lastActiveAt) / 3_600_000;
    if (idleHours < c.idleHours) return false;
    if (Math.random() >= c.probability) return false;

    const text = await this.generate('silence');
    if (!text) return false;

    await this.emit(text);
    this.logger.info({ text, idleHours: idleHours.toFixed(1) }, '冷场主动开口');
    return true;
  }

  // ── 触发器 4：分享发现 / 关心询问（二选一） ──────────────

  private async tryShareOrCare(now: Date): Promise<boolean> {
    const share = this.cfg.triggers.share;
    const care = this.cfg.triggers.care;
    const bothDisabled = !share.enabled && !care.enabled;
    if (bothDisabled) return false;

    // 先从「分享 / 关心」里挑一种（都启用时按各自概率权重随机，别同时来）
    const candidates: Array<'share' | 'care'> = [];
    if (share.enabled) candidates.push('share');
    if (care.enabled) candidates.push('care');
    if (candidates.length === 0) return false;
    const kind = candidates[Math.floor(Math.random() * candidates.length)];

    const c = kind === 'share' ? share : care;
    const idleHours = (Date.now() - this.session.lastActiveAt) / 3_600_000;
    if (idleHours < c.idleHours) return false;
    if (Math.random() >= c.probability) return false;

    // 记忆素材：从长期记忆里拉几条最近的，让「分享/关心」有据可依
    let memoryHints: string[] = [];
    if (c.fromMemory) {
      try {
        const mems = this.store.searchMemories(this.peerId, '', 4);
        memoryHints = mems.map((m) => m.content).filter(Boolean);
      } catch {
        memoryHints = [];
      }
    }

    const text = await this.generate(kind, [], kind === 'share' ? this.pickTopics(3) : undefined, memoryHints);
    if (!text) return false;

    await this.emit(text);
    this.logger.info(
      { text, kind, idleHours: idleHours.toFixed(1), memHints: memoryHints.length },
      kind === 'share' ? '主动分享发现' : '主动关心询问',
    );
    return true;
  }

  /** 从话题库随机挑 n 条（无库则返回空） */
  private pickTopics(n: number): string[] {
    if (this.topics.length === 0) return [];
    const shuffled = [...this.topics].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, n);
  }

  // ── 触发器 5：守约提醒 ──────────────────────────────────

  private async tryPromise(now: Date): Promise<boolean> {
    const c = this.cfg.triggers.promise;
    if (!c.enabled) return false;

    const due = this.store.listPromisesDue(this.peerId, c.horizonHours * 3_600_000);
    if (due.length === 0) return false;

    const text = await this.generate('promise');
    if (!text) return false;

    await this.emit(text);
    this.logger.info({ text }, '守约提醒');
    return true;
  }

  // ── 生成与发送 ──────────────────────────────────────────

  private shouldPause(afterIgnores: number, pauseDays: number): boolean {
    if (this.state.ignoreStreak < afterIgnores) return false;
    if (this.state.pausedUntil > Date.now()) return true;
    this.state.pausedUntil = Date.now() + pauseDays * 86_400_000;
    this.logger.info({ pauseDays, ignoreStreak: this.state.ignoreStreak }, '连续被无视，暂停主动开口');
    return true;
  }

  private async generate(
    kind: 'morning' | 'night' | 'silence' | 'share' | 'care' | 'tease' | 'promise',
    nightMessages: string[] = [],
    topics: string[] = [],
    memoryHints: string[] = [],
    greetingKind?: 'morning' | 'night',
  ): Promise<string | null> {
    // 醒来时如果昨晚你发过消息，她会带着这个上下文说话
    const nightHint =
      nightMessages.length > 0
        ? [
            '',
            '补充：昨晚你睡着之后，对方发了这些消息：',
            ...nightMessages.slice(-3).map((m) => `  「${m}」`),
            '如果觉得自然，可以顺带提一嘴；不想提也没关系。',
          ].join('\n')
        : '';

    const topicsHint =
      topics.length > 0
        ? ['', '你可以参考这些你最近在琢磨/碰到的事（挑一条自然地带出来，或只是当作灵感）：', ...topics.map((t) => `  - ${t}`)].join('\n')
        : '';

    const memoryHint =
      memoryHints.length > 0
        ? ['', '你记得对方最近说过/发生过这些事：', ...memoryHints.slice(-4).map((m) => `  - ${m}`), '如果自然，可以接续、关心或回应这些；不要生硬地全提。'].join('\n')
        : '';

    const prompts: Record<string, string> = {
      morning: [
        '现在是早上，你刚醒。',
        '你要跟对方道个早安，并且顺势关心他一句。',
        nightHint,
        memoryHint,
        '',
        '要求：',
        '- 不要说「早安」这个词，太公式化了',
        '- 像刚睡醒的人说话，可以有点没睡醒的感觉',
        '- **问候之后要关心他一句**：问得具体自然，别问「吃了吗」「睡得好吗」这种客套',
        '- 最好接着他最近提过的事关心（比如他之前说忙/累/不舒服）',
        '- 傲娇式和直接式都行，看心情',
        '- 一到两句话，总共不超过 35 字',
      ].join('\n'),
      night: [
        '现在是深夜，你要睡了，跟他道个晚安，并且关心他一句。',
        '',
        '要求：',
        '- 不要用「晚安」这个词（或者最多用一次，而且要自然）',
        '- **道晚安之后要关心他一句**：让他早点睡、别熬太晚，或者问他今天怎么样',
        '- 关心要具体自然，别像家长说教',
        '- 傲娇式和直接式都行：可以嘴硬着关心，也可以直接说',
        '- 一到两句话，总共不超过 35 字',
      ].join('\n'),
      silence: [
        '对方有一阵子没说话了。',
        '你有点想找他说点什么，也可能只是无聊。',
        '',
        '要求：',
        '- 一句话，不超过 20 字',
        '- 像随口一说，不要提问式（提问像客服回访）',
        '- 不要问「在吗」',
      ].join('\n'),
      share: [
        '你突然想跟对方分享一件你觉得有意思的事，或一个刚冒出来的小发现、小情绪。',
        '就像朋友之间随手转发/随口一说，不是汇报，也不是没话找话。',
        topicsHint,
        memoryHint,
        '',
        '要求：',
        '- 一句话，不超过 30 字',
        '- 是你「主动分享」，不是问对方，也不是等对方回应',
        '- 内容要具体、有画面，不要空泛的「今天好无聊」',
        '- 偶尔可以带点傲娇（三分傲七分娇），但别每句都来',
        '- 不要重复话题库里的原话，要换成你自己的说法',
      ].join('\n'),
      care: [
        '你有点惦记对方，想主动关心一下，或者问问他最近怎么样。',
        '不是客服回访，是朋友之间的那种自然的牵挂。',
        memoryHint,
        '',
        '要求：',
        '- 一两句话，不超过 30 字',
        '- 可以提问，但问得要具体、自然，别问「在吗」「吃了吗」这种空话',
        '- 语气在「傲娇式关心」和「直接式关心」之间自然切换，不要固定',
        '- 傲娇式：明明关心却装作随口一问；直接式：坦率地问一句',
        '- 如果记忆里有对方提过的事，优先接着那件事关心',
      ].join('\n'),
      promise: [
        '你想起之前和对方有个约定，时间快到了。',
        '',
        '要求：',
        '- 一句话，不超过 25 字',
        '- 用你自己的口吻提一句，别像提醒事项',
      ].join('\n'),
      tease: [
        greetingKind === 'night'
          ? '你刚跟他道了晚安，还关心了他一句，结果他半天没回你。'
          : '你刚跟他说了早安，还关心了他一句，结果他半天没回你。',
        '你有点不高兴，但不是真生气——是那种"我都主动找你了你居然不理我"的委屈。',
        '你想撒娇催他回你一句。',
        '',
        '要求：',
        '- 撒娇，不是质问，不是生气，不是"在吗"这种查岗',
        '- 傲娇式的委屈最自然：嘴硬着表达"你怎么不理我"',
        '- 可以耍一点点无赖，但别真的作',
        '- 一句话，不超过 25 字',
        '- 不要用「早安」「晚安」这种词——你刚才已经说过了',
        '- 别重复刚才那句问候的内容，要往前推一步',
      ].join('\n'),
    };

    try {
      const messages = this.promptBuilder.build(this.session, prompts[kind]);
      const res = await this.llm.generate(messages, { temperature: 0.95, maxTokens: 100 });
      const text = res.text.trim();
      if (!text) return null;
      if (text.length > this.cfg.safety.maxChars) {
        this.logger.warn({ len: text.length }, '主动开口超长，放弃');
        return null;
      }
      return text;
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, '主动开口生成失败');
      return null;
    }
  }

  private async emit(text: string): Promise<void> {
    if (!this.sender) {
      this.logger.warn('未绑定发送函数，丢弃主动消息');
      return;
    }
    await this.sender(text);
    this.lastProactiveAt = Date.now();
    this.hourlyCount++;
    this.state.count++;
    this.session.recordAssistant(text);
    this.session.persist(true);
  }

  /** 用户回消息时调用：清除"被无视"计数 + 取消等待回复的问候 */
  onUserReplied(): void {
    let changed = false;
    if (this.state.ignoreStreak > 0) {
      this.state.ignoreStreak = 0;
      changed = true;
    }
    // 用户回了，就不需要再撒娇催了
    if (this.state.awaitingReply) {
      this.state.awaitingReply = null;
      changed = true;
    }
    if (changed) {
      this.saveState();
      this.logger.debug('用户回复了，重置被无视计数与等待回复状态');
    }
  }

  /** 检测"被无视"：用户长时间没回，且主动消息之后没有任何回应 */
  checkIgnored(): void {
    if (this.lastProactiveAt === 0) return;
    const hoursSinceActive = (Date.now() - this.session.lastActiveAt) / 3_600_000;
    if (hoursSinceActive > 12) {
      this.state.ignoreStreak++;
      this.lastProactiveAt = 0;
      this.saveState();
      this.logger.info({ ignoreStreak: this.state.ignoreStreak }, '主动开口被无视');
    }
  }

  private formatMinute(m: number): string {
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  }
}
