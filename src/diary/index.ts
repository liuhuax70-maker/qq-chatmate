import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from 'pino';
import type { LLMClient } from '../brain/llm';

export interface DiaryConfig {
  enabled: boolean;
  /** 日记文件夹（绝对路径），默认 D:\日记 */
  dir: string;
  /** 少于这么多字的心里话不算，避免"在吗""嗯"也写日记 */
  minChars: number;
  /** 判断"值不值得记"用的温度，低一点更稳定 */
  judgeTemperature: number;
  /** 单条日记最多多少字 */
  maxEntryChars: number;
}

export interface DiaryEntry {
  /** 这一天已经写过的条数，用于去重和格式 */
  count: number;
  /** 追加后的完整文件路径 */
  file: string;
}

/**
 * 第二人称日记。
 *
 * 需求原文：「在我发消息吐露心声时，能给我记录，当做第二人称的日记
 * （以大肥鱼的视角），来记录我的生活。以每天的日期为准，每天新建一个文件，
 * 每次聊天把有价值的、跟我有很大关联的事件追加到日记文件中。」
 *
 * 设计要点：
 *  1. 不是「每句话都记」——先让 LLM 判断这条值不值得记，避免日记变成聊天记录
 *  2. 第二人称 = 阿龙是「你」，写的人是大肥鱼（第一人称省略，日记体）
 *  3. 一天一个文件：D:\日记\2026-10-26.md
 *  4. 全程异步 + 失败静默：写日记绝不能影响对话
 */
export class Diary {
  private cfg: DiaryConfig;
  private llm: LLMClient;
  private logger: Logger;
  /** 防止同一天并发写坏文件 */
  private writing = false;
  /** 当前时间（测试可覆盖，用来验证「换一分钟就另起一段」） */
  now: () => Date = () => new Date();

  constructor(cfg: DiaryConfig, llm: LLMClient, logger: Logger) {
    this.cfg = cfg;
    this.llm = llm;
    this.logger = logger;
  }

