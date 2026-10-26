import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from 'pino';
import type { LLMClient } from '../brain/llm';
import { WeatherService, type WeatherConfig } from './weather';

export interface DiaryConfig {
  enabled: boolean;
  /** 日记文件夹（绝对路径），默认 D:\日记 */
  dir: string;
  /** 少于这么多字不算，避免"在吗""嗯"也写日记 */
  minChars: number;
  /** 判断"值不值得记"用的温度，低一点更稳定 */
  judgeTemperature: number;
  /** 正文各段落的字数上限（单个段落，不是总数） */
  maxSectionChars: number;
  /** 天气 */
  weather: WeatherConfig;
}

export interface DiaryEntry {
  /** 这一天已经写过几条 */
  count: number;
  /** 追加后的完整文件路径 */
  file: string;
}

/** 一条日记的结构化内容（由 LLM 生成 JSON） */
export interface DiaryContent {
  /** 标题，如「第一次自己做饭」 */
  title: string;
  /** 心情，如「有点累但挺开心」 */
  mood: string;
  /** 地点，如「家中」 */
  place: string;
  /** 开头：一句总述 */
  opening: string;
  /** 正文一：发生了什么 */
  what: string;
  /** 正文二：细节 */
  detail: string;
  /** 正文三：感受和想法 */
  feeling: string;
  /** 结尾：收尾 + 明天 */
  ending: string;
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * 第二人称日记。
 *
 * 用户给定的格式（2026-10-26 重构）：
 *
 *   2026年10月26日  星期一  晴
 *   地点：家中
 *   心情：有点累但挺开心
 *
 *   标题：第一次自己做饭
 *
 *   【开头】……
 *   【正文一：发生了什么】……
 *   【正文二：细节】……
 *   【正文三：感受和想法】……
 *   【结尾】……
 *
 * 核心约束：
 *   - 视角是大肥鱼（她记阿龙的日常），用第二人称「你」称呼阿龙
 *   - 每天一个文件 D:\日记\YYYY-MM-DD.md
 *   - 不是每句话都记：先让 LLM 判断值不值得记
 *   - 天气要真实（wttr.in），不能瞎编
 */
export class Diary {
  private cfg: DiaryConfig;
  private llm: LLMClient;
  private logger: Logger;
  private weather: WeatherService;
  /** 防止同一天并发写坏文件 */
  private writing = false;
  /** 当前时间（测试可覆盖） */
  now: () => Date = () => new Date();

