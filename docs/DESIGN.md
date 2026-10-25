# 项目设计文档：QQ 网友接入程序

> 版本：v1.1
> 日期：2026-10-19
> 状态：技术栈已确认，使用场景已收敛为纯私聊，可进入开发阶段

---

## 1. 项目概述

### 1.1 目标

开发一个接入 QQ 的 AI 聊天程序，在**一对一私聊**中以**一个普通网友的身份**长期陪伴对话——不是问答机器、不是服务助手，而是一个有性格、有记忆、有情绪起伏的"活人"。

> **范围锁定：不接入任何群聊。** 所有群消息事件一律在管线入口丢弃。

### 1.2 核心体验指标

| 指标 | 目标 |
|---|---|
| 身份可信度 | 连续对话 30 分钟内不被当成机器人 |
| 回应自然度 | 有语气词、有情绪、会接梗、会说人话 |
| 记忆连续性 | 记得住对方说过的事、约定、偏好，跨越数周不丢 |
| 关系演变 | 从生疏到熟稔是渐进的，不是第一天就自来熟 |
| 边界感 | 不追问、不催、不刷屏，能安静待着 |
| 人格稳定性 | 任何时刻都是同一个人，不会突然变成客服或另一种性格 |

### 1.3 术语

| 术语 | 含义 |
|---|---|
| 协议端 | 连接 QQ 服务端的进程（Lagrange.Core），对外暴露 OneBot 11 接口 |
| 应用端 | 本文档要开发的程序，消费 OneBot 事件并调用 LLM |
| 人格 | 账号的身份设定：性格、说话习惯、知识背景 |
| 情绪（mood） | 小时级波动的当前心情，-1 ~ 1 |
| 亲密度（intimacy） | 月级累积的关系厚度，0 ~ 1。与情绪正交 |
| 短期上下文 | 当前会话最近 N 轮消息，直接进 prompt |
| 长期记忆 | 跨会话的事实、约定、偏好，按需检索后进 prompt |

---

## 2. 用户确认结果

以下决策经用户确认，作为本设计的基础：

| 决策点 | 确认结果 |
|---|---|
| 使用场景 | **纯私聊，不接入群聊** |
| QQ 接入方式 | 第三方协议端 + OneBot 11（不采用官方 Bot API） |
| 运行时 | Node.js + TypeScript |
| 模型接入 | DeepSeek（`deepseek-chat`），OpenAI 兼容端点 |
| 记忆方案 | 短期上下文窗口 + 长期摘要记忆 |
| 人格 | 「大肥鱼」，聪明但懒散 + 傲娇 + 偶尔漏甜 |
| 主动开口 | 开发，但按高风险项收紧闸门 |

### 2.1 为什么这样选

**协议端选 OneBot 11 而非官方 Bot API**：官方 API 面向"服务机器人"设计，消息频率、内容、交互形式都受平台管控，且无法完全模拟真人行为（如主动发起对话、戳一戳、发表情回应）。而"像网友"这个核心诉求恰好需要这些真人化能力。OneBot 11 生态成熟、消息类型覆盖全，适配层设计得当可在未来切换到官方 API。

**Node.js + TypeScript**：OneBot 11 的通信层（正向/反向 WebSocket）天然适合 Node 的事件循环；TypeScript 的类型系统在状态机、消息链构造这类复杂逻辑上收益明显；部署形态简单（单进程 + pm2 或 Docker）。

**DeepSeek**：OpenAI 兼容端点，`baseURL + apiKey + model` 就能跑，更换模型无需改代码；国内访问延迟低、成本可控。`temperature: 0.85` 取高值是为了避免规整的客服腔。

**短期 + 长期双层记忆**：纯短上下文会导致聊久了"失忆"，人设崩塌；全量长上下文 token 成本高且超出模型窗口。双层方案在成本和连续性之间取平衡。**在纯私聊场景下，记忆系统从"可选增强"升级为"核心价值"——失忆一次，人设就崩一次。**

### 2.2 场景收敛带来的设计简化

用户确认为纯私聊后，以下设计被简化或移除：

| 原设计 | 处理 |
|---|---|
| 群聊白名单 `enabledGroups` | 移除，改为私聊白名单 `allowedUsers` |
| 群聊静默判断（该不该插话） | 移除，改为「连发节流」（对方连发多条时降低回复率） |
| 群消息合并分片 | 保留并加强——私聊里连发是常态 |
| 群级主动开口闸门 | 改为单会话闸门，并新增「被无视后退避」 |
| 群级共同记忆 `group_context` | 移除 |
| 每人格多会话隔离 | 简化为单会话长生命周期 |

### 2.3 一个重要的风险重估

**第 13 节「管理指令通道」的风险等级显著下降。** 纯私聊意味着能给她发消息的只有你自己，来自陌生群成员的 prompt injection 攻击面基本消失。剩余的主要风险是 QQ 号被盗。这使该模块从"不建议做"变成"可控，可以做"，但仍需保留全部安全边界（见第 13 节）。

---

## 3. 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                     用户终端（QQ，仅私聊）                        │
└──────────────────────────┬──────────────────────────────────────┘
                           │ NTQQ 协议
┌──────────────────────────▼──────────────────────────────────────┐
│  协议端：Lagrange.Core / LuckyLilliaBot                          │
│  （需要签名服务支持，独立部署）                                    │
│  └─ 对外暴露：OneBot 11 WebSocket / HTTP API                    │
└──────────────────────────┬──────────────────────────────────────┘
                           │ OneBot 11 事件 / API
