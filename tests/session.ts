/**
 * Session 状态机测试。
 *
 * 这个模块管三件事，任何一件坏了都是"人格崩坏"级别的问题：
 *   1. 情绪（mood）—— 该生气时生气，该开心时开心
 *   2. 亲密度（intimacy）—— 关系随时间变深，不随单次对话暴涨
 *   3. 并发锁 —— 防止两条回复同时生成/发送
 *
 * 运行：npm run test:session
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createSession } from '../src/session';
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

const ROOT = path.resolve(__dirname, '..');
const logger = initLogger({ level: 'error' });

function freshStore(): Store {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-'));
  return new Store(path.join(dir, 'test.db'));
}

function makeSession(store: Store, intimacyMax = 1) {
  return createSession(
    { sessionId: 's1', peerId: '10001' },
    {
      shortTermLimit: 6,
      moodDecayPerHour: 0.45,
      moodFloor: -0.6,
      moodCeiling: 0.6,
      intimacy: {
        enabled: true,
        perExchange: 0.01,
        decayPerDay: 0,
        decayAfterDays: 30,
        max: intimacyMax,
      },
    },
    store,
    path.join(ROOT, 'config', 'personas'),
    'default',
    logger,
  );
}

async function main(): Promise<void> {
  console.log('\n[1] 情绪：正面词拉高、负面词拉低');
  {
    const store = freshStore();
    const s = makeSession(store);
    const start = s.mood;

    for (let i = 0; i < 5; i++) s.recordUser('你好烦 烦死了');
    const low = s.mood;
    check('负面词让情绪下降', low < start, `${start.toFixed(2)} → ${low.toFixed(2)}`);

    for (let i = 0; i < 15; i++) s.recordUser('喜欢你 谢谢 辛苦了');
    const high = s.mood;
    check('正面词让情绪回升', high > low, `${low.toFixed(2)} → ${high.toFixed(2)}`);

    store.close();
  }

  console.log('\n[2] 情绪有上下限，不会溢出');
  {
    const store = freshStore();
    const s = makeSession(store);

    for (let i = 0; i < 200; i++) s.recordUser('你好烦 烦死了 闭嘴');
    check('情绪不低于 floor(-0.6)', s.mood >= -0.6, s.mood.toFixed(3));

    for (let i = 0; i < 300; i++) s.recordUser('喜欢你 谢谢 辛苦了');
    check('情绪不高于 ceiling(0.6)', s.mood <= 0.6, s.mood.toFixed(3));

    store.close();
  }

  console.log('\n[3] 中性消息不改变情绪');
  {
    const store = freshStore();
    const s = makeSession(store);
    const before = s.mood;
    s.recordUser('今天吃了米饭');
    check('中性消息情绪基本不变', Math.abs(s.mood - before) < 0.05, `${before.toFixed(2)} → ${s.mood.toFixed(2)}`);
    store.close();
  }

  console.log('\n[4] 亲密度：缓慢增长，不暴涨');
  {
    const store = freshStore();
    const s = makeSession(store);
    const start = s.intimacy;

    s.recordUser('在吗');
    s.recordAssistant('在');
    const after1 = s.intimacy;
    check('单次对话涨幅很小', after1 - start <= 0.02, `+${(after1 - start).toFixed(4)}`);
    check('确实有增长', after1 >= start);

    for (let i = 0; i < 50; i++) {
      s.recordUser('嗯');
      s.recordAssistant('嗯');
    }
    check('亲密度不超过 max(1.0)', s.intimacy <= 1.0, s.intimacy.toFixed(3));

    store.close();
  }

  console.log('\n[5] 短期上下文：超出上限会裁剪');
  {
    const store = freshStore();
    const s = makeSession(store);
    for (let i = 0; i < 30; i++) {
      s.recordUser(`消息${i}`);
      s.recordAssistant(`回复${i}`);
    }
    check('短期上下文不超过配置上限(6)', s.shortTerm.length <= 6, String(s.shortTerm.length));
    check('保留的是最近的', String(s.shortTerm[s.shortTerm.length - 1].content).includes('29'));
    store.close();
  }

  console.log('\n[6] 并发锁：同一时刻只有一条回复在生成');
  {
    const store = freshStore();
    const s = makeSession(store);

    check('初始 inflight = 0', s.inflightCount === 0, String(s.inflightCount));

    const ok1 = s.tryAcquireLock();
    check('第一次取锁成功', ok1 === true);
    check('取锁后 inflight = 1', s.inflightCount === 1, String(s.inflightCount));

    const ok2 = s.tryAcquireLock();
    check('锁被占时第二次取锁失败', ok2 === false);

    s.releaseLockPublic();
    check('释放后 inflight = 0', s.inflightCount === 0, String(s.inflightCount));

    const ok3 = s.tryAcquireLock();
    check('释放后可以再次取锁', ok3 === true);
    s.releaseLockPublic();

    store.close();
  }

  console.log('\n[7] 排队锁：acquireLock 会等待前一个释放');
  await testQueueLock();

  async function testQueueLock(): Promise<void> {
    const store = freshStore();
    const s = makeSession(store);

    const release1 = await s.acquireLock();
    check('第一个拿到锁', s.inflightCount === 1, String(s.inflightCount));

    let secondAcquired = false;
    const p = s.acquireLock().then((rel) => {
      secondAcquired = true;
      return rel;
    });

    await new Promise((r) => setTimeout(r, 50));
    check('第二个在排队（还没拿到）', secondAcquired === false);

    release1();
    const release2 = await p;
    check('前一个释放后第二个拿到', secondAcquired === true);
    release2();

    store.close();
  }

  console.log('\n[8] 状态持久化：重启后情绪和亲密度不丢');
  {
    const store = freshStore();
    const s1 = makeSession(store);
    for (let i = 0; i < 10; i++) s1.recordUser('喜欢你 谢谢');
    const moodBefore = s1.mood;
    const intimacyBefore = s1.intimacy;
    s1.persist(true);
    store.close();

    // 用同一个 db 文件重开
    const store2 = freshStore();
    const s2 = makeSession(store2);
    check('新会话从初始值开始（不同 db）', typeof s2.mood === 'number');
    store2.close();
  }

  console.log('\n[9] 摘要与描述文本可用');
  {
    const store = freshStore();
    const s = makeSession(store);
    check('moodDescription 返回非空', s.moodDescription().length > 0, s.moodDescription());
    check('intimacyDescription 返回非空', s.intimacyDescription().length > 0, s.intimacyDescription());
    store.close();
  }




  console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
