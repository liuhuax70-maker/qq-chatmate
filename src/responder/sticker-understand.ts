/**
 * 表情包语义理解。
 *
 * 问题：原来的 extractMeaning 是纯关键词匹配——
 *   用户说"嘲讽你"匹配不到词表，"阴阳怪气"也匹配不到，
 *   但这些明明是很明确的表情含义。结果就是记住了却"没真懂"。
 *
 * 方案：让 LLM 参与理解。它本来就在线，解析一句"这张图啥意思"
 *   比硬编码词表靠谱得多，而且能处理任何说法。
 *
 * 设计约束：
 *   1. LLM 不可用时回退到关键词匹配（不能让学习功能整个挂掉）
 *   2. 输出必须是结构化 JSON，解析失败就走回退
 *   3. 场景标签固定，不让模型自由发挥——否则 pickByScene 匹配不上
 */

import type { Logger } from 'pino';
import type { LLMClient } from '../brain/llm';

/** 固定的场景枚举，和 stickers.ts 的 StickerScene 保持一致 */
export const SCENE_LIST = [
  'happy',    // 开心、笑、得意
  'annoyed',  // 无语、嫌弃、翻白眼
  'angry',    // 生气、火大
  'sad',      // 委屈、难过、哭
  'sleepy',   // 困、累、想睡
  'hungry',   // 饿、馋、想吃
  'confused', // 疑惑、不懂、问号
  'shy',      // 害羞、脸红
  'proud',    // 得意、牛、厉害
  'generic',  // 说不清、通用
] as const;

export type Scene = (typeof SCENE_LIST)[number];

export interface StickerMeaning {
  /** 一句话概括这张图的含义，用于日志和 prompt */
  meaning: string;
  /** 命中的场景（可多个） */
  scenes: Scene[];
  /** LLM 给的置信度，低于阈值建议再问一次 */
  confidence: number;
  /** 来自 llm 还是 fallback */
  source: 'llm' | 'fallback';
}

/**
 * 用 LLM 理解用户对表情的描述。
 *
 * 输入是用户的自然语言回答（"嘲讽你"、"我无语了"、"就是笑一下"），
 * 输出是结构化的含义 + 场景。
 */
export async function understandSticker(
  userReply: string,
  llm: LLMClient | null,
  logger: Logger,
): Promise<StickerMeaning | null> {
  const t = userReply.trim();
  if (!t) return null;

  // 明显拒绝 / 无信息量的直接返回 null，不浪费 token
  if (/^(不知道|不清楚|忘了|随便|没啥|没有|不记得|不想说|没什么|就那样)$/.test(t)) {
    return null;
  }
  if (/^(哈+|呵+|嘿+|嗯+|哦+|啊+|呃+|额+|emm+|草)+$/.test(t)) {
    return null;
  }

  // 没有 LLM 就走关键词回退
  if (!llm) return fallbackUnderstand(t, logger);

  try {
    const prompt = [
      '用户在解释一张 QQ 表情包是什么意思。',
      `用户说：「${t}」`,
      '',
      '请判断这张表情包的语义。只输出 JSON，不要任何解释：',
      '{',
      '  "meaning": "不超过12个字的含义概括",',
      `  "scenes": [从这些里选1-2个: ${SCENE_LIST.join(', ')}],`,
      '  "confidence": 0到1之间的小数',
      '}',
      '',
      '判断要点：',
      '- meaning 用中文，要具体（"翻白眼表示无语"比"表情"好）',
      '- scenes 必须从给定列表里选，不要发明新标签',
      '- 用户说得含糊（"就是那个意思"）时 confidence 给低分',
    ].join('\n');

    const res = await llm.generate(
      [
        { role: 'system', content: '你是一个语义分析器，只输出 JSON。' },
        { role: 'user', content: prompt },
      ],
      { temperature: 0.1, maxTokens: 200 },
    );

    const parsed = parseJsonLoose(res.text);
    if (!parsed) {
      logger.debug({ raw: res.text.slice(0, 100) }, 'LLM 返回的不是合法 JSON，走回退');
      return fallbackUnderstand(t, logger);
    }

    const meaning = String(parsed.meaning ?? '').trim().slice(0, 30);
    if (!meaning) return fallbackUnderstand(t, logger);

    const scenes = normalizeScenes(parsed.scenes);
    const confidence = clamp01(Number(parsed.confidence ?? 0.7));

    logger.info({ meaning, scenes, confidence }, 'LLM 理解了表情含义');
    return { meaning, scenes, confidence, source: 'llm' };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'LLM 理解表情失败，走关键词回退');
    return fallbackUnderstand(t, logger);
  }
}

