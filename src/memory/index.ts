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
  /** 记忆保留天数，超期自动清理（0 = 永久保留） */
  ttlDays?: number;
  /** 单个用户最多保留多少条记忆，超出按「重要度 + 新近度」淘汰 */
  maxMemories?: number;
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

  /**
   * 检索与当前消息相关的长期记忆。
   *
   * 不只是关键词匹配——还在结果上叠加「新近度」和「重要度」：
   *   - 昨天说的"我不舒服"比三个月前的更该被想起
   *   - 但"他没谈过恋爱"这种高权重事实，时间久了也还记得
   *
   * 注意：这里刻意不引入向量检索。配置里的 vector 段是为将来准备的，
   * 强依赖外部 embedding 服务会让整套系统在服务不可用时失效。
   * 关键词 + 时间衰减 + 重要度，在当前私聊场景下已经够用。
   */
  retrieve(scopeId: string, query: string): ReturnType<Store['searchMemories']> {
    if (!this.cfg.enabled) return [];

    // 多取一些候选，再按综合分重排
    const candidates = this.store.searchMemories(scopeId, query, this.cfg.topK * 3);
    if (candidates.length === 0) return [];

    const now = Date.now();
    const scored = candidates.map((m) => {
      const ageDays = (now - (m.createdAt ?? now)) / 86_400_000;
      // 时间衰减：半年内基本不衰减，之后缓慢下降
      const recency = ageDays < 180 ? 1 : Math.max(0.3, 1 - (ageDays - 180) / 540);
      // 重要度直接乘上去；访问次数多的稍微加权（说明反复被想起）
      const usage = 1 + Math.min(0.3, (m.accessCount ?? 0) * 0.05);
      const score = m.importance * recency * usage;
      return { m, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, this.cfg.topK).map((s) => s.m);
  }

  /**
   * 清理过期记忆。
   *
   * 记忆无限增长会有两个问题：
   *   1. 检索时噪音变多，该想起的事被埋掉
   *   2. 数据库膨胀
   *
   * 淘汰规则：超过 ttlDays 的删掉；超过 maxMemories 条的，
   * 按「重要度低 + 最久没被访问」优先淘汰。
   * 白名单记忆（importance >= 0.9）永远不删——那是"他没谈过恋爱"这种核心事实。
   */
  prune(scopeId: string): { expired: number; overflow: number } {
    const expired = 0;
    const overflow = 0;
    try {
      // SQL 层的 TTL 清理由 store 做，这里只处理条数上限
      const limit = this.cfg.maxMemories;
      if (!limit) return { expired, overflow };

      const all = this.store.searchMemories(scopeId, '', limit * 3);
      if (all.length <= limit) return { expired, overflow };

      // 永远保留高权重的
      const keep = all.filter((m) => m.importance >= 0.9);
      const rest = all
        .filter((m) => m.importance < 0.9)
        // 重要度低的、久未访问的，排在前面等着被删
        .sort((a, b) => {
          const sa = a.importance * (1 + Math.min(0.3, (a.accessCount ?? 0) * 0.05));
          const sb = b.importance * (1 + Math.min(0.3, (b.accessCount ?? 0) * 0.05));
          return sa - sb;
        });

      const over = keep.length + rest.length - limit;
      if (over > 0) {
        const toDelete = rest.slice(0, over);
        for (const m of toDelete) {
          try {
            this.store.deleteMemory(m.id);
          } catch { /* 单条失败不影响其它 */ }
        }
        this.logger.info({ deleted: toDelete.length, kept: keep.length }, '记忆超限，已淘汰低权重条目');
        return { expired, overflow: toDelete.length };
      }
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, '记忆清理失败');
    }
    return { expired, overflow };
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
