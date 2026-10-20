import type { Logger } from 'pino';
import type { Store } from '../store/db';

export interface SleepConfig {
  sleepWindow: [number, number];
  /** 道晚安之后还有多久才真正睡着（分钟） */
  awakeAfterGoodnightMinutes: number;
  /** 睡着后是否完全不回消息 */
  hardSleep: boolean;
  /** 被吵醒后需要多久才能真正回消息（分钟区间） */
  wakeUpDelayMinutes: [number, number];
  /** 被吵醒后多久重新睡着（分钟）。超过就继续睡，不回 */
  stayAwakeMinutes: number;
}

/** 睡眠中的哪一段 */
export type SleepPhase =
  /** 清醒 */
  | 'awake'
  /** 说过晚安，还没睡着 */
  | 'drowsy'
  /** 深度睡眠，不会回任何消息 */
  | 'asleep'
  /** 被吵醒中，正在缓过来，还不能正常说话 */
  | 'waking'
  /** 被吵醒后短暂清醒，可以聊 */
  | 'awake-after-wake';

export interface SleepState {
  goodnightSent: boolean;
  goodnightAt: number;
  /** 真正睡着的时刻 */
  sleepAt: number;
  /** 醒来时刻（自然醒） */
  wakeAt: number;
  sleeping: boolean;
  /** 被吵醒的时刻（0 = 没被吵醒过） */
  wokenAt: number;
  /** 被吵醒后能开始回复的时刻 */
  wakeUpReadyAt: number;
  /** 被吵醒后重新睡着的时刻 */
  backToSleepAt: number;
  /** 被吵醒的累计次数（吵太多次会影响第二天） */
  wakeCount: number;
  day: string;
  /** 睡眠期间收到的消息 */
  nightMessages: Array<{ text: string; at: number }>;
}

const STORAGE_KEY = 'sleep_state_v2';

/**
 * 睡眠状态机（第二版）。
 *
 * 规则（用户指定）：
 *   00:00 - 02:00  任意时刻说晚安
 *         ↓
 *   30 分钟内        还醒着，正常回（半睡半醒）
 *         ↓
 *   30 分钟后        睡着
 *         ↓
 *   ┌─────────────────────────────────────┐
 *   │ 如果没人吵她：一直睡到自然醒          │
 *   │                                     │
 *   │ 如果被吵：她会被吵醒，但需要时间缓过来 │
 *   │   · 先沉默几分钟（起床需要时间）      │
 *   │   · 然后才回你，而且带着起床气        │
 *   │   · 聊一会儿之后重新睡着              │
 *   └─────────────────────────────────────┘
 *
 * 设计要点：**"被吵醒"不是瞬间完成的。**
 * 真人被半夜吵醒，不会立刻清醒地聊天——
 * 得先迷糊一会儿，说话也带着困意和脾气。
 */
export class SleepStateMachine {
  private cfg: SleepConfig;
  private store: Store;
  private logger: Logger;
  private state: SleepState;

  constructor(cfg: SleepConfig, store: Store, logger: Logger) {
    this.cfg = cfg;
    this.store = store;
    this.logger = logger;
    this.state = this.loadState();
  }

