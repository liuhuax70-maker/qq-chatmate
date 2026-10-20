# 签名服务（SignServer）配置指南

> 适用对象：`qq-netizen` 项目的协议端 Lagrange.OneBot
> 日期：2026-10-19
> 前置阅读：本文假设你已完成 [DESIGN.md](DESIGN.md) 的阅读

---

## 0. 先理解：为什么会有这个东西

QQ 的 NTQQ 协议里，登录、发消息等关键请求的数据包都必须携带签名（sign / token / extra）。这个签名算法只存在于官方 QQ 客户端内部。

Lagrange.Core 是协议的**第三方实现**，它没有签名算法，所以需要外挂一个"签名服务"帮它算。**不配签名服务 = 能扫上码但发不出任何消息**，而且现象很阴间：手机提示"有其他设备登录"，但电脑端不被顶掉，`Online` 事件不触发，消息调用直接卡住无报错。

所以这不是可选项，是必选项。

---

## 1. 三条路，先选一条

| 路径 | 难度 | 长期维护 | 适合谁 | 上限 |
|---|---|---|---|---|
| **A. 官方白名单 API** | 中（一次性 GPG 流程） | 几乎为零 | 想省心、能接受一次折腾 | 每 GitHub 账号 3 个 QQ 号 |
| **B. Docker 自建** | 低（两条命令） | QQ 升级后可能要更新 | 你已经有 Docker 29.7.2 | 无限制 |
| **C. 换 LuckyLilliaBot** | 低 | 无 | 不想碰签名、能常驻 QQ 客户端 | 无限制，但 OneBot 覆盖率略低 |

### 本鲸娘的推荐

**先走 A，嫌 GPG 麻烦立刻切 B。**

理由：A 是官方在维护的服务，QQ 升级、协议变动它自己会跟上，你什么都不用管；代价是一次性的 GPG 注册流程（约 15 分钟）。B 虽然两条命令就跑起来，但签名服务依赖 QQ Linux 版的 `wrapper.node`，QQ 客户端一升级，里面签名函数的地址就可能变，届时你要重新构建。

**C 是兜底**：LuckyLilliaBot 的原理是 Hook 真实 NTQQ 客户端，直接复用客户端自己的签名能力，所以**完全不需要签名服务**。代价是必须常驻一个 PC QQ 客户端（GUI），不能纯命令行。Windows 机器反而适合这条路。

---

## 2. 路径 A：官方 Lagrange V2 Sign API（白名单制）

### 2.1 你需要提前准备

