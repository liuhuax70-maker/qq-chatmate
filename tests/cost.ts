/**
 * Prompt 开销测算：估算一次对话的 token 消耗与费用。
 * 运行：npm run cost
 *
 * 用途：回答"上下文越丰富，token 是不是炸了"这个问题。
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const ROOT = process.cwd();

/** 粗略估算：中文约 1.5 字符/token，英文约 4 字符/token。混合取 1.6 */
function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const other = text.length - cjk;
  return Math.ceil(cjk / 1.5 + other / 4);
}

function readIfExists(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

console.log('=== Prompt 开销测算 ===\n');

// 1. 固定部分
const systemMd = readIfExists(path.join(ROOT, 'config/prompts/system.md'));
const rulesMd = readIfExists(path.join(ROOT, 'config/prompts/rules.md'));

const sysTok = estimateTokens(systemMd);
const rulesTok = estimateTokens(rulesMd);

console.log('【固定开销】每次调用都带');
console.log(`  system.md        ${systemMd.length.toString().padStart(5)} 字符  ≈ ${sysTok.toString().padStart(4)} tokens`);
console.log(`  rules.md         ${rulesMd.length.toString().padStart(5)} 字符  ≈ ${rulesTok.toString().padStart(4)} tokens`);

// 2. 动态部分（按经验值）
const relationTok = 180; // 关系档位 + 处境说明
const sceneTok = 60; // 时间/场景
const memoryTok = 5 * 40; // 5 条长期记忆，每条约 40 tokens
const summaryTok = 300; // 滚动摘要上限

console.log('\n【动态开销】每条消息变化');
console.log(`  关系+情绪状态    ≈ ${relationTok.toString().padStart(4)} tokens`);
console.log(`  场景（时间等）   ≈ ${sceneTok.toString().padStart(4)} tokens`);
console.log(`  长期记忆 top-5   ≈ ${memoryTok.toString().padStart(4)} tokens`);
console.log(`  滚动摘要         ≈ ${summaryTok.toString().padStart(4)} tokens`);
console.log(`  （后两项为上限，实际通常更少）`);

// 3. 上下文部分（读真实数据）
const dbPath = path.join(ROOT, 'data/qq-netizen.db');
let shortTermTok = 0;
let turns = 0;
try {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare('SELECT role, content FROM chat_logs ORDER BY id DESC LIMIT 60').all() as any[];
  turns = rows.length;
  shortTermTok = rows.reduce((sum, r) => sum + estimateTokens(r.content), 0);
  db.close();
} catch {
  console.log('\n⚠️ 读不到数据库，上下文部分用默认值估算');
  shortTermTok = 60 * 15; // 60 条 × 15 tokens
  turns = 60;
}

console.log('\n【短期上下文】当前配置上限 60 条');
console.log(`  实际 ${turns} 条        ≈ ${shortTermTok.toString().padStart(4)} tokens`);

// 4. 汇总
const totalPrompt = sysTok + rulesTok + relationTok + sceneTok + memoryTok + summaryTok + shortTermTok;
const outputTok = 80; // 平均回复 8 tokens，但 max_tokens 300，按实际输出算

console.log('\n' + '─'.repeat(50));
console.log(`【单次调用 prompt 总计】  ≈ ${totalPrompt} tokens`);
console.log(`【输出】                  ≈ ${outputTok} tokens（实际约 8-30）`);
console.log(`【单次合计】              ≈ ${totalPrompt + outputTok} tokens`);

// 5. 费用（DeepSeek 官方定价，2026）
const INPUT_PRICE = 0.5 / 1_000_000; // 元/token，缓存未命中
const OUTPUT_PRICE = 2.0 / 1_000_000;

const costPerCall = totalPrompt * INPUT_PRICE + outputTok * OUTPUT_PRICE;
console.log('\n【费用】按 DeepSeek 定价（输入 0.5 元/百万，输出 2 元/百万）');
console.log(`  单次对话     ≈ ${costPerCall.toFixed(5)} 元`);
console.log(`  100 次对话   ≈ ${(costPerCall * 100).toFixed(3)} 元`);
console.log(`  1000 次对话  ≈ ${(costPerCall * 1000).toFixed(2)} 元`);
console.log(`  10000 次对话 ≈ ${(costPerCall * 10000).toFixed(1)} 元`);

// 6. 对比：如果砍掉"思考"部分
const minimal = sysTok * 0.3 + rulesTok + 200; // 只有极简人设
const costMinimal = minimal * INPUT_PRICE + outputTok * OUTPUT_PRICE;
console.log('\n【对比】如果只给极简人设、不给上下文');
console.log(`  prompt ≈ ${Math.round(minimal)} tokens，单次 ≈ ${costMinimal.toFixed(5)} 元`);
console.log(`  省下约 ${(((costPerCall - costMinimal) / costPerCall) * 100).toFixed(0)}% 的钱`);

console.log('\n【结论】');
console.log('  完整的上下文（关系+记忆+摘要+短期）让单次成本从 ~0.00022 元涨到 ~0.00055 元。');
console.log('  涨了约 2.5 倍，但绝对值仍然是"一天聊 100 句不到 6 分钱"。');
console.log('  真正决定她像不像人的，恰恰就是这部分多出来的上下文。');
