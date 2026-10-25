/**
 * TTS 工具函数测试。
 *
 * 重点测 WAV 解析/构建（唱歌功能靠它拼接多行歌词），
 * 以及文本清洗（英文会导致 cmudict 报错）。
 *
 * 运行：npm run test:tts
 */
import { speechableText, parseWav, buildWav } from '../src/tts';

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

console.log('\n[1] 文本清洗：去掉表情标记');
{
  check('去掉 [表情:笑]', speechableText('好的[表情:笑]') === '好的', speechableText('好的[表情:笑]'));
  check('去掉 [face:1]', speechableText('嗯[face:1]') === '嗯', speechableText('嗯[face:1]'));
  check('多个标记都去掉', speechableText('a[表情:x]b[face:y]c') === 'abc', speechableText('a[表情:x]b[face:y]c'));
  check('没有标记时原样返回', speechableText('今天想你了') === '今天想你了');
  check('首尾空白被 trim', speechableText('  嗯  ') === '嗯');
}

console.log('\n[2] WAV 构建 → 解析 往返一致');
{
  const sampleRate = 24000;
  const channels = 1;
  const pcm = Buffer.alloc(1000 * 2); // 1000 个 16-bit 采样
  for (let i = 0; i < 1000; i++) pcm.writeInt16LE(i % 1000, i * 2);

  const wav = buildWav(pcm, sampleRate, channels);
  check('生成的文件以 RIFF 开头', wav.toString('ascii', 0, 4) === 'RIFF');
  check('生成的文件含 WAVE 标记', wav.toString('ascii', 8, 12) === 'WAVE');
  check('总长度 = 44 + pcm', wav.length === 44 + pcm.length, `${wav.length} vs ${44 + pcm.length}`);

  const parsed = parseWav(wav);
  check('能解析回来', parsed !== null);
  if (parsed) {
    check('采样率正确', parsed.sampleRate === sampleRate, String(parsed.sampleRate));
    check('声道数正确', parsed.channels === channels, String(parsed.channels));
    check('PCM 数据长度正确', parsed.pcm.length === pcm.length, `${parsed.pcm.length} vs ${pcm.length}`);
    check('PCM 内容完全一致', parsed.pcm.equals(pcm));
  }
}

console.log('\n[3] 解析异常输入不崩');
{
  check('空 buffer 返回 null', parseWav(Buffer.alloc(0)) === null);
  check('太短的 buffer 返回 null', parseWav(Buffer.alloc(10)) === null);
  check('非 WAV 数据返回 null', parseWav(Buffer.from('this is not a wav file at all, just text')) === null);
  check('全零 buffer 返回 null', parseWav(Buffer.alloc(100)) === null);
}

console.log('\n[4] 不同采样率');
{
  for (const sr of [16000, 22050, 24000, 44100, 48000]) {
    const pcm = Buffer.alloc(100);
    const wav = buildWav(pcm, sr, 1);
    const parsed = parseWav(wav);
    check(`${sr}Hz 往返一致`, parsed?.sampleRate === sr, String(parsed?.sampleRate));
  }
}

console.log('\n[5] 立体声');
{
  const pcm = Buffer.alloc(400); // 100 帧 × 2 声道 × 2 字节
  const wav = buildWav(pcm, 24000, 2);
  const parsed = parseWav(wav);
  check('声道数 2 能正确解析', parsed?.channels === 2, String(parsed?.channels));
  check('数据长度正确', parsed?.pcm.length === pcm.length);
}

console.log('\n[6] 唱歌拼接的基础能力：多段 WAV 可以顺序拼');
{
  // 模拟三行歌词
  const parts = [Buffer.alloc(200), Buffer.alloc(300), Buffer.alloc(100)];
  const combined = Buffer.concat(parts);
  check('拼接后长度是总和', combined.length === 600, String(combined.length));

  const wav = buildWav(combined, 24000);
  const parsed = parseWav(wav);
  check('拼接后仍能正确解析', parsed?.pcm.length === 600, String(parsed?.pcm.length));
}

console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
process.exit(fail > 0 ? 1 : 0);
