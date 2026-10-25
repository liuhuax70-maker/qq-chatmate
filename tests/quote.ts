/**
 * 引用回复挑选测试。
 *
 * 需求澄清（重要）：
 *   ❌ 不是"一条 15 字以上的消息就引用"
 *   ✅ 而是"多条消息时，挑几个重要的分别引用回复"
 *
 * 场景：你连发五六条，信息量很大，
 *       她挑其中最有内容的几条，每条单独引用回一句，
 *       而不是笼统回一句总的话。
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

/** 造一条缓冲消息 */
function m(text: string, id: number, at = Date.now()): any {
  return { text, messageId: id, at };
}

console.log('\n[1] 单条消息 → 永不引用');
{
  const { p, store } = makePipeline();
  check('单条短消息不引用', p.pickQuotable([m('在吗', 1)]).length === 0);
  check(
    '单条长消息也不引用（关键：需求澄清点）',
    p.pickQuotable([m('我今天下午去了一趟超市买了好多东西回来真的很累', 1)]).length === 0,
  );
  store.close();
}

console.log('\n[2] 两条消息 → 只挑 1 条');
{
  const { p, store } = makePipeline();
  const picked = p.pickQuotable([m('在吗', 1), m('我有个事想跟你说', 2)]);
  check('两条挑 1 条', picked.length === 1, `实际 ${picked.length}`);
  check('挑的是有内容的那条', picked[0]?.text.includes('有个事') === true, picked[0]?.text);
  store.close();
}

console.log('\n[3] 多条消息 → 挑 2-3 条');
{
  const { p, store } = makePipeline();
  const msgs = [
    m('在吗', 1),
    m('我今天被老板骂了', 2),
    m('好烦', 3),
    m('你说我是不是该辞职', 4),
    m('唉', 5),
  ];
  const picked = p.pickQuotable(msgs);
  check('挑出 2-3 条', picked.length >= 2 && picked.length <= 3, `实际 ${picked.length}`);
  check(
    '包含最重要的那条（问辞职）',
    picked.some((x) => x.text.includes('辞职')),
    picked.map((x) => x.text).join(' | '),
  );
  store.close();
}

console.log('\n[4] 带问号的优先');
{
  const { p, store } = makePipeline();
  const picked = p.pickQuotable([
    m('今天天气还行', 1),
    m('哦对了你觉得我该去吗', 2),
    m('反正随便', 3),
  ]);
  check('问句被挑中', picked.some((x) => x.text.includes('该去吗')), picked.map((x) => x.text).join(' | '));
  store.close();
}

console.log('\n[5] 极短消息不单独引用');
{
  const { p, store } = makePipeline();
  const picked = p.pickQuotable([m('嗯', 1), m('哦', 2), m('好', 3)]);
  check('全是无意义的短句 → 不引用', picked.length === 0, `实际 ${picked.length}`);
  store.close();
}

console.log('\n[6] 数量上限 3 条');
{
  const { p, store } = makePipeline();
  const msgs = Array.from({ length: 10 }, (_, i) =>
    m(`这是第${i + 1}条有内容的消息`, i + 1, Date.now() + i),
  );
  const picked = p.pickQuotable(msgs);
  check('最多 3 条', picked.length <= 3, `实际 ${picked.length}`);
  store.close();
}

console.log('\n[7] 引用顺序跟说话顺序一致');
{
  const { p, store } = makePipeline();
  const base = Date.now();
  const picked = p.pickQuotable([
    m('第一句话比较短', 1, base),
    m('第二句很长很长很长很长的内容', 2, base + 100),
    m('第三句', 3, base + 200),
  ]);
  const ids = picked.map((x) => x.messageId);
  const sorted = [...ids].sort((a, b) => Number(a) - Number(b));
  check('按原始顺序返回', JSON.stringify(ids) === JSON.stringify(sorted), JSON.stringify(ids));
  store.close();
}

console.log('\n[8] 意思相近的不重复挑');
{
  const { p, store } = makePipeline();
  const picked = p.pickQuotable([
    m('我今天真的很累啊', 1),
    m('我今天真的很累啊', 2),
    m('别的什么', 3),
  ]);
  check('重复内容只挑一条', picked.filter((x) => x.text.includes('真的很累')).length <= 1);
  store.close();
}

console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
process.exit(fail > 0 ? 1 : 0);
