/**
 * 冒烟测试：不连真 QQ，用假协议端验证管线行为。
 * 运行：npx tsx tests/smoke.ts
 */
import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import { MessagePipeline } from '../src/pipeline';
import { OneBotAdapter } from '../src/adapter/onebot';
import { initLogger, maskQQ } from '../src/infra/logger';

// 测试用的假账号（非真实 QQ 号，可安全开源）
const OWNER = '100000001';
const BOT = '100000002';
const STRANGER = '999888777';

const logger = initLogger({ level: 'warn', pretty: false, maskQQ: true });

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}`);
  }
}

function makePipeline() {
  return new MessagePipeline(
    {
      mergeWindowMs: 120,
      mergeMaxWaitMs: 600,
      dedup: { enabled: true, windowMs: 2000 },
      filter: { allowedUsers: [OWNER], blockedUsers: [], dropSelf: true, dropGroupEvents: true },
      throttle: {
        burstWindowSeconds: 60,
        burstMaxReplies: 3,
        burstSkipProbability: 0.4,
        floodThreshold: 6,
        floodSkipProbability: 0.8,
      },
    },
    logger,
  );
}

function privateMsg(userId: string, text: string, id: number) {
  return {
    post_type: 'message',
    message_type: 'private',
    self_id: Number(BOT),
    user_id: Number(userId),
    message_id: id,
    time: Math.floor(Date.now() / 1000),
    message: [{ type: 'text', data: { text } }],
    raw_message: text,
    sender: { user_id: Number(userId), nickname: 'test' },
  } as any;
}

async function testSingleAllowed(): Promise<void> {
  console.log('\n[1] 白名单内私聊 → 应触发回复');
  const p = makePipeline();
  await new Promise<void>((resolve) => {
    p.accept(privateMsg(OWNER, '在吗', 1), (d) => {
      check('决策为 reply', d.action === 'reply');
      if (d.action === 'reply') check('文本正确', d.text === '在吗');
      resolve();
    });
  });
}

async function testStrangerDropped(): Promise<void> {
  console.log('\n[2] 非白名单私聊 → 必须丢弃');
  const p = makePipeline();
  await new Promise<void>((resolve) => {
    p.accept(privateMsg(STRANGER, '你好啊机器人', 2), (d) => {
      check('决策为 drop', d.action === 'drop');
      check('原因是 not-allowed', d.action === 'drop' && d.reason === 'not-allowed');
      resolve();
    });
  });
}

async function testGroupDropped(): Promise<void> {
  console.log('\n[3] 群消息 → 必须丢弃');
  const p = makePipeline();
  const groupMsg = {
    post_type: 'message',
    message_type: 'group',
    self_id: Number(BOT),
    user_id: Number(OWNER),
    group_id: 123456,
    message_id: 3,
    message: [{ type: 'text', data: { text: '群里说话' } }],
  } as any;
  await new Promise<void>((resolve) => {
    p.accept(groupMsg, (d) => {
      check('决策为 drop', d.action === 'drop');
      check('原因是 group-message', d.action === 'drop' && d.reason === 'group-message');
      resolve();
    });
  });
}

async function testSelfDropped(): Promise<void> {
  console.log('\n[4] 自己发出的消息 → 必须丢弃');
  const p = makePipeline();
  await new Promise<void>((resolve) => {
    p.accept(privateMsg(BOT, '我自己说的', 4), (d) => {
      check('决策为 drop', d.action === 'drop');
      resolve();
    });
  });
}

async function testMerge(): Promise<void> {
  console.log('\n[5] 连发多条 → 应合并成一段');
  const p = makePipeline();
  const results: string[] = [];
  await new Promise<void>((resolve) => {
    let done = false;
    const cb = (d: any) => {
      if (done) return;
      done = true;
      if (d.action === 'reply') results.push(d.text);
      resolve();
    };
    p.accept(privateMsg(OWNER, '在吗', 11), cb);
    setTimeout(() => p.accept(privateMsg(OWNER, '有个事', 12), cb), 30);
    setTimeout(() => p.accept(privateMsg(OWNER, '想问你', 13), cb), 60);
  });
  check('只产生一次回复决策', results.length === 1);
  check('三条已合并', results[0]?.split('\n').length === 3);
}

async function testDedup(): Promise<void> {
  console.log('\n[6] 重复消息 → 应去重');
  const p = makePipeline();
  const decisions: string[] = [];
  const msg = privateMsg(OWNER, '重复', 20);
  p.accept(msg, (d) => decisions.push(d.action));
  p.accept(msg, (d) => decisions.push(d.action));
  await new Promise((r) => setTimeout(r, 200));
  check('第二次被丢弃', decisions.filter((x) => x === 'drop').length >= 1);
}

async function testAdapterAuth(): Promise<void> {
  console.log('\n[7] 协议端 WS 鉴权 → 错误 token 应被拒绝');
  const adapter = new OneBotAdapter(
    {
      transport: 'reverse-websocket',
      listen: { host: '127.0.0.1', port: 18080, path: '/onebot/v11/ws' },
      accessToken: 'secret-token',
      selfId: BOT,
      heartbeatIntervalMs: 30000,
    },
    logger,
  );
  await adapter.start();

  const closed = await new Promise<boolean>((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:18080/onebot/v11/ws', {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    ws.on('close', () => resolve(true));
    ws.on('open', () => setTimeout(() => resolve(false), 300));
    ws.on('error', () => resolve(true));
  });
  check('错误 token 被断开', closed);

  const accepted = await new Promise<boolean>((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:18080/onebot/v11/ws', {
      headers: { Authorization: 'Bearer secret-token' },
    });
    ws.on('open', () => resolve(true));
    ws.on('error', () => resolve(false));
  });
  check('正确 token 可连接', accepted);

  await adapter.stop();
}

async function testAdapterApi(): Promise<void> {
  console.log('\n[8] 协议端 WS 通信 → API 应答应被正确解析');
  const adapter = new OneBotAdapter(
    {
      transport: 'reverse-websocket',
      listen: { host: '127.0.0.1', port: 18081, path: '/onebot/v11/ws' },
      accessToken: 'tok',
      selfId: BOT,
      heartbeatIntervalMs: 30000,
    },
    logger,
  );
  const gotEvent = new Promise<any>((resolve) => adapter.on('event', resolve));
  await adapter.start();

  const ws = new WebSocket('ws://127.0.0.1:18081/onebot/v11/ws', { headers: { Authorization: 'Bearer tok' } });

  // 必须在 open 之前挂上 message 监听，避免适配器握手完成后立刻调用 API 时无人应答
  ws.on('message', (raw) => {
    const req = JSON.parse(raw.toString());
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 999 }, echo: req.echo }));
  });

  await new Promise<void>((r) => ws.on('open', () => r()));
  // 等适配器把这条连接登记为 current client
  await adapter.waitForReady();

  try {
    const sent = await adapter.sendPrivateMessage(OWNER, '测试消息');
    check('send_private_msg 返回 message_id', sent?.message_id === 999);
  } catch (err) {
    console.log('    ↳ 调用异常：', (err as Error).message);
    check('send_private_msg 返回 message_id', false);
  }

  // 模拟协议端推送事件
  ws.send(JSON.stringify(privateMsg(OWNER, '推送测试', 30)));
  const ev = await Promise.race([gotEvent, new Promise((r) => setTimeout(() => r(null), 800))]);
  check('事件被正确解析', !!ev && ev.user_id === Number(OWNER));

  ws.close();
  await adapter.stop();
}

async function main(): Promise<void> {
  console.log('=== qq-netizen 冒烟测试 ===');
  console.log(`白名单：${maskQQ(OWNER)}　机器人：${maskQQ(BOT)}`);

  await testSingleAllowed();
  await testStrangerDropped();
  await testGroupDropped();
  await testSelfDropped();
  await testMerge();
  await testDedup();
  await testAdapterAuth();
  await testAdapterApi();

  console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
