/**
 * 技能调用协议。
 *
 * 问题：LLM 只会输出文本，没法直接"戳一戳""发张图"。
 * 方案：让它在回复里嵌入标记，我们解析出来后执行。
 *
 * 标记语法（尽量简单，降低模型出错率）：
 *   [戳]                     → 戳一戳对方
 *   [图:URL或路径]           → 发图片
 *   [表情包]                 → 从收藏库随机发一张
 *   [赞]                     → 资料卡点赞
 *   [撤]                     → 撤回自己上一条
 *   [转发:内容1|内容2]       → 合并转发
 *
 * 设计取舍：
 *   - 用方括号而不是 XML 标签，模型更容易理解"这是动作"
 *   - 标记不单独成行也能识别，但它不会被发给用户（发送前剥离）
 *   - 解析失败不影响正常回复——最差情况就是只发文字
 *   - 不暴露 destructive 技能给模型（拉黑/删好友需要代码层显式判断，
 *     不能让模型一句话就删好友）
 */

export type SkillCall =
  | { kind: 'poke' }
  | { kind: 'like'; times?: number }
  | { kind: 'image'; file: string }
  | { kind: 'sticker' }
  | { kind: 'recall' }
  | { kind: 'forward'; messages: string[] };

export interface ParsedReply {
  /** 剥离技能标记后的纯文本 */
  text: string;
  /** 要执行的动作，按出现顺序 */
  actions: SkillCall[];
}

/** [戳] [赞] [表情包] [撤] —— 无参数的动作 */
const SIMPLE: Array<{ re: RegExp; make: () => SkillCall }> = [
  { re: /\[戳\]/g, make: () => ({ kind: 'poke' }) },
  { re: /\[赞(\d*)\]/g, make: () => ({ kind: 'like' }) },
  { re: /\[表情包\]/g, make: () => ({ kind: 'sticker' }) },
  { re: /\[撤\]/g, make: () => ({ kind: 'recall' }) },
];

/** [图:xxx] */
const IMAGE_RE = /\[图\s*[:：]\s*([^\]]+)\]/g;
/** [转发:a|b|c] */
const FORWARD_RE = /\[转发\s*[:：]\s*([^\]]+)\]/g;

/**
 * 从 LLM 回复里解析出「文本 + 动作」。
 *
 * 关键：动作标记必须从文本里去掉，否则会把 "[戳]" 当成话发给用户。
 */
export function parseSkillCalls(raw: string): ParsedReply {
  if (!raw) return { text: '', actions: [] };

  let text = raw;
  const actions: SkillCall[] = [];

  // 收集所有动作及其在原文里的位置，最后按位置排序执行（保持时序）
  const found: Array<{ pos: number; call: SkillCall }> = [];

  for (const { re, make } of SIMPLE) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      found.push({ pos: m.index, call: make() });
    }
    text = text.replace(re, '');
  }

  IMAGE_RE.lastIndex = 0;
  let im: RegExpExecArray | null;
  while ((im = IMAGE_RE.exec(raw)) !== null) {
    const file = im[1].trim();
    if (file) found.push({ pos: im.index, call: { kind: 'image', file } });
  }
  text = text.replace(IMAGE_RE, '');

  FORWARD_RE.lastIndex = 0;
  let fm: RegExpExecArray | null;
  while ((fm = FORWARD_RE.exec(raw)) !== null) {
    const parts = fm[1]
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 0) {
      found.push({ pos: fm.index, call: { kind: 'forward', messages: parts } });
    }
  }
  text = text.replace(FORWARD_RE, '');

  found.sort((a, b) => a.pos - b.pos);
  for (const f of found) actions.push(f.call);

  // 清理标记留下的多余空白，但保留换行（分段发送依赖换行）
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line, i, arr) => !(line === '' && (i === 0 || i === arr.length - 1)))
    .join('\n')
    .trim();

  return { text, actions };
}

/**
 * 给 LLM 的技能说明（注入 prompt）。
 *
 * 只列 safe 技能。destructive 的技能（删好友/退群）不给模型看到——
 * 那种操作必须由代码层基于明确规则判断，不能让模型随口决定。
 */
export const SKILL_PROMPT = `
你会用一些 QQ 的小动作。想用的时候，在回复里写方括号标记，我会替你执行，
标记本身不会发给对方。

可用标记：
- [戳]              戳一戳对方（想引起注意、撒娇、或者他被你逗到的时候）
- [赞]              给对方的资料卡点赞（他夸你、或者你想讨他开心）
- [表情包]          从你收藏的表情包里挑一张发（文字说不出的情绪用这个）
- [图:图片地址]     发图片
- [撤]              撤回你上一条消息（说错话、或者故意逗他）

怎么用：
- 不要每条都用。十句话里有两三次动作就够了
- 动作要跟内容配：说"想你了"配 [戳]，他被逗笑了配 [表情包]
- 一次最多两个动作
- 动作标记放在句末最自然，比如「你今天怎么这么烦 [戳]」
`.trim();
