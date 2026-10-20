import type { Logger } from 'pino';
import type { Store } from '../store/db';
import type { OneBotAdapter } from '../adapter/onebot';

export interface Sticker {
  id: string;
  url: string;
  /** 人工或启发式打的标签，如 ['开心','得意'] */
  tags: string[];
  /** 用过的次数，用于避免总发同一张 */
  usedCount: number;
  lastUsedAt: number;
  /** 最后一次在收藏列表里出现的时间（累积式合并用） */
  lastSeenAt?: number;
}

const STORAGE_KEY = 'stickers_v1';
const BLOCKLIST_KEY = 'stickers_blocklist_v1';

/**
 * 收藏表情包管理。
 *
 * 数据来源：OneBot 的 fetch_custom_face —— 返回机器人账号「我的收藏」里所有表情的图片 URL。
 *
 * 设计取舍：
 *   本鲸娘**不做图像识别**。假装能看懂图片内容，最后只会发错表情，比不发更糟。
 *   做法是「标签池 + 场景匹配 + 随机 + 防重复」：
 *     - 每个场景对应一组候选标签
 *     - 从候选标签里找没用过的表情
 *     - 没有就打乱后随机挑（保证至少能发出去）
 *
 * 标签怎么来：
 *   首次拉取时，所有表情都是 `untagged`。发出去几次之后，
 *   你可以通过管理接口给她打标签（/api 接口之外，见 tools/tag-stickers.ts）。
 *   在她没被标注之前，就走纯随机，也不会出错。
 */
export class StickerLibrary {
  private store: Store;
  private logger: Logger;
  private stickers: Sticker[] = [];
  private loadedAt = 0;
  /** 被用户明确删除的表情，刷新时不再拉回来 */
  private blocklist = new Set<string>();

  constructor(store: Store, logger: Logger) {
    this.store = store;
    this.logger = logger;
    this.load();
  }

  private load(): void {
    try {
      const raw = this.store.getKv(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { stickers: Sticker[]; loadedAt: number };
        this.stickers = parsed.stickers ?? [];
        this.loadedAt = parsed.loadedAt ?? 0;
      }
      const bl = this.store.getKv(BLOCKLIST_KEY);
      if (bl) {
        const arr = JSON.parse(bl) as string[];
        this.blocklist = new Set(arr);
      }
    } catch {
      this.stickers = [];
    }
  }

  private save(): void {
    this.store.setKv(STORAGE_KEY, JSON.stringify({ stickers: this.stickers, loadedAt: this.loadedAt }));
    this.store.setKv(BLOCKLIST_KEY, JSON.stringify([...this.blocklist]));
  }

  /** 清空表情库，只保留指定的 URL（其他人加入黑名单，刷新也不会再回来） */
  keepOnly(urls: string[]): { removed: number; kept: number } {
    const keepSet = new Set(urls);
    const removed = this.stickers.filter((s) => !keepSet.has(s.url)).map((s) => s.url);
    for (const u of removed) this.blocklist.add(u);
    this.stickers = this.stickers.filter((s) => keepSet.has(s.url));
    this.save();
    this.logger.info({ removed: removed.length, kept: this.stickers.length }, '已清理表情库');
    return { removed: removed.length, kept: this.stickers.length };
  }

