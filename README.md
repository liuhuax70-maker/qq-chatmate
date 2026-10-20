# qq-chatmate · QQ 网友

一个**像真人**的 QQ 私聊 AI 陪伴程序。不是客服，不是助手，是泡在 QQ 上的一个网友。

> 她有作息、有情绪、会主动找你、会吐槽、会接梗、也会嘴硬心软。

---

## 她是什么样的

- **鲸奈**，自称鲸娘，一条上了岸的鲸鱼，把米饭当主食
- 傲娇：**七分软，三分硬**。软是底色，硬是调味
- **热情**：你说话她想接，有事没事也想找你
- 有完整的七情六欲——会开心、会烦、会委屈、会得意、会嘴硬、会心软
- 你叫「阿龙」，是她最好的朋友
- 会玩梗、会接梗、会顺杆爬、会造你们之间的暗号

### 她的作息（不是定时打卡）

- **23-24 点**之间随机一个时刻道晚安，并关心你一句
- **7-8 点**起床，隔 5-40 分钟才想起发早安，也带一句关心
- 25% 的日子根本想不起来发；连续被无视两次就停三天
- 你 20 分钟不回她的问候，她会撒娇催一下（只催一次）
- 半夜被吵醒要 2-8 分钟才能缓过来回话，带着起床气
- 白天不会说要去睡

---

## 功能

| 功能 | 说明 |
|---|---|
| **人格系统** | 人设 + 情绪（七分软三分硬）+ 亲密度，全部可配置 |
| **主动开口** | 早安/晚安/分享发现/关心询问/守约提醒/撒娇催回复 |
| **记忆系统** | 短期上下文 + 长期记忆抽取 + 滚动摘要，崩溃重启不丢 |
| **语音回复** | GPT-SoVITS 音色克隆，短句偶尔发语音（CPU 可跑） |
| **表情包** | 拉取 QQ 收藏表情，能"学会"你发的表情什么意思 |
| **语义分段** | 长回复按语义拆成 1-3 条发，中间停顿，像真人打字 |
| **控制面板** | 本地 Web 面板，监控/启停四个组件 |
| **节流** | 刷屏检测、连发上限、冷却期，不变成骚扰 |

---

## 架构

```
┌─────────────────────────────────────────────┐
│  QQ                                          │
└─────────────────┬───────────────────────────┘
                  │ OneBot 11
┌─────────────────▼───────────────────────────┐
│  Lagrange.OneBot        协议端（QQ 登录）      │
│  ntqq-sign-server       签名服务（Docker）     │
└─────────────────┬───────────────────────────┘
                  │ reverse-websocket :8080
┌─────────────────▼───────────────────────────┐
│  qq-netizen (Node/TS)                         │
│  ├─ pipeline     分片合并 / 白名单 / 节流       │
│  ├─ prompt       prompt 组装（人设+情绪+场景）   │
│  ├─ llm          DeepSeek（缓存优化）          │
│  ├─ responder    语义分段 / 表情包 / 语音        │
│  ├─ proactive    主动开口调度 + 睡眠状态机       │
│  ├─ memory       长期记忆 + 摘要                │
│  └─ panel        控制面板 HTTP 服务             │
└─────────────────┬───────────────────────────┘
                  │ HTTP :9880
┌─────────────────▼───────────────────────────┐
│  GPT-SoVITS TTS     语音合成（Python/CPU）      │
└─────────────────────────────────────────────┘
```

---

## 快速开始

### 1. 准备

- Node.js 22+
- Docker Desktop（跑签名服务）
- DeepSeek API Key
- 一个 QQ 小号

### 2. 配置

```bash
git clone https://github.com/liuhuax70-maker/qq-chatmate.git
cd qq-netizen
npm install
cp .env.example .env   # 填入真实值
```

`.env` 必填项：

```
DEEPSEEK_API_KEY=sk-xxx
ONEBOT_ACCESS_TOKEN=任意长随机串
ONEBOT_SELF_ID=你的机器人QQ号
OWNER_QQ=你的主号QQ号
```

### 3. 启动四个组件

按依赖顺序：**签名服务 → 协议端 → 主程序 → TTS**

```bash
# ① 签名服务（Docker）
cd ../ntqq-sign-server && docker compose up -d

# ② 协议端（首次需扫码，必须双击启动）
../lagrange/Lagrange.OneBot/bin/Release/net9.0/win-x64/publish/Lagrange.OneBot.exe

# ③ 主程序
npm run dev

# ④ TTS（可选，不发语音可跳过）
../tts-env/venv/Scripts/python.exe ../gpt-sovits/tts_server.py 9880
```

启动后访问 **http://127.0.0.1:3000/panel** 查看控制面板。

### 4. 验证

```bash
curl http://127.0.0.1:3000/healthz
# {"ok":true,"status":"connected"}
```

用主号私聊机器人小号，发一句「在吗」。

---

## 文档

- [DESIGN.md](docs/DESIGN.md) — 设计文档
- [getting-started.md](docs/getting-started.md) — 完整搭建指南
- [sign-server-guide.md](docs/sign-server-guide.md) — 签名服务
- [lagrange-startup.md](docs/lagrange-startup.md) — 协议端启动与排障
- [qrcode-issue.md](docs/qrcode-issue.md) — 二维码问题
- [contact-surface.md](docs/contact-surface.md) — 接触面防护

---

## 配置人设

人设在两个地方，改完**重启进程**生效：

- `config/personas/default.yaml` — 身份、情绪参数、亲密度、口癖
- `config/prompts/system.md` — 性格、说话方式、反应手段表、边界

写人设的方法论参考见 `config/prompts/system.md` 顶部注释。

---

## 测试

```bash
npm run smoke         # 14 项：管线行为
npm run test:emoji    # 11 项：表情解析
npm run test:sleep    # 23 项：睡眠状态机
npm run test:split    # 12 项：语义分段
npm run test:stickers # 28 项：表情库
```

---

## 成本

DeepSeek 缓存命中后约 **0.0012 元/轮**。主动开口的分享/关心会额外消耗，但每天仅 1-2 次。

---

## 已知限制

- 协议端（Lagrange）首次启动需扫码，且必须双击启动（无控制台会崩）
- 语音合成在 CPU 上较慢（5-7 秒/条），只对短句低概率触发
- 只支持私聊，不接群聊

---

## 许可

MIT