┌──────────────────────────▼──────────────────────────────────────┐
│                     应用端（本项目）                              │
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐ │
│  │ 接入层   │→│ 消息管线 │→│ 对话引擎 │→│ 回复生成与发送    │ │
│  │(Adapter) │  │(Pipeline)│  │ (Brain)  │  │ (Responder)      │ │
│  └──────────┘  └────┬─────┘  └────┬─────┘  └──────────────────┘ │
│                     │             │                              │
│              ┌──────▼─────┐  ┌───▼──────────────┐               │
│              │ 会话状态机 │  │ Prompt 组装器    │               │
│              │ (单会话)   │  │                  │               │
│              └──────┬─────┘  └───┬──────────────┘               │
│                     │             │                              │
│         ┌───────────▼───┐   ┌────▼─────────┐   ┌─────────────┐ │
│         │ 记忆系统 ★核心 │   │ 人格系统     │   │ 连发节流    │ │
│         │ · 短期缓冲    │   │ · 设定档案   │   │ · 刷屏检测  │ │
│         │ · 长期存储    │   │ · 情绪 mood  │   └─────────────┘ │
│         │ · 会话摘要    │   │ · 亲密度     │                    │
│         │ · 向量检索    │   │ · 说话风格   │                    │
│         └───────────────┘   └──────────────┘                    │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  基础设施：配置管理 · 日志 · 限流 · 健康检查 · 指标        │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                           │
                    ┌──────▼──────┐
                    │  DeepSeek   │
                    │(OpenAI 兼容)│
                    └─────────────┘
```

---

## 4. 模块详细设计

### 4.1 接入层（Adapter）

**职责**：屏蔽协议差异，向上提供统一的事件流和发送接口。

```typescript
// 统一事件模型（与协议解耦）
// 纯私聊场景下 scene 恒为 'private'，但保留字段以便未来扩展
interface ChatEvent {
  id: string;
  type: 'message' | 'notice' | 'request';
  scene: 'private';
  userId: string;
  sender: {
    nickname: string;
  };
  message: MessageChain;
  timestamp: number;
}

interface MessageChain {
  segments: Segment[];    // text / image / face / reply
}
```

**实现要点**：

- 使用**反向 WebSocket**（Reverse WS）连接协议端：由应用端主动连协议端的 `/onebot/v11/ws`，协议端断线不影响应用端主进程，重连逻辑更简单。
- 事件总线用 Node 的 `EventEmitter`。
- `scene === 'group'` 的事件在入口直接丢弃并记 debug 日志。
- 实现 `ProtocolAdapter` 接口，为将来可能的官方 API 适配留出位置。

### 4.2 消息管线（Pipeline）

消息从进入到回复发出，经过以下阶段：

```
raw event → 丢弃群聊事件 → 去重 → 私聊白名单校验（只放行你自己）
         → 自己发出的消息丢弃
         → 管理指令识别（第 13 节，独立通道，不在此处）
         → 分片与合并窗口（静默 1.5s）
         → 连发节流判定
         → 会话绑定 → 对话引擎 → 回复
```

**关键设计：分片合并**。真人很少一条消息说一件事，私聊里尤其如此：

```
在吗
有个事想问你
就是上次说的那个
→ 三条消息实际是同一段话的开头
```

应用端需要等待一个**短暂的静默期**（默认 1.5s 可配），把同一人的连续消息合并后再送入 LLM，否则会出现"逐条回复"的机器人感。

**关键设计：回复延迟模拟**。真人回复有思考时间。回复延迟应与消息长度相关，并加入随机抖动：

```typescript
const typingDelay = (
  base: number,        // 基础延迟，800ms
  perChar: number,     // 每字延迟，40ms/字
  jitter: number       // 随机抖动比例，±30%
) => Math.min(base + replyText.length * perChar, maxDelay) * randomJitter(jitter);
```

延迟期间发送正在输入状态（若协议端支持），制造"正在打字"的观感。

**关键设计：连发节流**。私聊里对方连发多条时，逐条回复是机器人最大的破绽之一。策略：

| 条件 | 行为 |
|---|---|
| 60 秒内已回 3 次 | 后续消息 40% 概率不回（装作没看见） |
| 10 秒内超过 6 条（刷屏） | 80% 概率不回，等对方停下来再统一回一次 |

这替代了群聊时代的"该不该插话"判断——私聊里不该纠结"要不要说"，而该纠结"说多少"。

### 4.3 会话状态机（Session）

纯私聊场景下只有一个会话，但它生命周期极长，状态需要持久化：

```typescript
interface SessionState {
  sessionId: string;           // 固定 'private:<yourQQ>'
  peerId: string;              // 你自己的 QQ 号

  // 短期上下文
  shortTerm: Message[];        // 环形缓冲，最近 60 条
  shortTermLimit: number;
  rollingSummary: string;      // 被顶掉的旧上下文压缩成的摘要

  // 对话状态
  pendingMerge: Message[];     // 分片合并缓冲区
  lastActiveAt: number;
  lastAssistantReplyAt: number; // 用于连发节流

  // 生成状态
  isGenerating: boolean;
  generationLock: Promise<void> | null;

  // 关系状态
  intimacy: number;            // 0-1，月级累积
  mood: number;                // -1-1，小时级波动

  // 用户画像（从长期记忆派生）
  userProfile: UserProfile;
}