  private todayKey(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  private loadState(): SleepState {
    const fresh: SleepState = {
      goodnightSent: false,
      goodnightAt: 0,
      sleepAt: 0,
      wakeAt: 0,
      sleeping: false,
      wokenAt: 0,
      wakeUpReadyAt: 0,
      backToSleepAt: 0,
      wakeCount: 0,
      day: this.todayKey(),
      nightMessages: [],
    };
    try {
      const raw = this.store.getKv(STORAGE_KEY);
      if (!raw) return fresh;
      const saved = JSON.parse(raw) as SleepState;
      return { ...fresh, ...saved };
    } catch {
      return fresh;
    }
  }

  private saveState(): void {
    this.store.setKv(STORAGE_KEY, JSON.stringify(this.state));
  }

  // ── 状态判定 ────────────────────────────────────────────

  /** 当前处于哪个阶段 */
  phase(): SleepPhase {
    this.refresh();
    const now = Date.now();

    if (!this.state.goodnightSent) return 'awake';

    // 深度睡眠中
    if (this.state.sleeping) {
      if (this.state.wokenAt > 0) {
        if (now < this.state.wakeUpReadyAt) return 'waking';
        if (now < this.state.backToSleepAt) return 'awake-after-wake';
        // 超过清醒期，重新睡着
        return 'asleep';
      }
      return 'asleep';
    }

    // 说过晚安但还没睡着
    if (this.state.sleepAt > now) return 'drowsy';

    return 'awake';
  }

  /** 现在能不能回消息 */
  canReply(): boolean {
    const p = this.phase();
    return p !== 'asleep' && p !== 'waking';
  }

  /**
   * 用户发来消息。
   * 返回 { respond, delayMs, reason }
   *   respond=false → 这条不回（可以记下来）
   *   respond=true  → 回，但可能要先延迟 delayMs（被吵醒的情况）
   */
  onUserMessage(text: string): { respond: boolean; delayMs: number; reason: string } {
    this.refresh();
    const p = this.phase();

    if (p === 'asleep') {
      // 被吵醒：进入 waking 阶段，需要缓一会儿
      const now = Date.now();
      const [minD, maxD] = this.cfg.wakeUpDelayMinutes;
      const delayMin = minD + Math.random() * (maxD - minD);

      this.state.wokenAt = now;
      this.state.wakeUpReadyAt = now + delayMin * 60_000;
      this.state.backToSleepAt = now + (delayMin + this.cfg.stayAwakeMinutes) * 60_000;
      this.state.wakeCount += 1;
      this.state.nightMessages.push({ text, at: now });
      if (this.state.nightMessages.length > 20) this.state.nightMessages.shift();
      this.saveState();

      this.logger.info(
        { delayMinutes: delayMin.toFixed(1), wakeCount: this.state.wakeCount },
        '半夜被吵醒，需要时间缓过来',
      );

      // 这一条不回（还在迷糊），等 wakeUpReadyAt 之后的消息才会正常处理
      return { respond: false, delayMs: 0, reason: 'waking-up' };
    }

    if (p === 'waking') {
      // 正在缓，还是不理
      this.state.nightMessages.push({ text, at: Date.now() });
      this.saveState();
      return { respond: false, delayMs: 0, reason: 'still-waking' };
    }

    return { respond: true, delayMs: 0, reason: p };
  }

  /**
   * 当前状态摘要（给 prompt 用）。
   *
   * 注意：这里只描述**处境**，不规定**态度**。
   *
   * 态度应该由她自己决定——取决于此刻的心情、跟对方的交情、以及被吵醒了几次。
   * 同样是半夜被吵醒，心情好可能是"……怎么了"，心情差可能是"你最好有事"。
   * 把态度写死，她就变成了念台词的。
   */
  describe(): string {
    const p = this.phase();
    switch (p) {
      case 'drowsy': {
        const left = Math.max(0, Math.round((this.state.sleepAt - Date.now()) / 60000));
        return `刚说了晚安，人还醒着，但已经很困了（大概 ${left} 分钟后会睡过去）`;
      }
      case 'asleep':
        return '你在睡觉的时候被消息声音吵到了，人还没醒透';
      case 'waking':
        return `你刚从睡梦里被吵醒，脑子还是糊的（今晚已经被吵醒 ${this.state.wakeCount} 次了）`;
      case 'awake-after-wake':
        return `你被吵醒了，能睁开眼说话，但还很困（今晚已经被吵醒 ${this.state.wakeCount} 次）`;
      default:
        return '清醒';
    }
  }

  isSleeping(): boolean {
    return this.phase() === 'asleep';
  }

  getWakeAt(): number {
    this.refresh();
    return this.state.wakeAt;
  }

  /** 被吵醒过几次（影响第二天的起床气） */
  getWakeCount(): number {
    return this.state.wakeCount;
  }

  /** 取走并清空夜里的消息 */
  drainNightMessages(): Array<{ text: string; at: number }> {
    const msgs = this.state.nightMessages.slice();
    this.state.nightMessages = [];
    this.saveState();
    return msgs;
  }

  // ── 状态推进 ────────────────────────────────────────────

  onGoodnightSent(): void {
    const now = Date.now();
    this.state.goodnightSent = true;
    this.state.goodnightAt = now;
    this.state.sleepAt = now + this.cfg.awakeAfterGoodnightMinutes * 60_000;
    this.state.sleeping = false;
    this.state.wakeAt = 0;
    this.state.wokenAt = 0;
    this.state.wakeUpReadyAt = 0;
    this.state.backToSleepAt = 0;
    this.state.day = this.todayKey();
    this.saveState();
    this.logger.info({ bufferMinutes: this.cfg.awakeAfterGoodnightMinutes }, '已道晚安，进入半睡半醒期');
  }

  /**
   * 决定她要睡多久。
   * 不读固定配置——按自己的睡眠时长算，每天不一样。
   */
  private decideSleepDurationMs(goodnightAt: number): number {
    const hour = new Date(goodnightAt).getHours();
    let hours = 6.5 + Math.random() * 2;

    if (hour >= 1 && hour < 6) hours += 0.3 + Math.random() * 0.9;
    else if (hour === 0 && new Date(goodnightAt).getMinutes() < 30) hours -= 0.2 + Math.random() * 0.4;

    const roll = Math.random();
    if (roll < 0.05) hours += 1 + Math.random();
    else if (roll < 0.1) hours -= 0.8 + Math.random() * 0.7;

    return Math.round(Math.max(5, Math.min(11, hours)) * 3_600_000);
  }

  /** 每次调用时推进状态 */
  refresh(): void {
    const now = Date.now();

    // 半睡半醒 → 睡着
    if (!this.state.sleeping && this.state.goodnightSent && this.state.sleepAt > 0 && now >= this.state.sleepAt) {
      if (this.cfg.hardSleep) {
        this.state.sleeping = true;
        const durationMs = this.decideSleepDurationMs(this.state.goodnightAt);
        this.state.wakeAt = this.state.sleepAt + durationMs;
        // 没被吵醒过的话，wokenAt 保持 0
        this.state.wokenAt = 0;
        this.state.wakeUpReadyAt = 0;
        this.state.backToSleepAt = 0;
        this.saveState();
        const wakeDate = new Date(this.state.wakeAt);
        this.logger.info(
          {
            sleepHours: (durationMs / 3_600_000).toFixed(1),
            wakeAt: `${String(wakeDate.getHours()).padStart(2, '0')}:${String(wakeDate.getMinutes()).padStart(2, '0')}`,
          },
          '睡着',
        );
      }
    }

    // 被吵醒后聊完了 → 重新睡着
    if (this.state.sleeping && this.state.backToSleepAt > 0 && now >= this.state.backToSleepAt) {
      this.state.wokenAt = 0;
      this.state.wakeUpReadyAt = 0;
      this.state.backToSleepAt = 0;
      this.saveState();
      this.logger.info('重新睡着了');
    }

    // 自然醒
    if (this.state.sleeping && this.state.wakeAt > 0 && now >= this.state.wakeAt && this.state.backToSleepAt === 0) {
      this.resetAfterWake();
      this.logger.info('自然醒了');
    }
  }

  /** 手动强制醒来（测试用） */
  forceWake(): void {
    this.resetAfterWake();
    this.saveState();
  }

  private resetAfterWake(): void {
    this.state.sleeping = false;
    this.state.goodnightSent = false;
    this.state.goodnightAt = 0;
    this.state.sleepAt = 0;
    this.state.wakeAt = 0;
    this.state.wokenAt = 0;
    this.state.wakeUpReadyAt = 0;
    this.state.backToSleepAt = 0;
    this.state.day = this.todayKey();
  }
}
