import type { Logger } from 'pino';
import type { LLMClient } from '../brain/llm';
import { understandSticker } from './sticker-understand';
import type { Store } from '../store/db';

/**
 * 把表情 URL 归一化成稳定标识。
 *
 * QQ 的图片链接带 rkey 签名参数，同一张图每次发过来 URL 都不同，
 * 直接拿 URL 当 key 会导致"同一张表情被反复问"。
 * 这里提取 fileid（稳定）作为判定依据。
 */
export function stickerKey(url: string): string {
  try {
    const idx = url.indexOf('fileid=');
    if (idx >= 0) {
      let fid = url.slice(idx + 7);
      const amp = fid.indexOf('&');
      if (amp >= 0) fid = fid.slice(0, amp);
      fid = decodeURIComponent(fid);
      // QQ 的 fileid 前半段是图片内容哈希（稳定），后半段是每次变化的加密签名。
      // 只取前 40 字符作为「这是同一张图」的判定依据。
      return 'fid:' + fid.slice(0, 40);
    }
    // 没有 fileid（比如 qpic.cn 永久链接）→ 去掉时效参数后用整条 URL
    const u = new URL(url);
    const keep = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      if (k !== 'rkey' && k !== 't' && k !== 'sign') keep.set(k, v);
    }
    u.search = keep.toString();
    return u.toString();
  } catch {
    return url;
  }
}
export interface LearnedSticker {
  /** 图片 URL（作为唯一标识） */
  url: string;
  /** 她学会的意思，如 "白眼"、"无语" */
  meaning: string;
  /** 长描述，如 "表示嫌弃、不想理人" */
  description: string;
  /** 适用的场景标签，用于以后检索 */
  scenes: string[];
  /** 学会的时间 */
  learnedAt: number;
  /** 用过几次 */
  usedCount: number;
  lastUsedAt: number;
  /** 是不是她自己收藏来的 */
  source: 'user' | 'self';
}

/** 待确认的提问：发了问题之后，等用户回答 */
export interface PendingAsk {
  url: string;
  askedAt: number;
  /** 她当时用的那句问话，便于上下文判断 */
  question: string;
}

const LEARNED_KEY = 'learned_stickers_v1';
const PENDING_KEY = 'sticker_pending_ask_v1';

/**
 * 表情学习器。
 *
 * 核心流程（用户指定的设计）：
 *   1. 用户发来一张没见过的表情
 *   2. 她不知道什么意思 → 主动问
 *   3. 用户回答 → 记进数据库
 *   4. 以后遇到相似情绪 → 自动调用
 *
 * 关键约束：
 *   - 不能每张图都问，那样很烦。同一个用户第一次发才问，或者问过的图不再问
 *   - 问题的措辞要符合她的性格（懒散、别扭，别像客服调研）
 *   - 答案解析要宽松（"这是白眼"、"嫌弃"、"表示无语" 都算）
 */
export class StickerLearner {
  private store: Store;
  private logger: Logger;
  private learned = new Map<string, LearnedSticker>();
  private pending: PendingAsk | null = null;

  /** 问过但还没得到答案的图，避免重复问 */
  private askedUrls = new Set<string>();

  /** 可选：注入后会用 LLM 理解表情含义（比关键词匹配准得多） */
  private llm: LLMClient | null = null;

  constructor(store: Store, logger: Logger, llm?: LLMClient) {
    this.store = store;
    this.logger = logger;
    this.llm = llm ?? null;
    this.load();
  }

  /** 后置注入（index.ts 里 llm 可能晚于 learner 创建） */
  bindLlm(llm: LLMClient): void {
    this.llm = llm;
  }

  private load(): void {
    try {
      const raw = this.store.getKv(LEARNED_KEY);
      if (raw) {
        const arr = JSON.parse(raw) as LearnedSticker[];
        for (const s of arr) this.learned.set(stickerKey(s.url), s);
      }
      const pend = this.store.getKv(PENDING_KEY);
      if (pend) this.pending = JSON.parse(pend) as PendingAsk;
    } catch {
      // 忽略损坏数据
    }
  }

  private save(): void {
    this.store.setKv(LEARNED_KEY, JSON.stringify([...this.learned.values()]));
    this.store.setKv(PENDING_KEY, this.pending ? JSON.stringify(this.pending) : '');
  }

  count(): number {
    return this.learned.size;
  }

