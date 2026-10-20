/** 分段逻辑测试：npm run test:split */
import { PostProcessor } from '../src/responder';
import { loadPersona } from '../src/persona';
import { initLogger } from '../src/infra/logger';

const logger = initLogger({ level: 'error', pretty: false, maskQQ: true });
const persona = loadPersona('config/personas', 'default');

const post = new PostProcessor(
  {
    typing: { baseMs: 800, perCharMs: 40, jitter: 0.3, maxMs: 8000 },
    split: { enabled: true, minCharsToSplit: 60, maxCharsPerMessage: 60, pauseMsMin: 500, pauseMsMax: 1500 },
    typo: { enabled: false, probability: 0 },
    maxChars: 150,
  },
  persona,
  logger,
);

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

console.log('=== 分段逻辑测试 ===\n');

console.log('[1] 短回复不拆');
check('单句原样返回', post.split('嗯').length === 1);
check('短句原样返回', post.split('懒得动 不想起').length === 1);

console.log('\n[2] 模型用换行分好 → 直接采用');
{
  const r = post.split('先说好\n我只是看一眼');
  check('拆成两条', r.length === 2, JSON.stringify(r));
  check('内容正确', r[0] === '先说好' && r[1] === '我只是看一眼');
}

console.log('\n[3] 转折词拆分（够长的句子）');
{
  // 这句话 32 字，超过 30 的"太短不拆"阈值
  const r = post.split('行吧 那就这样吧 我也不多说了 但是你要记得给我留一口饭');
  check('在转折处拆开', r.length === 2, JSON.stringify(r));
  check('第二条以转折词开头', r[1]?.startsWith('但是'), JSON.stringify(r));
}

console.log('\n[3b] 太短的句子即使有转折也不拆');
{
  const r = post.split('行吧但是不行');
  check('短句不拆', r.length === 1, JSON.stringify(r));
}

console.log('\n[4] 最多三条');
{
  const r = post.split('一\n二\n三\n四');
  check('即使模型分了 4 行也只取 3 条', r.length === 3, JSON.stringify(r));
}

console.log('\n[5] 超长兜底拆分');
{
  const long = '我今天真的不想动'.repeat(10); // 80 字
  const r = post.split(long);
  check('拆成两条', r.length === 2, `实际 ${r.length}`);
  check('每条都在限长附近', r[0].length <= 60 && r[1].length <= 60, `len=${r.map((x) => x.length)}`);
}

console.log('\n[6] 转折词位置太靠前不拆');
{
  const r = post.split('但是我觉得你说得对');
  check('转折词在开头不拆', r.length === 1, JSON.stringify(r));
}

console.log('\n[7] 中等长度不拆');
{
  const text = '今天没什么想说的 就是有点累 想早点睡'; // 约 22 字
  check('22 字不拆', post.split(text).length === 1, JSON.stringify(post.split(text)));
}

console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
process.exit(fail > 0 ? 1 : 0);
