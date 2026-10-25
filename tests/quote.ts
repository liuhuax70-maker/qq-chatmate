/**
 * 引用回复判断测试。
 *
 * 需求：不是所有消息都引用。只有信息量大时才引用——
 * 单条短消息引用反而显得郑重、不自然。
 *
 * 运行：npm run test:quote
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { MessagePipeline } from '../src/pipeline';
import { Store } from '../src/store/db';
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

function makePipeline(): { p: MessagePipeline; store: Store } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-'));
  const store = new Store(path.join(dir, 'test.db'));
  const p = new MessagePipeline(
    {
      mergeWindowMs: 100,
      mergeMaxWaitMs: 400,
      dedup: { enabled: true, windowMs: 5000 },
      filter: { allowedUsers: ['10001'], blockedUsers: [], dropSelf: true, dropGroupEvents: true },
      throttle: {
        burstWindowSeconds: 60,
        burstMaxReplies: 10,
        burstSkipProbability: 0,
        floodWindowSeconds: 10,
        floodThreshold: 20,
        floodSkipProbability: 0,
        cooldownAfterSkipSeconds: 0,
      },
    },
    logger,
  );
  return { p, store };
}

console.log('\n[1] 单条短消息 → 不引用');
{
  const { p, store } = makePipeline();
  check('"在吗" 不引用', p.shouldQuote('在吗', 1) === false);
  check('"嗯" 不引用', p.shouldQuote('嗯', 1) === false);
  check('"哈哈哈" 不引用', p.shouldQuote('哈哈哈', 1) === false);
  check('"吃了" 不引用', p.shouldQuote('吃了', 1) === false);
  check('"今天好累" 不引用（8字，未达阈值）', p.shouldQuote('今天好累', 1) === false);
  store.close();
}

console.log('\n[2] 单条长消息 → 引用');
{
  const { p, store } = makePipeline();
  check(
    '15 字以上引用',
    p.shouldQuote('我今天下午去了一趟超市买了好多东西回来', 1) === true,
  );
  check(
    '刚好 15 字边界',
    p.shouldQuote('一二三四五六七八九十一二三四五', 1) === true,
  );
  check(
    '14 字不引用',
    p.shouldQuote('一二三四五六七八九十一二三四', 1) === false,
  );
  store.close();
}

console.log('\n[3] 连发多条 → 引用');
{
  const { p, store } = makePipeline();
  check('2 条合并 → 引用', p.shouldQuote('在吗\n有事', 2) === true);
  check('3 条合并 → 引用', p.shouldQuote('a\nb\nc', 3) === true);
  check('即使字数少，多条也引用', p.shouldQuote('嗯\n对', 2) === true);
  store.close();
}

console.log('\n[4] 带问号的具体提问 → 引用');
{
  const { p, store } = makePipeline();
  check('"你昨天说的那个是什么?" → 引用', p.shouldQuote('你昨天说的那个是什么？', 1) === true);
  check('"在吗?" → 不引用（太短）', p.shouldQuote('在吗？', 1) === false);
  check('"咋了?" → 不引用（太短）', p.shouldQuote('咋了?', 1) === false);
  store.close();
}

console.log('\n[5] 多行（他自己分段打字）→ 引用');
{
  const { p, store } = makePipeline();
  check('多行且字数够 → 引用', p.shouldQuote('今天上班\n好烦啊真的', 1) === true);
  check('多行但太短 → 不引用', p.shouldQuote('嗯\n对', 1) === false);
  store.close();
}

console.log('\n[6] 空白不计入字数');
{
  const { p, store } = makePipeline();
  const withSpaces = '一 二 三 四 五 六 七 八 九 十 一 二 三 四 五';
  check('空格不计入 → 15 字算引用', p.shouldQuote(withSpaces, 1) === true);
  const padded = '  嗯  ';
  check('纯空白不影响判断', p.shouldQuote(padded, 1) === false);
  store.close();
}

console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
process.exit(fail > 0 ? 1 : 0);
