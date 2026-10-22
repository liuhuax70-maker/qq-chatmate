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
  /** 唱歌（念歌词）功能 */
  sing?: {
    enabled: boolean;
    /** 你要求她唱时的触发词 */
    keywords: string[];
    /** 她自己想唱的概率（每天最多一次，由调用方控制） */
    probability: number;
  };
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

/** 最小 WAV 解析：取出 16-bit PCM 数据和采样率 */
export function parseWav(buf: Buffer): { pcm: Buffer; sampleRate: number; channels: number } | null {
  try {
    if (buf.length < 44) return null;
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;

    let pos = 12;
    let sampleRate = 24000;
    let channels = 1;
    let pcm: Buffer | null = null;

    while (pos + 8 <= buf.length) {
      const id = buf.toString('ascii', pos, pos + 4);
      const size = buf.readUInt32LE(pos + 4);
      const body = pos + 8;
      if (id === 'fmt ') {
        channels = buf.readUInt16LE(body + 2);
        sampleRate = buf.readUInt32LE(body + 4);
      } else if (id === 'data') {
        pcm = buf.subarray(body, body + size);
      }
      pos = body + size + (size % 2); // chunk 按 2 字节对齐
    }
    if (!pcm) return null;
    return { pcm: Buffer.from(pcm), sampleRate, channels };
  } catch {
    return null;
  }
}

/** 最小 WAV 封装：16-bit PCM */
export function buildWav(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const byteRate = sampleRate * channels * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);        // fmt chunk size
  header.writeUInt16LE(1, 20);         // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32); // block align
  header.writeUInt16LE(16, 34);        // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
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

  /**
   * 快速探测 TTS 服务是否在线（1 秒超时）。
   *
   * 为什么需要：TTS 没启动时，合成请求会一直等到 timeoutMs（60 秒）
   * 才失败，用户在那边干等一分钟才收到文字回复。
   * 触发语音前先用这个做一次秒级探测，不可用就直接跳过语音。
   */
  async isServerReady(): Promise<boolean> {
    if (!this.cfg.enabled) return false;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1000);
      try {
        const resp = await fetch(`${this.cfg.serverUrl}/health`, { signal: ctrl.signal });
        return resp.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  /** 这条回复该不该发语音（短句 + 概率） */
  shouldVoice(text: string): boolean {
    if (!this.cfg.enabled) return false;
    const clean = speechableText(text);
    if (!clean || clean.length > this.cfg.maxChars) return false;
    return Math.random() < this.cfg.probability;
  }

  /**
   * 该不该唱歌。
   * 触发条件（满足任一）：
   *   1. 你的原话里有明确的演唱要求（唱/唱歌/来一首/唱首歌…）
   *   2. 她自己想唱（低概率，且需要回复里有可分行的歌词）
   */
  shouldSing(userText: string, replyText: string): boolean {
    const s = this.cfg.sing;
    if (!this.cfg.enabled || !s?.enabled) return false;

    // 你明确要求
    if (s.keywords.some((k) => userText.includes(k))) return true;

    // 她自己想唱：低概率 + 回复里有换行（说明她在写歌词）
    if (replyText.includes('\n') && Math.random() < s.probability) return true;

    return false;
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
          body: JSON.stringify({ text: clean, speed: this.cfg.speed ?? 1.6 }),
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

  /**
   * 念歌词：逐行合成，中间插入静音间隔，最后拼成一条完整音频。
   *
   * 不是真唱——是用她的音色把歌词有节奏地念出来。
   * 之所以逐行合成而不是一次说完：一次合成的长文本会被 TTS 内部按标点切碎，
   * 节奏不可控；逐行合成能让每行之间有稳定的停顿，更像"念词"。
   */
  async synthesizeSong(lyrics: string, opts?: { speed?: number; gapMs?: number }): Promise<TtsResult> {
    const started = Date.now();
    const lines = lyrics
      .split(/\r?\n/)
      .map((l) => speechableText(l))
      .filter((l) => l.length > 0)
      .slice(0, 8); // 一次最多 8 行，太长合成太久

    if (lines.length === 0) return { ok: false, error: 'no lyrics to sing' };

    const speed = opts?.speed ?? 1.0; // 念歌词用较慢速度，更有节奏感
    const gapMs = opts?.gapMs ?? 350;

    try {
      // 逐行合成
      const parts: Buffer[] = [];
      let totalDur = 0;
      let sr = 24000;

      for (const line of lines) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
        let resp: Response;
        try {
          resp = await fetch(`${this.cfg.serverUrl}/tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ text: line, speed, text_lang: 'zh' }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        if (!resp.ok) {
          return { ok: false, error: `TTS HTTP ${resp.status} (line: ${line.slice(0, 12)})` };
        }
        const data = (await resp.json()) as { ok?: boolean; file?: string; duration?: number };
        if (!data?.ok || !data?.file) return { ok: false, error: 'TTS 响应缺少 file 字段' };

        const audioResp = await fetch(`${this.cfg.serverUrl}/audio/${encodeURIComponent(data.file)}`);
        if (!audioResp.ok) return { ok: false, error: `下载音频失败 HTTP ${audioResp.status}` };

        const wav = Buffer.from(await audioResp.arrayBuffer());
        const parsed = parseWav(wav);
        if (!parsed) return { ok: false, error: 'wav 解析失败' };
        sr = parsed.sampleRate;
        parts.push(parsed.pcm);
        totalDur += parsed.pcm.length / 2 / sr;
      }

      // 行间插入静音
      const gapSamples = Math.floor((sr * gapMs) / 1000) * 2; // 16-bit = 2 bytes
      const gap = Buffer.alloc(gapSamples);
      const joined: Buffer[] = [];
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) joined.push(gap);
        joined.push(parts[i]);
      }
      const pcm = Buffer.concat(joined);

      // 重新包成 wav
      const audio = buildWav(pcm, sr);
      const dur = pcm.length / 2 / sr + (gapMs * (lines.length - 1)) / 1000;

      return {
        ok: true,
        audio,
        duration: Math.round(dur * 100) / 100,
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
