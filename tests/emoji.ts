/** 表情解析测试：npm run test:emoji */
import { parseEmojiMarkers, maybeInjectEmoji, FACE_MAP } from '../src/responder/emoji';

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

console.log('=== 表情模块测试 ===\n');

// 1. 中文名 → face 段
{
  const segs = parseEmojiMarkers('懒得动 [表情:白眼]');
  check('纯文本 + 中文表情', segs.length === 2 && segs[0].type === 'text' && segs[1].type === 'face');
  check('白眼 ID 正确', segs[1]?.data.id === String(FACE_MAP['白眼']), `实际=${segs[1]?.data.id}`);
}

// 2. 只有表情
{
  const segs = parseEmojiMarkers('[表情:睡]');
  check('只有表情时无空文本段', segs.length === 1 && segs[0].type === 'face');
}

// 3. 数字 ID 兜底
{
  const segs = parseEmojiMarkers('嗯 [face:23]');
  check('支持 [face:数字]', segs[1]?.type === 'face' && segs[1]?.data.id === '23');
}

// 4. 未知表情名不丢内容
{
  const segs = parseEmojiMarkers('哦 [表情:不存在的脸]');
  check('未知表情保留为文本', segs.some((s) => s.type === 'text' && s.data.text?.includes('不存在的脸')));
}

// 5. 全角冒号
{
  const segs = parseEmojiMarkers('好 [表情：呲牙]');
  check('支持全角冒号', segs[1]?.data.id === String(FACE_MAP['呲牙']));
}

// 6. 纯文本无表情
{
  const segs = parseEmojiMarkers('嗯 哦');
  check('纯文本只有一个段', segs.length === 1 && segs[0].type === 'text');
}

// 7. 注入：命中情绪词
{
  let hit = false;
  for (let i = 0; i < 50; i++) {
    const out = maybeInjectEmoji('好烦', 1.0);
    if (out.includes('[表情:')) {
      hit = true;
      check('情绪词触发注入', true);
      break;
    }
  }
  if (!hit) check('情绪词触发注入', false);
}

// 8. 注入：概率 0 时不加
{
  let added = false;
  for (let i = 0; i < 50; i++) {
    if (maybeInjectEmoji('随便说点什么', 0).includes('[表情:')) added = true;
  }
  check('概率 0 时不注入', !added);
}

// 9. 已有标记不重复注入
{
  const out = maybeInjectEmoji('好烦 [表情:白眼]', 1.0);
  const count = (out.match(/\[表情:/g) ?? []).length;
  check('已有表情不重复注入', count === 1, `实际 ${count} 个`);
}

// 10. 空白处理
{
  const segs = parseEmojiMarkers('  [表情:睡]  ');
  check('首尾空白不产生空文本段', segs.length === 1);
}

console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
process.exit(fail > 0 ? 1 : 0);
