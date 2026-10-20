# 快速开始

> 目标：让「鲸奈」在 QQ 私聊里跑起来。
> 预计耗时：30 分钟（不含签名服务申请）

---

## 前置条件

| 条件 | 说明 |
|---|---|
| 两个 QQ 号 | 你的主号（聊天用）+ 一个小号（机器人用）。别用主号当机器人 |
| DeepSeek API Key | [platform.deepseek.com](https://platform.deepseek.com/) 申请 |
| 签名服务 | 协议端的必需依赖，见 [sign-server-guide.md](sign-server-guide.md) |
| Node.js ≥ 22 | 已确认本机 v22.15.0 |

---

## 第 1 步：配置

```powershell
cd qq-netizen
copy .env.example .env
```

编辑 `.env`，填入：

```ini
DEEPSEEK_API_KEY=sk-xxxxxxxx        # 必填
ONEBOT_ACCESS_TOKEN=随便设一串      # 必填，协议端要一致
ONEBOT_SELF_ID=机器人QQ号           # 机器人小号
```

`config/default.yaml` 里的白名单已经填好了你的号：

```yaml
pipeline:
  filter:
    allowedUsers: ["你的QQ号"]   # ← 只有这个号会被回复
```

---

## 第 2 步：配置协议端（Lagrange.OneBot）

在 `Lagrange.OneBot.exe` 同目录编辑 `appsettings.json`：

```jsonc
{
  "SignServerUrl": "https://sign.lagrangecore.org/api/sign",
  "Account": {
    "Uin": 机器人QQ号,
    "Protocol": "Linux"
  },
  "Implementations": [
    {
      "Type": "ReverseWebSocket",
      "Host": "127.0.0.1",
      "Port": 8080,
      "Suffix": "/onebot/v11/ws",
      "AccessToken": "和 .env 里的 ONEBOT_ACCESS_TOKEN 完全一致"
    }
  ]
}
```

启动后扫码登录机器人小号。

**注意**：`Uin` 必须是**已绑定签名权限**的那个号。如果扫码成功但发不出消息，先回去看签名服务配置。

---

## 第 3 步：启动

```powershell
npm install      # 首次运行
npm run dev      # 开发模式（改代码自动重启）
```

看到这些日志说明成功：

```
OneBot 反向 WS 服务已启动 ws://127.0.0.1:8080/onebot/v11/ws
协议端已连接
管理接口已启动 http://127.0.0.1:3000
就绪：只回应白名单内的私聊
```

---

## 第 4 步：验证

用你的主号（你的QQ号）私聊机器人小号，发一句「在吗」。

应该会看到：
1. 约 1.5 秒静默（分片合并窗口）
2. 再等一会儿（打字延迟模拟）
3. 收到回复

同时控制台应出现：

```
准备回复 user=181****39 chars=8 delayMs=1120 tokens=23
```

---

## 验证清单

用**另一个号**做这几件事，确认防护生效：

| 测试 | 预期 |
|---|---|
| 陌生人私聊机器人 | **无回复**，日志出现「非白名单私聊，已丢弃」 |
| 陌生人加好友 | 自动拒绝 |
| 把机器人拉进群 | 立即退群，日志出现「被拉进群，执行自动退群」 |
| 你的主号连发 3 条 | 合并成一段，只回一次 |
| 重启程序后继续聊 | 她记得之前聊过什么（情绪和关系状态已持久化） |

---

## 管理接口

```powershell
curl http://127.0.0.1:3000/healthz   # 协议端连接状态
curl http://127.0.0.1:3000/state     # 当前情绪、亲密度、上下文轮数
```

如果 `.env` 里设了 `ADMIN_TOKEN`，需要带 `Authorization: Bearer <token>`。

---

## 冒烟测试

不连 QQ，验证管线逻辑：

```powershell
npm run smoke
```

预期 `14 通过，0 失败`。

---

## 调参在哪

| 想调什么 | 改哪里 |
|---|---|
| 回复快慢 | `responder.typing`（baseMs / perCharMs） |
| 回复长度 | `responder.maxChars` |
| 她多久主动开口 | `proactive.minGapMinutes`、`proactive.maxPerDay` |
| 关系升温速度 | `persona.intimacy.perExchange` |
| 情绪波动幅度 | `config/personas/default.yaml` 的 `mood.triggers` |
| 人格口癖 | `config/personas/default.yaml` 的 `speechStyle` |
| 她绝对不能说啥 | `config/prompts/rules.md` + `speechStyle.forbidden` |

改完重启生效（`speechStyle` 和 prompt 是启动时加载的）。

---

## 常见问题

**扫码成功但发不出消息** → 签名服务没配好，或 `Account.Uin` 没绑定签名权限。见 [sign-server-guide.md](sign-server-guide.md)。

**回了一句就不回了** → 看是不是触发了连发节流。日志里会有 `burst-throttle` 或 `flood-throttle`。

**她说话像客服** → 检查 `temperature` 是否够高（0.85），以及 `rules.md` 的禁用列表。也可以看 `chat_logs` 表复盘。

**重启后不记得之前的事** → 检查 `data/qq-netizen.db` 是否存在且没被删。
