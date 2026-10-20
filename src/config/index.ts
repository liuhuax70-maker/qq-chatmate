import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * 配置加载：默认配置 + 本地覆盖 + 环境变量替换。
 * ${VAR} 形式的值从 process.env 读取，缺失则报错（避免静默使用空值）。
 */

const EMBEDDING = z.object({
  provider: z.string().default('openai-compatible'),
  baseURL: z.string().optional(),
  apiKey: z.string().optional(),
  model: z.string().default('BAAI/bge-m3'),
  dimensions: z.number().default(1024),
});

const ConfigSchema = z.object({
  app: z.object({
    name: z.string().default('qq-netizen'),
    env: z.string().default('development'),
    scenario: z.enum(['private-only']).default('private-only'),
  }),

  adapter: z.object({
    type: z.literal('onebot11').default('onebot11'),
    transport: z.enum(['reverse-websocket', 'forward-websocket']).default('reverse-websocket'),
    // reverse-websocket：本程序起 WS 服务端，协议端主动连过来
    listen: z
      .object({
        host: z.string().default('127.0.0.1'),
        port: z.number().default(8080),
        path: z.string().default('/onebot/v11/ws'),
      })
      .default({}),
    // forward-websocket：本程序主动连协议端
    url: z.string().nullish().transform((v) => v ?? undefined),
    accessToken: z.string().nullish().transform((v) => v ?? undefined),
    selfId: z.string(),
    heartbeatIntervalMs: z.number().default(30000),
  }),

  pipeline: z.object({
    mergeWindowMs: z.number().default(1500),
    // 从第一条算起最多等多久。默认 6 秒：足够把"慢慢说完的一件事"收全，
    // 又不至于让她迟迟不反应。
    mergeMaxWaitMs: z.number().default(6000),
    dedup: z.object({ enabled: z.boolean().default(true), windowMs: z.number().default(5000) }).default({}),
    filter: z
      .object({
        allowedUsers: z.array(z.string()).default([]),
        blockedUsers: z.array(z.string()).default([]),
        dropSelf: z.boolean().default(true),
        dropGroupEvents: z.boolean().default(true),
      })
      .default({}),
  }),

  guard: z
    .object({
      friendRequest: z
        .object({
          autoReject: z.boolean().default(true),
          rejectReason: z.string().default(''),
          autoAcceptWhitelisted: z.boolean().default(true),
        })
        .default({}),
      groupInvite: z
        .object({
          autoLeave: z.boolean().default(true),
          leaveDelayMs: z.number().default(0),
          announceOnLeave: z.boolean().default(false),
        })
        .default({}),
      groupRequest: z.object({ autoReject: z.boolean().default(true) }).default({}),
      unknownPrivate: z
        .object({
          action: z.enum(['drop', 'log-only']).default('drop'),
          skipLLM: z.boolean().default(true),
          escalateAfterN: z.number().default(1),
        })
        .default({}),
      alert: z
        .object({
          enabled: z.boolean().default(true),
          onUnknownPrivate: z.boolean().default(true),
          onGroupJoin: z.boolean().default(true),
          onFriendRequest: z.boolean().default(true),
        })
        .default({}),
    })
    .default({}),

  session: z.object({
    shortTermLimit: z.number().default(60),
    contextMaxTokens: z.number().default(4000),
    lockTimeoutMs: z.number().default(60000),
    persistIntervalMs: z.number().default(30000),
  }),

  persona: z.object({
    default: z.string().default('default'),
    dir: z.string().default('config/personas'),
    promptsDir: z.string().default('config/prompts'),
    moodDecayPerHour: z.number().default(0.15),
    moodFloor: z.number().default(-0.6),
    moodCeiling: z.number().default(0.6),
    intimacy: z
      .object({
        enabled: z.boolean().default(true),
        perExchange: z.number().default(0.02),
        decayPerDay: z.number().default(0.05),
        decayAfterDays: z.number().default(7),
        max: z.number().default(1),
      })
      .default({}),
  }),

  llm: z.object({
    provider: z.string().default('deepseek'),
    baseURL: z.string(),
    apiKey: z.string(),
    model: z.string().default('deepseek-chat'),
    temperature: z.number().default(0.85),
    topP: z.number().default(0.95),
    maxTokens: z.number().default(300),
    timeoutMs: z.number().default(30000),
    retries: z.number().default(1),
    retryDelayMs: z.number().default(2000),
    maxConcurrent: z.number().default(2),
    requestsPerMinute: z.number().default(20),
  }),

  memory: z.object({
    enabled: z.boolean().default(true),
    db: z.object({ path: z.string().default('data/qq-netizen.db') }).default({}),
    vector: z
      .object({
        enabled: z.boolean().default(false),
        path: z.string().default('data/vectors'),
        embedding: EMBEDDING.default({}),
      })
      .default({}),
    longTerm: z
      .object({
        topK: z.number().default(5),
        importanceThreshold: z.number().default(0.25),
        ttlDays: z.number().default(365),
        extractEveryNTurns: z.number().default(8),
        explicitKeywords: z.array(z.string()).default(['记住', '别忘了', '下次', '约好', '说好了', '帮我记']),
      })
      .default({}),
    summary: z
      .object({ enabled: z.boolean().default(true), triggerAtTurns: z.number().default(30), maxSummaryChars: z.number().default(500) })
      .default({}),
  }),

  responder: z.object({
    typing: z
      .object({
        baseMs: z.number().default(800),
        perCharMs: z.number().default(40),
        jitter: z.number().default(0.3),
        maxMs: z.number().default(8000),
      })
      .default({}),
    split: z
      .object({
        enabled: z.boolean().default(true),
        minCharsToSplit: z.number().default(60),
        maxCharsPerMessage: z.number().default(60),
        pauseMsMin: z.number().default(500),
        pauseMsMax: z.number().default(1500),
      })
      .default({}),
    typo: z.object({ enabled: z.boolean().default(false), probability: z.number().default(0.05) }).default({}),
    maxChars: z.number().default(120),
    // 收藏表情包：短回复后附加一张贴纸
    sticker: z
      .object({
        enabled: z.boolean().default(true),
        probability: z.number().default(0.25),
      })
      .default({}),
    // 语音回复：短句偶尔用 GPT-SoVITS 合成一条语音，替代打字
    voice: z
      .object({
        enabled: z.boolean().default(false),
        // 触发概率（仅对短回复生效）
        probability: z.number().default(0.15),
        // 只对不超过这个字数的回复发语音
        maxChars: z.number().default(15),
        // GPT-SoVITS HTTP 服务地址
        serverUrl: z.string().default('http://127.0.0.1:9880'),
        timeoutMs: z.number().default(60000),
        // 语速因子：1.0 参考原速（偏慢），1.3 正常语速
        speed: z.number().default(1.3),
        // 合成失败是否回退为文字（true = 回退，保证有回复）
        fallbackToText: z.boolean().default(true),
      })
      .default({}),
  }),

  throttle: z
    .object({
      burstWindowSeconds: z.number().default(45),
      burstMaxReplies: z.number().default(2),
      burstSkipProbability: z.number().default(1.0),
      floodWindowSeconds: z.number().default(10),
      floodThreshold: z.number().default(5),
      floodSkipProbability: z.number().default(1.0),
      cooldownAfterSkipSeconds: z.number().default(20),
    })
    .default({}),

  proactive: z
    .object({
      enabled: z.boolean().default(true),
      quietHours: z.tuple([z.number(), z.number()]).default([1, 8]),
      maxPerDay: z.number().default(2),
      maxPerHour: z.number().default(1),
      minGapMinutes: z.number().default(120),
      ignoreBackoff: z
        .object({ enabled: z.boolean().default(true), factor: z.number().default(2), maxMultiplier: z.number().default(8), resetAfterReply: z.boolean().default(true) })
        .default({}),
      triggers: z
        .object({
          silence: z.object({ enabled: z.boolean().default(true), idleHours: z.number().default(6), probability: z.number().default(0.3), topicsFile: z.string().optional() }).default({}),
          share: z
            .object({
              enabled: z.boolean().default(true),
              idleHours: z.number().default(4),
              probability: z.number().default(0.35),
              topicsFile: z.string().optional(),
              fromMemory: z.boolean().default(true),
            })
            .default({}),
          care: z
            .object({
              enabled: z.boolean().default(true),
              idleHours: z.number().default(5),
              probability: z.number().default(0.4),
              fromMemory: z.boolean().default(true),
            })
            .default({}),
          morning: z
            .object({
              enabled: z.boolean().default(true),
              wakeWindow: z.tuple([z.number(), z.number()]).default([6, 8]),
              lateWake: z.object({ probability: z.number().default(0.2), window: z.tuple([z.number(), z.number()]).default([9, 12]) }).default({}),
              delayMinutes: z.tuple([z.number(), z.number()]).default([5, 40]),
              skipProbability: z.number().default(0.25),
              pauseAfterIgnores: z.number().default(2),
              pauseDays: z.number().default(3),
            })
            .default({}),
          night: z
            .object({
              enabled: z.boolean().default(true),
              sleepWindow: z.tuple([z.number(), z.number()]).default([0, 2]),
              awakeAfterGoodnightMinutes: z.number().default(30),
              hardSleep: z.boolean().default(true),
              // 半夜被吵醒后，需要多久才能回消息（分钟区间）
              wakeUpDelayMinutes: z.tuple([z.number(), z.number()]).default([2, 8]),
              // 被吵醒后能聊多久，然后重新睡着（分钟）
              stayAwakeMinutes: z.number().default(15),
              mentionNightMessages: z.object({ enabled: z.boolean().default(true) }).default({}),
              // 问候发出后用户多久没回，她会撒娇催一下（分钟）。0 = 不撒娇
              teaseAfterIgnoredMinutes: z.number().default(20),
              skipProbability: z.number().default(0.15),
              pauseAfterIgnores: z.number().default(2),
              pauseDays: z.number().default(3),
            })
            .default({}),
          promise: z.object({ enabled: z.boolean().default(true), horizonHours: z.number().default(24) }).default({}),
        })
        .default({}),
      safety: z
        .object({
          maxChars: z.number().default(60),
          forbiddenTopics: z.array(z.string()).default([]),
        })
        .default({}),
    })
    .default({}),

  infra: z.object({
    log: z.object({ level: z.string().default('info'), pretty: z.boolean().default(true), maskQQ: z.boolean().default(true) }).default({}),
    server: z.object({ host: z.string().default('127.0.0.1'), port: z.number().default(3000), authToken: z.string().optional() }).default({}),
    metrics: z.object({ enabled: z.boolean().default(true) }).default({}),
  }),

  // 控制面板：监控 + 启停各组件
  control: z
    .object({
      tts: z
        .object({
          python: z.string().default(''),
          script: z.string().default(''),
          workdir: z.string().default(''),
          port: z.number().default(9880),
        })
        .default({}),
      lagrange: z
        .object({
          exe: z.string().default(''),
          workdir: z.string().default(''),
          bundleExtractBase: z.string().optional(),
        })
        .default({}),
      signServer: z
        .object({
          container: z.string().default('ntqq-sign-server'),
          port: z.number().default(8090),
        })
        .default({}),
    })
    .default({}),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

/** 允许为空的可选环境变量：缺失时替换为空串而不是报错 */
const OPTIONAL_VARS = new Set(['EMBEDDING_API_KEY', 'EMBEDDING_BASE_URL', 'ADMIN_TOKEN']);

/** 递归替换字符串里的 ${VAR} */
function interpolate(value: unknown): unknown {
  if (typeof value === 'string') {
    // 整串就是一个变量引用时，空值返回空串（便于可选配置留空）
    const whole = value.match(/^\$\{([A-Z0-9_]+)\}$/);
    if (whole) {
      const v = process.env[whole[1]];
      if ((v === undefined || v === '') && OPTIONAL_VARS.has(whole[1])) return '';
      if (v === undefined || v === '') {
        throw new Error(`配置引用了环境变量 ${whole[1]}，但它没有设置。请检查 .env 文件。`);
      }
      return v;
    }
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (match, name: string) => {
      const v = process.env[name];
      if ((v === undefined || v === '') && OPTIONAL_VARS.has(name)) return '';
      if (v === undefined || v === '') {
        throw new Error(`配置引用了环境变量 ${name}，但它没有设置。请检查 .env 文件。`);
      }
      return v;
    });
  }
  if (Array.isArray(value)) return value.map(interpolate);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = interpolate(v);
    return out;
  }
  return value;
}

