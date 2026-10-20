import type { Logger } from 'pino';
import type { Store } from '../store/db';
import {
  loadPersona,
  bandFor,
  moodDeltaFromText,
  decayMood,
  decayIntimacy,
  clamp,
  type PersonaData,
} from '../persona';

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
  at: number;
}

export interface SessionConfig {
  sessionId: string;
  peerId: string;
  shortTermLimit: number;
  moodDecayPerHour: number;
  moodFloor: number;
  moodCeiling: number;
  intimacy: {
    enabled: boolean;
    perExchange: number;
    decayPerDay: number;
    decayAfterDays: number;
    max: number;
  };
}

/**
 * 单会话状态机。纯私聊场景只有一个实例，但状态必须持久化：
 * 崩溃重启后情绪和关系不能归零。
 */
export class Session {
  readonly sessionId: string;
  readonly peerId: string;

  shortTerm: Turn[] = [];
  rollingSummary = '';

  mood: number;
  intimacy: number;
  proactiveIgnoreStreak = 0;

  lastActiveAt = 0;
  lastAssistantReplyAt = 0;
  lastMoodUpdateAt = Date.now();
  lastPersistAt = 0;

  isGenerating = false;
  private lockQueue: Array<() => void> = [];
  private persona: PersonaData;
  private cfg: SessionConfig;
  private store: Store;
  private logger: Logger;
  private turnsSinceExtract = 0;

  constructor(cfg: SessionConfig, store: Store, persona: PersonaData, logger: Logger) {
    this.cfg = cfg;
    this.store = store;
    this.logger = logger;
    this.sessionId = cfg.sessionId;
    this.peerId = cfg.peerId;
    this.persona = persona;

    const rec = store.getSession(cfg.sessionId);
    if (rec) {
      this.mood = rec.mood;
      this.intimacy = rec.intimacy;
      this.rollingSummary = rec.rollingSummary;
      this.lastActiveAt = rec.lastActiveAt;
      this.proactiveIgnoreStreak = rec.proactiveIgnoreStreak;

      // 恢复短期上下文
      this.shortTerm = store.recentChats(cfg.sessionId, cfg.shortTermLimit).map((m) => ({
        role: m.role,
        content: m.content,
        at: m.at,
      }));

      // 离线期间的情绪衰减与关系衰减
      const now = Date.now();
      const idleMs = now - (rec.lastActiveAt || now);
      if (idleMs > 60000) {
        const before = this.mood;
        this.mood = decayMood(this.mood, idleMs, cfg.moodDecayPerHour, cfg.moodFloor, cfg.moodCeiling);
        const daysIdle = idleMs / 86400000;
        this.intimacy = decayIntimacy(this.intimacy, daysIdle, cfg.intimacy.decayPerDay, cfg.intimacy.decayAfterDays);
        if (Math.abs(before - this.mood) > 0.01) {
          this.logger.debug({ from: before, to: this.mood }, '离线期间情绪已自然回归');
        }
      }
      this.logger.info({ intimacy: this.intimacy.toFixed(2), mood: this.mood.toFixed(2), turns: this.shortTerm.length }, '已恢复会话状态');
    } else {
      this.mood = persona.mood.initial;
      this.intimacy = 0;
      this.logger.info('首次会话，初始化人格状态');
    }
    this.lastMoodUpdateAt = Date.now();
  }

  getPersona(): PersonaData {
    return this.persona;
  }

  /** 当前情绪对应的行为描述 */
  moodDescription(): string {
    return bandFor(this.persona.mood.bands, this.mood) || '情绪中性';
  }

  /** 当前亲密度对应的行为描述 */
  intimacyDescription(): string {
    return bandFor(this.persona.intimacy.bands, this.intimacy) || '关系未知';
  }

  /** 获取生成锁，防止并发回复 */
  async acquireLock(): Promise<() => void> {
    if (!this.isGenerating) {
      this.isGenerating = true;
      return () => this.releaseLock();
    }
    // 排队
    await new Promise<void>((resolve) => this.lockQueue.push(resolve));
    return () => this.releaseLock();
  }

