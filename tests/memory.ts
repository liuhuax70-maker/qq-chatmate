/**
 * 记忆系统测试。
 *
 * 记忆是"她记不记得你说过的话"的基础。坏了的表现是：
 * 昨天说过的事今天完全不记得，或者记了一堆没用的垃圾。
 *
 * 运行：npm run test:memory
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Store } from '../src/store/db';
import { MemorySystem } from '../src/memory';
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

function freshStore(): Store {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'));
  return new Store(path.join(dir, 'test.db'));
}

// 记忆系统只需要 llm 的接口存在，测试里不真的调 LLM
const fakeLlm = { generate: async () => ({ text: '' }) } as any;

const cfg = {
  enabled: true,
  topK: 5,
  importanceThreshold: 0.5,
  extractEveryNTurns: 10,
  explicitKeywords: ['记住', '别忘了', '记一下'],
  summaryEnabled: true,
  summaryMaxChars: 200,
};

console.log('\n[1] 显式记忆：命中关键词才写入');
{
  const store = freshStore();
  const mem = new MemorySystem(store, fakeLlm, cfg, logger);

  mem.captureExplicit('10001', '今天天气不错');
  check('不含关键词 → 不写入', store.searchMemories('10001', '天气', 10).length === 0);

  mem.captureExplicit('10001', '记住 我下周要考试');
  const found = store.searchMemories('10001', '考试', 10);
  check('含「记住」→ 写入', found.length === 1, `实际 ${found.length} 条`);
  check('内容完整保存', found[0]?.content.includes('考试'), String(found[0]?.content));

  store.close();
}

console.log('\n[2] 检索：关键词命中优先');
{
  const store = freshStore();
  store.addMemory({ scope: 'user', scopeId: '10001', type: 'fact', content: '他养了一只叫年糕的猫', importance: 0.8 });
  store.addMemory({ scope: 'user', scopeId: '10001', type: 'preference', content: '他讨厌香菜', importance: 0.6 });
  store.addMemory({ scope: 'user', scopeId: '10001', type: 'event', content: '他上周去了杭州', importance: 0.5 });

  const hits = store.searchMemories('10001', '猫', 5);
  check('按关键词能搜到', hits.length > 0);
  check('最相关的排第一', hits[0]?.content.includes('年糕'), String(hits[0]?.content));

  store.close();
}

console.log('\n[3] 检索：scope 隔离，不会串到别人');
{
  const store = freshStore();
  store.addMemory({ scope: 'user', scopeId: '10001', type: 'fact', content: 'A 的秘密', importance: 1 });
  store.addMemory({ scope: 'user', scopeId: '20002', type: 'fact', content: 'B 的秘密', importance: 1 });

  const a = store.searchMemories('10001', '秘密', 10);
  check('只返回自己的记忆', a.length === 1, `实际 ${a.length} 条`);
  check('内容正确', a[0]?.content.includes('A 的秘密'), String(a[0]?.content));

  store.close();
}

console.log('\n[4] 检索：topK 生效');
{
  const store = freshStore();
  for (let i = 0; i < 20; i++) {
    store.addMemory({ scope: 'user', scopeId: '10001', type: 'fact', content: `记忆${i}`, importance: 0.5 });
  }
  const hits = store.searchMemories('10001', '记忆', 3);
  check('返回条数不超过 topK(3)', hits.length <= 3, String(hits.length));

  store.close();
}

console.log('\n[5] 检索：重要度影响排序');
{
  const store = freshStore();
  store.addMemory({ scope: 'user', scopeId: '10001', type: 'fact', content: '不重要的事', importance: 0.1 });
  store.addMemory({ scope: 'user', scopeId: '10001', type: 'fact', content: '很重要的事', importance: 1.0 });

  const hits = store.searchMemories('10001', '无关查询词', 5);
  check('重要度高的排前面', hits[0]?.content.includes('很重要'), String(hits[0]?.content));

  store.close();
}

console.log('\n[6] 访问计数会累加（用于后续淘汰策略）');
{
  const store = freshStore();
  store.addMemory({ scope: 'user', scopeId: '10001', type: 'fact', content: '被反复检索的记忆', importance: 1 });

  // 注意：searchMemories 先查出结果、再 UPDATE 计数，
  // 所以返回的对象里 accessCount 是"本次访问之前"的值。
  const first = store.searchMemories('10001', '检索', 5);
  check('第一次检索返回访问前计数(0)', first[0]?.accessCount === 0, String(first[0]?.accessCount));

  const second = store.searchMemories('10001', '检索', 5);
  check('第二次返回 1（上次访问已累加）', second[0]?.accessCount === 1, String(second[0]?.accessCount));

  const third = store.searchMemories('10001', '检索', 5);
  check('第三次返回 2', third[0]?.accessCount === 2, String(third[0]?.accessCount));

  store.close();
}

console.log('\n[7] enabled=false 时完全不工作');
{
  const store = freshStore();
  const disabled = { ...cfg, enabled: false };
  const mem = new MemorySystem(store, fakeLlm, disabled, logger);

  mem.captureExplicit('10001', '记住 这件事');
  check('禁用时不写入', store.searchMemories('10001', '这件事', 10).length === 0);
  check('禁用时检索返回空', mem.retrieve('10001', '任何').length === 0);

  store.close();
}

console.log('\n[8] 空查询不崩');
{
  const store = freshStore();
  store.addMemory({ scope: 'user', scopeId: '10001', type: 'fact', content: '随便', importance: 0.5 });
  let ok = true;
  try {
    store.searchMemories('10001', '', 5);
    store.searchMemories('10001', '   ', 5);
    store.searchMemories('10001', '，。！？', 5);
  } catch (e) {
    ok = false;
    console.log('    异常: ' + (e as Error).message);
  }
  check('空/纯标点查询不抛异常', ok);
  store.close();
}

console.log('\n[9] 记忆内容超长不崩');
{
  const store = freshStore();
  let ok = true;
  try {
    store.addMemory({ scope: 'user', scopeId: '10001', type: 'fact', content: '长'.repeat(10000), importance: 1 });
    store.searchMemories('10001', '长', 5);
  } catch (e) {
    ok = false;
    console.log('    异常: ' + (e as Error).message);
  }
  check('超长内容可写入可检索', ok);
  store.close();
}

console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
process.exit(fail > 0 ? 1 : 0);
