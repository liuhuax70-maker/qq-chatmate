/**
 * 表情去重键测试。
 *
 * 背景：QQ 图片链接的 fileid 后半段是每次变化的加密签名，
 * 直接用整条 URL 当 key 会导致同一张表情被反复问（线上踩过：
 * 一张图被问了三次、学了三个不同含义）。
 * 运行：npm run test:stickerkey
 */
import { stickerKey } from '../src/responder/sticker-learner';

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

console.log('\n[1] 同一内容、不同签名 → 应视为同一张');
{
  const a = 'https://x.com/d?appid=1406&fileid=EhTfBbKSt54tD0lQG47TIfK4-sokbRjV4H4g_goooIbh3unIlwMy&rkey=AAA';
  const b = 'https://x.com/d?appid=1406&fileid=EhTfBbKSt54tD0lQG47TIfK4-sokbRjV4H4g_goosN7ZgInJlwMy&rkey=BBB';
  check('key 相同', stickerKey(a) === stickerKey(b), stickerKey(a) + ' vs ' + stickerKey(b));
  check('带 fid: 前缀', stickerKey(a).startsWith('fid:'));
}

console.log('\n[2] 不同内容 → 应视为不同');
{
  const a = 'https://x.com/d?fileid=EhTfBbKSt54tD0lQG47TIfK4-sokbRjV4H4g_goooIbh3&rkey=A';
  const b = 'https://x.com/d?fileid=EhSpwKu9nlnEOSwDPxJei4LZVs0qORi0o4gBIP4KKPDcp4eJ&rkey=A';
  check('key 不同', stickerKey(a) !== stickerKey(b));
}

console.log('\n[3] 无 fileid 的永久链接：去掉时效参数后应相同');
{
  const a = 'https://p.qpic.cn/qq_expression/123/ABC/0?rkey=OLD';
  const b = 'https://p.qpic.cn/qq_expression/123/ABC/0?rkey=NEW';
  check('key 相同', stickerKey(a) === stickerKey(b), stickerKey(a) + ' vs ' + stickerKey(b));
}

console.log('\n[4] 异常输入不崩');
{
  check('空字符串', typeof stickerKey('') === 'string');
  check('非法 URL', typeof stickerKey('not a url') === 'string');
}

console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
process.exit(fail > 0 ? 1 : 0);