function deepMerge(base: any, override: any): any {
  if (override === null || override === undefined) return base;
  if (Array.isArray(override)) return override;
  if (typeof override !== 'object' || typeof base !== 'object' || base === null) return override;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}

function readYamlIfExists(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = parseYaml(raw);
  return (parsed ?? {}) as Record<string, unknown>;
}

export function loadConfig(rootDir: string = process.cwd()): AppConfig {
  const base = readYamlIfExists(path.resolve(rootDir, 'config/default.yaml'));
  const local = readYamlIfExists(path.resolve(rootDir, 'config/local.yaml'));
  const merged = deepMerge(base, local);

  const interpolated = interpolate(merged) as Record<string, unknown>;

  // 环境变量兜底（优先级高于 yaml）
  if (process.env.ONEBOT_SELF_ID) (interpolated.adapter as any).selfId = process.env.ONEBOT_SELF_ID;
  if (process.env.ONEBOT_ACCESS_TOKEN) (interpolated.adapter as any).accessToken = process.env.ONEBOT_ACCESS_TOKEN;
  if (process.env.DEEPSEEK_API_KEY) (interpolated.llm as any).apiKey = process.env.DEEPSEEK_API_KEY;
  if (process.env.ADMIN_TOKEN) (interpolated.infra as any).server.authToken = process.env.ADMIN_TOKEN;

  const result = ConfigSchema.safeParse(interpolated);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`配置校验失败：\n${issues}`);
  }
  return result.data;
}
