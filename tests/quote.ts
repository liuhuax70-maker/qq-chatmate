/**
 * 引用回复挑选测试（v3）。
 *
 * 用户澄清的三条规则：
 *   1) 分批边界是「她上次说话」，不是固定时间窗口
 *   2) 同一时间窗内的多条，才需要引用回复
 *   3) 不是每条都引用——有些消息本来能组合成一句
 *
 * 典型场景：
 *   「我今天」+「被老板骂了」+「烦死了」  ← 同一件事，合成一句回，不引用
 *   「在吗」+「问你个事」+「你觉得我该辞职吗」 ← 三件事，挑重要的引用
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
      mergeWindowMs: 3500,
      mergeMaxWaitMs: 12000,
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

/** 造缓冲消息，at 相对 base 偏移 */
function m(text: string, id: number, offsetMs: number, base: number): any {
  return { text, messageId: id, at: base + offsetMs };
}

console.log('\n[1] 单条消息 → 永不引用');
{
  const { p, store } = makePipeline();
  const base = Date.now();
  check('单条短消息不引用', p.pickQuotable([m('在吗', 1, 0, base)]).length === 0);
  check(
    '单条长消息也不引用（关键澄清点）',
    p.pickQuotable([m('我今天下午去了一趟超市买了好多东西回来真的很累', 1, 0, base)]).length === 0,
  );
  store.close();
}

console.log('\n[2] 同一件事的碎片 → 不引用（能组合成一句）');
{
  const { p, store } = makePipeline();
  const base = Date.now();
  // 三条紧挨着（2 秒内），明显是同一句话被拆开发
  const picked = p.pickQuotable([
    m('我今天', 1, 0, base),
    m('被老板骂了', 2, 1500, base),
    m('烦死了', 3, 3000, base),
  ]);
  check('同一件事不引用', picked.length === 0, `实际挑了 ${picked.length} 条`);
  store.close();
}

console.log('\n[3] 两件独立的事 → 挑 2 条');
{
  const { p, store } = makePipeline();
  const base = Date.now();
  // 前后相隔 10 秒以上，明显是两件事
  const picked = p.pickQuotable([
    m('今天上班累死了', 1, 0, base),
    m('对了你觉得我该不该换个工作', 2, 12000, base),
  ]);
  check('两件事挑 2 条', picked.length === 2, `实际 ${picked.length}`);
  store.close();
}

console.log('\n[4] 问句优先被挑中');
{
  const { p, store } = makePipeline();
  const base = Date.now();
  const picked = p.pickQuotable([
    m('今天天气还行吧', 1, 0, base),
    m('你说我要不要报个班学点东西', 2, 12000, base),
  ]);
  check(
    '带问号的那条被选中',
    picked.some((x) => x.text.includes('报个班')),
    picked.map((x) => x.text).join(' | '),
  );
  store.close();
}

console.log('\n[5] 极短消息不算一件事');
{
  const { p, store } = makePipeline();
  const base = Date.now();
  const picked = p.pickQuotable([
    m('嗯', 1, 0, base),
    m('哦', 2, 12000, base),
    m('好', 3, 24000, base),
  ]);
  check('全是无意义短句 → 不引用', picked.length === 0, `实际 ${picked.length}`);
  store.close();
}

console.log('\n[6] 数量上限 3 条');
{
  const { p, store } = makePipeline();
  const base = Date.now();
  const msgs = Array.from({ length: 8 }, (_, i) =>
    m(`这是第${i + 1}件完全独立的事情记录`, i + 1, i * 12000, base),
  );
  const picked = p.pickQuotable(msgs);
  check('最多 3 条', picked.length <= 3, `实际 ${picked.length}`);
  store.close();
}

console.log('\n[7] 顺序跟说话顺序一致');
{
  const { p, store } = makePipeline();
  const base = Date.now();
  const picked = p.pickQuotable([
    m('第一件事情比较长一些', 1, 0, base),
    m('第二件事情也不短哦', 2, 12000, base),
  ]);
  const ids = picked.map((x) => Number(x.messageId));
  check('按原始顺序', ids[0] < ids[1], JSON.stringify(ids));
  store.close();
}

console.log('\n[8] 空输入不崩');
{
  const { p, store } = makePipeline();
  check('空数组返回空', p.pickQuotable([]).length === 0);
  store.close();
}

console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
process.exit(fail > 0 ? 1 : 0);
