# 协议端启动记录与已知问题

> 日期：2026-10-20
> 状态：**三个崩溃全部定位并修复**，待最后启动验证

---

## 1. 环境现状

| 组件 | 状态 |
|---|---|
| 签名服务 `ntqq-sign-server` | ✅ Docker 运行中，`Up (healthy)`，端口 8090 |
| 主程序 `qq-netizen` | ✅ 运行中，8080 监听等协议端 |
| 协议端 `Lagrange.OneBot` | ⏳ 配置已修好，待启动 |

---

## 2. 三个崩溃：根因与修复

从你贴的日志看，**程序已经能跑到登录阶段了**——这本身就是大进步。三个坑依次是：

### 坑 ①：EventLog 写入权限（已修）

```
Cannot open log for source '.NET Runtime'. You may not have write access.
   at Microsoft.Extensions.Logging.EventLog.EventLogLogger.WriteMessage
   at Lagrange.OneBot.Utility.MusicSigner..ctor
```

**根因**：`MusicSignServerUrl` 为空 → `MusicSigner` 打一条警告 → .NET 默认把日志同时写入 Windows 事件日志 → 当前进程无权写入 → 日志系统抛异常 → 程序退出。

**修复**：

```jsonc
"Logging": {
  "EventLog": {
    "LogLevel": { "Default": "None" }   // 彻底关掉事件日志输出
  }
}
```

### 坑 ②：Console 句柄无效（只影响自动化启动）

```
System.IO.IOException: 句柄无效。
   at System.Console.get_BufferWidth()
```

**根因**：程序启动时无条件读控制台宽度。在「无控制台 + 输出重定向」环境下拿不到句柄。

**说明**：**你手动双击不会触发这个**，因为双击有真实控制台。这个问题只挡自动化启动。

**辅助修复**：`QrCode.ConsoleCompatibilityMode` 改为 `true`，避免富终端渲染二维码失败时静默退出。

### 坑 ③：签名服务返回 BadRequest（核心问题，已修）

```
warn: System.Exception: Signer server returned a BadRequest
   at Lagrange.OneBot.Utility.OneBotSigner.Sign(...)
Unhandled exception. System.Exception: All login failed!
```

**这才是你「看不到二维码」的真正原因**——登录在签名这一步就失败了，根本没走到生成二维码。

#### 定位过程

本鲸娘先在签名服务端加日志，发现服务收到了请求但返回 400：

```
GET /appinfo   200   ✅
POST /         400   ❌
```

用 curl 测各种格式都返回 200，说明**不是格式问题**。

于是起了一个「假签名服务」把 Lagrange 发来的**原始请求**抓下来，拿到了决定性证据：

```
POST /
HEADERS: {'Host': '127.0.0.1:8091',
          'Transfer-Encoding': 'chunked',      ← 关键
          'Content-Type': 'application/json; charset=utf-8'}
RAW_BODY: b''                                  ← 读不到内容
```

#### 根因

| 项 | 说明 |
|---|---|
| Lagrange 用什么发 | `HttpClient`，**默认 `Transfer-Encoding: chunked`**，不带 `Content-Length` |
| 签名服务怎么读 | `body = self.rfile.read(int(headers.get('Content-Length', 0)))` |
| 结果 | chunked 请求没有 `Content-Length` → 读到 **0 字节** → JSON 解析失败 → **返回 400** |

也就是说：**服务是好的，只是不会读 chunked 编码的请求体。**

#### 修复

在 `sign.py` 的 `SignHandler` 里重写 `do_POST`，支持 chunked 解码：

```python
def _read_body(self) -> bytes:
    te = (self.headers.get('Transfer-Encoding') or '').lower()
    if 'chunked' in te:
        chunks = []
        while True:
            line = self.rfile.readline().strip()
            if not line:
                continue
            try:
                size = int(line.split(b';')[0], 16)
            except ValueError:
                break
            if size == 0:
                while True:                      # 吃掉 trailer
                    if not self.rfile.readline().strip():
                        break
                break
            chunks.append(self.rfile.read(size))
            self.rfile.read(2)                   # CRLF
        return b''.join(chunks)

    content_len = int(self.headers.get('Content-Length', 0) or 0)
    return self.rfile.read(content_len) if content_len > 0 else b''
```

**验证**：