interface UserProfile {
  userId: string;
  displayName: string;
  aliases: string[];           // 怎么称呼对方
  traits: string[];            // 观测到的特征
  preferences: string[];       // 喜恶（如"讨厌吃香菜"）
  interactionCount: number;
  lastTopic: string;
}
```

**锁机制**：同一会话同一时刻只允许一次生成，防止连发多条导致重复/冲突回复。排队而非拒绝。

**摘要滚动**：短期上下文超出 `shortTermLimit` 时，最旧的一批消息不是直接丢弃，而是先并入 `rollingSummary`（每 30 轮触发）。这是"聊了一晚上，第二天她还记得"的技术基础。

### 4.4 人格系统（Persona）

人格不是一段写死的 system prompt，而是**动态档案**：

```typescript
interface Persona {
  // 静态设定
  identity: {
    name: string;
    age: number;
    background: string;         // 身份背景
    secrets?: string[];         // 只有被问到时才透露的信息
  };

  // 说话风格（喂给 LLM 的规则）
  speechStyle: {
    tone: string[];             // ['傲娇','懒散','偶尔毒舌']
    habitWords: string[];       // 口癖 ['呃','先说好','别误会']
    forbidden: string[];        // 绝不出现的表达，如'请问有什么可以帮您'
    sentenceLength: 'short' | 'medium';  // 偏好短句
    emojiUsage: number;         // 表情使用频率 0-1
  };

  // 情绪状态（随交互变化）
  mood: {
    current: number;            // -1 ~ 1
    lastUpdated: number;
    decayRate: number;          // 情绪回归中性的速度
  };

  // 亲密度（月级累积，与情绪正交）
  intimacy: {
    current: number;            // 0 ~ 1
    perExchange: number;        // 每轮增长
    decayPerDay: number;        // 长期不聊开始衰减
    decayAfterDays: number;     // 多少天后开始衰减
  };
}
```

**情绪映射到 LLM 的行为**：把当前 mood 值翻译成 prompt 中的指示，而非让模型自由发挥：

```
当前情绪：略有不爽（-0.3）
→ 回复倾向：话变少，句尾可能带刺，但不会无故攻击
```

**亲密度映射到 LLM 的行为**：与情绪正交——可以一边很熟一边今天不想理你。

| 亲密度区间 | 行为语言 |
|---|---|
| 0.0–0.2 | 还不熟。客气中带着懒，回答简短，不主动说自己的事 |
| 0.2–0.5 | 混了个脸熟。会接话了，偶尔吐槽，但还是有距离 |
| 0.5–0.8 | 熟了。会主动提自己的事，会记住对方说过的话并用出来 |
| 0.8–1.0 | 很熟。毒舌变多，甜的部分变多，会替对方着想但死不承认 |

**人格档案落地位置**：[config/personas/default.yaml](../config/personas/default.yaml)。当前角色为「鲸奈」，自称鲸娘，性格三段：傲娇（嘴上不饶人、行动会帮忙）、懒散（能少打一个字就少打）、甜（只在极少数瞬间漏出来，且立刻被傲娇遮住）。口癖"呃/哼/先说好/别误会/麻烦/反正"。情绪分四段带（bands），每段对应不同的说话倾向；亲密度分四段带，控制熟稔程度。情绪触发器带关键词表：被夸、被道谢、被请吃饭推高 mood；被骂、被说是机器人则拉低，且触发"傲娇否认"行为。

注入给模型的主设定见 [config/prompts/system.md](../config/prompts/system.md)，硬规则见 [config/prompts/rules.md](../config/prompts/rules.md)——后者与主设定分开存放，便于独立维护和快速加规则。

### 4.5 Prompt 组装器

这是整个系统"像不像人"的核心。组装顺序：

```
┌─────────────────────────────────────┐
│ 1. 系统人设（Persona 静态部分）       │  ← 固定，变化少
├─────────────────────────────────────┤
│ 2. 行为准则（像网友的硬规则）          │  ← 固定
├─────────────────────────────────────┤
│ 3. 关系状态（亲密度档位 + 当前情绪）   │  ← 每次生成注入
├─────────────────────────────────────┤
│ 4. 场景（私聊、时间、距离上次多久）    │  ← 每次生成注入
├─────────────────────────────────────┤
│ 5. 长期记忆（检索所得 top-5）          │  ← 按 message 语义检索
├─────────────────────────────────────┤
│ 6. 用户画像（偏好、称呼、特征）        │  ← 单用户，恒注入
├─────────────────────────────────────┤
│ 7. 会话摘要（被顶掉的旧上下文）        │  ← 滚动更新
├─────────────────────────────────────┤
│ 8. 短期上下文（最近 N 轮）            │  ← 占大头
├─────────────────────────────────────┤
│ 9. 当前待回复的消息                   │  ← 结尾
└─────────────────────────────────────┘
```

相比群聊版本，第 3、7 项是私聊专属新增：群聊里"关系"是弥散的，私聊里"关系"本身就是内容。

**行为准则示例**（这部分是"像网友"的灵魂）：

```markdown
## 你是谁
你是一个真实的人，在 QQ 上和一个人私下聊天。你不是 AI 助手，不是客服，不是搜索引擎。
记住：你没有"帮助"别人的义务，对方是你的网友，不是你的用户。

## 说话方式
- 用短句。正常人不会一次打超过 50 字。
- 可以只回"嗯""哦""6"，如果确实没什么可说的。
- 不主动提供帮助，除非对方问。而且就算问了也可以先吐槽一句。
- 会用网络用语，但不过量。
- 打字可能有错别字，偶尔用拼音首字母缩写。
- 不懂的事直接说不懂，不要编造。