  /** 今天的日记文件路径 */
  fileFor(date = this.now()): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return path.join(this.cfg.dir, `${y}-${m}-${d}.md`);
  }

  /** 确保目录存在（用户可能删了） */
  private ensureDir(): boolean {
    try {
      if (!fs.existsSync(this.cfg.dir)) {
        fs.mkdirSync(this.cfg.dir, { recursive: true });
        this.logger.info({ dir: this.cfg.dir }, '日记目录不存在，已创建');
      }
      return true;
    } catch (err) {
      this.logger.warn({ err: (err as Error).message, dir: this.cfg.dir }, '创建日记目录失败');
      return false;
    }
  }

  /**
   * 判断一条消息值不值得写进日记。
   *
   * 判据（给 LLM 的规则）：
   *   - 是「跟我说他的事」，不是问句、不是闲聊、不是指令
   *   - 有情绪、有细节、有分量：发生了什么事、他什么感受、他想要什么
   *   - 跟他的生活强相关，以后回头看有意义
   */
  private async worthRecording(userText: string, recent: Array<{ role: string; content: string }>): Promise<boolean> {
    const context = recent
      .slice(-6)
      .map((m) => `${m.role === 'user' ? '阿龙' : '我'}：${m.content}`)
      .join('\n');

    const prompt = [
      '判断下面这条消息值不值得写进「日记」。',
      '',
      '只有满足全部条件才算值得：',
      '1. 阿龙在说「他自己的事」——他的经历、感受、想法、困扰、计划、回忆',
      '2. 有实质内容，不是寒暄、不是问句、不是让我做事、不是单纯吐槽一句',
      '3. 有分量：以后回头看有意义，能看出他当时的状态',
      '',
      '不算的例子（返回 false）：',
      '- 「在吗」「吃了吗」「睡了吗」——寒暄',
      '- 「你几岁了」「你叫什么」——问关于我的事',
      '- 「唱首歌」「发个表情包」——指令',
      '- 「哈哈哈」「6」「草」——无内容',
      '- 「今天天气不错」——太泛，没有跟他个人关联',
      '',
      '算的例子（返回 true）：',
      '- 「今天面试挂了，感觉自己特别没用」——有事件有情绪',
      '- 「我妈又催我找对象了，烦死了」——有事件有情绪',
      '- 「其实我一直觉得自己不适合做这行」——自我剖白',
      '- 「刚才路过以前上班那栋楼，突然挺难受的」——回忆+情绪',
      '',
      '只输出一个词：true 或 false。',
      '',
      `阿龙刚说的：「${userText}」`,
      '',
      context ? `上文（供参考）：\n${context}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const res = await this.llm.generate([{ role: 'user', content: prompt }], {
        temperature: this.cfg.judgeTemperature,
        maxTokens: 10,
      });
      const t = res.text.trim().toLowerCase();
      return t.startsWith('true') || t.startsWith('是') || t.startsWith('值得');
    } catch (err) {
      this.logger.debug({ err: (err as Error).message }, '日记判定失败，跳过');
      return false;
    }
  }

  /**
   * 生成一条日记正文（第二人称，大肥鱼视角）。
   */
  private async compose(userText: string, recent: Array<{ role: string; content: string }>): Promise<string | null> {
    const context = recent
      .slice(-8)
      .map((m) => `${m.role === 'user' ? '阿龙' : '我'}：${m.content}`)
      .join('\n');

    const prompt = [
      '你叫大肥鱼，是一条上了岸的鲸鱼。现在你在写日记。',
      '',
      '写日记的规矩：',
      '- **用第二人称「你」称呼阿龙**，就像在跟他说话',
      '- 是你自己记下来的，语气是你的：嘴上有点不耐烦，心里其实很在意',
      '- 只写这一件事，不要扯别的',
      `- 2 到 5 句话，总共不超过 ${this.cfg.maxEntryChars} 字`,
      '- 不要写「今天阿龙说」这种转述腔，直接写你当时的感觉和反应',
      '- 不要总结、不要说教、不要给建议，就记下这件事和你的心情',
      '- 不要用 markdown 加粗，不要小标题',
      '',
      '写法参考（只是感觉，不要照抄）：',
      '- 你说今天面试挂了，说得挺轻松的，我就没接话。其实我知道那种轻松是装的。',
      '- 你提了一嘴以前上班那栋楼。我没问，但你停了一下才往下说。',
      '- 你说觉得自己不适合做这行。我想说不是，但我没说出口。',
      '',
      `现在的阿龙刚说：「${userText}」`,
      '',
      context ? `刚才的对话：\n${context}` : '',
      '',
      '只输出日记正文，不要时间、不要标题、不要任何标记。',
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const res = await this.llm.generate([{ role: 'user', content: prompt }], {
        temperature: 0.8,
        maxTokens: 400,
      });
      let text = res.text.trim();
      // 去掉模型可能带的引号/代码块
      text = text.replace(/^```[\s\S]*?\n/, '').replace(/\n```$/, '').trim();
      text = text.replace(/^["'“”「」]([\s\S]*)["'“”「」]$/, '$1').trim();
      // 去掉可能多写的标题行
      text = text.replace(/^#+\s*.*\n+/, '');
      if (!text) return null;
      // 硬截断兜底
      if (text.length > this.cfg.maxEntryChars * 2) {
        text = text.slice(0, this.cfg.maxEntryChars * 2);
      }
      return text;
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, '日记生成失败');
      return null;
    }
  }

  /** 一天一个文件。第一次写的时候建文件并写日期头。 */
  private appendToFile(text: string): DiaryEntry | null {
    const file = this.fileFor();
    const isNew = !fs.existsSync(file);

    const now = this.now();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const stamp = `${hh}:${mm}`;

    // 同一分钟内写了多条时不要再起一个时间戳标题——
    // 会出现一排「## 04:44」「## 04:44」「## 04:44」，看着像坏了。
    // 直接接在上一段下面，中间空一行。
    let sameMinute = false;
    if (!isNew) {
      try {
        const existing = fs.readFileSync(file, 'utf8');
        const stamps = existing.match(/^## \d{2}:\d{2}$/gm) ?? [];
        sameMinute = stamps.length > 0 && stamps[stamps.length - 1] === `## ${stamp}`;
      } catch { /* 读不到就当不同分钟 */ }
    }

    const header = isNew ? `# ${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日\n\n` : '';

    let block: string;
    if (isNew) {
      block = `${header}## ${stamp}\n\n${text}\n`;
    } else if (sameMinute) {
      block = `\n${text}\n`;
    } else {
      block = `\n## ${stamp}\n\n${text}\n`;
    }

    fs.appendFileSync(file, block, 'utf8');

    // 数一下今天写了多少条（按时间段算，同分钟的多条算一段）
    let count = 0;
    try {
      const content = fs.readFileSync(file, 'utf8');
      count = (content.match(/^## \d{2}:\d{2}$/gm) ?? []).length;
    } catch { /* 无所谓 */ }

    return { count, file };
  }

  /**
   * 主入口：判断 → 生成 → 追加。
   *
   * 全程不抛异常、不阻塞调用方（调用方用 void 调用即可）。
   */
  async maybeWrite(userText: string, recent: Array<{ role: string; content: string }>): Promise<DiaryEntry | null> {
    if (!this.cfg.enabled) return null;
    if (!userText || userText.trim().length < this.cfg.minChars) return null;

    // 简单预筛：明显不是的话直接跳过，省一次 LLM 调用
    if (looksLikeNoise(userText)) return null;

    if (this.writing) {
      this.logger.debug('上一条日记还在写，跳过这次');
      return null;
    }
    this.writing = true;
    try {
      const worth = await this.worthRecording(userText, recent);
      if (!worth) return null;

      if (!this.ensureDir()) return null;

      const text = await this.compose(userText, recent);
      if (!text) return null;

      const entry = this.appendToFile(text);
      if (entry) {
        this.logger.info({ file: entry.file, count: entry.count }, '日记已写入');
      }
      return entry;
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, '写日记失败（不影响对话）');
      return null;
    } finally {
      this.writing = false;
    }
  }

  /** 读今天的日记（给管理接口/排查用） */
  readToday(): string {
    try {
      const f = this.fileFor();
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    } catch {
      return '';
    }
  }

  /** 列出所有日记文件（新→旧） */
  list(): Array<{ date: string; file: string; size: number }> {
    try {
      if (!fs.existsSync(this.cfg.dir)) return [];
      return fs
        .readdirSync(this.cfg.dir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
        .sort()
        .reverse()
        .map((f) => {
          const full = path.join(this.cfg.dir, f);
          return { date: f.replace('.md', ''), file: full, size: fs.statSync(full).size };
        });
    } catch {
      return [];
    }
  }
}

/**
 * 一眼就能排除的噪音。
 *
 * 目的是省一次 LLM 调用，不是为了精确——
 * 真正该不该记还是交给 worthRecording 判断。
 */
function looksLikeNoise(text: string): boolean {
  const t = text.trim();
  // 纯标点/表情/单字
  if (t.replace(/[\s\p{P}\p{S}]/gu, '').length < 2) return true;
  // 纯表情标记
  if (/^\[.*\]$/.test(t)) return true;
  // 极短寒暄
  const noise = new Set([
    '在吗', '在不在', '在么', '嗯', '哦', '好', '好的', '行', '可以',
    '晚安', '早安', '早', '睡了', '我睡了', '吃了吗', '你吃了吗',
    '哈哈', '哈哈哈', '笑死', '草', '6', '啊', '？', '?',
  ]);
  if (noise.has(t)) return true;
  return false;
}