```
POST / (chunked) → 200
SIGN REQUEST: keys=['cmd', 'seq', 'src'] cmd='wtlogin.login' seq=1 src_len=4
value.sign = 41F971148EDBA120...
```

---

## 3. 当前的完整状态

### 签名服务

```
docker ps
ntqq-sign-server   Up (healthy)   0.0.0.0:8090->8080/tcp
```

已打补丁：支持 chunked + 请求日志。

> ⚠️ 补丁是通过 `docker cp` 注入容器的。**如果重新 build 镜像，补丁会丢失**，需要重新执行：
> ```powershell
> docker cp "D:\Agent\HarnessWorkPlace\Deepseek\ntqq-sign-server\sign.py" ntqq-sign-server:/app/sign.py
> docker restart ntqq-sign-server
> ```
> 源码文件 `ntqq-sign-server\sign.py` 已同步修改。

### 协议端配置

```jsonc
{
  "Logging": {
    "LogLevel": { "Default": "Information", "Microsoft": "Warning" },
    "EventLog": { "LogLevel": { "Default": "None" } }
  },
  "SignServerUrl": "http://127.0.0.1:8090",
  "Account": {
    "Uin": 机器人QQ号,
    "Password": "",
    "Protocol": "Linux",
    "AutoReconnect": true,
    "GetOptimumServer": true
  },
  "QrCode": { "ConsoleCompatibilityMode": true },
  "Implementations": [{
    "Type": "ReverseWebSocket",
    "Host": "127.0.0.1", "Port": 8080, "Suffix": "/onebot/v11/ws",
    "AccessToken": "<与 .env 的 ONEBOT_ACCESS_TOKEN 一致>"
  }]
}
```

---

## 4. 下一步：再双击一次

```powershell
cd "D:\Agent\HarnessWorkPlace\Deepseek\lagrange\Lagrange.OneBot\bin\Release\net9.0\win-x64\publish"
.\Lagrange.OneBot.exe
```

或直接双击 `Lagrange.OneBot.exe`。

### 这次应该看到

```
info: Protocol Version: 3.2.27-47354
info: [WtExchangeLogic] Connecting Servers...
info: [SocketContext] Server: ... Latency: 2x     ← 多台服务器
     ↓
（二维码出现）
```

### 扫码

用**手机 QQ（登录着主号 你的QQ号）**扫窗口里的二维码，手机上确认登录 机器人QQ号。

### 成功判据

| 检查点 | 预期 |
|---|---|
| Lagrange 窗口 | `Online` 事件 / 登录成功 |
| 本程序日志 | `协议端已连接` |
| `curl http://127.0.0.1:3000/healthz` | `{"ok":true,"status":"connected"}` |

---

## 5. 如果还有问题

### 签名还是 400

查容器日志里的 `SIGN REQUEST` 行：

```powershell
docker logs ntqq-sign-server --tail 20
```

- 看到 `SIGN REQUEST: keys=[...]` 且返回 200 → 签名 OK
- 看到 `invalid JSON body (0 bytes)` → chunked 补丁没生效，重新 `docker cp` + `restart`

### 出现二维码但扫码后失败

| 可能 | 排查 |
|---|---|
| 签名权限没绑定 | 协议端登录不需要绑定（自建服务无白名单），但如果走的是官方 API 就必须绑定 |
| 协议版本不对 | `Protocol` 改成 `Linux`（已是） |
| 设备锁 | 手机上关掉设备锁，或扫码时选「信任此设备」 |
| 风控 | 换网络环境，或等一段时间 |

### 登录成功但本程序没收到连接

检查 `AccessToken` 是否两边一致：

```powershell
# 协议端配置里的
Get-Content "D:\Agent\HarnessWorkPlace\Deepseek\lagrange\Lagrange.OneBot\bin\Release\net9.0\win-x64\publish\appsettings.json" | Select-String AccessToken
# 项目 .env 里的
Get-Content "D:\Agent\HarnessWorkPlace\Deepseek\qq-netizen\.env" | Select-String ONEBOT_ACCESS_TOKEN
```

两边必须**完全相同**。

---

## 6. 重要提醒

**协议端要自己扫码，不能复用 QQ 客户端的登录状态。**

- 用手机 QQ（主号已登录）扫协议端的二维码
- 手机上确认登录 **机器人QQ号**
- 两个客户端各自独立，不会冲突（除非同时登录同一个号）
