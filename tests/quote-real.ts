/**
 * 真实时序端到端测试。
 *
 * 用真实的 OneBot 事件 + 真实的时间间隔，验证：
 *   「以她上次回复为界」这个分批逻辑，在真实聊天节奏下对不对。
 *
 * 关键：不mock时间，用真实的 setTimeout 等。
 * 这能测出"合并窗口"和"分批边界"的交互是否正确。
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
let counter = 1;

function evt(text: string): OneBotEvent {
  return {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    time: Math.floor(Date.now() / 1000),
    self_id: Number(SELF),
    message_id: counter++,
    user_id: Number(OWNER),
    message: [{ type: 'text', data: { text } }],
    raw_message: text,
    sender: { user_id: Number(OWNER), nickname: '阿龙' },
  } as unknown as OneBotEvent;
}

function mkPipe(mergeWindowMs = 400): { p: MessagePipeline; store: Store } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e2-'));
  const store = new Store(path.join(dir, 'test.db'));
  const p = new MessagePipeline(
    {
      mergeWindowMs,
      mergeMaxWaitMs: mergeWindowMs * 3,
      dedup: { enabled: false, windowMs: 100 },
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 发一条，等决策 */
function send(p: MessagePipeline, text: string, waitMs: number): Promise<any> {
  return new Promise((resolve) => {
    let done = false;
    p.accept(evt(text), (d) => {
      if (done) return;
      if (d.action === 'reply') { done = true; resolve(d); }
    });
    setTimeout(() => { if (!done) { done = true; resolve(null); } }, waitMs);
  });
}

async function main(): Promise<void> {
  console.log('\n[场景A] 她回复 → 你只发 1 条长句 → 不引用');
  {
    const { p, store } = mkPipe();
    p.markReplied();
    await sleep(50);
    const d = await send(p, '我今天下午去超市买了好多东西回来真的很累啊', 800);
    check('得到 decision', d !== null);
    check('mergedCount = 1', d?.mergedCount === 1, String(d?.mergedCount));
    check('quotable 为空 ★核心断言', d?.quotable?.length === 0, `${d?.quotable?.length} 条`);
    store.close();
  }

  console.log('\n[场景B] 她回复 → 你连发 3 条碎句 → 不引用');
  {
    const { p, store } = mkPipe(500);
    p.markReplied();
    await sleep(50);

    // 真实连发：间隔 200ms（小于合并窗口 500ms，会被合并）
    let result: any = null;
    p.accept(evt('我今天'), (d) => { if (d.action === 'reply' && !result) result = d; });
    await sleep(200);
    p.accept(evt('被老板骂了'), (d) => { if (d.action === 'reply' && !result) result = d; });
    await sleep(200);
    p.accept(evt('烦死了'), (d) => { if (d.action === 'reply' && !result) result = d; });
    await sleep(1200);

    check('三条被合并', result?.mergedCount === 3, String(result?.mergedCount));
    check('quotable 为空 ★核心断言', result?.quotable?.length === 0, `${result?.quotable?.length} 条`);
    store.close();
  }

  console.log('\n[场景C] 她回复 → 你发 2 条都是长句（独立的事）→ 挑 2 条');
  {
    const { p, store } = mkPipe(600);
    p.markReplied();
    await sleep(50);

    let result: any = null;
    p.accept(evt('今天上班被安排了一堆破活累得要死'), (d) => { if (d.action === 'reply' && !result) result = d; });
    await sleep(300);
    p.accept(evt('对了你觉得我应该换个工作吗'), (d) => { if (d.action === 'reply' && !result) result = d; });
    await sleep(1500);

    check('两条被合并', result?.mergedCount === 2, String(result?.mergedCount));
    check('挑出 2 条 ★核心断言', result?.quotable?.length === 2, `${result?.quotable?.length} 条`);
    store.close();
  }

  console.log('\n[场景D] 上一批旧消息 + 她回复 + 你只发 1 条 → 不引用');
  {
    const { p, store } = mkPipe(400);
    // 先发一批
    await send(p, '第一件独立的事呢', 800);
    await sleep(100);
    // 她回复
    p.markReplied();
    await sleep(100);
    // 你只发一条
    const d = await send(p, '我回来了', 800);
    check('新批次只有 1 条', d?.mergedCount === 1, String(d?.mergedCount));
    check('quotable 为空 ★核心断言', d?.quotable?.length === 0, `${d?.quotable?.length} 条`);
    store.close();
  }

  console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