  private releaseLock(): void {
    const next = this.lockQueue.shift();
    if (next) {
      next(); // isGenerating 保持 true，交给下一个
    } else {
      this.isGenerating = false;
    }
  }

  /** 记录用户发来的一条消息 */
  recordUser(text: string): void {
    const now = Date.now();
    this.shortTerm.push({ role: 'user', content: text, at: now });
    this.trimShortTerm();
    this.lastActiveAt = now;
    this.store.logChat(this.sessionId, 'user', text);
    this.store.upsertUserProfile(this.peerId, '对方');

    // 情绪更新
    this.updateMood(text);

    // 关系推进
    if (this.cfg.intimacy.enabled) {
      this.intimacy = clamp(this.intimacy + this.cfg.intimacy.perExchange, 0, this.cfg.intimacy.max);
    }

    // 被回复说明对方没无视她
    this.proactiveIgnoreStreak = 0;
  }

  /** 记录助手回复 */
  recordAssistant(text: string, meta?: { tokens?: number; latencyMs?: number }): void {
    const now = Date.now();
    this.shortTerm.push({ role: 'assistant', content: text, at: now });
    this.trimShortTerm();
    this.lastAssistantReplyAt = now;
    this.lastActiveAt = now;
    this.store.logChat(this.sessionId, 'assistant', text, meta);
    this.turnsSinceExtract += 1;
  }

  /** 是否需要触发记忆抽取 */
  shouldExtract(): boolean {
    return this.turnsSinceExtract >= 8;
  }

  markExtracted(): void {
    this.turnsSinceExtract = 0;
  }

  private updateMood(text: string): void {
    // 先做时间衰减
    const now = Date.now();
    const elapsed = now - this.lastMoodUpdateAt;
    this.mood = decayMood(this.mood, elapsed, this.cfg.moodDecayPerHour, this.cfg.moodFloor, this.cfg.moodCeiling);

    const delta = moodDeltaFromText(this.persona, text);
    if (delta !== 0) {
      this.mood = clamp(this.mood + delta, this.cfg.moodFloor, this.cfg.moodCeiling);
      this.logger.debug({ delta, mood: this.mood.toFixed(2) }, '情绪变化');
    }
    this.lastMoodUpdateAt = now;
  }

  private trimShortTerm(): void {
    if (this.shortTerm.length <= this.cfg.shortTermLimit) return;
    const overflow = this.shortTerm.length - this.cfg.shortTermLimit;
    const dropped = this.shortTerm.splice(0, overflow);
    // 被顶掉的内容并入滚动摘要的"待压缩"队列由上层处理
    this.logger.debug({ dropped: dropped.length }, '短期上下文溢出，等待摘要压缩');
  }

  /** 取出最旧的 N 条用于摘要压缩 */
  takeOldestForSummary(count: number): Turn[] {
    return this.shortTerm.slice(0, count);
  }

  /** 应用新的滚动摘要 */
  setRollingSummary(summary: string): void {
    this.rollingSummary = summary;
    this.persist();
  }

  persist(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastPersistAt < 30000) return;
    this.lastPersistAt = now;
    this.store.saveSession({
      sessionId: this.sessionId,
      intimacy: this.intimacy,
      mood: this.mood,
      rollingSummary: this.rollingSummary,
      summaryUpdatedAt: this.rollingSummary ? now : 0,
      lastActiveAt: this.lastActiveAt || now,
      proactiveIgnoreStreak: this.proactiveIgnoreStreak,
    });
  }
}

export function createSession(
  seed: { sessionId: string; peerId: string },
  cfg: Omit<SessionConfig, 'sessionId' | 'peerId'>,
  store: Store,
  personaDir: string,
  personaName: string,
  logger: Logger,
): Session {
  const persona = loadPersona(personaDir, personaName);
  return new Session({ ...cfg, ...seed }, store, persona, logger);
}