  list(): LearnedSticker[] {
    return [...this.learned.values()];
  }

  /** 是否已经认识这张图 */
  knows(url: string): boolean {
    return this.learned.has(stickerKey(url));
  }

  /** 是否正在等待用户回答 */
  hasPending(): boolean {
    return this.pending !== null;
  }

  getPending(): PendingAsk | null {
    return this.pending;
  }

  /**
   * 收到一张用户发来的图片。
   *
   * 返回：
   *   - 'known'     已经认识，无需处理
   *   - 'ask'       不认识，应该问她
   *   - 'already-asked' 问过了还没答，不要再问
   *   - 'ignore'    不处理（比如不是表情包）
   */
  onReceivedImage(url: string, isSticker: boolean): 'known' | 'ask' | 'already-asked' | 'ignore' {
    const key = stickerKey(url);
    if (this.learned.has(key)) return 'known';

    // 只学表情包，不学普通照片（用户发生活照时不该问"这张什么意思"）
    if (!isSticker) return 'ignore';

    if (this.askedUrls.has(key)) return 'already-asked';

    // 已经有一个待回答的，先不追问第二张
    if (this.pending) return 'already-asked';

    return 'ask';
  }

  /** 记录"已经问了"，并进入等待状态 */
  markAsked(url: string, question: string): void {
    this.askedUrls.add(stickerKey(url));
    this.pending = { url, askedAt: Date.now(), question };
    this.save();
    this.logger.info({ url: url.slice(0, 60) }, '不认识这张表情，准备问她');
  }

  /**
   * 尝试从用户回复里解析出表情的意思。
   *
   * 解析策略（宽松）：
   *   "这是白眼" / "白眼" / "表示嫌弃" / "这表示无语" / "你在嫌弃我"
   * 都能提取出核心词。
   *
   * 如果用户说"不知道"、"随便发的"、"没啥意思"，则放弃学习。
   */
  /**
   * 从用户的回复里学这张表情的含义。
   *
   * 改成 async 是为了让 LLM 参与理解——纯关键词匹配会漏掉
   * "嘲讽你""阴阳怪气"这类说法，学到的标签是错的，
   * 后续按场景挑图就会挑错，等于"没真懂"。
   */
  async tryLearnFromReply(reply: string): Promise<LearnedSticker | null> {
    if (!this.pending) return null;

    const pending = this.pending;

    // 明显拒绝回答的
    const giveUp = /不知道|不清楚|忘了|随便|没啥|没有|不记得|就是随便|不想说/;
    if (giveUp.test(reply.trim())) {
      this.logger.info('用户没打算解释这张表情，放弃学习');
      this.pending = null;
      this.save();
      return null;
    }

    // 让 LLM 真正理解，而不是硬匹配关键词
    const understood = await understandSticker(reply, this.llm, this.logger);
    if (!understood) {
      // 解析不出来，保留 pending，让她下次再问
      this.logger.debug({ reply }, '没解析出表情的意思');
      return null;
    }

    const learned: LearnedSticker = {
      url: pending.url,
      meaning: understood.meaning,
      description: reply.trim().slice(0, 100),
      scenes: understood.scenes,
      learnedAt: Date.now(),
      usedCount: 0,
      lastUsedAt: 0,
      source: 'user',
    };

    this.learned.set(stickerKey(pending.url), learned);
    this.pending = null;
    this.save();
    this.logger.info({ meaning: understood.meaning, scenes: understood.scenes }, '学会了一张新表情');
    return learned;
  }

  /** 记录使用 */
  markUsed(url: string): void {
    const s = this.learned.get(stickerKey(url));
    if (!s) return;
    s.usedCount++;
    s.lastUsedAt = Date.now();
    this.save();
  }

  /** 按场景挑一张已学会的表情 */
  pickByScene(scene: string): LearnedSticker | null {
    const pool = [...this.learned.values()].filter((s) => s.scenes.includes(scene));
    if (pool.length === 0) return null;

    // 优先用得少的
    pool.sort((a, b) => a.usedCount - b.usedCount || Math.random() - 0.5);
    const chosen = pool[0];
    this.markUsed(chosen.url);
    return chosen;
  }
}

