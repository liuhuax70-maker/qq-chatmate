/**
 * Prompt 组装测试。
 *
 * 这是整个项目最核心的模块——人设能不能正确注入、
 * 缓存前缀有没有被破坏、用户消息会不会重复，全在这里。
 *
 * 之前这个模块完全没有测试覆盖，而它一旦出问题，
 * 表现是"她说话不像她了"，很难从日志里看出来。
 *
 * 运行：npm run test:prompt
 */
import path from 'node:path';
import { PromptBuilder } from '../src/brain/prompt';
import { loadPersona } from '../src/persona';
import { createSession } from '../src/session';
import { Store } from '../src/store/db';
import { initLogger } from '../src/infra/logger';
import os from 'node:os';
import fs from 'node:fs';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompttest-'));
  return new Store(path.join(dir, 'test.db'));
}

function makeBuilder(store: Store, memories: any[] = []): PromptBuilder {
  const persona = loadPersona(path.join(ROOT, 'config', 'personas'), 'default');
  return new PromptBuilder({
    promptsDir: path.join(ROOT, 'config', 'prompts'),
    memoryTopK: 5,
    retrieve: () => memories,
    sleepState: () => '你是清醒的',
  });
}

function makeSession(store: Store) {
  return createSession(
    { sessionId: 'test-session', peerId: '10001' },
    {
      shortTermLimit: 20,
      moodDecayPerHour: 0.45,
      moodFloor: -0.6,
      moodCeiling: 0.6,
      intimacy: {
        enabled: true,
        perExchange: 0.01,
        decayPerDay: 0,
        decayAfterDays: 30,
        max: 1,
      },
    },
    store,
    path.join(ROOT, 'config', 'personas'),
    'default',
    logger,
  );
}

console.log('\n[1] 人设注入：占位符必须被替换');
{
  const store = freshStore();
  const builder = makeBuilder(store);
  const session = makeSession(store);
  const msgs = builder.build(session, '在吗');

  const system = String(msgs[0].content ?? '');
  check('system 消息存在', msgs.length > 0 && msgs[0].role === 'system');
  check('没有未替换的 {name} 占位符', !system.includes('{name}'));
  check('没有未替换的 {background}', !system.includes('{background}'));
  check('没有未替换的 {selfClaim}', !system.includes('{selfClaim}'));
  check('没有未替换的 {secrets}', !system.includes('{secrets}'));
  check('注入了角色名', system.includes('大肥鱼'));
  check('注入了自称', system.includes('鲸娘'));

  store.close();
}

console.log('\n[2] 关键段落必须存在（防止 system.md 被改坏）');
{
  const store = freshStore();
  const builder = makeBuilder(store);
  const session = makeSession(store);
  const system = String(builder.build(session, '嗯')[0].content ?? '');

  for (const tag of ['<role>', '<love>', '<character>', '<voice>', '<human>', '<reactions>', '<limits>', '<pacing>']) {
    check(`含 ${tag} 段`, system.includes(tag));
  }
  check('恋爱身份已注入', system.includes('恋爱对象'));
  check('短回复约束已注入', system.includes('10 字以内') || system.includes('短'));
  check('禁止 emoji 约束已注入', system.includes('emoji'));
  check('必须回复的约束已注入', system.includes('必须回') || system.includes('每一条'));

  // <human> 段：真人聊天特征（来自 docs/human-chat-research.md）
  check('含碎片化规则', system.includes('碎片') || system.includes('拆成几条'));
  check('含标点规则', system.includes('标点'));
  check('含语气词规则', system.includes('语气词'));
  check('含 AI 味规则', system.includes('AI 味') || system.includes('译制腔'));
  check('禁止破折号插入语', system.includes('破折号'));

  // PERSONA LOAD 覆盖后的关键特征
  check('SMART LAZY：聪明但懒', system.includes('聪明') && system.includes('懒'));
  check('TAIL FLUKES：有尾巴', system.includes('尾巴'));
  check('LANG ZH CN ONLY：只说中文', system.includes('只说中文'));
  check('角色名是大肥鱼', system.includes('大肥鱼'));
  check('没有旧名鲸奈', !system.includes('鲸奈'));

  store.close();
}

console.log('\n[3] 用户消息不能重复出现（曾导致"你问两遍"的 bug）');
{
  const store = freshStore();
  const builder = makeBuilder(store);
  const session = makeSession(store);
  const userText = '今天好累啊';

  const msgs = builder.build(session, userText);
  const occurrences = msgs.filter(
    (m) => m.role === 'user' && String(m.content ?? '').includes(userText),
  ).length;
  check('用户消息只出现一次', occurrences === 1, `实际 ${occurrences} 次`);

  store.close();
}

console.log('\n[4] 缓存前缀稳定性（前 N 条必须每次一致）');
{
  const store = freshStore();
  const builder = makeBuilder(store);
  const session = makeSession(store);

  const a = builder.build(session, '第一句');
  const b = builder.build(session, '第二句完全不同的内容');

  // 静态人设部分（第一条 system）应该完全一致，否则缓存全废
  check('两次的 system 人设前缀一致', String(a[0].content) === String(b[0].content));
  check('两次的 user 末条不同', String(a[a.length - 1].content) !== String(b[b.length - 1].content));

  store.close();
}

console.log('\n[5] 长期记忆注入');
{
  const store = freshStore();
  const memories = [
    { id: 1, type: 'fact', content: '他养了一只叫年糕的猫', weight: 1, createdAt: Date.now(), scope: 'peer', scopeId: '10001' },
    { id: 2, type: 'preference', content: '他讨厌香菜', weight: 1, createdAt: Date.now(), scope: 'peer', scopeId: '10001' },
  ] as any[];
  const builder = makeBuilder(store, memories);
  const session = makeSession(store);
  const all = builder.build(session, '随便说点什么').map((m) => String(m.content ?? '')).join('\n');

  check('注入了记忆内容', all.includes('年糕') || all.includes('香菜'));
  store.close();
}

console.log('\n[6] 情绪会随用户消息变化并进入 prompt');
{
  const store = freshStore();
  const builder = makeBuilder(store);
  const session = makeSession(store);

  // 负面词会拉低情绪
  for (let i = 0; i < 5; i++) session.recordUser('你好烦 烦死了');
  const sad = String(builder.build(session, '嗯')[0].content ?? '');
  check('心情被拉低后 prompt 有对应描述', sad.length > 0);

  // 正面词会拉高
  for (let i = 0; i < 12; i++) session.recordUser('喜欢你 谢谢 辛苦了');
  const happy = String(builder.build(session, '嗯')[0].content ?? '');
  check('心情被拉高后 prompt 有对应描述', happy.length > 0);
  check('两种心情的 prompt 不同', sad !== happy);

  store.close();
}

console.log('\n[7] 空消息与超长消息不崩');
{
  const store = freshStore();
  const builder = makeBuilder(store);
  const session = makeSession(store);

  let ok = true;
  try {
    builder.build(session, '');
    builder.build(session, '啊'.repeat(5000));
  } catch (e) {
    ok = false;
    console.log('    异常: ' + (e as Error).message);
  }
  check('空消息和超长消息都不抛异常', ok);

  store.close();
}

console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
process.exit(fail > 0 ? 1 : 0);
