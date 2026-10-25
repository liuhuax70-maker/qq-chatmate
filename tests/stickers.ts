/** 表情学习器测试：npm run test:learn */
import { StickerLearner, buildAskQuestion } from '../src/responder/sticker-learner';
import { StickerLibrary } from '../src/responder/stickers';
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

function fresh(): StickerLearner {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-test-'));
  const store = new Store(path.join(dir, 'test.db'));
  return new StickerLearner(store, logger);
}

console.log('=== 表情学习器测试 ===\n');

console.log('[1] 新表情 → 应该问');
{
  const l = fresh();
  check('不认识的图返回 ask', l.onReceivedImage('http://x/1.png', true) === 'ask');
}

console.log('\n[2] 普通照片不学');
{
  const l = fresh();
  check('非表情包返回 ignore', l.onReceivedImage('http://x/photo.jpg', false) === 'ignore');
}

console.log('\n[3] 问了之后不重复问');
{
  const l = fresh();
  l.onReceivedImage('http://x/1.png', true);
  l.markAsked('http://x/1.png', '这是啥');
  check('同一张图再发 → already-asked', l.onReceivedImage('http://x/1.png', true) === 'already-asked');
  check('有待回答的标记', l.hasPending());
}

console.log('\n[4] 从回复里学意思');
{
  const l = fresh();
  l.onReceivedImage('http://x/1.png', true);
  l.markAsked('http://x/1.png', '这是啥');
  const learned = l.tryLearnFromReply('这是白眼');
  check('成功学到', learned !== null, String(learned));
  check('意思是白眼', learned?.meaning === '白眼', learned?.meaning);
  check('场景含 annoyed', learned?.scenes.includes('annoyed') === true, JSON.stringify(learned?.scenes));
  check('学完之后认识这张图', l.knows('http://x/1.png'));
  check('pending 已清除', !l.hasPending());
}

console.log('\n[5] 各种表述都能解析');
{
  const cases: Array<[string, string | null]> = [
    ['白眼', '白眼'],
    ['这是表示无语', '无语'],
    ['你在嫌弃我', '嫌弃'],
    ['就表示开心哈哈哈', '开心'],
    ['不知道', null],
    ['随便发的', null],
    ['哈哈', null],
    ['嗯', null],
  ];
  for (const [reply, expected] of cases) {
    const l = fresh();
    l.onReceivedImage('http://x/t.png', true);
    l.markAsked('http://x/t.png', '这是啥');
    const r = l.tryLearnFromReply(reply);
    const actual = r?.meaning ?? null;
    check(`"${reply}" → ${expected ?? '不识'}`, actual === expected, `实际=${actual}`);
  }
}

console.log('\n[6] 按场景检索已学的表情');
{
  const l = fresh();
  l.onReceivedImage('http://x/a.png', true);
  l.markAsked('http://x/a.png', 'q');
  l.tryLearnFromReply('这是白眼');

  l.onReceivedImage('http://x/b.png', true);
  l.markAsked('http://x/b.png', 'q');
  l.tryLearnFromReply('表示开心');

  const annoyed = l.pickByScene('annoyed');
  check('能按 annoyed 取出', annoyed !== null, String(annoyed));
  check('取到的是白眼那张', annoyed?.url === 'http://x/a.png', annoyed?.url);

  const happy = l.pickByScene('happy');
  check('能按 happy 取出', happy !== null);
  check('取到的是开心那张', happy?.url === 'http://x/b.png', happy?.url);

  check('没有的场景返回 null', l.pickByScene('hungry') === null);
}

console.log('\n[7] 学习结果持久化');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-test-'));
  const store = new Store(path.join(dir, 'test.db'));
  const l1 = new StickerLearner(store, logger);
  l1.onReceivedImage('http://x/p.png', true);
  l1.markAsked('http://x/p.png', 'q');
  l1.tryLearnFromReply('这是白眼');

  const l2 = new StickerLearner(store, logger);
  check('重启后仍认识', l2.knows('http://x/p.png'));
  check('重启后数量一致', l2.count() === 1, String(l2.count()));
}

console.log('\n[8] 问话随关系变化');
{
  const low = buildAskQuestion(0.1);
  const high = buildAskQuestion(0.9);
  check('低关系问话存在', low.length > 0);
  check('高关系问话存在', high.length > 0);
  check('两者措辞不同', low !== high);
}

console.log('\n[9] 已经认识的不再问');
{
  const l = fresh();
  l.onReceivedImage('http://x/k.png', true);
  l.markAsked('http://x/k.png', 'q');
  l.tryLearnFromReply('白眼');
  check('已认识的图返回 known', l.onReceivedImage('http://x/k.png', true) === 'known');
}


  console.log('\n[N] 表情包去重：池子小时不该反复发同一张');
  {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-lib-'));
    const store2 = new Store(path.join(dir2, 'test.db'));
    const lib = new StickerLibrary(store2, logger);
    (lib as any).stickers = [
      { url: 'http://x/a.png', tags: [], usedCount: 0, lastUsedAt: 0 },
      { url: 'http://x/b.png', tags: [], usedCount: 0, lastUsedAt: 0 },
      { url: 'http://x/c.png', tags: [], usedCount: 0, lastUsedAt: 0 },
    ];

    const picked = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const s = lib.pick('generic');
      if (s) picked.add(s.url);
    }
    check('3 张库连挑 3 次不重复', picked.size === 3, 'actual ' + picked.size);
    check('3 张时 isPoolHealthy=false', lib.isPoolHealthy() === false);
    check('size() 返回 3', lib.size() === 3, String(lib.size()));

    store2.close();
  }

console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
process.exit(fail > 0 ? 1 : 0);
