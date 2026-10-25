/**
 * 技能标记解析测试。
 *
 * 这块一旦出错，表现是「用户看到 [戳] 这种字」或者「该做的动作没做」。
 * 所以重点测：
 *   1. 标记能被正确剥离（不能漏给用户）
 *   2. 动作顺序保持
 *   3. 各种奇怪写法不崩
 *
 * 运行：npm run test:skills
 */
import { parseSkillCalls } from '../src/responder/skills';

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

console.log('\n[1] 无标记：原文返回');
{
  const r = parseSkillCalls('今天想你了');
  check('文本不变', r.text === '今天想你了', r.text);
  check('无动作', r.actions.length === 0, String(r.actions.length));
}

console.log('\n[2] 简单标记被剥离');
{
  const r = parseSkillCalls('你今天怎么这么烦 [戳]');
  check('标记已移除', !r.text.includes('[戳]'), r.text);
  check('文本保留', r.text.includes('烦'), r.text);
  check('识别出戳', r.actions.length === 1 && r.actions[0].kind === 'poke');
}

console.log('\n[3] 表情包标记');
{
  const r = parseSkillCalls('懒得说 [表情包]');
  check('标记已移除', !r.text.includes('[表情包]'), r.text);
  check('识别出表情包', r.actions[0]?.kind === 'sticker');
}

console.log('\n[4] 带参数的图片标记');
{
  const r = parseSkillCalls('看这个 [图:https://example.com/a.png]');
  check('标记已移除', !r.text.includes('[图'), r.text);
  check('识别出图片', r.actions[0]?.kind === 'image');
  if (r.actions[0]?.kind === 'image') {
    check('参数正确', r.actions[0].file === 'https://example.com/a.png', r.actions[0].file);
  }
}

console.log('\n[5] 中文冒号也支持');
{
  const r = parseSkillCalls('给你看 [图：D:\\pics\\a.jpg]');
  check('识别出图片', r.actions[0]?.kind === 'image');
  if (r.actions[0]?.kind === 'image') {
    check('路径正确', r.actions[0].file.includes('a.jpg'), r.actions[0].file);
  }
}

console.log('\n[6] 多个动作保持顺序');
{
  const r = parseSkillCalls('想你 [戳] 算了 [赞]');
  check('两个动作', r.actions.length === 2, String(r.actions.length));
  check('顺序：先戳后赞',
    r.actions[0]?.kind === 'poke' && r.actions[1]?.kind === 'like',
    r.actions.map((a) => a.kind).join(','));
  check('文字干净', !r.text.includes('['), r.text);
}

console.log('\n[7] 合并转发');
{
  const r = parseSkillCalls('给你看 [转发:第一句|第二句|第三句]');
  check('识别出转发', r.actions[0]?.kind === 'forward');
  if (r.actions[0]?.kind === 'forward') {
    check('拆成三段', r.actions[0].messages.length === 3, String(r.actions[0].messages.length));
    check('内容正确', r.actions[0].messages[0] === '第一句', r.actions[0].messages[0]);
  }
}

console.log('\n[8] 撤标记');
{
  const r = parseSkillCalls('说错了 [撤]');
  check('识别出撤回', r.actions[0]?.kind === 'recall');
}

console.log('\n[9] 只有标记没有文字');
{
  const r = parseSkillCalls('[戳]');
  check('文本为空', r.text === '', `"${r.text}"`);
  check('动作还在', r.actions.length === 1);
}

console.log('\n[10] 空输入');
{
  const r = parseSkillCalls('');
  check('文本空', r.text === '');
  check('无动作', r.actions.length === 0);
}

console.log('\n[11] 未闭合的方括号不崩');
{
  let ok = true;
  try {
    parseSkillCalls('测试 [戳');
    parseSkillCalls('测试 [图:');
    parseSkillCalls('测试 [');
    parseSkillCalls(']]]');
  } catch (e) {
    ok = false;
    console.log('    异常: ' + (e as Error).message);
  }
  check('不抛异常', ok);
}

console.log('\n[12] 多行文本保留换行（分段发送依赖它）');
{
  const r = parseSkillCalls('第一句\n第二句\n第三句');
  check('换行保留', r.text.split('\n').length === 3, String(r.text.split('\n').length));
}

console.log('\n[13] 标记不破坏多行结构');
{
  const r = parseSkillCalls('今天好累\n不想动 [戳]\n你陪我');
  const lines = r.text.split('\n').filter(Boolean);
  check('三段仍在', lines.length === 3, String(lines.length));
  check('第一段完整', lines[0] === '今天好累', lines[0]);
  check('第二段干净', lines[1] === '不想动', lines[1]);
}

console.log('\n[14] 同一标记出现多次都识别');
{
  const r = parseSkillCalls('[戳]中间[戳]');
  check('两个戳动作', r.actions.length === 2, String(r.actions.length));
}

console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
process.exit(fail > 0 ? 1 : 0);
