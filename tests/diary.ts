/**
 * 日记测试。
 *
 * 重点验证：
 *  - 不值得记的东西不写（寒暄、指令、无内容）
 *  - 值得记的写进去，且是第二人称
 *  - 一天一个文件，同一天追加不覆盖
 *  - 目录不存在会自动创建
 *  - 写失败不影响调用方
 *
 * 用假 LLM，不打真实 API。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Diary } from '../src/diary';
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

/** 假 LLM：按 prompt 内容返回预设结果，不打网络 */
class FakeLlm {
  constructor(
    private judge: (p: string) => boolean,
    private compose: (p: string) => string,
  ) {}
  calls: string[] = [];
  async generate(messages: Array<{ content?: unknown }>): Promise<{ text: string }> {
    const p = String(messages[0]?.content ?? '');
    this.calls.push(p);
    if (p.includes('判断下面这条消息值不值得写进「日记」')) {
      return { text: this.judge(p) ? 'true' : 'false' };
    }
    return { text: this.compose(p) };
  }
}

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'diary-'));
}

function cfg(dir: string) {
  return { enabled: true, dir, minChars: 6, judgeTemperature: 0.1, maxEntryChars: 180 };
}

async function main(): Promise<void> {
  console.log('\n[1] 寒暄和噪音不触发任何 LLM 调用');
  {
    const dir = makeDir();
    const llm = new FakeLlm(() => true, () => '不该写');
    const d = new Diary(cfg(dir), llm as any, logger);

    for (const t of ['在吗', '嗯', '哈哈', '6', '？', '[表情]', '好']) {
      await d.maybeWrite(t, []);
    }
    check('噪音一次 LLM 都没调', llm.calls.length === 0, `实际 ${llm.calls.length} 次`);
    check('没生成文件', fs.readdirSync(dir).length === 0);
  }

  console.log('\n[2] LLM 判定不值得 → 不写文件');
  {
    const dir = makeDir();
    const llm = new FakeLlm(() => false, () => '不该写');
    const d = new Diary(cfg(dir), llm as any, logger);
    const r = await d.maybeWrite('今天天气不错', []);
    check('返回 null', r === null);
    check('没生成文件', fs.readdirSync(dir).length === 0);
  }

  console.log('\n[3] 判定值得 → 写入，且是第二人称');
  {
    const dir = makeDir();
    const entry = '你说今天面试挂了，说得挺轻松的。我知道那种轻松是装的。';
    const llm = new FakeLlm(() => true, () => entry);
    const d = new Diary(cfg(dir), llm as any, logger);

    const r = await d.maybeWrite('今天面试挂了，感觉自己特别没用', []);
    check('返回了写入结果', r !== null);
    check('文件存在', r !== null && fs.existsSync(r.file));

    const content = fs.readFileSync(r!.file, 'utf8');
    check('有日期标题', /^# \d{4} 年 \d{1,2} 月 \d{1,2} 日/m.test(content));
    check('有时间戳', /^## \d{2}:\d{2}$/m.test(content));
    check('正文写进去了', content.includes('你说今天面试挂了'));
    check('用第二人称「你」', content.includes('你'));
    check('没有第三人称「阿龙说」', !content.includes('阿龙说'));
  }

  console.log('\n[4] 一天一个文件：同一天追加，不覆盖');
  {
    const dir = makeDir();
    let n = 0;
    const llm = new FakeLlm(
      () => true,
      () => `第${++n}条：你说了一件事，我记住了。`,
    );
    const d = new Diary(cfg(dir), llm as any, logger);

    // 固定在同一分钟，验证"同一分钟合并成一段"
    d.now = () => new Date(2026, 9, 26, 14, 30, 5);

    const r1 = await d.maybeWrite('第一件事发生了，我很难受', []);
    const r2 = await d.maybeWrite('第二件事也发生了，我还是难受', []);
    const r3 = await d.maybeWrite('第三件事又来了', []);

    check('三次写的是同一个文件', r1!.file === r2!.file && r2!.file === r3!.file);
    check('目录里只有一个文件', fs.readdirSync(dir).length === 1, fs.readdirSync(dir).join(','));

    const content = fs.readFileSync(r1!.file, 'utf8');
    check('三条正文都在', content.includes('第1条') && content.includes('第2条') && content.includes('第3条'));
    check('同一分钟只起一个时间戳', (content.match(/^## \d{2}:\d{2}$/gm) ?? []).length === 1,
      String((content.match(/^## \d{2}:\d{2}$/gm) ?? []).length));
    check('日期标题只有 1 个', (content.match(/^# \d{4} 年/gm) ?? []).length === 1);
  }

  console.log('\n[4b] 换一分钟 → 另起一个时间段');
  {
    const dir = makeDir();
    let n = 0;
    const llm = new FakeLlm(() => true, () => `第${++n}条。`);
    const d = new Diary(cfg(dir), llm as any, logger);

    d.now = () => new Date(2026, 9, 26, 14, 30, 5);
    const r1 = await d.maybeWrite('第一件事，挺难受的', []);

    d.now = () => new Date(2026, 9, 26, 16, 5, 0);
    const r2 = await d.maybeWrite('过了两小时又一件事', []);

    const content = fs.readFileSync(r1!.file, 'utf8');
    check('同一文件', r1!.file === r2!.file);
    check('两个时间段', (content.match(/^## \d{2}:\d{2}$/gm) ?? []).length === 2,
      String((content.match(/^## \d{2}:\d{2}$/gm) ?? []).length));
    check('时间戳是 14:30', content.includes('## 14:30'));
    check('时间戳是 16:05', content.includes('## 16:05'));
  }

  console.log('\n[4c] 跨天 → 另起一个文件');
  {
    const dir = makeDir();
    let n = 0;
    const llm = new FakeLlm(() => true, () => `第${++n}条。`);
    const d = new Diary(cfg(dir), llm as any, logger);

    d.now = () => new Date(2026, 9, 26, 23, 50, 0);
    const r1 = await d.maybeWrite('26 号的事，比较重要', []);

    d.now = () => new Date(2026, 9, 27, 0, 10, 0);
    const r2 = await d.maybeWrite('27 号凌晨的事', []);

    check('两个不同的文件', r1!.file !== r2!.file);
    check('文件名含 26 号', r1!.file.includes('2026-10-26'));
    check('文件名含 27 号', r2!.file.includes('2026-10-27'));
    check('目录里两个文件', fs.readdirSync(dir).length === 2);
  }

  console.log('\n[5] 目录不存在 → 自动创建');
  {
    const base = makeDir();
    const deep = path.join(base, 'a', 'b', '日记');
    const llm = new FakeLlm(() => true, () => '你说了一件事。');
    const d = new Diary(cfg(deep), llm as any, logger);

    check('目录初始不存在', !fs.existsSync(deep));
    const r = await d.maybeWrite('我说了一件事，挺重要的', []);
    check('写的时候创建了目录', fs.existsSync(deep));
    check('文件写成功', r !== null && fs.existsSync(r.file));
  }

  console.log('\n[6] 关闭时什么都不做');
  {
    const dir = makeDir();
    const llm = new FakeLlm(() => true, () => '不该写');
    const d = new Diary({ ...cfg(dir), enabled: false }, llm as any, logger);
    const r = await d.maybeWrite('我说了一件很重要的事', []);
    check('返回 null', r === null);
    check('没调 LLM', llm.calls.length === 0);
    check('没生成文件', fs.readdirSync(dir).length === 0);
  }

  console.log('\n[7] LLM 抛错不影响调用方');
  {
    const dir = makeDir();
    const bad = {
      async generate() {
        throw new Error('网络炸了');
      },
    };
    const d = new Diary(cfg(dir), bad as any, logger);
    let threw = false;
    try {
      await d.maybeWrite('我说了一件很重要的事', []);
    } catch {
      threw = true;
    }
    check('没有向上抛异常', !threw);
    check('没生成文件', fs.readdirSync(dir).length === 0);
  }

  console.log('\n[8] 正文清理：去掉 markdown 包裹和标题');
  {
    const dir = makeDir();
    const llm = new FakeLlm(
      () => true,
      () => '```markdown\n# 日记\n\n你说你累了。我没接话。\n```',
    );
    const d = new Diary(cfg(dir), llm as any, logger);
    const r = await d.maybeWrite('我真的好累啊，撑不住了', []);
    const content = fs.readFileSync(r!.file, 'utf8');
    check('去掉了代码块标记', !content.includes('```'));
    check('去掉了多余的标题', !content.includes('# 日记'));
    check('保留了正文', content.includes('你说你累了'));
  }

  console.log('\n[9] fileFor 用当天日期命名');
  {
    const dir = makeDir();
    const d = new Diary(cfg(dir), new FakeLlm(() => true, () => 'x') as any, logger);
    const f = d.fileFor(new Date(2026, 9, 26));   // 2026-10-26
    check('文件名是 YYYY-MM-DD.md', path.basename(f) === '2026-10-26.md', path.basename(f));
    check('路径在指定目录下', path.dirname(f) === dir);
  }

  console.log('\n[10] list 按日期倒序');
  {
    const dir = makeDir();
    for (const name of ['2026-10-24.md', '2026-10-26.md', '2026-10-25.md', 'readme.txt']) {
      fs.writeFileSync(path.join(dir, name), 'x');
    }
    const d = new Diary(cfg(dir), new FakeLlm(() => true, () => 'x') as any, logger);
    const list = d.list();
    check('只列 .md 日期文件', list.length === 3, String(list.length));
    check('倒序：最新在前', list[0].date === '2026-10-26', list[0]?.date);
    check('最后是最旧的', list[2].date === '2026-10-24', list[2]?.date);
  }

  console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