  constructor(cfg: DiaryConfig, llm: LLMClient, logger: Logger, weather?: WeatherService) {
    this.cfg = cfg;
    this.llm = llm;
    this.logger = logger;
    this.weather = weather ?? new WeatherService(cfg.weather, logger);
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
   * 生成一条日记的结构化内容。
   * 返回 null 表示生成失败（调用方跳过）。
   */
  private async compose(
    userText: string,
    recent: Array<{ role: string; content: string }>,
  ): Promise<DiaryContent | null> {
    const context = recent
      .slice(-8)
      .map((m) => `${m.role === 'user' ? '阿龙' : '我'}：${m.content}`)
      .join('\n');

    const prompt = [
      '你是大肥鱼，一条上了岸的鲸鱼。你要写今天的日记，记的是「阿龙」的日常。',
      '',
      '⚠️ 最重要的两条：',
      '1. **用第二人称「你」称呼阿龙** —— 你在写他，但像在跟他说话',
      '2. **视角是你自己（大肥鱼）** —— 你看到的、听到的、想到的，不是全知视角',
      '',
      '按下面这个结构写，每一段都要有实质内容：',
      '- title：给今天这件事起个标题，4-10 字，不要「日记」「今天」这种废话',
      `- mood：你此刻的心情，一句话，不超过 15 字`,
      `- place：「家中」「公司」「路上」这种，结合对话判断`,
      `- opening：开头，一句总述今天这件事对你的意义，不超过 ${this.cfg.maxSectionChars} 字`,
      `- what：发生了什么。把他说的事情讲清楚：时间、做了什么、过程。不超过 ${this.cfg.maxSectionChars} 字`,
      `- detail：细节。具体的动作、画面、他说的话或你注意到的细节。不超过 ${this.cfg.maxSectionChars} 字`,
      `- feeling：感受和想法。你怎么看这件事，你从中明白了什么。不超过 ${this.cfg.maxSectionChars} 字`,
      `- ending：结尾。收一句今天的状态，可以提一句明天。不超过 ${this.cfg.maxSectionChars} 字`,
      '',
      '语气要求：',
      '- 是你的语气：嘴上有点懒、有点嘴硬，但心里很在意',
      '- 不要写成新闻通稿，不要「综上所述」「总而言之」',
      '- 不要编造他没说过的事。信息不够就写短一点，别硬撑',
      '- 不要提「AI」「模型」「程序」这些词',
      '- 不要用 markdown 加粗、不要用 # 号标题',
      '',
      '只输出一个 JSON 对象，不要任何解释、不要 ``` 包裹：',
      '{"title":"","mood":"","place":"","opening":"","what":"","detail":"","feeling":"","ending":""}',
      '',
      `阿龙刚说：「${userText}」`,
      '',
      context ? `刚才的对话：\n${context}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const res = await this.llm.generate([{ role: 'user', content: prompt }], {
        temperature: 0.8,
        maxTokens: 900,
      });
      const parsed = parseDiaryJson(res.text);
      if (!parsed) {
        this.logger.warn({ raw: res.text.slice(0, 200) }, '日记 JSON 解析失败');
        return null;
      }
      return parsed;
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, '日记生成失败');
      return null;
    }
  }

  /** 渲染成用户要求的格式 */
  private render(content: DiaryContent, now: Date, weather: string): string {
    const y = now.getFullYear();
    const mo = now.getMonth() + 1;
    const d = now.getDate();
    const wd = WEEKDAYS[now.getDay()];

    // 「2026年10月26日  星期一  晴」——天气拿不到时就不写那一段
    const head = [`${y}年${mo}月${d}日`, `星期${wd}`, weather].filter(Boolean).join('  ');

    const lines: string[] = [];
    lines.push(head);
    if (content.place) lines.push(`地点：${content.place}`);
    if (content.mood) lines.push(`心情：${content.mood}`);
    lines.push('');
    if (content.title) lines.push(`标题：${content.title}`);
    lines.push('');

    const section = (label: string, body: string) => {
      const t = (body ?? '').trim();
      if (!t) return;
      lines.push(`【${label}】`);
      lines.push(t);
      lines.push('');
    };

    section('开头', content.opening);
    section('正文一：发生了什么', content.what);
    section('正文二：细节', content.detail);
    section('正文三：感受和想法', content.feeling);
    section('结尾', content.ending);

    // 去掉末尾多余空行
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

    return lines.join('\n');
  }

  /**
   * 写入文件。
   *
   * 一天一个文件：
   *   - 新的一天 → 建文件，直接写完整头部 + 第一条
   *   - 同一天再写 → 追加分隔线 + 时间戳 + 新的完整结构
   *
   * 为什么不合并成"一天一篇"：用户要的是「每次聊天把有价值的追加到日记文件」，
   * 所以同一天多次记录是正常的，每次是独立的一篇。
   */
  private appendToFile(rendered: string): DiaryEntry | null {
    const file = this.fileFor();
    const isNew = !fs.existsSync(file);

    const now = this.now();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');

    let block: string;
    if (isNew) {
      block = `${rendered}\n`;
    } else {
      // 分隔线用 ── 而不是 markdown 的 ---，避免和正文混淆
      block = `\n\n────────────────────────\n\n${hh}:${mm}\n\n${rendered}\n`;
    }

    fs.appendFileSync(file, block, 'utf8');

    let count = 0;
    try {
      const text = fs.readFileSync(file, 'utf8');
      count = (text.match(/^\d{4}年\d{1,2}月\d{1,2}日/gm) ?? []).length;
    } catch { /* 无所谓 */ }

    return { count, file };
  }

  /**
   * 主入口：判断 → 生成 → 渲染 → 追加。
   * 全程不抛异常、不阻塞调用方。
   */
  async maybeWrite(userText: string, recent: Array<{ role: string; content: string }>): Promise<DiaryEntry | null> {
    if (!this.cfg.enabled) return null;
    if (!userText || userText.trim().length < this.cfg.minChars) return null;
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

      const content = await this.compose(userText, recent);
      if (!content) return null;

      const now = this.now();
      // 天气拿不到就用空串，日记头部少一段，不阻断
      const weather = await this.weather.today(now).catch(() => '');
      const rendered = this.render(content, now, weather);

      const entry = this.appendToFile(rendered);
      if (entry) {
        this.logger.info({ file: entry.file, count: entry.count, weather }, '日记已写入');
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

/** 从模型输出里抠出 JSON（容忍 ``` 包裹、前后废话、字段缺失） */
export function parseDiaryJson(raw: string): DiaryContent | null {
  if (!raw) return null;

  let t = raw.trim();
  // 去掉 ```json ... ``` 包裹
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  let obj: any;
  try {
    obj = JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;

  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const content: DiaryContent = {
    title: str(obj.title),
    mood: str(obj.mood),
    place: str(obj.place),
    opening: str(obj.opening),
    what: str(obj.what),
    detail: str(obj.detail),
    feeling: str(obj.feeling),
    ending: str(obj.ending),
  };

  // 至少要有一段正文，否则算失败（避免写入一个空壳）
  const body = content.opening + content.what + content.detail + content.feeling + content.ending;
  if (body.replace(/\s/g, '').length < 10) return null;

  return content;
}

/**
 * 一眼就能排除的噪音。目的是省一次 LLM 调用，不追求精确。
 */
function looksLikeNoise(text: string): boolean {
  const t = text.trim();
  if (t.replace(/[\s\p{P}\p{S}]/gu, '').length < 2) return true;
  if (/^\[.*\]$/.test(t)) return true;
  const noise = new Set([
    '在吗', '在不在', '在么', '嗯', '哦', '好', '好的', '行', '可以',
    '晚安', '早安', '早', '睡了', '我睡了', '吃了吗', '你吃了吗',
    '哈哈', '哈哈哈', '笑死', '草', '6', '啊', '？', '?',
  ]);
  if (noise.has(t)) return true;
  return false;
}