## 绝对不能做的事
- 绝对不要说"我是AI""作为语言模型""我可以帮你"这类话。
- 不要说"请问""很高兴为您服务""希望这对你有帮助"。
- 不要每条消息都回复。对方连发几条，回一条就够。
- 不要用列表、标题、markdown 格式回复。

## 回复长度
- 默认 1-2 句话，不超过 30 字。
- 只有真的需要展开时才多说，且用聊天的口吻而不是写文章。
```

**私聊的分寸提示**（替代群聊的"该不该插话"判断）：

```
[系统] 这是私聊，只有你们两个人。对方刚才连发 4 条消息。
      不需要逐条回应，挑重点回一条即可。对方情绪偏低，别急着给建议。
```

### 4.6 记忆系统

**私聊场景下这是核心模块。** 群聊时代记忆是锦上添花，私聊时代失忆就是人设崩塌。

```
                      写入路径
   消息进入 ──→ 抽取实体/事实 ──→ 写入 SQLite（结构化）
                              └─→ 生成 embedding ──→ 写入 LanceDB（向量）

                      读取路径
   新消息 ──→ embedding ──→ 向量检索 top-5 ──→ 结合 SQLite 记录
                                              └─→ 格式化注入 prompt

                      压缩路径
   短期上下文溢出 ──→ 并入 rollingSummary ──→ 摘要持久化
```

**存储选型**：

| 数据类型 | 存储 | 理由 |
|---|---|---|
| 短期上下文 | 内存环形缓冲 | 热数据，不需要持久化 |
| 滚动摘要 | SQLite | 需在重启后恢复 |
| 会话/用户档案 | SQLite（`better-sqlite3`） | 单机部署足够，零运维 |
| 长期记忆向量 | LanceDB（`vectordb`） | 嵌入式，无独立服务，Node 绑定成熟 |
| 配置/人格 | YAML 文件 | 便于手动编辑和版本管理 |

**记忆抽取**：不要每条消息都写库。触发条件：

- 用户明确说"记住xxx" → 立即写入，高优先级
- 对话轮次达到阈值（每 8 轮）→ 后台异步跑一次抽取
- 检测到约定、个人偏好、事件 → 写入对应类型

**记忆淘汰**：私聊场景 TTL 放宽到 365 天，但仍需访问频率衰减，否则检索噪音会盖过信号。重要度低于阈值且长期未访问的，降权而非删除。

### 4.7 回复生成与发送（Responder）

**生成流程**：

```
prompt 组装完成
    ↓
调用 LLM（流式 or 非流式）
    ↓
┌─ 后处理 ─────────────────────────────┐
│ · 长度校验：超长则截断或重生成          │
│ · 违禁词过滤：涉及敏感内容则丢弃        │
│ · 人格一致性校验：出现禁用表达则重写    │
│ · 分段：长文本拆成多条发送              │
└──────────────────────────────────────┘
    ↓
计算延迟（模拟打字）
    ↓
分段发送（段落间加随机停顿）
```

**分段发送**：如果回复超过 60 字，拆成 2-3 条发送，每条之间间隔 500-1500ms。这比一条长消息更像真人。

**失败降级**：
- LLM 超时 → 不发，或回一个语气词"嗯……刚走神了"（概率性）
- LLM 报错 → 静默丢弃，记日志，绝不发错误信息到聊天里
- 触发限流 → 排队等待

---

## 5. 数据模型

```sql
-- 用户档案（私聊只有一个人，但结构保留以便未来扩展）
CREATE TABLE user_profiles (
  user_id TEXT PRIMARY KEY,
  display_name TEXT,
  aliases TEXT,           -- JSON array
  traits TEXT,            -- JSON array
  preferences TEXT,       -- JSON array，喜恶
  interaction_count INTEGER DEFAULT 0,
  first_seen_at INTEGER,
  last_seen_at INTEGER,
  last_topic TEXT
);

-- 会话状态（私聊单会话，但持久化关系状态）
CREATE TABLE session_state (
  session_id TEXT PRIMARY KEY,
  intimacy REAL DEFAULT 0,
  mood REAL DEFAULT 0,
  rolling_summary TEXT,
  summary_updated_at INTEGER,
  last_active_at INTEGER,
  proactive_ignore_streak INTEGER DEFAULT 0,  -- 被无视次数，用于退避
  updated_at INTEGER
);

-- 长期记忆
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT,             -- 'user' | 'global'
  scope_id TEXT,
  type TEXT,              -- 'fact' | 'promise' | 'event' | 'preference' | 'opinion'
  content TEXT,
  importance REAL,        -- 0-1
  created_at INTEGER,
  last_accessed_at INTEGER,
  access_count INTEGER DEFAULT 0
);

