import type { Logger } from 'pino';
import type { Session } from '../session';
import type { PersonaData } from '../persona';
import { maybeInjectEmoji, parseEmojiMarkers, type ParsedSegment } from './emoji';
import { StickerLibrary, inferScene } from './stickers';

export interface ResponderConfig {
  typing: { baseMs: number; perCharMs: number; jitter: number; maxMs: number };
  split: { enabled: boolean; minCharsToSplit: number; maxCharsPerMessage: number; pauseMsMin: number; pauseMsMax: number };
  typo: { enabled: boolean; probability: number };
  maxChars: number;
}

export interface PostProcessResult {
  text: string;
  /** 是否触发重写 */
  needRetry: boolean;
  reason?: string;
}

/**
 * 后处理：人格一致性校验 + 长度控制。
 * 这是防止 LLM 偶尔"客服化"的兜底。
 */
export class PostProcessor {
  private cfg: ResponderConfig;
  private persona: PersonaData;
  private logger: Logger;
  /** 收藏表情包库（可选，注入后才会发贴纸） */
  private stickers?: StickerLibrary;

  constructor(cfg: ResponderConfig, persona: PersonaData, logger: Logger, stickers?: StickerLibrary) {
    this.cfg = cfg;
    this.persona = persona;
    this.logger = logger;
    this.stickers = stickers;
  }

  process(raw: string): PostProcessResult {
    let text = raw.trim();

    // 去掉模型可能带出的 markdown 包裹
    text = text.replace(/^```[\s\S]*?\n/, '').replace(/\n```$/, '').trim();
    // 去掉引号包裹
    text = text.replace(/^["'“”「」](.*)["'“”「」]$/s, '$1').trim();

    if (!text) {
      return { text: '', needRetry: true, reason: '空回复' };
    }

    // 人格禁用表达
    const hitForbidden = this.persona.speechStyle.forbidden.find((f) => text.includes(f));
    if (hitForbidden) {
      this.logger.warn({ hit: hitForbidden }, '回复命中禁用表达，触发重写');
      return { text, needRetry: true, reason: `禁用表达：${hitForbidden}` };
    }

    // 长度超限
    if (text.length > this.cfg.maxChars) {
      this.logger.warn({ len: text.length, max: this.cfg.maxChars }, '回复超长，触发重写');
      return { text, needRetry: true, reason: '超长' };
    }

    // 表情注入：按 emojiUsage 概率给情绪句加一个 QQ 小黄脸
    text = maybeInjectEmoji(text, this.persona.speechStyle.emojiUsage);

    return { text, needRetry: false };
  }

  /** 把带表情标记的文本解析成 OneBot 消息段 */
  toSegments(text: string): ParsedSegment[] {
    return parseEmojiMarkers(text);
  }

  /**
   * 决定这条回复要不要附一张收藏表情包。
   *
   * 修正记录：
   *   原来只对 <=15 字的回复、且 25% 概率才发。
   *   实测她的回复常常 15-20 字，加上 25% 的概率，几乎永远轮不到。
   *
   *   现在：放宽到 25 字，并区分"强烈该发"和"随机发"两种情形。
   */
  pickStickerFor(text: string, probability: number): { url: string } | null {
    if (!this.stickers || this.stickers.count() === 0) return null;

    // 去掉表情标记再判断长度，避免 [表情:xxx] 占字数
    const clean = text.replace(/\[(?:表情|face)\s*[:：][^\]]+\]/g, '').trim();
    if (clean.length > 25) return null;

    const scene = inferScene(clean);

    // 情绪明确的场景 → 高概率附加（这类句子天然适合配图）
    const strongScenes: typeof scene[] = ['annoyed', 'sleepy', 'happy', 'sad'];
    const effectiveProb = strongScenes.includes(scene) ? Math.min(0.85, probability * 2.5) : probability;

    if (Math.random() >= effectiveProb) return null;

    const s = this.stickers.pick(scene);
    if (!s) return null;
    this.logger.info({ scene, prob: effectiveProb.toFixed(2), len: clean.length }, '附加收藏表情包');
    return { url: s.url };
  }

  /** 计算打字延迟 */
  typingDelayMs(textLength: number): number {
    const { baseMs, perCharMs, jitter, maxMs } = this.cfg.typing;
    const raw = baseMs + textLength * perCharMs;
    const j = 1 + (Math.random() * 2 - 1) * jitter;
    return Math.min(Math.round(raw * j), maxMs);
  }

  /**
   * 把回复拆成多条消息。
   *
   * 设计演进：
   *   第一版：纯粹按字数切（超过 60 字就切）—— 切出来的句子往往半截，很不像人。
   *   现在：优先按【语义】拆，最多两条。
   *
   * 拆的优先级：
   *   1. 用户自己用换行分隔的（模型按 prompt 约定可以换行表示分成两条）
   *   2. 出现明显转折（但是 / 不过 / 算了 / 其实）且前后都够长
   *   3. 实在太长（超过 2 倍上限）才机械切
   */
  split(text: string): string[] {
    const s = this.cfg.split;
    if (!s.enabled) return [text];

    // 1) 模型已经用换行分好了
    if (text.includes('\n')) {
      const lines = text
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean);
      if (lines.length > 1) return lines.slice(0, 3); // 最多三条
    }

    // 2) 很短的一句话直接返回，不折腾
    //    12 字以内（"嗯"、"懒得动"、"行吧就这样"）硬拆只会显得碎。
    if (text.length <= 12) return [text];

    // 3) 找转折点拆成两条
    const turnWords = ['但是', '不过', '算了', '其实', '对了', '还有'];
    for (const w of turnWords) {
      const idx = text.indexOf(w);
      // 转折词要在句子中间靠后位置，前后都够长度，拆出来才自然。
      if (idx >= 5 && idx <= text.length - 6) {
        const a = text.slice(0, idx).trim();
        const b = text.slice(idx).trim();
        if (a.length >= 4 && b.length >= 4 && a.length <= s.maxCharsPerMessage && b.length <= s.maxCharsPerMessage) {
          return [a, b];
        }
      }
    }

    // 4) 没超过单条上限就不拆了
    if (text.length <= s.maxCharsPerMessage) return [text];

    // 4) 按标点找最接近中间的断点
    let bestCut = -1;
    const mid = Math.floor(text.length / 2);
    for (let i = mid; i > mid - 12; i--) {
      if ('。！？'.includes(text[i])) {
        bestCut = i + 1;
        break;
      }
    }
    if (bestCut > 0) {
      const a = text.slice(0, bestCut).trim();
      const b = text.slice(bestCut).trim();
      if (b && a.length <= s.maxCharsPerMessage * 2 && b.length <= s.maxCharsPerMessage * 2) {
        return [a, b];
      }
    }

    // 5) 兜底：机械切
    const parts: string[] = [];
    let remaining = text;
    while (remaining.length > s.maxCharsPerMessage) {
      let cut = -1;
      for (let i = s.maxCharsPerMessage; i > s.maxCharsPerMessage * 0.5; i--) {
        if ('。！？；，\n'.includes(remaining[i])) {
          cut = i + 1;
          break;
        }
      }
      if (cut === -1) cut = s.maxCharsPerMessage;
      parts.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut).trim();
    }
    if (remaining) parts.push(remaining);
    return parts.filter(Boolean).slice(0, 3);
  }

  /** 段间停顿 */
  segmentPauseMs(): number {
    const { pauseMsMin, pauseMsMax } = this.cfg.split;
    return pauseMsMin + Math.random() * (pauseMsMax - pauseMsMin);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
