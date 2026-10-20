/**
 * QQ 小黄脸表情映射。
 *
 * 为什么用「中文名 → ID」而不是让模型直接输出 ID：
 *   模型不知道 [微笑] 是 14，硬让它记数字容易出错，
 *   而且换个协议端 ID 就得全改。
 *   让它输出 `[表情:白眼]` 这种自然标记，由代码翻译，稳得多。
 *
 * ID 取自 QQ 官方 face 表（NTQQ 通用）。
 */
export const FACE_MAP: Record<string, number> = {
  微笑: 14,
  撇嘴: 1,
  色: 2,
  发呆: 3,
  得意: 4,
  流泪: 5,
  害羞: 6,
  闭嘴: 7,
  睡: 8,
  大哭: 9,
  尴尬: 10,
  发怒: 11,
  调皮: 12,
  呲牙: 13,
  惊讶: 15,
  难过: 16,
  酷: 17,
  冷汗: 18,
  抓狂: 19,
  吐: 20,
  偷笑: 21,
  可爱: 22,
  白眼: 23,
  傲慢: 24,
  饥饿: 25,
  困: 26,
  惊恐: 27,
  流汗: 28,
  憨笑: 29,
  悠闲: 30,
  奋斗: 31,
  咒骂: 32,
  疑问: 33,
  嘘: 34,
  晕: 35,
  折磨: 36,
  衰: 37,
  骷髅: 38,
  敲打: 39,
  再见: 40,
  擦汗: 41,
  抠鼻: 42,
  鼓掌: 43,
  糗大了: 44,
  坏笑: 45,
  左哼哼: 46,
  右哼哼: 47,
  哈欠: 48,
  鄙视: 49,
  委屈: 50,
  快哭了: 51,
  阴险: 52,
  亲亲: 53,
  吓: 54,
  可怜: 55,
  菜刀: 56,
  西瓜: 57,
  啤酒: 58,
  篮球: 59,
  乒乓: 60,
  咖啡: 61,
  饭: 62,
  猪头: 63,
  玫瑰: 64,
  凋谢: 65,
  示爱: 66,
  爱心: 67,
  心碎: 68,
  蛋糕: 69,
  闪电: 70,
  炸弹: 71,
  刀: 72,
  足球: 73,
  瓢虫: 74,
  便便: 75,
  月亮: 76,
  太阳: 77,
  礼物: 78,
  拥抱: 79,
  强: 80,
  弱: 81,
  握手: 82,
  胜利: 83,
  抱拳: 84,
  勾引: 85,
  拳头: 86,
  差劲: 87,
  爱你: 88,
  NO: 89,
  OK: 90,
  爱情: 91,
  飞吻: 92,
  跳跳: 93,
  发抖: 94,
  怄火: 95,
  转圈: 96,
  磕头: 97,
  回头: 98,
  跳绳: 99,
  挥手: 100,
  激动: 101,
  街舞: 102,
  献吻: 103,
  左太极: 104,
  右太极: 105,
};

/**
 * 从文本里解析出消息段。
 *
 * 支持两种标记：
 *   [表情:白眼]   → face 段
 *   [face:23]     → face 段（兜底，允许模型直接给 ID）
 *
 * 其余文字保持为 text 段。
 */
export interface ParsedSegment {
  type: 'text' | 'face';
  data: Record<string, string>;
}

export function parseEmojiMarkers(text: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  // 匹配 [表情:名字] 或 [face:数字]
  const re = /\[(?:表情|face)\s*[:：]\s*([^\]]+)\]/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index);
    if (before.trim()) segments.push({ type: 'text', data: { text: before.trim() } });

    const raw = match[1].trim();
    const faceId = /^\d+$/.test(raw) ? Number(raw) : FACE_MAP[raw];
    if (faceId !== undefined && faceId > 0) {
      segments.push({ type: 'face', data: { id: String(faceId) } });
    } else {
      // 未知表情名：原样保留成文字，别丢内容
      segments.push({ type: 'text', data: { text: match[0] } });
    }
    lastIndex = re.lastIndex;
  }

  const tail = text.slice(lastIndex);
  if (tail.trim()) segments.push({ type: 'text', data: { text: tail.trim() } });

  return segments;
}

/**
 * 后处理阶段的表情规则：
 *  1. 按 emojiUsage 概率，把句子末尾的一个词替换成表情
 *  2. 已有表情标记则原样保留
 *
 * 返回处理后的文本（仍是带标记的字符串，交给 parseEmojiMarkers 解析）。
 */
export function maybeInjectEmoji(text: string, emojiUsage: number): string {
  if (text.includes('[表情:') || text.includes('[face:')) return text;
  if (Math.random() >= emojiUsage) return text;

  // 只在情绪词附近注入，避免乱加
  const candidates: Array<[RegExp, string]> = [
    [/好烦|烦死了|无语/, '白眼'],
    [/好吧|行吧|算了/, '撇嘴'],
    [/哈哈|笑死/, '呲牙'],
    [/困了|睡了|晚安/, '睡'],
    [/饿了|吃饭|米饭/, '饭'],
    [/不懂|不知道|什么/, '疑问'],
    [/厉害|牛|强/, '强'],
    [/委屈|难过|呜呜/, '委屈'],
    [/生气|哼/, '傲慢'],
  ];

  for (const [re, face] of candidates) {
    if (re.test(text)) return `${text} [表情:${face}]`;
  }

  // 没有匹配的情绪词，就用最通用的
  const generic = ['白眼', '撇嘴', '微笑'];
  const face = generic[Math.floor(Math.random() * generic.length)];
  return `${text} [表情:${face}]`;
}
