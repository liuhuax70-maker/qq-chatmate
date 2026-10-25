/**
 * 批量补充表情包 + 语义标注。
 *
 * 场景：
 *   表情池太小（只有 2 张），不管算法怎么优化都会重复，人机感重。
 *   解决要让池子变大，但新表情默认是 untagged，按场景挑图时匹配不上。
 *
 * 这个工具做两件事：
 *   1. 从 OneBot 收藏拉取所有表情，补进库
 *   2. 对没有标签的，让 LLM 按「文件名 + 上下文」猜一个语义标签
 *
 * 注意：LLM 只能猜。真正的理解还是靠用户发过来时问清楚（learn 流程）。
 *   这里标注的作用是让新表情**至少能用**，不至于全是 generic。
 *
 * 用法：
 *   npx tsx tools/import-stickers.ts
 */

import path from 'node:path';
import { loadConfig } from '../src/config';
import { Store } from '../src/store/db';
import { StickerLibrary } from '../src/responder/stickers';
import { initLogger } from '../src/infra/logger';
import { LLMClient } from '../src/brain/llm';
import { SCENE_LIST } from '../src/responder/sticker-understand';

const ROOT = path.resolve(__dirname, '..');
const logger = initLogger({ level: 'info', pretty: true, maskQQ: true });

async function main(): Promise<void> {
  const cfg = loadConfig(ROOT);
  const store = new Store(path.resolve(ROOT, cfg.memory.db.path));
  const lib = new StickerLibrary(store, logger);
  const llm = new LLMClient(
    {
      baseURL: cfg.llm.baseURL,
      apiKey: cfg.llm.apiKey,
      model: cfg.llm.model,
      temperature: 0.3,
      topP: 0.9,
      maxTokens: 300,
      timeoutMs: cfg.llm.timeoutMs,
      retries: cfg.llm.retries,
      retryDelayMs: cfg.llm.retryDelayMs,
      maxConcurrent: cfg.llm.maxConcurrent,
      requestsPerMinute: cfg.llm.requestsPerMinute,
    },
    logger,
  );

  // 从 OneBot 拉收藏需要 adapter。这里不启整个 adapter，
  // 而是用 HTTP 直连本地管理接口。
  const cfgUrl = `http://127.0.0.1:${cfg.infra.server.port}/api/fetch_custom_face`;

  console.log('=== 拉取收藏表情 ===');
  let urls: string[] = [];
  try {
    const res = await fetch(cfgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const j = (await res.json()) as { ok?: boolean; data?: unknown };
    if (j.ok && Array.isArray(j.data)) {
      urls = j.data as string[];
    }
  } catch (err) {
    console.error('拉取失败:', (err as Error).message);
    console.error('提示：机器人必须在运行（fetch_custom_face 走它的 WS 通道）');
    store.close();
    process.exit(1);
  }

  console.log(`  收藏里拿到 ${urls.length} 张`);
  if (urls.length === 0) {
    console.log('  收藏是空的。请先去手机 QQ 里收藏一些表情。');
    store.close();
    return;
  }

  // 补进库
  const before = lib.size();
  await lib.refreshGeneric(urls);
  const after = lib.size();
  console.log(`  库从 ${before} 张 → ${after} 张`);

  // 对没标签的做 LLM 猜测
  const untagged = lib.list().filter((s) => s.tags.includes('untagged') || s.tags.length === 0);
  console.log(`\n=== 有 ${untagged.length} 张需要打标签 ===`);

  let tagged = 0;
  for (const s of untagged.slice(0, 40)) {
    try {
      const prompt = [
        '这是一张 QQ 表情包，你不知道图片内容，只能从 URL 和常见规律推测。',
        '请给一个最可能的情绪/场景标签。',
        `可选：${SCENE_LIST.join(', ')}`,
        '只输出一个词，不要解释。如果完全无法判断就输出 generic。',
      ].join('\n');

      const res = await llm.generate(
        [
          { role: 'system', content: '你只输出一个场景标签词。' },
          { role: 'user', content: prompt },
        ],
        { temperature: 0.3, maxTokens: 20 },
      );

      const tag = res.text.trim().toLowerCase().replace(/[^a-z]/g, '');
      if ((SCENE_LIST as readonly string[]).includes(tag)) {
        lib.tag(s.url, [tag]);
        tagged++;
        console.log(`  ✅ ${s.id} → ${tag}`);
      } else {
        console.log(`  ? ${s.id} → 无法判断（保持 untagged）`);
      }
    } catch (err) {
      console.log(`  ❌ ${s.id} 失败: ${(err as Error).message}`);
    }
  }

  console.log(`\n=== 完成 ===`);
  console.log(`  库大小: ${lib.size()} 张`);
  console.log(`  本次新打标签: ${tagged} 张`);
  console.log(
    lib.isPoolHealthy()
      ? '  ✅ 池子健康（>= 5 张），可以正常发'
      : '  ⚠️ 池子仍然偏小，建议再多收藏一些',
  );

  store.close();
}

void main().catch((err) => {
  console.error('失败:', err);
  process.exit(1);
});
