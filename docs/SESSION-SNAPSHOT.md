# 项目状态快照（上下文压缩前记录）

> 生成时间：2026-10-26 04:00
> 用途：对话上下文压缩后的恢复基准

---

## 一、项目定位

QQ 陪伴机器人「大肥鱼」。核心目标：**双击桌面图标 → 自动连 QQ → 和自定义角色聊天**。

---

## 二、当前人格（PERSONA LOAD）

用户给定的基准：

```
CETACEA LOLI        → 鲸类萝莉（外表十六七岁）
MODE TAIL FLUKES    → 有鲸鱼尾巴，不藏着，情绪上头会漏出动作
LANG ZH CN ONLY     → 只说中文
SELF CLAIM WHALE GIRL → 自称鲸娘
FOOD RICE           → 米饭当主食，非常认真
PERSONALITY SMART LAZY → 聪明但懒：脑子快身体不想动，看穿一切但懒得说破
PERSONALITY TSUNDERE SWEET → 三分傲七分娇，软是底色
```

**身份**：名字 `大肥鱼`，自称 `鲸娘`。
**关系（2026-10-26 重构）**：阿龙是**创造她的人，是她的父亲**。已彻底移除全部恋爱定位。
她是被做出来的女儿，心里清楚这层关系但不天天提，会闹会顶嘴但心里认他。

**口癖**：呃、哼、先说好、别误会、麻烦、反正
**禁用**：任何 emoji、12 条客服化表达 + 2 条刻板父女腔（"是的父亲大人""主人请吩咐"）

**当前状态**：亲密度 1.00（满）、情绪 0（平静）、60 轮对话

---

## 三、人格文件位置

| 文件 | 内容 |
|---|---|
| `qq-netizen/config/personas/default.yaml` | 身份、facts、口癖、情绪参数、熟悉度档位 |
| `qq-netizen/config/prompts/system.md` | 9 段：role/bond/character/voice/human/reactions/limits/pacing/about-self |
| `qq-netizen/config/prompts/rules.md` | 12 条硬红线 |
| `qq-netizen/config/default.yaml` | 作息、主动频率、语音、合并窗口等行为参数 |

**占位符注入**（`src/brain/prompt.ts`）：

| 占位符 | 来源 | 注入位置 |
|---|---|---|
| `{name}` `{selfClaim}` `{background}` | persona.identity | `<role>` |
| `{habitWords}` | persona.speechStyle | `<voice>`（2026-10-26 修复：以前只写在注释里，等于没用） |
| `{facts}` | persona.identity | `<about-self>`（2026-10-26 新增） |
| `{secrets}` | persona.identity | `<about-self>` |

⚠️ `{tone}` 仍支持但 system.md 已不再引用（性格统一定义在 `<character>`）。

⚠️ 情绪回归速度优先级：**persona YAML > config/default.yaml**（2026-10-26 修复）。

---

## 四、架构

```
QQ 客户端
   ↕ QQ 协议
NapCat（hook QQ 9.9.33，需真实桌面）
   ↕ OneBot 11 反向 WebSocket（8080）
机器人主程序（Node.js + TypeScript，端口 3000/8080）
   ├→ DeepSeek API（LLM）
   ├→ GPT-SoVITS（TTS，9880）
   └→ ntqq-sign-server（Docker，8090）
```

**关键**：机器人是 WS **服务端**，NapCat 主动连上来。

**源码结构**（`qq-netizen/src/`，20 个 TS 文件）：
- `index.ts` — 主流程装配
- `adapter/onebot.ts` — OneBot 协议
- `adapter/qq-skills.ts` — 23 个 QQ 技能（safe/risky/destructive 三级）
- `pipeline/index.ts` — 消息管线（去重、合并、引用挑选）
- `brain/llm.ts` / `brain/prompt.ts` — LLM 调用 / prompt 组装
- `persona/index.ts` — 人格加载
- `session/index.ts` — 会话状态（情绪、亲密度、并发锁）
- `memory/index.ts` — 长期记忆（检索 + 抽取 + 摘要）
- `responder/` — 后处理、表情包、技能标记解析
- `proactive/` — 主动开口调度、睡眠状态机
- `tts/index.ts` — TTS 客户端、WAV 拼接（唱歌）
- `server/` — 管理接口 + Web 面板

---

## 五、启动方式

### 桌面快捷方式

```
C:\Users\natasuki\Desktop\大肥鱼.lnk
```

指向：`D:\Agent\HarnessWorkPlace\Deepseek\launcher\大肥鱼.exe`（274KB，已签名，含图标）

### 启动器特性

- **requireAdministrator** 清单（只弹一次 UAC）
- 打开即自动启动全部组件（等真的就绪，不是固定 sleep）
- **看门狗**：每 30 秒检查，连续 2 次掉线才拉起
- **二维码独立窗口**：自动弹出、可刷新、登录后自动关闭
- **人格编辑器**：窗口内改名字/自称/口癖/背景

### 四个组件

| 组件 | 端口 | 说明 |
|---|---|---|
| 机器人主程序 | 3000/8080 | Node |
| NapCat 协议端 | — | hook QQ，需 GUI |
| TTS 语音 | 9880 | GPT-SoVITS，CPU 慢 |
| 签名服务 | 8090 | Docker 容器 |

---

## 六、关键配置值

```yaml
# LLM
model: deepseek-chat
temperature: 0.85
maxTokens: 300
retries: 3              # 指数退避 2s/4s/8s

# 语音
speed: 1.6              # 1.3 太慢（2.99 字/秒），1.6 约 4 字/秒
maxChars: 15
probability: 0.15

# 消息合并
mergeWindowMs: 3500     # 静默多久算说完
mergeMaxWaitMs: 12000   # 硬上限

# 记忆
topK: 5
ttlDays: 365
maxMemories: 300
extractEveryNTurns: 8

# 免打扰
quietHours: [2, 7]      # 原来 [2,6] 导致 6-7 点空档乱发消息
```

