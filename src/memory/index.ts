import type { Logger } from 'pino';
import type { Store, MemoryType } from '../store/db';
import type { LLMClient } from '../brain/llm';

export interface MemoryConfig {
  enabled: boolean;
  topK: number;
  importanceThreshold: number;
  extractEveryNTurns: number;
  explicitKeywords: string[];
  summaryEnabled: boolean;
  summaryMaxChars: number;
}

/**
 * 记忆系统。
 *
 * 私聊场景下这是核心模块——失忆一次，人设就崩一次。
 *
 * 职责：
 *  1. 检索：新消息到来时取出相关长期记忆
 *  2. 抽取：定期把对话里的值得记的内容写进长期记忆
 *  3. 摘要：短期上下文溢出时压缩成滚动摘要
 */
export class MemorySystem {
  private store: Store;
  private llm: LLMClient;
  private cfg: MemoryConfig;
  private logger: Logger;

  constructor(store: Store, llm: LLMClient, cfg: MemoryConfig, logger: Logger) {
    this.store = store;
    this.llm = llm;
    this.cfg = cfg;
    this.logger = logger;
  }

  /** 检索与当前消息相关的长期记忆 */
  retrieve(scopeId: string, query: string): ReturnType<Store['searchMemories']> {
    if (!this.cfg.enabled) return [];
    return this.store.searchMemories(scopeId, query, this.cfg.topK);
  }

  /** 命中"记住/别忘了"这类显式指令，立即写入 */
  captureExplicit(scopeId: string, text: string): void {
    if (!this.cfg.enabled) return;
    const hit = this.cfg.explicitKeywords.some((k) => text.includes(k));
    if (!hit) return;

    this.store.addMemory({
      scope: 'user',
      scopeId,
      type: 'fact',
      content: text,
      importance: 0.9,
    });
    this.logger.info({ text: text.slice(0, 40) }, '检测到显式记忆指令，已写入长期记忆');
  }

  /**
   * 后台抽取：把最近的对话交给 LLM，让它挑出值得记的东西。
   * 异步执行，不阻塞回复。
   */
  async extract(scopeId: string, recent: Array<{ role: string; content: string }>): Promise<void> {
    if (!this.cfg.enabled || recent.length === 0) return;

    const transcript = recent.map((m) => `${m.role === 'user' ? '对方' : '你'}：${m.content}`).join('\n');

    const prompt = [
      '下面是一段私人聊天记录。请从中提取值得长期记住的信息。',
      '',
      '提取规则：',
      '- 只提取对方明确说过的：个人事实、偏好喜恶、约定、重要事件',
      '- 不要提取寒暄、日常琐碎、以及你自己说过的话',
      '- 每条一句话，不超过 30 字，用陈述句，以“对方”为主语',
      '- 最多 5 条，没有值得记的就返回空数组',
      '',
      '只输出 JSON 数组，格式：[{"type":"fact|preference|promise|event","content":"...","importance":0.0-1.0}]',
      '',
      '聊天记录：',
      transcript,
    ].join('\n');

    try {
      const res = await this.llm.generate([{ role: 'user', content: prompt }], { temperature: 0.2, maxTokens: 500 });
      const parsed = parseJsonArray(res.text);
      let count = 0;
      for (const item of parsed) {
        if (!item?.content) continue;
        const importance = typeof item.importance === 'number' ? item.importance : 0.5;
        if (importance < this.cfg.importanceThreshold) continue;
        const type = (['fact', 'promise', 'event', 'preference', 'opinion'].includes(item.type) ? item.type : 'fact') as MemoryType;
        this.store.addMemory({ scope: 'user', scopeId, type, content: String(item.content), importance });
        count++;
      }
      if (count > 0) this.logger.info({ count }, '记忆抽取完成');
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, '记忆抽取失败（不影响对话）');
    }
  }

  /** 把一段旧对话压缩成摘要，并合并进已有摘要 */
  async summarize(scopeId: string, existingSummary: string, transcript: Array<{ role: string; content: string }>): Promise<string> {
    if (!this.cfg.summaryEnabled) return existingSummary;

    const old = transcript.map((m) => `${m.role === 'user' ? '对方' : '你'}：${m.content}`).join('\n');

    const prompt = [
      '把下面的聊天记录压缩成摘要，供以后回忆用。',
      '',
      '要求：',
      `- 总长度不超过 ${this.cfg.summaryMaxChars} 字`,
      '- 保留：聊了什么话题、对方的情绪状态、结论或约定',
      '- 用第三人称叙述，语气平实',
      '- 如果已有摘要，把新内容合并进去，不要重复',
      '',
      existingSummary ? `已有摘要：\n${existingSummary}\n` : '',
      '新的聊天记录：',
      old,
    ].join('\n');

    try {
      const res = await this.llm.generate([{ role: 'user', content: prompt }], { temperature: 0.3, maxTokens: 600 });
      return res.text.trim() || existingSummary;
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, '摘要生成失败，保留旧摘要');
      return existingSummary;
    }
  }
}

function parseJsonArray(text: string): any[] {
  // 容忍模型输出被 markdown 包裹
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  try {
    const v = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
