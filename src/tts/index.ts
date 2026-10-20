import type { Logger } from 'pino';

/**
 * GPT-SoVITS HTTP 语音合成客户端。
 *
 * 职责：把一段中文短句交给 tts_server.py 合成 wav，取回音频字节。
 * 机器人侧用这些字节构造 OneBot 的 record 段（base64 或本地文件）发送。
 *
 * 为什么独立成一个模块：
 *   - TTS 服务是常驻 Python 进程，跨进程通过 HTTP 调用最省事。
 *   - 合成很慢（CPU 上 5-7 秒），需要独立超时与失败回退策略。
 *   - 崩溃/超时都不该影响正常文字回复（调用方决定是否回退）。
 */

export interface VoiceConfig {
  enabled: boolean;
  probability: number;
  maxChars: number;
  serverUrl: string;
  timeoutMs: number;
  fallbackToText: boolean;
  /** 语速因子：1.0 = 参考音频原速（偏慢），1.3 = 正常语速 */
  speed?: number;
}

export interface TtsResult {
  ok: boolean;
  /** wav 音频字节（合成成功时） */
  audio?: Buffer;
  /** 音频时长（秒） */
  duration?: number;
  /** 合成耗时（秒） */
  elapsed?: number;
  error?: string;
}

/** 去掉表情标记后的纯文本字数（判断要不要发语音用） */
export function speechableText(text: string): string {
  return text
    .replace(/\[(?:表情|face)\s*[:：][^\]]+\]/g, '')
    .trim();
}

export class TtsClient {
  private cfg: VoiceConfig;
  private logger: Logger;

  constructor(cfg: VoiceConfig, logger: Logger) {
    this.cfg = cfg;
    this.logger = logger;
  }

  isEnabled(): boolean {
    return this.cfg.enabled;
  }

  /** 合成失败时是否允许回退为文字 */
  shouldFallbackToText(): boolean {
    return this.cfg.fallbackToText;
  }

  /** 这条回复该不该发语音（短句 + 概率） */
  shouldVoice(text: string): boolean {
    if (!this.cfg.enabled) return false;
    const clean = speechableText(text);
    if (!clean || clean.length > this.cfg.maxChars) return false;
    return Math.random() < this.cfg.probability;
  }

  /**
   * 合成语音。失败时返回 ok:false（不抛异常），由调用方决定是否回退文字。
   */
  async synthesize(text: string): Promise<TtsResult> {
    const clean = speechableText(text);
    const started = Date.now();

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);

      let resp: Response;
      try {
        resp = await fetch(`${this.cfg.serverUrl}/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ text: clean, speed: this.cfg.speed ?? 1.3 }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!resp.ok) {
        // 400 = 没有可念的中文内容（已由服务端过滤），静默回退即可
        let detail = '';
        try { detail = (await resp.text()).slice(0, 120); } catch { /* ignore */ }
        return { ok: false, error: `TTS HTTP ${resp.status}${detail ? `: ${detail}` : ''}` };
      }

      const data = (await resp.json()) as { ok?: boolean; file?: string; duration?: number; elapsed?: number };
      if (!data?.ok || !data?.file) {
        return { ok: false, error: 'TTS 响应缺少 file 字段' };
      }

      // 下载音频字节
      const audioResp = await fetch(`${this.cfg.serverUrl}/audio/${encodeURIComponent(data.file)}`);
      if (!audioResp.ok) {
        return { ok: false, error: `下载音频失败 HTTP ${audioResp.status}` };
      }
      const audio = Buffer.from(await audioResp.arrayBuffer());

      return {
        ok: true,
        audio,
        duration: data.duration,
        elapsed: Math.round((Date.now() - started) / 100) / 10,
      };
    } catch (err) {
      const msg = (err as Error)?.name === 'AbortError'
        ? `TTS 超时（>${this.cfg.timeoutMs}ms）`
        : `TTS 异常：${(err as Error)?.message}`;
      return { ok: false, error: msg };
    }
  }
}