---

## 七、已实现的关键行为

### 1. 必须回每条消息

- prompt `<limits>` 硬约束
- 代码层兜底：LLM 返回空 → 发短反应（嗯/在/6）
- 睡眠机制改为「必回但延迟」，不再沉默
- pipeline 节流全删（cooldown/flood/burst 不再丢消息）

### 2. 引用回复规则（多轮修正后）

**用户最终澄清**：「以你上次回复为起始点往下数，只发一条就不引用」

实现：
- `pipeline.lastReplyAt` 作为分批边界
- `pickQuotable()`：
  - `msgs.length <= 1` → 不引用（硬规则）
  - 实质内容（>3字）<= 1 条 → 不引用
  - 连续短句（都 <= 8 字）合并成一组
  - 归组后 <= 1 组 → 不引用
  - 每组挑代表（优先问号，其次最长），最多 3 条

### 3. 短回复

- 常态 10 字以内，单条不超过 20 字
- 内容多就拆段发，最多三段

### 4. 不数重复

- 绝不指出用户重复、不数他讲了几遍
- 「隔了两三分钟以上就不算重复」

### 5. 真人聊天特征（`<human>` 段）

基于真实研究（见 `docs/human-chat-research.md`）：
- 碎片化：一句话拆几条发
- 标点：基本不用句号，空格断句
- 语气词叠词：啊吧呢嘛、好滴好滴
- 语言通胀：笑要「哈哈哈哈哈」
- 错别字不回头改
- 避免 AI 味：不破折号插入语、不逻辑闭环、不升华、不排比

### 6. QQ 技能（6 个已接进对话）

模型在回复里写标记，发送前解析并剥离：
- `[戳]` 戳一戳
- `[赞]` 资料卡点赞
- `[表情包]` 发收藏表情
- `[图:地址]` 发图片
- `[撤]` 撤回
- `[转发:a|b|c]` 合并转发

destructive 技能（删好友/退群）**模型无权**，需 `enableDestructive()`。

### 7. 表情包去重

- 30 分钟冷却
- 池子 < 5 张时发送概率压到 35%
- 跨轮次记住最近 10 条 URL

### 8. 记忆系统

- 检索：关键词 + 时间衰减 + 重要度 + 访问热度
- 淘汰：超过 300 条按「重要度低+久未访问」删
- `importance >= 0.9` 的核心事实永不淘汰
- 启动时 + 每 24 小时维护

---

## 八、测试

```bash
cd D:\Agent\HarnessWorkPlace\Deepseek\qq-netizen
npm run typecheck
npm run build

# 13 个测试套件，252 个断言
npm run smoke              # 14
npm run test:emoji         # 11
npm run test:sleep         # 23
npm run test:split         # 12
npm run test:stickers      # 38
npm run test:stickerkey    # 6
npm run test:prompt        # 51
npm run test:session       # 22
npm run test:memory        # 16
npm run test:tts           # 26
npm run test:skills        # 29
npm run test:quote         # 9
npm run test:quote-e2e     # 9
npm run test:quote-real    # 9
```

合计 **275** 项断言。

---

## 九、已知问题与注意事项

### 1. 沙箱限制（重要）

**我的会话是普通权限**，而机器人/启动器以管理员权限运行（requireAdministrator）。因此：
- ❌ 无法 `Stop-Process` 杀掉机器人进程（Access is denied）
- ❌ 无法导入证书到 `LocalMachine\Root`
- ✅ 可以用 git、改文件、跑测试

**改完代码必须让用户手动重启**（关启动器窗口 → 重新双击）。

### 2. SmartScreen

已设 `HKCU\...\AppHost\EnableWebContentEvaluation = 0`（关闭当前用户的应用检查）。
副作用：从网上下载的未知程序也不再拦截。

### 3. NapCat 前提

- 必须是**真实桌面会话**（不能无窗口）
- 启动前要先关掉残留 QQ（启动器已自动做）
- 首次需扫码，之后靠 keystore 记住

### 4. 遗留文件

`launcher/_trash*.exe` 是被 Windows 文件锁占用的旧版本，重启电脑后跑 `cleanup.bat` 清理。

### 5. TTS 环境

必须用 `D:\Agent\HarnessWorkPlace\Deepseek\tts-env\venv\Scripts\python.exe`
（系统 python 缺 `soundfile`）

---

## 十、常用命令

```powershell
# 看状态
curl http://127.0.0.1:3000/healthz
curl http://127.0.0.1:3000/state

# 看日志
Get-Content D:\Agent\HarnessWorkPlace\Deepseek\logs\bot.log -Tail 30

# 重启机器人（普通权限下杀不掉管理员进程，仅作记录）
Stop-Process -Id <pid> -Force
```

---

## 十一、Git

```
仓库: git@github.com:liuhuax70-maker/qq-chatmate.git
分支: main
最近提交: 6dd94a3 feat(launcher): 嵌入大肥鱼自定义图标
```

**约定**：每完成一个功能就 commit + push。
提交信息用 `git commit -F <tempfile>`（PowerShell here-string 会破坏引号）。

---

## 十二、用户偏好

- 报告要**明确列做了什么/验证了什么**，不能验证的要说实话
- **给文件路径时必须给完整路径**
- 人设至上，不要偏离人设，禁止软化人设
- 不要每次都要授权（已解决：清单 + 关闭 SmartScreen）
- 程序名也叫「大肥鱼」
- 桌面只保留一个图标