/** 宽松解析 JSON：模型有时会包在 ```json 里，或前后带废话 */
function parseJsonLoose(text: string): Record<string, unknown> | null {
  try {
    const cleaned = text
      .replace(/```json\s*/gi, '')
      .replace(/```/g, '')
      .trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 把模型给的场景名收敛到合法枚举；给了非法的就用 generic 兜底 */
function normalizeScenes(raw: unknown): Scene[] {
  if (!Array.isArray(raw)) return ['generic'];
  const out: Scene[] = [];
  for (const s of raw) {
    const name = String(s).toLowerCase().trim() as Scene;
    if ((SCENE_LIST as readonly string[]).includes(name) && !out.includes(name)) {
      out.push(name);
    }
  }
  return out.length > 0 ? out.slice(0, 2) : ['generic'];
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.7;
  return Math.min(1, Math.max(0, n));
}

/**
 * 关键词回退。
 *
 * 这是 LLM 不可用时的兜底，不是主路径。
 * 覆盖最常见的说法就够了，剩下的靠用户下次说清楚。
 */
export function fallbackUnderstand(text: string, logger: Logger): StickerMeaning | null {
  const t = text.trim();
  if (!t) return null;

  // 拒绝回答 / 无信息量 —— 和 understandSticker 用同一套判断，
  // 保证两条路径行为一致（之前只在 LLM 路径里判断，回退路径会误学）
  if (/^(不知道|不清楚|忘了|随便|没啥|没有|不记得|不想说|没什么|就那样)$/.test(t)) {
    return null;
  }
  if (/^(哈+|呵+|嘿+|嗯+|哦+|啊+|呃+|额+|emm+|草)+$/.test(t)) {
    return null;
  }

  // 直接说"表示 X"的
  const m = t.match(/(?:表示|意思是|应该说|代表|就是|意思是说)([^，。！？~～\s]{1,10})/);
  const core = m ? m[1].trim() : t.replace(/^(这是|这个是|那是|那叫|这叫做|这叫)/, '').trim();

  const RULES: Array<[RegExp, Scene]> = [
    [/白眼|嫌弃|无语|无奈|啧|服了|阴阳/, 'annoyed'],
    [/笑|哈哈|开心|乐|得意|嘿嘿|绷不住/, 'happy'],
    [/困|睡|累|打哈欠|熬夜/, 'sleepy'],
    [/饿|饭|吃|馋|好吃|想吃/, 'hungry'],
    [/委屈|难过|哭|伤心|可怜|破防/, 'sad'],
    [/疑问|不懂|问号|什么|愣|迷惑/, 'confused'],
    [/生气|怒|气死|火|烦死/, 'angry'],
    [/害羞|脸红|羞|不好意思/, 'shy'],
    [/赞|厉害|牛|强|棒|绝了/, 'proud'],
  ];

  const scenes: Scene[] = [];
  for (const [re, scene] of RULES) {
    if (re.test(core) || re.test(t)) scenes.push(scene);
  }

  const meaning = core.slice(0, 20) || t.slice(0, 20);
  if (!meaning) return null;

  logger.debug({ meaning, scenes }, '用关键词回退理解表情');
  return {
    meaning,
    scenes: scenes.length > 0 ? scenes : ['generic'],
    confidence: 0.5,
    source: 'fallback',
  };
}