/**
 * 从用户回复里提取表情含义。
 *
 * 测试驱动的修正记录：
 *   初版用"去前缀 + 截断"的简单规则，结果：
 *     "这是表示无语"   → 提取成 "表示无语"（没去掉"表示"）
 *     "你在嫌弃我"     → 整句拿走了（没有识别主语）
 *     "就表示开心哈哈哈" → 整句拿走了
 *
 *   现在的策略：从"关键词表"里反向匹配，比正向截断可靠得多。
 */
function extractMeaning(reply: string): string | null {
  const t = reply.trim();

  // 1) 先看是不是明确拒绝
  if (/不知道|不清楚|忘了|随便|没啥|不记得|不想说|没什么/.test(t)) return null;

  // 2) 纯感叹词/纯笑声 → 不是在回答，是在笑
  //    （"哈哈"、"哈哈哈"、"嗯嗯"、"呃" 这些词没信息量）
  if (/^(哈+|呵+|嘿+|嗯+|哦+|啊+|呃+|额+|emm+|草)+$/.test(t)) return null;

  // 3) 先在整句里找已知的情绪词（最可靠）
  const KNOWN_MEANINGS = [
    '白眼', '无语', '嫌弃', '翻白眼', '无奈', '啧',
    '开心', '笑', '哈哈', '乐', '得意', '嘿嘿',
    '困', '睡', '累', '打哈欠',
    '饿', '饭', '吃', '馋',
    '委屈', '难过', '哭', '伤心',
    '疑问', '问号', '不懂', '疑惑',
    '生气', '怒', '气死',
    '害羞', '脸红',
    '赞', '厉害', '牛', '强',
  ];
  for (const kw of KNOWN_MEANINGS) {
    // 短词要防止误匹配（"笑"不该匹配到"笑话"里的笑，但这里可接受）
    if (t.includes(kw)) return kw;
  }

  // 3) 找"表示/意思是"后面的词
  const m = t.match(/(?:表示|意思是|应该说|代表|就是)([^，。！？~～\s]{1,8})/);
  if (m) {
    const w = m[1].trim();
    if (!/^(哈哈+|呵+|嗯+|哦+|啊+|的|了|我|你)/.test(w)) return w;
  }

  // 4) 去掉常见修饰后剩下的短词
  const cleaned = t
    .replace(/^(这是|这个是|那是|那叫|这叫做|这叫|意思是|表示)/, '')
    .replace(/(吧|啊|呀|呢|哦|哈|嘛|欸|诶)+$/, '')
    .replace(/[，。！？~～\s].*$/, '')
    .trim();

  if (cleaned.length >= 1 && cleaned.length <= 8) {
    if (/^(哈+|呵+|嗯+|哦+|啊+|的|了|我|你|他|对|好|行|可以)$/.test(cleaned)) return null;
    return cleaned;
  }

  return null;
}

/** 把意思映射到场景标签 */
function mapMeaningToScenes(meaning: string): string[] {
  const scenes: string[] = [];
  const rules: Array<[RegExp, string]> = [
    [/白眼|嫌弃|无语|无奈|翻白眼|啧/, 'annoyed'],
    [/笑|哈哈|开心|乐|得意|嘿嘿/, 'happy'],
    [/困|睡|累|打哈欠|晚安/, 'sleepy'],
    [/饿|饭|吃|馋|好吃/, 'hungry'],
    [/委屈|难过|哭|伤心|可怜/, 'sad'],
    [/疑问|不懂|问号|什么|愣/, 'confused'],
    [/生气|怒|气死|火/, 'angry'],
    [/害羞|脸红|羞/, 'shy'],
    [/赞|厉害|牛|强|棒/, 'proud'],
  ];

  for (const [re, scene] of rules) {
    if (re.test(meaning)) scenes.push(scene);
  }

  return scenes.length > 0 ? scenes : ['generic'];
}

/**
 * 生成"问她这张什么意思"的话术。
 *
 * 要符合她的性格：懒散、别扭、不客气。
 * 不要像客服调研。
 */
export function buildAskQuestion(intimacy: number): string {
  const low = [
    '这是啥',
    '这表情什么意思',
    '看不懂这个',
    '这张是啥意思',
  ];
  const mid = [
    '这表情干嘛的',
    '这图啥意思啊',
    '我不懂这个 讲一下',
  ];
  const high = [
    '这是什么意思啊',
    '这表情啥意思 教我',
    '没看懂 说人话',
  ];

  const pool = intimacy < 0.3 ? low : intimacy < 0.6 ? mid : high;
  return pool[Math.floor(Math.random() * pool.length)];
}
