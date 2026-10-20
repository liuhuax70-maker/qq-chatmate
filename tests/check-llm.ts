/**
 * LLM 连通性测试：真实调用一次 DeepSeek。
 * 运行：npm run check:llm
 */
import dotenv from 'dotenv';
import { LLMClient } from '../src/brain/llm';
import { initLogger } from '../src/infra/logger';

dotenv.config();

const logger = initLogger({ level: 'info', pretty: true, maskQQ: true });

async function main(): Promise<void> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.error('❌ 没有找到 DEEPSEEK_API_KEY，请先配置 .env');
    process.exit(1);
  }

  console.log('→ 正在测试 DeepSeek 连通性…\n');

  const llm = new LLMClient(
    {
      baseURL: 'https://api.deepseek.com',
      apiKey,
      model: 'deepseek-chat',
      temperature: 0.85,
      topP: 0.95,
      maxTokens: 60,
      timeoutMs: 30000,
      retries: 0,
      retryDelayMs: 2000,
      maxConcurrent: 2,
      requestsPerMinute: 20,
    },
    logger,
  );

  try {
    const t0 = Date.now();
    const res = await llm.generate([
      { role: 'system', content: '你是一个真实的人在 QQ 上聊天，不用敬语，句子很短。' },
      { role: 'user', content: '在吗' },
    ]);
    const elapsed = Date.now() - t0;

    console.log('\n✅ API 调用成功');
    console.log(`   模型回复：「${res.text}」`);
    console.log(`   耗时：${elapsed}ms`);
    console.log(`   token：prompt=${res.promptTokens}, completion=${res.completionTokens}`);

    // 粗略成本估算（deepseek-chat 官方价：输入约 0.5 元/百万 token，输出约 2 元/百万 token）
    const cost = (res.promptTokens / 1_000_000) * 0.5 + (res.completionTokens / 1_000_000) * 2;
    console.log(`   本次成本：约 ${cost.toFixed(6)} 元`);
  } catch (err) {
    const msg = (err as Error).message;
    console.error('\n❌ API 调用失败');
    console.error(`   ${msg}`);
    if (msg.includes('401') || msg.includes('Authentication')) {
      console.error('   → Key 无效或已失效，请去 DeepSeek 后台确认');
    } else if (msg.includes('402') || msg.includes('Insufficient')) {
      console.error('   → 账户余额不足，需要充值');
    } else if (msg.includes('429')) {
      console.error('   → 请求过于频繁，稍后再试');
    }
    process.exit(1);
  }
}

void main();