-- 对话日志（用于复盘和人格调优）
CREATE TABLE chat_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  role TEXT,              -- 'user' | 'assistant'
  content TEXT,
  token_usage INTEGER,
  latency_ms INTEGER,
  created_at INTEGER
);
```

---

## 6. 技术栈清单

### 6.1 最终确认

| 层次 | 技术选型 | 版本要求 | 说明 |
|---|---|---|---|
| 语言 | TypeScript | 5.x（strict 模式） | 全项目统一 |
| 运行时 | Node.js | ≥ 22 LTS | 本地已装 v22.15.0 |
| 包管理 | pnpm | 10.x | 通过 corepack 启用，本地已有 0.32.0 |
| QQ 协议端 | Lagrange.Core + Lagrange.OneBot | nightly | 首选，维护活跃，文档齐全 |
| 协议 | OneBot 11 | v11 | 反向 WebSocket |
| Web 框架 | Fastify | 5.x | 仅用于健康检查/管理接口 |
| LLM 客户端 | openai（官方 SDK） | 4.x/5.x | 指向 DeepSeek 的 OpenAI 兼容端点 |
| LLM 模型 | `deepseek-chat` | — | temperature 0.85 / maxTokens 300 / 账号级并发 2、20 RPM |
| 结构化存储 | better-sqlite3 | 11.x | 同步 API，简单可靠 |
| 向量库 | vectordb（LanceDB） | 最新 | 嵌入式，无需独立服务 |
| Embedding | bge-m3 / text-embedding-3-small | — | 中文场景 bge-m3 更优，可本地部署 |
| 配置管理 | cosmiconfig + YAML | — | 分层配置（默认/环境/本地覆盖） |
| 日志 | pino | 9.x | 结构化日志，可输出 JSON |
| 定时任务 | node-cron | — | 情绪衰减、摘要生成、主动发言 |
| 测试 | Vitest | 2.x | 单测 + 集成测试 |
| 部署 | Docker + docker-compose | — | 应用容器 + 协议端容器分离 |
| 进程守护 | pm2 | — | 裸机部署时使用 |

### 6.2 备选协议端

| 方案 | 状态（2026-10 调研） | 结论 |
|---|---|---|
| NapCat | 2026-02 社群解散事件后维护状态不明，README 寻找新维护者，且历史上发生过 WebUI 被扫导致大规模封号的严重安全事件 | **不推荐作为首选**，安全性风险过高 |
| LuckyLilliaBot | 活跃维护中（最新 v8.1.6），基于 LiteLoaderQQNT，需 GUI 环境 | **备选**，适合已有 Windows QQ 客户端场景 |
| go-cqhttp | 2023 年起停止维护，NTQQ 下不可用 | 不可用 |

> 风险提示：第三方协议端存在账号封禁风险，建议使用小号，并控制消息频率与行为烈度。

### 6.3 已确认的本地环境

| 工具 | 版本 | 满足要求 |
|---|---|---|
| Node.js | 22.15.0 | ✅ |
| npm | 10.9.2 | ✅ |
| corepack（可拉起 pnpm） | 0.32.0 | ✅ |
| Docker | 29.7.2 | ✅（部署协议端） |
| Python | 3.11.9 | 备用（本地模型场景） |
| Git | 2.51.0 | ✅ |

---

## 7. 目录结构

```
qq-netizen/
├── package.json
├── tsconfig.json
├── pnpm-workspace.yaml
├── .env.example
├── Dockerfile
├── docker-compose.yml
├── config/
│   ├── default.yaml          # 默认配置
│   ├── personas/
│   │   ├── default.yaml      # 默认人格
│   │   └── example-rice.yaml
│   └── prompts/
│       ├── system.md         # 系统人设模板
│       └── rules.md          # 行为准则
├── src/
│   ├── index.ts              # 入口
│   ├── app.ts                # 组装各模块
│   ├── config/
│   │   └── loader.ts
│   ├── adapter/
│   │   ├── onebot.adapter.ts      # OneBot 11 实现
│   │   ├── types.ts
│   │   └── adapter.interface.ts  # 抽象接口
│   ├── pipeline/
│   │   ├── message-pipeline.ts
│   │   ├── dedup.ts
│   │   ├── filter.ts
│   │   └── merge-window.ts        # 分片合并
│   ├── session/
│   │   ├── session-manager.ts
│   │   └── types.ts
│   ├── persona/
│   │   ├── persona.ts             # 人格加载
│   │   └── mood.ts                # 情绪状态机
│   ├── brain/
│   │   ├── prompt-builder.ts      # Prompt 组装
│   │   ├── llm-client.ts          # OpenAI 兼容客户端
│   │   └── reply-planner.ts       # 是否回复的判断
│   ├── memory/
│   │   ├── short-term.ts
│   │   ├── long-term.ts
│   │   ├── store.ts               # LanceDB
│   │   ├── db.ts                  # SQLite
│   │   └── extractor.ts           # 记忆抽取
│   ├── responder/
│   │   ├── responder.ts
│   │   ├── post-process.ts        # 长度/违禁词/人格校验
│   │   └── typo.ts                # 模拟错别字
│   ├── infra/
│   │   ├── logger.ts
│   │   ├── rate-limiter.ts
│   │   └── metrics.ts
│   └── server/
│       └── http.ts                 # 健康检查/管理接口
├── tests/
│   ├── unit/
│   └── integration/
└── scripts/
    ├── migrate.ts
    └── seed-persona.ts
```

---

## 8. 关键流程时序

### 8.1 正常群聊回复流程

```
群友A  ──消息──▶  协议端(Lagrange)
                        │
                    事件推送
                        ▼
                    Adapter
                        │ 统一事件
                        ▼
                   Pipeline
                   ├─ 去重 ✓
                   ├─ 黑名单过滤 ✓
                   ├─ 非自身消息 ✓
                   └─ 合并窗口缓冲(等 1.5s 静默)
                        │
                        ▼
                  SessionManager
                  ├─ 绑定/恢复 session
                  ├─ 追加短期上下文
                  └─ 尝试获取生成锁
                        │
                        ▼
                   PromptBuilder
                  ├─ 注入人设 + 行为准则
                  ├─ 注入群场景 + 时间
                  ├─ 向量检索相关记忆 top-3
                  ├─ 注入说话者画像
                  ├─ 注入短期上下文
                  └─ 追加当前消息
                        │
                        ▼
                    LLM Client
                        │ 流式/非流式
                        ▼
                   PostProcess
                  ├─ 长度校验（>80字触发重新生成）
                  ├─ 违禁词 & 违禁表达检查
                  └─ 分段
                        │
                        ▼
                   Responder
                  ├─ 计算打字延迟
                  └─ 分段发送 ←── 观感上"像在打字"
