import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface MoodBand {
  range: [number, number];
  /** 翻译成对 LLM 的行为指示 */
  description: string;
}

export interface IntimacyBand {
  range: [number, number];
  description: string;
}

export interface PersonaData {
  identity: {
    name: string;
    selfClaim: string;
    age: string | number;
    background: string;
    facts: string[];
    secrets: string[];
  };
  speechStyle: {
    tone: string[];
    habitWords: string[];
    longestSentence: number;
    forbidden: string[];
    emojiUsage: number;
    typoProbability: number;
  };
  mood: {
    initial: number;
    /**
     * 情绪回归速度。
     *
     * ⚠️ 刻意不做默认值：`undefined` 表示「人格档案没指定，用全局 config」。
     * 以前这里默认 0.15，结果 persona YAML 里写的 0.45 永远覆盖不掉 config，
     * 改了人格档案等于没改。
     */
    decayPerHour?: number;
    floor: number;
    ceiling: number;
    triggers: { positive: { keywords: string[]; delta: number }; negative: { keywords: string[]; delta: number } };
    bands: MoodBand[];
  };
  intimacy: {
    bands: IntimacyBand[];
  };
}

/** 解析 "[-1.0, -0.3]" 这种 key */
function parseRange(key: string): [number, number] {
  const cleaned = key.replace(/^\(/, '[').replace(/\)$/, ']');
  const m = cleaned.match(/\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/);
  if (!m) throw new Error(`无法解析区间：${key}`);
  return [parseFloat(m[1]), parseFloat(m[2])];
}

function parseBands(raw: Record<string, string> | undefined): { range: [number, number]; description: string }[] {
  if (!raw) return [];
  return Object.entries(raw).map(([k, v]) => ({ range: parseRange(k), description: String(v) }));
}

export function loadPersona(dir: string, name: string): PersonaData {
  const file = path.resolve(dir, `${name}.yaml`);
  if (!fs.existsSync(file)) throw new Error(`找不到人格档案：${file}`);
  const raw = parseYaml(fs.readFileSync(file, 'utf8')) as any;

  return {
    identity: {
      name: raw.identity?.name ?? '大肥鱼',
      selfClaim: raw.identity?.selfClaim ?? '鲸娘',
      age: raw.identity?.age ?? '',
      background: String(raw.identity?.background ?? '').trim(),
      facts: raw.identity?.facts ?? [],
      secrets: raw.identity?.secrets ?? [],
    },
    speechStyle: {
      tone: raw.speechStyle?.tone ?? [],
      habitWords: raw.speechStyle?.habitWords ?? [],
      longestSentence: raw.speechStyle?.longestSentence ?? 30,
      forbidden: raw.speechStyle?.forbidden ?? [],
      emojiUsage: raw.speechStyle?.emojiUsage ?? 0.3,
      typoProbability: raw.speechStyle?.typoProbability ?? 0.05,
    },
    mood: {
      initial: raw.mood?.initial ?? 0,
      // 不写 ?? 0.15 —— 让「没配置」保持 undefined，由调用方回退到全局 config。
      decayPerHour: typeof raw.mood?.decayPerHour === 'number' ? raw.mood.decayPerHour : undefined,
      floor: raw.mood?.floor ?? -0.6,
      ceiling: raw.mood?.ceiling ?? 0.6,
      triggers: {
        positive: {
          keywords: raw.mood?.triggers?.positive?.keywords ?? [],
          delta: raw.mood?.triggers?.positive?.delta ?? 0.15,
        },
        negative: {
          keywords: raw.mood?.triggers?.negative?.keywords ?? [],
          delta: raw.mood?.triggers?.negative?.delta ?? -0.2,
        },
      },
      bands: parseBands(raw.mood?.bands),
    },
    intimacy: {
      bands: parseBands(raw.intimacy?.bands),
    },
  };
}

export function bandFor<T extends { range: [number, number]; description: string }>(bands: T[], value: number): string {
  for (const b of bands) {
    const [lo, hi] = b.range;
    if (value >= lo && value <= hi) return b.description;
  }
  return '';
}

/** 根据关键词推导情绪增量 */
export function moodDeltaFromText(persona: PersonaData, text: string): number {
  const t = text.toLowerCase();
  let delta = 0;
  if (persona.mood.triggers.positive.keywords.some((k) => t.includes(k.toLowerCase()))) {
    delta += persona.mood.triggers.positive.delta;
  }
  if (persona.mood.triggers.negative.keywords.some((k) => t.includes(k.toLowerCase()))) {
    delta += persona.mood.triggers.negative.delta;
  }
  return delta;
}

/** 情绪随时间的自然回归 */
export function decayMood(current: number, elapsedMs: number, decayPerHour: number, floor: number, ceiling: number): number {
  const hours = elapsedMs / 3600000;
  const next = current * Math.max(0, 1 - decayPerHour * hours);
  return clamp(next, floor, ceiling);
}

/** 亲密度衰减（长期不聊） */
export function decayIntimacy(current: number, daysSinceActive: number, decayPerDay: number, decayAfterDays: number): number {
  if (daysSinceActive <= decayAfterDays) return current;
  const excess = daysSinceActive - decayAfterDays;
  return clamp(current - excess * decayPerDay, 0, 1);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
