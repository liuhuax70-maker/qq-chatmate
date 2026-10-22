/** 睡眠状态机测试（含"被吵醒"）：npm run test:sleep */
import { SleepStateMachine } from '../src/proactive/sleep';
import { Store } from '../src/store/db';
import { initLogger } from '../src/infra/logger';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const logger = initLogger({ level: 'error', pretty: false, maskQQ: true });

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name} ${extra}`);
  }
}

function freshStore(): Store {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleep-test-'));
  return new Store(path.join(dir, 'test.db'));
}

function makeSM(store: Store, bufferMinutes = 30, wakeDelay: [number, number] = [2, 8]) {
  return new SleepStateMachine(
    {
      sleepWindow: [0, 2],
      awakeAfterGoodnightMinutes: bufferMinutes,
      hardSleep: true,
      wakeUpDelayMinutes: wakeDelay,
      stayAwakeMinutes: 15,
    },
    store,
    logger,
  );
}

async function main(): Promise<void> {
  console.log('=== 睡眠状态机测试（第二版）===\n');

  console.log('[1] 初始状态');
  {
    const store = freshStore();
    const sm = makeSM(store);
    check('初始 phase = awake', sm.phase() === 'awake', sm.phase());
    check('初始可回复', sm.canReply());
    store.close();
  }

  console.log('\n[2] 道晚安 → drowsy');
  {
    const store = freshStore();
    const sm = makeSM(store);
    sm.onGoodnightSent();
    check('phase = drowsy', sm.phase() === 'drowsy', sm.phase());
    check('仍可回复', sm.canReply());
    const r = sm.onUserMessage('还不睡？');
    check('缓冲期消息正常处理', r.respond === true, r.reason);
    store.close();
  }

  console.log('\n[3] 缓冲期结束 → asleep');
  {
    const store = freshStore();
    const sm = makeSM(store, 0.0001);
    sm.onGoodnightSent();
    await new Promise((r) => setTimeout(r, 60));
    sm.refresh();
    check('phase = asleep', sm.phase() === 'asleep', sm.phase());
    check('不可回复', !sm.canReply());
    store.close();
  }

  console.log('\n[4] 睡着时被吵醒 → waking（不回，但记下）');
  {
    const store = freshStore();
    const sm = makeSM(store, 0.0001, [2, 8]);
    sm.onGoodnightSent();
    await new Promise((r) => setTimeout(r, 60));
    sm.refresh();
    check('睡前是 asleep', sm.phase() === 'asleep', sm.phase());

    const r = sm.onUserMessage('喂 醒醒');
    // 2026-10-22 改：用户要求"发了消息就必须有回复"，所以被吵醒也回，只是慢一点
    check('被吵醒也要回（不能沉默）', r.respond === true, JSON.stringify(r));
    check('原因是 waking-up', r.reason === 'waking-up', r.reason);
    check('带延迟（起床气）', r.delayMs > 0, String(r.delayMs));
    check('phase 变成 waking', sm.phase() === 'waking', sm.phase());
    check('记录被吵醒次数', sm.getWakeCount() === 1, String(sm.getWakeCount()));
    check('消息被记下', sm.drainNightMessages().length === 1);
    store.close();
  }

  console.log('\n[5] 缓过来之后 → awake-after-wake（可以回）');
  {
    const store = freshStore();
    const sm = makeSM(store, 0.0001, [0.0001, 0.0002]); // 几乎瞬间缓过来
    sm.onGoodnightSent();
    await new Promise((r) => setTimeout(r, 60));
    sm.refresh();
    sm.onUserMessage('喂');
    await new Promise((r) => setTimeout(r, 100));
    sm.refresh();
    check('phase = awake-after-wake', sm.phase() === 'awake-after-wake', sm.phase());
    check('可以回复了', sm.canReply());
    const r = sm.onUserMessage('醒了吗');
    check('正常处理消息', r.respond === true, r.reason);
    store.close();
  }

  console.log('\n[6] 被吵醒后聊完 → 重新睡着');
  {
    const store = freshStore();
    const sm = new SleepStateMachine(
      {
        sleepWindow: [0, 2],
        awakeAfterGoodnightMinutes: 0.0001,
        hardSleep: true,
        wakeUpDelayMinutes: [0.0001, 0.0002],
        stayAwakeMinutes: 0.0001, // 立刻重新睡
      },
      store,
      logger,
    );
    sm.onGoodnightSent();
    await new Promise((r) => setTimeout(r, 60));
    sm.refresh();
    sm.onUserMessage('喂');
    await new Promise((r) => setTimeout(r, 300));
    sm.refresh();
    check('重新睡着', sm.phase() === 'asleep', sm.phase());
    check('又不可回复了', !sm.canReply());
    store.close();
  }

  console.log('\n[7] 描述文本区分状态');
  {
    const store = freshStore();
    const sm = makeSM(store);
    check('清醒描述', sm.describe() === '清醒', sm.describe());
    sm.onGoodnightSent();
    check('drowsy 描述含"困"', sm.describe().includes('困'), sm.describe());
    store.close();
  }

  console.log('\n[8] 状态持久化');
  {
    const store = freshStore();
    const sm1 = makeSM(store, 0.0001);
    sm1.onGoodnightSent();
    await new Promise((r) => setTimeout(r, 60));
    sm1.refresh();
    check('第一个实例已 asleep', sm1.phase() === 'asleep');

    const sm2 = makeSM(store, 0.0001);
    check('重启后仍 asleep', sm2.phase() === 'asleep', sm2.phase());
    store.close();
  }

  console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
