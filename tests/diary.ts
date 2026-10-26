/**
 * 日记测试。
 *
 * 用户给定的格式（2026-10-26 重构后的规范）：
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
 * 重点验证：
 *  - 不值得记的东西不写
 *  - 值得记的按新格式写，六段齐全
 *  - 第二人称（「你」= 阿龙）
 *  - 天气是真实的（拿不到就不写，不瞎编）
 *  - 一天一个文件，同一天追加
 *  - 失败不影响调用方
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Diary, parseDiaryJson, type DiaryContent } from '../src/diary';
import { toChineseWeather } from '../src/diary/weather';
import { initLogger } from '../src/infra/logger';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass++;
    console.log('  ✅ ' + name);
  } else {
    fail++;
    console.log('  ❌ ' + name + ' ' + extra);
  }
}

const logger = initLogger({ level: 'error' });

const SAMPLE: DiaryContent = {
  title: '第一次自己做饭',
  mood: '有点累但挺开心',
  place: '家中',
  opening: '今天总体上比较忙，最让我有成就感的是你说晚上第一次自己做饭。',
  what: '晚上六点你爸妈还没回家，你就自己试着做西红柿炒鸡蛋。你说先洗西红柿打鸡蛋，按手机步骤一步步做。',
  detail: '你说倒油的时候油突然滋啦一声，吓了你一跳。鸡蛋倒进锅里翻了几下，虽然有点碎，西红柿也切得大小不一。',
  feeling: '你妈尝了一口说第一次做成这样已经很好了。你觉得做饭看着简单，其实很需要耐心，火候和顺序都很重要。',
  ending: '你今天有点累，但挺有收获。你说明天想再学一道简单的菜，希望下次做得更好看。',
};

/** 假 LLM */
class FakeLlm {
  judgeResult = true;
  contentResult: string = JSON.stringify(SAMPLE);
  calls: string[] = [];

  constructor(judge = true, content?: string) {
    this.judgeResult = judge;
    if (content !== undefined) this.contentResult = content;
  }

  async generate(messages: Array<{ content?: unknown }>): Promise<{ text: string }> {
    const p = String(messages[0]?.content ?? '');
    this.calls.push(p);
    if (p.includes('判断下面这条消息值不值得写进「日记」')) {
      return { text: this.judgeResult ? 'true' : 'false' };
    }
    return { text: this.contentResult };
  }
}

/** 假天气（不真的请求网络） */
class FakeWeather {
  text = '晴';
  constructor(t = '晴') { this.text = t; }
  async today(): Promise<string> { return this.text; }
}

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'diary-'));
}

function cfg(dir: string) {
  return {
    enabled: true,
    dir,
    minChars: 6,
    judgeTemperature: 0.1,
    maxSectionChars: 120,
    weather: { city: '', timeoutMs: 8000 },
  };
}

