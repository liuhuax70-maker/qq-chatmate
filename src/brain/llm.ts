import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { Logger } from 'pino';

export interface LLMConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  timeoutMs: number;
  retries: number;
  retryDelayMs: number;
  maxConcurrent: number;
  requestsPerMinute: number;
}

export interface GenerateResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  /** 命中缓存的 prompt tokens（DeepSeek 特有，省钱的关键） */
  cachedTokens: number;
  latencyMs: number;
}

/**
 * DeepSeek（OpenAI 兼容）客户端。
 * 自带并发闸 + 每分钟限流，避免触发上游 429 和账号异常特征。
 */
export class LLMClient {
  private client: OpenAI;
  private cfg: LLMConfig;
  private logger: Logger;

  private running = 0;
  private queue: Array<() => void> = [];
  private requestTimes: number[] = [];

  /** 累计用量（用于成本监控） */
  readonly totals = {
    calls: 0,
    promptTokens: 0,
    cachedTokens: 0,
    completionTokens: 0,
  };

  /**
   * 成本估算（DeepSeek 2026 定价，元/百万 token）
   *  - 输入（未命中缓存）: 0.5
   *  - 输入（命中缓存）:   0.05  ← 约 1/10
   *  - 输出:              2.0
   */
  estimateCostYuan(): { input: number; output: number; total: number } {
    const missTokens = this.totals.promptTokens - this.totals.cachedTokens;
    const input = (missTokens / 1_000_000) * 0.5 + (this.totals.cachedTokens / 1_000_000) * 0.05;
    const output = (this.totals.completionTokens / 1_000_000) * 2.0;
    return { input, output, total: input + output };
  }

  stats(): Record<string, unknown> {
    const cost = this.estimateCostYuan();
    const hitRate =
      this.totals.promptTokens > 0 ? (this.totals.cachedTokens / this.totals.promptTokens) * 100 : 0;
    return {
      calls: this.totals.calls,
      promptTokens: this.totals.promptTokens,
      cachedTokens: this.totals.cachedTokens,
      cacheHitRate: `${hitRate.toFixed(1)}%`,
      completionTokens: this.totals.completionTokens,
      costYuan: Number(cost.total.toFixed(4)),
      avgTokensPerCall:
        this.totals.calls > 0 ? Math.round(this.totals.promptTokens / this.totals.calls) : 0,
    };
  }

  constructor(cfg: LLMConfig, logger: Logger) {
    this.cfg = cfg;
    this.logger = logger;
    this.client = new OpenAI({
      baseURL: cfg.baseURL,
      apiKey: cfg.apiKey,
      timeout: cfg.timeoutMs,
      maxRetries: 0, // 自己控制重试，便于记录日志
    });
  }

  private async acquireSlot(): Promise<() => void> {
    // 并发闸
    if (this.running >= this.cfg.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.running++;

    // 每分钟限流
    const now = Date.now();
    this.requestTimes = this.requestTimes.filter((t) => now - t < 60000);
    if (this.requestTimes.length >= this.cfg.requestsPerMinute) {
      const waitMs = 60000 - (now - this.requestTimes[0]) + 50;
      this.logger.warn({ waitMs }, '触发每分钟限流，等待中');
      await sleep(waitMs);
    }
    this.requestTimes.push(Date.now());

    return () => {
      this.running--;
      const next = this.queue.shift();
      if (next) next();
    };
  }

  async generate(messages: ChatCompletionMessageParam[], opts?: { temperature?: number; maxTokens?: number }): Promise<GenerateResult> {
    const release = await this.acquireSlot();
    const startedAt = Date.now();
    let lastErr: Error | undefined;

    try {
      for (let attempt = 0; attempt <= this.cfg.retries; attempt++) {
        try {
          const res = await this.client.chat.completions.create({
            model: this.cfg.model,
            messages,
            temperature: opts?.temperature ?? this.cfg.temperature,
            top_p: this.cfg.topP,
            max_tokens: opts?.maxTokens ?? this.cfg.maxTokens,
            // 抑制重复：frequency_penalty 惩罚已出现过的 token，presence_penalty 惩罚出现过的词。
            // 之前没设，导致她反复复用同一个"数落对方"的句式，陷入循环。
            frequency_penalty: 0.5,
            presence_penalty: 0.5,
            stream: false,
          });

          const text = res.choices?.[0]?.message?.content?.trim() ?? '';
          const latencyMs = Date.now() - startedAt;

          // DeepSeek 的 usage 里带 prompt_cache_hit_tokens / prompt_cache_miss_tokens
          const usage = res.usage as any;
          const cachedTokens: number = usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0;
          const promptTokens = usage?.prompt_tokens ?? 0;
          const completionTokens = usage?.completion_tokens ?? 0;

          if (cachedTokens > 0) {
            this.logger.debug(
              { promptTokens, cachedTokens, hitRate: ((cachedTokens / promptTokens) * 100).toFixed(0) + '%' },
              '上下文缓存命中',
            );
          }

          // 累计统计
          this.totals.calls++;
          this.totals.promptTokens += promptTokens;
          this.totals.cachedTokens += cachedTokens;
          this.totals.completionTokens += completionTokens;

          return {
            text,
            promptTokens,
            completionTokens,
            cachedTokens,
            latencyMs,
          };        } catch (err) {
          lastErr = err as Error;
          if (attempt < this.cfg.retries) {
            const wait = this.cfg.retryDelayMs * Math.pow(2, attempt);
            this.logger.warn({ attempt: attempt + 1, wait, err: lastErr.message }, 'LLM 调用失败，准备重试');
            await sleep(wait);
          }
        }
      }
      throw lastErr ?? new Error('LLM 调用失败');
    } finally {
      release();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