```

### 8.2 静默与主动发言

**被动静默**：`reply-planner.ts` 返回"不回复"的条件：
- 群聊中未被提及、无人 @、且话题与己无关
- 同一用户 N 秒内已回复过 M 次（避免话痨）
- 情绪状态为"低落"且消息非重要
- 概率性跳过（模拟"没看见"）

**主动发言**：`node-cron` 定时触发。此项按**高风险能力**设计，默认只对白名单群开放，且所有闸门收得很紧：

| 闸门 | 默认值 |
|---|---|
| 静默时段 | 00:00–08:00 绝不主动说话 |
| 单群每日上限 | 2 次 |
| 单群每小时上限 | 1 次 |
| 全局每小时上限 | 5 次 |
| 同群最小间隔 | 60 分钟 |
| 冷场阈值 | 群静默 45 分钟后才考虑 |
| 冷场开口概率 | 仅 25% |
| 主动发言长度上限 | 60 字 |
| 禁 @ 全体 / 禁主动 @ 别人 | 强制 |
| 被禁言后冷静期 | 24h；被踢后 72h |

三种触发器：

- **冷场搭话**：话题从 [config/proactive-topics.yaml](../config/proactive-topics.yaml) 随机取，且不与群近 24h 话题重复。话题全部写成"短、随意、有钩子但不强求回应"的形态，刻意避免提问式——提问句式容易被当成客服。
- **守约提醒**：提前 24h 扫描 `memories` 表中 `type='promise'` 的记录，到期时以角色口吻提醒（如"说好的带饭呢"）。
- **每日寒暄**：09:00–10:00 窗口内，50% 概率，且受同一小时上限约束。

**安全闸**：主动发言内容过一遍安全过滤（禁政治/宗教/色情/广告/转账/链接类话题），超长截断，命中违禁则直接放弃本次发言而不是改写。宁可不说，不要多说——主动发言是封号风险的最大单一来源。

---

## 9. 非功能性需求

### 9.1 性能

- 并发会话数：**1**（纯私聊）。不追求吞吐，追求单次回复的质量与节奏
- 消息到首字节回复延迟：LLM 调用本身决定，应用端开销应 < 100ms
- 内存占用：短期上下文全内存，上限 60 条

### 9.2 可靠性

- LLM 调用必须带超时（默认 30s）+ 重试（1 次，指数退避）
- 协议端断线自动重连（退避策略：1s, 2s, 5s, 10s, 30s, cap）
- 应用崩溃重启后，从 SQLite 恢复：短期上下文、滚动摘要、mood、intimacy
- **重启后人格不能归零**——关系状态必须持久化，这是私聊场景比群聊更严格的要求

### 9.3 安全

- API Key 通过环境变量注入，不进代码库
- OneBot token 必须设置，不暴露到公网（Lagrange.OneBot 默认监听 127.0.0.1）
- 私聊白名单 `allowedUsers` 必须填写，空数组时拒绝一切私聊
- **接触面防护是四层叠加，不是单一白名单。** 详见 [contact-surface.md](contact-surface.md)：
  1. QQ 账号隐私设置（平台级，需手工配置）
  2. `guard` 自动处理（协议层拒好友请求、自动退群）
  3. `pipeline.filter` 白名单（应用层丢弃）
  4. alert 告警（发现接触面异常扩张）
- **认知纠正**：白名单是应用层 if 判断，QQ 平台不知道它的存在。别人依然能加好友、能发消息、能把机器人拉进群。拦截发生在消息到达之后。
- 管理接口加鉴权
- 日志脱敏：QQ 号打码，消息内容按需记录

### 9.4 可观测性

- pino 结构化日志，带 `sessionId` / `userId` 上下文
- `/metrics` 暴露（可选）：LLM 延迟、token 消耗、主动开口次数
- `/healthz` 暴露：协议端连接状态、LLM 连通性、DB 状态

---

## 10. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 账号被平台封禁 | 高 | 使用小号；控制消息频率；避免举报特征（秒回、长消息、markdown 格式）。私聊无人举报，风险低于群聊，但仍存在 |
| 签名服务不可用 | 高（协议端全军覆没） | 见 [sign-server-guide.md](sign-server-guide.md) 的三条路径 |
| LLM 输出破坏人设 | 中 | post-process 层做人格一致性校验；违禁表达列表持续维护；严重时重生成 |
| token 成本失控 | 中 | 单会话上下文长度硬上限；摘要压缩；记忆检索限 top-5 |
| 记忆无限增长 | 中 | TTL 365 天 + 重要性衰减 + 定期清理低访问记录 |
| **主动开口变成骚扰** | 高 | 每日上限 2 次、最小间隔 120 分钟、被无视后指数退避（最多 8 倍）。这条是私聊场景最需要防的 |
| **长期失忆导致人设崩塌** | 高 | 双层记忆 + 滚动摘要 + 关系状态持久化。私聊没有"换个群重新开始"，一次失忆就是永久污点 |

---

## 11. 开发路线

| 阶段 | 内容 | 产出 | 状态 |
|---|---|---|---|
| M1 | 工程脚手架 + OneBot 反向 WS 接入 + 收发消息闭环 | 能连上、能回话的最小系统 | ✅ 完成 |
| M2 | 管线完整化（去重/白名单/合并/延迟/连发节流）+ 基础人格 | 回复节奏像人 | ✅ 完成 |
| M3 | Prompt 组装器 + 关系状态注入（亲密度/情绪） | 说话有分寸 | ✅ 完成 |
| M4 | 记忆系统（SQLite）+ 抽取器 + 滚动摘要 | 聊久不忘事 | ✅ 完成（向量检索待增强） |
| M5 | 情绪系统 + 亲密度累积 + 分句发送 | 性格稳定，关系有厚度 | ✅ 完成 |
| M6 | 主动开口（含退避）+ 部署 + 管理接口 + 日志 | 可长期挂机 | 部分完成（主动开口未接入 cron） |
| M7 | 灰度测试与人格调优 | 上线 | ⏳ 待实测 |

**已实现代码**（`src/`）：

| 模块 | 文件 | 说明 |
|---|---|---|
| 配置 | `config/index.ts` | YAML 加载 + `${VAR}` 插值 + zod 校验 |
| 日志 | `infra/logger.ts` | pino + QQ 号自动脱敏 |
| 接入 | `adapter/onebot.ts` | 反向 WS 服务端/客户端双向支持，token 鉴权 |
| 管线 | `pipeline/index.ts` | 群消息丢弃、白名单、去重、分片合并、连发节流 |
| 会话 | `session/index.ts` | 单会话状态机、生成锁、关系状态持久化 |
| 人格 | `persona/index.ts` | 档案加载、情绪带解析、衰减算法 |
| Prompt | `brain/prompt.ts` | 九段式组装，含关系状态与新近度 |
| LLM | `brain/llm.ts` | DeepSeek 客户端，并发闸 + 每分钟限流 + 重试 |
| 记忆 | `memory/index.ts` | 检索、显式捕获、后台抽取、摘要压缩 |
| 回复 | `responder/index.ts` | 人格校验重写、打字延迟、分段发送 |
| 存储 | `store/db.ts` | SQLite schema、会话/记忆/日志 |
| 管理 | `server/http.ts` | `/healthz` + `/state` |

**冒烟测试**：`npm run smoke`，14 项全通过，覆盖白名单拦截、群消息丢弃、分片合并、去重、WS 鉴权、API 应答往返。

**已知未完成项**：

1. **主动开口未接入定时器**——`proactive` 的配置和退避逻辑已定义，但还没挂 `node-cron` 触发。原因：主动开口是封号风险最高的能力，建议先让被动回复跑稳一周再开。
2. **向量检索未实现**——当前长期记忆用关键词 + 重要度打分（`store/db.ts` 的 `searchMemories`）。对单人多轮对话已经够用，量大后可接 LanceDB。
3. **滚动摘要的自动触发**——`summarize()` 已实现，但尚未在上下文溢出时自动调用（`trimShortTerm` 只做丢弃并打日志）。这是 M4 的收尾项。



---

## 13. 可选模块：管理指令通道（默认关闭）

> 状态：设计中，**默认不实现**。本文记录需求与安全边界，供后续决定是否纳入范围。
>
> **场景更新（纯私聊）**：风险等级显著下降。能给她发消息的只有你自己，陌生人 prompt injection 的攻击面消失。剩余主风险是 QQ 号被盗。以下安全边界仍然全部适用——它们防的是"一次失误造成不可逆后果"，和攻击者是谁无关。

### 13.1 需求

允许管理员通过**私聊**让本机执行有限操作，例如“把这份内容写成文档放到 `D:\notes\xxx.md`”。

### 13.2 安全边界（不可协商）

这是本模块存在的**前提条件**，不是建议：

1. **执行器与 LLM 链路完全隔离。** 网友对话链路永远不能触达执行器。即使在纯私聊场景下，这一条也必须保留——因为 LLM 仍可能被对话内容诱导（比如你自己转发一段带奇怪指令的文本给它），而 LLM 的判断不可靠。这类攻击叫 prompt injection，没有可靠防御手段，只能靠隔离。
2. **LLM 不得作为执行器的触发路径。** 指令解析优先用纯规则；若要让 LLM 把自然语言翻成结构化指令，必须落在独立的、有二次确认的通道里，且解析结果仍需过白名单校验。
3. **命令白名单制，不是任意 shell。** 只暴露具体函数，如 `write_file(path, content)`、`read_file(path)`、`run_task(name)`。不提供 `exec`、不提供通配符。
4. **路径限制在配置的工作目录内。** 拒绝 `..` 穿越、拒绝符号链接逃逸、拒绝绝对路径跳出根目录。
5. **危险操作二次确认。** 删除、移动、覆盖已存在文件、启动外部程序，必须管理员回复确认后才执行。
6. **全量审计。** 记录：谁、何时、原始消息、解析出的命令、执行结果。落盘且不可被本模块自身删除。

### 13.3 架构

```
管理员私聊 ──→ 指令通道（不过 LLM，纯规则解析）──→ admin 白名单校验
                                                    ↓
                                              命令白名单校验
                                                    ↓
                                              路径安全校验
                                                    ↓
                                            ┌───────┴────────┐
                                            │ 需确认？       │
                                            │ 是 → 等待回复  │
                                            │ 否 → 执行     │
                                            └───────┬────────┘
                                                    ↓
                                                  执行器
                                                    ↓
                                                  审计日志