- 一个 GitHub 账号
- 一对 **RSA 算法的 GPG 密钥**（必须支持加密/解密。Ed25519 只支持签名，**不能用于本流程**）
- Windows 上装 [Gpg4win](https://www.gpg4win.org/)（自带 Kleopatra，图形界面操作）

### 2.2 生成 GPG 密钥（Kleopatra 图形界面）

1. 打开 Kleopatra → **文件 → 新建密钥对**
2. 选 **OpenPGP 密钥对**
3. 填姓名和邮箱，**高级选项里把密钥算法改成 RSA，位数 3072 或 4096**
4. 设置口令（passphrase），**这个口令忘了密钥就废了，记好**
5. 生成完成后，右键密钥 → **导出**，得到 `.asc` 公钥文件

### 2.3 把公钥挂到 GitHub

1. GitHub → **Settings → SSH and GPG keys → New GPG key**
2. 粘贴刚才导出的 `.asc` 文件内容
3. 保存。看到密钥显示为 "Verified" 最好，未验证也能用

### 2.4 记录你的 GPG Key ID

在 Kleopatra 里选中密钥，详情里有一串 **16 位十六进制字符**，这就是 Key ID。

> ⚠️ 要的是**主 Key ID（16 字符）**，不是 Subkey 的 ID。搞错了 Bot 会用大锤表情敲你。

### 2.5 找到申请用的 QQ 群

官方申请渠道是一个特定 QQ Bot，它只在**特定群聊**里响应命令。这个群的入口不在公开文档里，需要加入 Lagrange 的 Telegram 群获取（[Lagrange.Core README](https://github.com/LagrangeDev/Lagrange.Core) 里有入口说明）。

### 2.6 注册

进群后，用**你的主 QQ 号**发送：

```
#signer register <你的 GitHub 用户名> <你的 GPG Key ID>
```

例：`#signer register natasuki A1B2C3D4E5F60718`

**Bot 的表情反馈**：

| 表情 | 含义 |
|---|---|
| `/续标识`（手指按红钮） | 请求已接收，正在处理 |
| `/喝彩`（派对礼花） | **处理成功** |
| `/敲`（大锤敲头） | 格式有误，检查命令 |
| `/睡`（小黄脸睡觉） | 触发 1 分钟/次限流，等 1 分钟再试 |

> 限流对 `register` / `bind` / `unbind` / `profile` 都生效。**要绑多个号就一次性写完，分开发容易吃限流。**

### 2.7 解密验证（5 分钟限时）

Bot 会发来一条 **GPG 加密的消息**。用 Kleopatra 解密它，得到一段字符串（通常 6 位数字或字母），然后在 **5 分钟内**发出：

```
#signer verify <解密得到的字符串>
```

### 2.8 领取 Token

验证成功后，Bot 会把 token 用你的 GPG 公钥加密后发来。Kleopatra 解密，得到一个 **UUID 字符串**。这就是你后续的凭证，**妥善保管，丢失只能注销重注册**。

### 2.9 绑定实际使用的 QQ 号

**关键点：主 QQ 号本身没有签名权限，只有绑定的子 QQ 号才有。**

```
#signer bind <要绑定的 QQ 号 1> <要绑定的 QQ 号 2> ...
```

- 每个 GitHub 账号 = 1 个主 QQ 号 + 最多 **3 个**子 QQ 号
- 主 QQ 号也可以绑自己，但会占用 1 个名额
- **这里绑的就是你机器人的小号 QQ 号**

其他管理命令：

```
#signer profile                      # 查看已绑定列表
#signer unbind <QQ号>                # 解绑
#signer delete                       # 注销账号（3 天内不能重注册）
```

### 2.10 配置协议端

编辑 `Lagrange.OneBot` 同目录的 `appsettings.json`：

```jsonc
{
  "SignServerUrl": "https://sign.lagrangecore.org/api/sign",
  "Account": {
    "Uin": 123456789,        // ← 改成你绑定的那个子 QQ 号
    "Protocol": "Linux"
  },
  "Implementations": [
    {
      "Type": "ReverseWebSocket",
      "Host": "127.0.0.1",
      "Port": 8080,
      "Suffix": "/onebot/v11/ws",
      "AccessToken": "和 qq-netizen 的 ONEBOT_ACCESS_TOKEN 一致"
    }
  ]
}
```

> `Uin` 这个字段只用于识别数据库文件和二维码文件名，**不影响签名权限**——真正决定能不能签名的是 2.9 步绑定的 QQ 号。两个必须一致，否则登录的号没绑，照样发不出消息。

---

## 3. 路径 B：Docker 自建签名服务

适合：不想碰 GPG、需要超过 3 个 QQ 号、或者想完全自持。

### 3.1 拉源码

```powershell
git clone https://github.com/Micuks/ntqq-sign-server.git
cd ntqq-sign-server
```

### 3.2 端口避让（重要）

签名服务默认用 8080，**和本项目的 OneBot 反向 WS 端口冲突**。必须错开。

编辑 `docker-compose.yml`，把宿主机端口改成 8090：

```yaml
ports:
  - "8090:8080"    # 宿主机 8090 → 容器内 8080
```

### 3.3 修复 Dockerfile（实测必须改的两处）

这套工程上传到 GitHub 时是能跑的，但腾讯下架了旧版安装包，直接 build 会失败。两处必须改：

**① QQ 安装包地址已失效**

原 Dockerfile 里是：

```dockerfile
ARG QQ_DEB_URL=https://dldir1.qq.com/qqfile/qq/QQNT/Linux/QQ_3.2.15_250116_amd64_01.deb
```

这个地址**返回 404**（腾讯已下架旧版）。改为可访问的归档镜像：

```dockerfile
ARG QQ_DEB_URL=https://github.com/Rodert/qq-versions/releases/download/qq-packages-20260813-1d08f1d4/QQ_3.2.32_260812_amd64_01.deb
```

> 归档源：[Rodert/qq-versions](https://github.com/Rodert/qq-versions)，自动同步 QQ 官方安装包。
> 版本可以换，但**别低于 3.2.18**（签名偏移量探测需要较新的结构）。

**② 缺少 QQ 运行所需的图形库**

`wrapper.node` 加载时会按需寻找 X11 相关库，缺一个就 `OSError` 退出。原 Dockerfile 的依赖不全，需要补：

```dockerfile
RUN apt-get update && \
    apt-get install -y --no-install-recommends -o Acquire::Retries=10 -o Acquire::http::Timeout=60 \
    python3 gcc libc6-dev ca-certificates curl \
    libgnutls30 libglib2.0-0 libnss3 libatk1.0-0 libcups2 \
    libdrm2 libgbm1 libxkbcommon0 libpango-1.0-0 libcairo2 \
    libvips42 \
    libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 \
    libxext6 libxfixes3 libxrandr2 libxtst6 libasound2 libdbus-1-3 \
    libunwind8 \
    && rm -rf /var/lib/apt/lists/*
```

> 已知踩坑顺序：先缺 `libX11-xcb.so.1`，补完又缺 `libunwind-x86_64.so.8`。一次性全装上省事。
>
> **不要用国内镜像源**（清华、阿里云实测都出现过 502 / Connection failed）。官方源虽然慢，但能拉全。

### 3.4 构建并启动

```powershell
docker build -t ntqq-sign-server .
docker run -d --name ntqq-sign -p 8080:8080 ntqq-sign-server
```

Dockerfile 会在构建时自动下载 QQ Linux 版来提取 `wrapper.node`，你不需要手动准备。

### 3.3 验证

```powershell
curl http://127.0.0.1:8080/health
```

应返回：

```json
{"status":"ok","uptime_seconds":...,"platform":"Linux","version":"3.2.27-47354"}
```

> 这个服务启动时会先跑一次自检签名调用，**自检失败会直接退出、不开端口**。所以 `/health` 能通就说明原生签名路径是好的。Docker 里也配了 HEALTHCHECK，挂了会显示 unhealthy。

### 3.4 配置协议端

```jsonc
{
  "SignServerUrl": "http://127.0.0.1:8080",
  "Account": {
    "Uin": 123456789,
    "Protocol": "Linux"
  }
}
```

> Lagrange.Core 会向 `{SignServerUrl}` POST 签名请求，并 GET `{SignServerUrl}/api/sign/appinfo` 取应用信息。这个自建服务两者都支持，直接填根地址即可。
>
> 如果 Lagrange 跑在另一台机器或另一个容器里，把 `127.0.0.1` 换成对应的 host.docker.internal 或内网 IP。

### 3.5 维护须知

签名函数在 `wrapper.node` 里的地址是硬编码偏移量。项目自带按特征码自动探测，覆盖了这几个版本：

| QQ 版本 | 偏移量 |
|---|---|
| 3.2.27-47354 | `0x56D81D1` |
| 3.2.19-39038 | `0x5ADE220` |
| 3.2.18-36497 | `0x59660D0` |

自动探测失败时手动指定：

```powershell
python3 sign.py --wrapper ./wrapper.node --port 8080 --offset 0x56D81D1
```

**QQ 升级后的应对**：重新 `docker build`（会下载新版 QQ），然后看日志确认自检通过。如果启动就退出，说明偏移量失效了，去项目 Issue 区找新偏移量或等更新。

---

## 4. 路径 C：换 LuckyLilliaBot（完全不需要签名服务）
### 4.1 原理

LuckyLilliaBot 通过 LiteLoaderQQNT 把代码注入**真实的 NTQQ 客户端**，复用客户端自己的签名能力，所以签名问题根本不存在。

### 4.2 代价

| 项目 | 说明 |
|---|---|
| 必须 GUI | 不能纯命令行，Windows 桌面常驻 |
| 必须登录 PC QQ | 客户端要一直开着 |
| 资源占用 | 比 Lagrange.Core 高 |
| OneBot 覆盖率 | 略低于 Lagrange，且历史上曾长期偏低 |

### 4.3 适用场景

- 你就在 Windows 上日常用机，不介意多开一个 QQ
- 签名服务三条路都走不通时的逃生门

项目地址：[LLOneBot/LuckyLilliaBot](https://github.com/LLOneBot/LuckyLilliaBot)

---

## 5. 排错速查

| 现象 | 原因 | 处理 |
|---|---|---|
| 扫码成功、有 `BotContext`、有 uin，但消息发不出去且无报错 | **没配签名服务**，或配了但登录的 QQ 号不在白名单/未绑定 | 检查 `SignServerUrl`；确认 `Account.Uin` 与绑定的 QQ 号一致 |
| 手机提示"其他设备登录"，但电脑端不被顶 | 同上，登录其实没真正完成 | 同上 |
| 没有任何 `Online` 事件 | 同上 | 同上 |
| 出现验证码登录 | NTQQ 风控 | 删掉 `Keystore` 重新扫码；官方明确说明**验证码登录成功率低** |
| 日志级别不够看不出问题 | 默认 Information | `Logging.LogLevel.Default` 改成 `Trace` 重启复现 |
| 自建服务启动即退出 | 原生签名自检失败（偏移量失效 / wrapper.node 损坏 / 缺依赖） | 看容器日志，换 `--offset` 或重新 build |
| Docker 里通了，Lagrange 连不上 | 网络命名空间问题 | 用 `host.docker.internal` 替代 `127.0.0.1` |

---

## 6. 与 qq-netizen 的衔接

协议端就绪后，确认 `appsettings.json` 里：

- `Implementations[0].Type = "ReverseWebSocket"`
- `Port` / `Suffix` 与 [config/default.yaml](../config/default.yaml) 的 `adapter.url` 匹配（默认 `ws://127.0.0.1:8080/onebot/v11/ws`）
- `AccessToken` 与 `ONEBOT_ACCESS_TOKEN` 一致

然后即可进入 M1 开发。

---

## 参考资料

- [Lagrange V2 Sign API 使用指南](https://github.com/LagrangeDev/SignApiGuide)
- [Lagrange.OneBot 快速部署 & 配置](https://lagrangedev.github.io/Lagrange.Doc/v1/Lagrange.OneBot/Config/)
- [Lagrange 配置生成器](https://lagrangedev.github.io/lagrange-config-generator/)
- [Micuks/ntqq-sign-server（自建方案）](https://github.com/Micuks/ntqq-sign-server)
- [unidbg-fetch-qsign（Android 协议，与 NTQQ 不互通，仅存档）](https://github.com/fuqiuluo/unidbg-fetch-qsign)
- [LuckyLilliaBot（LLOneBot）](https://github.com/LLOneBot/LuckyLilliaBot)
