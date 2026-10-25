/**
 * 端到端测试：完整走一遍 pipeline 的真实流程。
 *
 * 不只测 pickQuotable，而是喂真实事件、等合并窗口、看最终 decision。
 * 这样能测出"分批边界"在真实时序下到底对不对。
 *
 * 场景（严格按用户描述）：
 *   她回复 → 你发 1 条 → 应该不引用
 *   她回复 → 你发 2 条独立事 → 应该挑 2 条
 *   她回复 → 你发 3 条碎片（同一件事）→ 应该不引用
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { MessagePipeline } from '../src/pipeline';
import { Store } from '../src/store/db';
import { initLogger } from '../src/infra/logger';
import type { OneBotEvent } from '../src/adapter/onebot';

const logger = initLogger({ level: 'error' });

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + ' ' + extra); }
}

const OWNER = '10001';
const SELF = '20002';
let msgId = 1;

function makeEvent(text: string): OneBotEvent {
  return {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    time: Math.floor(Date.now() / 1000),
    self_id: Number(SELF),
    message_id: msgId++,
    user_id: Number(OWNER),
    message: [{ type: 'text', data: { text } }],
    raw_message: text,
    sender: { user_id: Number(OWNER), nickname: '阿龙' },
  } as unknown as OneBotEvent;
}

function makePipeline(): { p: MessagePipeline; store: Store } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
  const store = new Store(path.join(dir, 'test.db'));
  const p = new MessagePipeline(
    {
      mergeWindowMs: 300,      // 测试用缩短，加速
      mergeMaxWaitMs: 1000,
      dedup: { enabled: false, windowMs: 1000 },
      filter: { allowedUsers: [OWNER], blockedUsers: [], dropSelf: true, dropGroupEvents: true },
      throttle: {
        burstWindowSeconds: 60, burstMaxReplies: 10, burstSkipProbability: 0,
        floodWindowSeconds: 10, floodThreshold: 20, floodSkipProbability: 0,
        cooldownAfterSkipSeconds: 0,
      },
    },
    logger,
  );
  return { p, store };
}

/** 喂一条消息并等 decision */
function feedAndWait(p: MessagePipeline, text: string, waitMs = 700): Promise<any> {
  return new Promise((resolve) => {
    let resolved = false;
    p.accept(makeEvent(text), (d) => {
      if (resolved) return;
      if (d.action === 'reply') { resolved = true; resolve(d); }
    });
    setTimeout(() => { if (!resolved) { resolved = true; resolve(null); } }, waitMs);
  });
}

/** 连续喂多条，等它们合并成一次 decision */
function feedBatch(p: MessagePipeline, texts: string[], gapMs = 100, waitMs = 1000): Promise<any> {
  return new Promise((resolve) => {
    let resolved = false;
    let i = 0;
    p.accept(makeEvent(texts[0]), (d) => {
      if (resolved) return;
      if (d.action === 'reply') { resolved = true; resolve(d); }
    });
    const timer = setInterval(() => {
      i++;
      if (i >= texts.length) { clearInterval(timer); return; }
      p.accept(makeEvent(texts[i]), (d) => {
        if (resolved) return;
        if (d.action === 'reply') { resolved = true; resolve(d); }
      });
    }, gapMs);
    setTimeout(() => { if (!resolved) { resolved = true; resolve(null); } }, waitMs);
  });
}

async function main(): Promise<void> {
  console.log('\n[1] 她刚回复过，你只发 1 条 → 不引用');
  {
    const { p, store } = makePipeline();
    p.markReplied();   // 模拟她刚回复
    await new Promise((r) => setTimeout(r, 50));
    const d = await feedAndWait(p, '我今天下午去超市买了好多东西回来真的很累');
    check('有 decision', d !== null);
    check('quotable 为空', d && Array.isArray(d.quotable) && d.quotable.length === 0,
      d ? `实际 ${d.quotable?.length} 条` : 'null');
    store.close();
  }

  console.log('\n[2] 她刚回复过，你连发 3 条碎句（同一件事）→ 不引用');
  {
    const { p, store } = makePipeline();
    p.markReplied();
    await new Promise((r) => setTimeout(r, 50));
    const d = await feedBatch(p, ['我今天', '被老板骂了', '烦死了']);
    check('有 decision', d !== null);
    check('3 条被合并', d && d.mergedCount === 3, d ? `mergedCount=${d.mergedCount}` : 'null');
    check('quotable 为空（同一件事）', d && d.quotable?.length === 0,
      d ? `实际 ${d.quotable?.length} 条` : 'null');
    store.close();
  }

  console.log('\n[3] 她刚回复过，你连发 2 条独立事（间隔久）→ 挑 2 条');
  {
    const { p, store } = makePipeline();
    p.markReplied();
    await new Promise((r) => setTimeout(r, 50));
    // 两条相隔 9 秒（超过 8 秒分组阈值），但合并窗口只有 300ms，
    // 所以要手动模拟：先发一条等它处理完，再发另一条……
    // 但那样就是两次 decision 了。
    // 真实场景：两条都在同一合并窗口内，但 at 相差 > 8 秒。
    // 这里直接构造 msgs 验证 pickQuotable 的行为。
    const base = Date.now();
    const msgs = [
      { text: '今天上班累死了', messageId: 1, at: base },
      { text: '对了你觉得我该不该换个工作', messageId: 2, at: base + 9000 },
    ];
    const picked = p.pickQuotable(msgs);
    check('2 件独立事 → 挑 2 条', picked.length === 2, `实际 ${picked.length}`);
    store.close();
  }

  console.log('\n[4] 关键：上一批旧消息不能影响新一批');
  {
    const { p, store } = makePipeline();
    // 先来一批（3 条独立事）
    await feedBatch(p, ['第一件独立的事', '第二件独立的事', '第三件独立的事'], 100, 1000);
    // 她回复
    p.markReplied();
    await new Promise((r) => setTimeout(r, 100));
    // 现在你只发 1 条
    const d = await feedAndWait(p, '我回来了');
    check('新批次只有 1 条', d && d.mergedCount === 1, d ? `mergedCount=${d.mergedCount}` : 'null');
    check('quotable 为空', d && d.quotable?.length === 0, d ? `实际 ${d.quotable?.length} 条` : 'null');
    store.close();
  }

  console.log('\n[5] 她没说过话（首次对话），连发 3 条独立事 → 最多挑 3');
  {
    const { p, store } = makePipeline();
    const base = Date.now();
    const msgs = [
      { text: '第一件独立的事情呢', messageId: 1, at: base },
      { text: '第二件独立的事情呢', messageId: 2, at: base + 9000 },
      { text: '第三件独立的事情呢', messageId: 3, at: base + 18000 },
    ];
    const picked = p.pickQuotable(msgs);
    check('3 件独立事 → 挑 3 条', picked.length === 3, `实际 ${picked.length}`);
    store.close();
  }

  console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