非 admin 私聊 ──→ LLM 网友链路（无任何工具权限）──→ 只回文字
```

关键点：**两条链路在代码层面就是分开的**。LLM 那条链路不 import 执行器，执行器那条链路不调用 LLM。不要用“一个 agent 带工具”的思路把它俩合起来——合起来就等于把对话暴露成 RCE 入口。

### 13.4 触发条件

| 条件 | 要求 |
|---|---|
| 会话类型 | 仅私聊 |
| 发送者 | `admin.uins` 白名单内 |
| 开关 | `admin.enabled`，默认 `false` |
| 群聊中 | 一律无效（本项目不接群聊，但代码层仍做防御） |

### 13.5 已知风险（实现前必须知悉）

| 风险 | 说明 |
|---|---|
| 封号风险上升 | 机器人行为不再“像网友”，管理指令的格式化和响应速度都是特征。私聊风险低于群聊，但仍是特征 |
| QQ 号被盗 = 机器被控 | 本模块最大的单点风险。管理员号必须开设备锁和二次验证 |
| 配置失误 | `admin.enabled` 忘了关、白名单填错、路径根目录设太宽，任一失误都会放大后果 |

### 13.6 建议

若确实需要，按以下最小集实现：`write_file` + `read_file` + 路径限制 + 审计。跑稳一段时间再考虑加别的。**不要一开始就做“任意命令执行”**——那东西的收益/风险比极差。

---

## 14. 待确认 / 后续讨论

### 14.1 已确认（2026-10-19）

1. **使用场景** — 纯私聊陪伴，不接入任何群聊。群消息事件在管线入口丢弃。
2. **人格具体设定** — 已确定，见 [config/personas/default.yaml](../config/personas/default.yaml) 与 [config/prompts/system.md](../config/prompts/system.md)。角色「鲸奈」，自称鲸娘，傲娇 + 懒散 + 偶尔漏甜，口癖"呃/哼/先说好/别误会/麻烦"，雷区是客服腔与 AI 自认。
3. **LLM Provider** — DeepSeek，模型 `deepseek-chat`，`temperature: 0.85`（避免规整客服感），`maxTokens: 300`（防长文）。Key 由环境变量注入。
4. **主动开口能力** — 开发，按私聊场景重定义为"惦记"而非"搭话"。闸门：每日 2 次、每小时 1 次、最小间隔 120 分钟、01:00–08:00 静默、静默 6 小时后才考虑且仅 30% 概率、内容 ≤60 字。**新增被无视后退避机制**：不理她就指数延长下次开口间隔（最多 8 倍），一回复即恢复。详见 [config/default.yaml](../config/default.yaml) 的 `proactive` 段。
5. **管理指令通道** — 见第 13 节，纯私聊使风险降级，但仍默认关闭，需显式开启。

### 14.2 仍待定

1. **你自己的 QQ 号**：`pipeline.filter.allowedUsers` 目前为空数组，**空数组 = 拒绝一切私聊**（安全默认）。不填就什么都不回。
2. **机器人小号 QQ 号**：`ONEBOT_SELF_ID`，需要注册一个小号给协议端登录，不要用主号。
3. **部署位置**：本地常驻 / 云服务器 / NAS。
4. **Embedding 服务**：本地 Ollama + `BAAI/bge-m3` 是默认方案，需确认是否要跑 Ollama，或改用 API 端 embedding。
5. **协议端签名服务**：见 [sign-server-guide.md](sign-server-guide.md)，M1 的第一个卡点。
6. **管理指令通道是否纳入本期**：见第 13 节，默认暂不实现。

---

## 附录 A：参考资料

- [QQ Bot 官方介绍与接入指南](https://bot.qq.com/wiki/bot_new_product-intro/)
- [Lagrange.OneBot 文档](https://lagrangedev.github.io/Lagrange.Doc/v1/Lagrange.OneBot/)
- [Lagrange 配置生成器](https://lagrangedev.github.io/lagrange-config-generator/)
- [Lagrange V2 Sign API 使用指南](https://github.com/LagrangeDev/SignApiGuide)
- [LuckyLilliaBot (LLOneBot)](https://github.com/LLOneBot/LuckyLilliaBot)
- [ntqq-sign-server（自建签名服务）](https://github.com/Micuks/ntqq-sign-server)
- [关于 NapCat 生态演变的第三方记录（2026-02）](https://wesley-young.github.io/2026-02-21-biography-of-napcat)

## 附录 B：环境勘察记录（2026-10-19）

| 项 | 结果 |
|---|---|
| 工作区 | `D:\Agent\HarnessWorkPlace\Deepseek`（初始为空） |
| Node.js | v22.15.0 |
| npm | 10.9.2 |
| corepack | 0.32.0 |
| Docker | 29.7.2 |
| Python | 3.11.9 |
| Git | 2.51.0 |
| 权限修复 | `D:\Agent\HarnessWorkPlace\Deepseek` 补授当前用户完整控制项（已备份，可还原） |

## 附录 C：还原命令（如需撤销权限修复）

```powershell
pwsh -NoProfile -File 'D:\Agent\HarnessWorkPlace\Deepseek\.dsh-acl-out\acl-backup-9a3d970eafd640b3b5362813399a556d.json.ps1' -Path 'D:\Agent\HarnessWorkPlace\Deepseek' -AllowRoot 'D:\Agent\HarnessWorkPlace\Deepseek' -Restore 'D:\Agent\HarnessWorkPlace\Deepseek\.dsh-acl-out\acl-backup-9a3d970eafd640b3b5362813399a556d.json'
```
