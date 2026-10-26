import type { Logger } from 'pino';

/**
 * 日记头部的天气。
 *
 * 为什么需要它：用户给的日记格式第一行是
 *   「2026年10月26日  星期一  晴」
 * 「晴」必须是真实天气，不能瞎编——每天的日记都写「晴」会露馅。
 *
 * 数据源：wttr.in（免费、无需 key、支持中文城市名）。
 * 实测可用，但返回的是英文天气词（Sunny / Patchy rain nearby ...），
 * 所以要自己做一层英文 → 中文的映射。
 *
 * 失败策略：拿不到就返回空字符串，日记头部只写日期和星期，
 * 绝不让天气请求拖慢或阻断写日记。
 */

export interface WeatherConfig {
  /** 城市名（支持中文），空则用 IP 定位 */
  city: string;
  /** 请求超时（毫秒） */
  timeoutMs: number;
}

interface CacheEntry {
  /** 缓存属于哪一天（YYYY-MM-DD），跨天就重新取 */
  day: string;
  text: string;
}

/** 英文天气描述 → 中文。按关键词匹配，长的放前面避免被短的抢先命中。 */
const WEATHER_MAP: Array<[RegExp, string]> = [
  [/thundery|thunder|storm/i, '雷阵雨'],
  [/heavy\s+(rain|shower)/i, '大雨'],
  [/moderate\s+rain/i, '中雨'],
  [/light\s+(rain|drizzle)|patchy\s+rain|drizzle|rain\s+shower/i, '小雨'],
  [/freez|sleet|ice\s+pellets/i, '雨夹雪'],
  [/blizzard|heavy\s+snow/i, '大雪'],
  [/moderate\s+snow/i, '中雪'],
  [/light\s+snow|patchy\s+snow|snow\s+shower|snow/i, '小雪'],
  [/fog|mist/i, '雾'],
  [/overcast/i, '阴'],
  [/cloudy/i, '多云'],
  [/sunny|clear/i, '晴'],
];

/** 英文天气描述转中文；认不出来就用原文的前几个字符，不硬编 */
export function toChineseWeather(raw: string): string {
  const t = (raw ?? '').trim();
  if (!t) return '';
  for (const [re, zh] of WEATHER_MAP) {
    if (re.test(t)) return zh;
  }
  return t.slice(0, 8);
}

export class WeatherService {
  private cfg: WeatherConfig;
  private logger: Logger;
  private cache: CacheEntry | null = null;

  constructor(cfg: WeatherConfig, logger: Logger) {
    this.cfg = cfg;
    this.logger = logger;
  }

  private dayKey(d = new Date()): string {
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  /**
   * 取今天的天气（中文，如「晴」）。
   * 失败返回空字符串——日记头部会少这一段，但不影响写日记。
   */
  async today(now = new Date()): Promise<string> {
    const key = this.dayKey(now);

    // 同一天只请求一次
    if (this.cache && this.cache.day === key) return this.cache.text;

    const city = encodeURIComponent((this.cfg.city || '').trim());
    const url = `https://wttr.in/${city}?format=%C`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
      let text = '';
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (res.ok) text = (await res.text()).trim();
      } finally {
        clearTimeout(timer);
      }

      const zh = toChineseWeather(text);
      this.cache = { day: key, text: zh };
      if (zh) this.logger.debug({ raw: text, zh, city: this.cfg.city }, '天气已获取');
      return zh;
    } catch (err) {
      // 网络问题很常见（代理、墙、离线），降级为不写天气
      this.logger.debug({ err: (err as Error).message }, '天气获取失败，日记将省略天气');
      this.cache = { day: key, text: '' };
      return '';
    }
  }

  /** 清掉缓存（测试或手动刷新用） */
  clearCache(): void {
    this.cache = null;
  }
}