async function main(): Promise<void> {
  console.log('\n[1] 寒暄和噪音不触发任何 LLM 调用');
  {
    const dir = makeDir();
    const llm = new FakeLlm();
    const d = new Diary(cfg(dir), llm as any, logger, new FakeWeather() as any);

    for (const t of ['在吗', '嗯', '哈哈', '6', '？', '[表情]', '好']) {
      await d.maybeWrite(t, []);
    }
    check('噪音零 LLM 调用', llm.calls.length === 0, `实际 ${llm.calls.length} 次`);
    check('没生成文件', fs.readdirSync(dir).length === 0);
  }

  console.log('\n[2] 判定不值得 → 不写文件');
  {
    const dir = makeDir();
    const llm = new FakeLlm(false);
    const d = new Diary(cfg(dir), llm as any, logger, new FakeWeather() as any);
    const r = await d.maybeWrite('今天天气不错', []);
    check('返回 null', r === null);
    check('没生成文件', fs.readdirSync(dir).length === 0);
  }

  console.log('\n[3] 写入格式：日期行 + 地点 + 心情 + 标题 + 六段');
  {
    const dir = makeDir();
    const llm = new FakeLlm();
    const d = new Diary(cfg(dir), llm as any, logger, new FakeWeather('晴') as any);
    d.now = () => new Date(2026, 9, 26, 19, 30, 0);   // 2026-10-26 是周一

    const r = await d.maybeWrite('今天第一次自己做饭，还挺有成就感的', []);
    check('文件写成功', r !== null && fs.existsSync(r.file));

    const c = fs.readFileSync(r!.file, 'utf8');

    // 第一行格式
    check('第一行是「日期  星期  天气」', /^2026年10月26日  星期一  晴$/m.test(c), c.split('\n')[0]);
    check('有地点行', /^地点：家中$/m.test(c));
    check('有心情行', /^心情：有点累但挺开心$/m.test(c));
    check('有标题行', /^标题：第一次自己做饭$/m.test(c));

    // 六段标题
    check('有【开头】', c.includes('【开头】'));
    check('有【正文一：发生了什么】', c.includes('【正文一：发生了什么】'));
    check('有【正文二：细节】', c.includes('【正文二：细节】'));
    check('有【正文三：感受和想法】', c.includes('【正文三：感受和想法】'));
    check('有【结尾】', c.includes('【结尾】'));

    // 六段正文都在
    check('开头正文在', c.includes('今天总体上比较忙'));
    check('正文一在', c.includes('西红柿炒鸡蛋'));
    check('正文二在', c.includes('滋啦一声'));
    check('正文三在', c.includes('很需要耐心'));
    check('结尾在', c.includes('明天想再学一道'));

    // 第二人称
    check('用第二人称「你」', c.includes('你'));
    check('没有第三人称「阿龙说」', !c.includes('阿龙说'));
  }

  console.log('\n[4] 天气拿不到 → 不写那一段，但日记照写');
  {
    const dir = makeDir();
    const llm = new FakeLlm();
    const d = new Diary(cfg(dir), llm as any, logger, new FakeWeather('') as any);
    d.now = () => new Date(2026, 9, 26, 19, 30, 0);

    const r = await d.maybeWrite('今天面试挂了，感觉自己特别没用', []);
    check('文件写成功', r !== null);
    const c = fs.readFileSync(r!.file, 'utf8');
    check('第一行没有多余空格', /^2026年10月26日  星期一$/m.test(c), c.split('\n')[0]);
    check('其余内容正常', c.includes('【开头】'));
  }

  console.log('\n[5] 星期几算对');
  {
    const dir = makeDir();
    const llm = new FakeLlm();
    const d = new Diary(cfg(dir), llm as any, logger, new FakeWeather('多云') as any);

    const cases: Array<[Date, string]> = [
      [new Date(2026, 9, 26), '星期一'],
      [new Date(2026, 9, 27), '星期二'],
      [new Date(2026, 9, 31), '星期六'],
      [new Date(2026, 10, 1), '星期日'],
    ];
    for (const [date, expect] of cases) {
      d.now = () => date;
      const r = await d.maybeWrite(`测试星期几，这是第${date.getDate()}天的事`, []);
      const c = fs.readFileSync(r!.file, 'utf8');
      check(`${date.getMonth() + 1}/${date.getDate()} 是${expect}`, c.includes(expect), c.split('\n')[0]);
    }
  }

  console.log('\n[6] 一天一个文件，同一天追加');
  {
    const dir = makeDir();
    let n = 0;
    const llm = new FakeLlm();
    // 每次换标题，验证是追加不是覆盖
    Object.defineProperty(llm, 'contentResult', {
      get() {
        const c = { ...SAMPLE, title: `第${n + 1}件事` };
        return JSON.stringify(c);
      },
    });

    const d = new Diary(cfg(dir), llm as any, logger, new FakeWeather() as any);
    d.now = () => new Date(2026, 9, 26, 14, 30, 0);

    n = 0; const r1 = await d.maybeWrite('第一件事，挺重要的', []);
    n = 1; const r2 = await d.maybeWrite('第二件事也很重要', []);
    n = 2; const r3 = await d.maybeWrite('第三件事又来了', []);

    check('三次同文件', r1!.file === r2!.file && r2!.file === r3!.file);
    check('目录只有一个文件', fs.readdirSync(dir).length === 1);

    const c = fs.readFileSync(r1!.file, 'utf8');
    check('三条标题都在', c.includes('标题：第1件事') && c.includes('标题：第2件事') && c.includes('标题：第3件事'));
    check('有分隔线', c.includes('────'));
    check('count 正确', r3!.count === 3, String(r3!.count));
  }

  console.log('\n[7] 跨天 → 另起文件');
  {
    const dir = makeDir();
    const llm = new FakeLlm();
    const d = new Diary(cfg(dir), llm as any, logger, new FakeWeather() as any);

    d.now = () => new Date(2026, 9, 26, 23, 50, 0);
    const r1 = await d.maybeWrite('26号的事，比较重要', []);
    d.now = () => new Date(2026, 9, 27, 0, 10, 0);
    const r2 = await d.maybeWrite('27号凌晨的事也很重要', []);

    check('两个不同文件', r1!.file !== r2!.file);
    check('含 26 号', r1!.file.includes('2026-10-26'));
    check('含 27 号', r2!.file.includes('2026-10-27'));
    check('目录两个文件', fs.readdirSync(dir).length === 2);
  }

  console.log('\n[8] 目录不存在 → 自动创建');
  {
    const base = makeDir();
    const deep = path.join(base, 'a', 'b', '日记');
    const llm = new FakeLlm();
    const d = new Diary(cfg(deep), llm as any, logger, new FakeWeather() as any);
    check('目录初始不存在', !fs.existsSync(deep));
    const r = await d.maybeWrite('我说了一件挺重要的事', []);
    check('写的时候创建了目录', fs.existsSync(deep));
    check('文件写成功', r !== null && fs.existsSync(r.file));
  }

  console.log('\n[9] 关闭时什么都不做');
  {
    const dir = makeDir();
    const llm = new FakeLlm();
    const d = new Diary({ ...cfg(dir), enabled: false }, llm as any, logger, new FakeWeather() as any);
    const r = await d.maybeWrite('我说了一件很重要的事', []);
    check('返回 null', r === null);
    check('没调 LLM', llm.calls.length === 0);
    check('没生成文件', fs.readdirSync(dir).length === 0);
  }

  console.log('\n[10] LLM 抛错不影响调用方');
  {
    const dir = makeDir();
    const bad = { async generate() { throw new Error('网络炸了'); } };
    const d = new Diary(cfg(dir), bad as any, logger, new FakeWeather() as any);
    let threw = false;
    try { await d.maybeWrite('我说了一件很重要的事', []); } catch { threw = true; }
    check('没有向上抛异常', !threw);
    check('没生成文件', fs.readdirSync(dir).length === 0);
  }

  console.log('\n[11] 天气拿不到也不抛错');
  {
    const dir = makeDir();
    const llm = new FakeLlm();
    const badWeather = { async today() { throw new Error('网络不通'); } };
    const d = new Diary(cfg(dir), llm as any, logger, badWeather as any);
    d.now = () => new Date(2026, 9, 26, 10, 0, 0);
    let threw = false;
    let r: any = null;
    try { r = await d.maybeWrite('我说了一件挺重要的事', []); } catch { threw = true; }
    check('没有抛异常', !threw);
    check('日记仍然写了', r !== null && fs.existsSync(r.file));
  }

  console.log('\n[12] JSON 解析容错');
  {
    check('纯 JSON', parseDiaryJson(JSON.stringify(SAMPLE)) !== null);
    check('``` 包裹', parseDiaryJson('```json\n' + JSON.stringify(SAMPLE) + '\n```') !== null);
    check('前后有废话', parseDiaryJson('好的，这是日记：\n' + JSON.stringify(SAMPLE) + '\n希望满意') !== null);
    check('空串返回 null', parseDiaryJson('') === null);
    check('非 JSON 返回 null', parseDiaryJson('今天挺好的') === null);
    check('缺字段但有正文 → 可用', parseDiaryJson('{"opening":"今天你说了很多话，我一直在听。"}') !== null);
    check('全空 → null', parseDiaryJson('{"title":"x"}') === null);
  }

  console.log('\n[13] 英文天气转中文');
  {
    const cases: Array<[string, string]> = [
      ['Sunny', '晴'],
      ['Clear', '晴'],
      ['Partly cloudy', '多云'],
      ['Overcast', '阴'],
      ['Patchy rain nearby', '小雨'],
      ['Light drizzle', '小雨'],
      ['Heavy rain', '大雨'],
      ['Moderate rain', '中雨'],
      ['Thundery outbreaks possible', '雷阵雨'],
      ['Light snow', '小雪'],
      ['Blizzard', '大雪'],
      ['Fog', '雾'],
      ['Mist', '雾'],
      ['', ''],
    ];
    for (const [en, zh] of cases) {
      check(`"${en}" → "${zh}"`, toChineseWeather(en) === zh, toChineseWeather(en));
    }
    check('认不出的短词保留原文', toChineseWeather('Unknown') === 'Unknown', toChineseWeather('Unknown'));
    check('认不出的长词截断到 8 字符', toChineseWeather('Weird weather') === 'Weird we', toChineseWeather('Weird weather'));
  }

  console.log('\n[14] 段落缺失时不写空标题');
  {
    const dir = makeDir();
    const partial = { ...SAMPLE, detail: '', ending: '' };
    const llm = new FakeLlm(true, JSON.stringify(partial));
    const d = new Diary(cfg(dir), llm as any, logger, new FakeWeather() as any);
    d.now = () => new Date(2026, 9, 26, 10, 0, 0);
    const r = await d.maybeWrite('我说了一件挺重要的事', []);
    const c = fs.readFileSync(r!.file, 'utf8');
    check('缺的段落标题不出现', !c.includes('【正文二：细节】'));
    check('缺的结尾标题不出现', !c.includes('【结尾】'));
    check('有的段落还在', c.includes('【开头】') && c.includes('【正文一：发生了什么】'));
  }

  console.log('\n[15] 中文和空格路径');
  {
    const base = makeDir();
    const dir = path.join(base, '我的 日记', '2026');
    const llm = new FakeLlm();
    const d = new Diary(cfg(dir), llm as any, logger, new FakeWeather() as any);
    d.now = () => new Date(2026, 9, 26, 10, 0, 0);
    const r = await d.maybeWrite('我说了一件挺重要的事', []);
    check('中文空格路径写成功', r !== null && fs.existsSync(r.file));
    check('文件名正确', path.basename(r!.file) === '2026-10-26.md');
  }

  console.log('\n[16] list 按日期倒序');
  {
    const dir = makeDir();
    for (const n of ['2026-10-24.md', '2026-10-26.md', '2026-10-25.md', 'readme.txt']) {
      fs.writeFileSync(path.join(dir, n), 'x');
    }
    const d = new Diary(cfg(dir), new FakeLlm() as any, logger, new FakeWeather() as any);
    const list = d.list();
    check('只列 md', list.length === 3, String(list.length));
    check('倒序', list[0].date === '2026-10-26', list[0]?.date);
    check('最旧在最后', list[2].date === '2026-10-24', list[2]?.date);
  }

  console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