  /**
   * 从协议端重新拉取收藏列表。
   *
   * ⚠️ 修正记录：
   *   初版是【覆盖式】——用拉到的 URL 列表直接替换整个库。
   *   实测踩坑：某次拉取只返回 1 张（收藏列表变动），20 张的历史全被清空，
   *   连打过的标签和使用记录一起没了。
   *
   *   现在是【累积式】：拉到的合并进去，拉不到的保留（标记为 mayBeGone，不删）。
   *   理由：表情包的 URL 是稳定的，收藏里没了不代表不能用——
   *   而且她"学会"的意思不该因为一次拉取失败就丢掉。
   */
  async refresh(adapter: OneBotAdapter): Promise<number> {
    try {
      const urls = (await adapter.call('fetch_custom_face', {})) as unknown;
      if (!Array.isArray(urls)) {
        this.logger.warn('fetch_custom_face 返回格式异常');
        return 0;
      }
      if (urls.length === 0) {
        this.logger.warn('收藏列表为空，保留现有表情库');
        return this.stickers.length;
      }

      const existing = new Map(this.stickers.map((s) => [s.url, s]));
      let added = 0;
      let skipped = 0;

      for (const url of urls as string[]) {
        // 被用户明确删掉的表情，不再拉回来
        if (this.blocklist.has(url)) {
          skipped++;
          continue;
        }
        const old = existing.get(url);
        if (old) {
          old.lastSeenAt = Date.now();
          continue;
        }
        existing.set(url, {
          id: url.split('/').slice(-2)[0] ?? url,
          url,
          tags: ['untagged'],
          usedCount: 0,
          lastUsedAt: 0,
          lastSeenAt: Date.now(),
        });
        added++;
      }

      this.stickers = [...existing.values()];
      this.loadedAt = Date.now();
      this.save();
      this.logger.info(
        { fetched: urls.length, added, skippedByBlocklist: skipped, total: this.stickers.length },
        '已拉取收藏表情（累积合并）',
      );
      return this.stickers.length;
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, '拉取收藏表情失败');
      return 0;
    }
  }

  count(): number {
    return this.stickers.length;
  }

  list(): Sticker[] {
    return this.stickers.slice();
  }

  /** 给某个表情打标签 */
  tag(url: string, tags: string[]): boolean {
    const s = this.stickers.find((x) => x.url === url || x.id === url);
    if (!s) return false;
    s.tags = tags;
    this.save();
    return true;
  }

  /**
   * 按场景挑一张表情。
   *
   * 场景 → 候选标签。标签对不上也没关系，会退化成随机。
   */
  pick(scene: StickerScene): Sticker | null {
    if (this.stickers.length === 0) return null;

    const candidates = SCENE_TAGS[scene] ?? [];
    const now = Date.now();

    // 1) 有标签的优先
    let pool = this.stickers.filter(
      (s) => s.tags.some((t) => candidates.includes(t)) && s.tags[0] !== 'untagged',
    );

    // 2) 没标签 → 全部随机
    if (pool.length === 0) pool = this.stickers.slice();

    // 3) 优先挑没用过的 / 很久没用的
    pool.sort((a, b) => {
      const aRecent = now - a.lastUsedAt < 3_600_000 ? 1 : 0;
      const bRecent = now - b.lastUsedAt < 3_600_000 ? 1 : 0;
      if (aRecent !== bRecent) return aRecent - bRecent;
      return a.usedCount - b.usedCount || Math.random() - 0.5;
    });

    // 4) 从前 3 个里随机，避免每次都同一张
    const top = pool.slice(0, Math.min(3, pool.length));
    const chosen = top[Math.floor(Math.random() * top.length)];
    chosen.usedCount++;
    chosen.lastUsedAt = now;
    this.save();
    return chosen;
  }
}

export type StickerScene =
  | 'happy'
  | 'annoyed'
  | 'sleepy'
  | 'hungry'
  | 'confused'
  | 'proud'
  | 'sad'
  | 'generic';

/** 场景 → 候选标签（中文，方便你手工标注） */
const SCENE_TAGS: Record<StickerScene, string[]> = {
  happy: ['开心', '笑', '开心大笑', '嘿嘿', '得意'],
  annoyed: ['无语', '白眼', '嫌弃', '生气', '啧', '嫌烦'],
  sleepy: ['困', '睡', '打哈欠', '晚安'],
  hungry: ['饿', '饭', '吃', '馋'],
  confused: ['疑惑', '问号', '不懂', '愣'],
  proud: ['得意', '骄傲', '哼'],
  sad: ['委屈', '难过', '哭'],
  generic: [],
};

/** 从文本推断场景 */
export function inferScene(text: string): StickerScene {
  if (/困|睡|晚|打哈欠/.test(text)) return 'sleepy';
  if (/饿|饭|吃|馋/.test(text)) return 'hungry';
  if (/无语|烦|走开|哼|嫌|啧/.test(text)) return 'annoyed';
  if (/哈哈|笑|乐|开心/.test(text)) return 'happy';
  if (/\?|？|不知道|不懂|什么/.test(text)) return 'confused';
  if (/厉害|牛|强|得意/.test(text)) return 'proud';
  if (/难过|委屈|呜呜|伤心/.test(text)) return 'sad';
  return 'generic';
}
