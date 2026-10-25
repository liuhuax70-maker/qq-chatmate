# 登录状态保持 — 设计说明

> 目标：**打开 exe 就能用，不要每次扫码。**
> 每次打开都要重新登录，是用户体验里最痛的一条，值得单独写一篇。

---

## 一、结论先说

QQ 的登录状态能不能留住，取决于三件事：

| 环节 | 要保住什么 | 谁在破坏它 |
|---|---|---|
| QQ 退出方式 | `login.db` / `msf` / `nt_data\Login` 的凭证文件 | **`taskkill /F` 强杀** |
| 协议端启动方式 | 快速登录用的历史账号记录 | 每次都重新走二维码流程 |
| 看门狗 | 不要无谓地重启协议端 | 重启协议端 = 杀 QQ = 掉登录 |

三处全都修了。

---

## 二、根因分析

### 根因 1：强杀 QQ 导致凭证来不及落盘

旧代码 `KillLeftoverQQ()`：

```csharp
taskkill /IM QQ.exe /T /F      // ← 这个 /F
```

`/F` = 强制终止。QQ 收到的是"进程立刻消失"，**没有机会走退出流程**。
而 QQ 的登录凭证（session token、设备指纹、上次登录账号）是在正常退出时
刷盘并清理的。强杀之后：

- `login.db` 里的记录停留在旧状态
- `nt_data\Login\.<QQ号>` 快速登录标记没被续期
- 下次启动时 NapCat 调 `getLoginList()` 拿到的 `isQuickLogin` 记录不可用
- → 只能重新扫码

**修复**：`CloseQQGracefully()`

1. 对每个有主窗口的 QQ 进程发 `WM_CLOSE`（等于点右上角 ×）
2. 最多等 10 秒，让它走完退出流程
3. 真的不动了才 `taskkill /F` 兜底

### 根因 2：从来没启用快速登录

NapCat 支持 `-q <QQ号>` 参数：启动时直接复用上次的登录态，**不弹二维码**。

我们从来没传过这个参数 —— `launcher-napcat-qq.bat` 最后一行是：

```bat
"%NAPCAT_LAUNCHER_PATH%" "%QQPath%" "%NAPCAT_INJECT_PATH%" %*
```

`%*` 透传，但启动器调用它时一个参数都没给。

**修复**：

- 启动器从 `qq-netizen\.env` 的 `ONEBOT_SELF_ID` 读出机器人 QQ 号
- 启动 NapCat 时带上 `-q <QQ号>`
- 同时把账号写进 `napcat\napcat\config\webui.json` 的 `autoLoginAccount`（双保险）

### 根因 3：看门狗把好好的 NapCat 一起重启

旧 `WatchdogTick()`：

```csharp
bool lag = Program.TestLagrange();      // QQ 进程在 → true
_lagDownStreak = lag ? 0 : _lagDownStreak + 1;
```

`TestLagrange()` 只要看到**任意** `QQ.exe` 进程就返回 true。问题是：

- 用户自己开的 QQ（`D:\qq\QQ.exe`）也叫 `QQ.exe`
- NapCat 注入的 QQ（`napcat\QQ\QQ.exe`）也叫 `QQ.exe`

两者混在一起 → 判断完全不可靠 → 看门狗经常误判"协议端挂了" → 重启 NapCat → 杀 QQ → 掉登录。

**修复**：

- 新增 `IsNapCatRunning()`：查 **6099 端口**（NapCat 的 WebUI 端口，只有它活着才有）
- 看门狗里，**只要 6099 在听，就绝不重启协议端**
- 机器人自己掉了只重启机器人（NapCat 的 WS 客户端会自己重连）

### 根因 4（顺带的）：`StartLagrange()` 无条件杀 QQ

旧代码每次调 `StartLagrange()` 都先 `KillLeftoverQQ()`。
而 `StartAllAsync()` 在开机自启、点「一键全部启动」时都会调它 ——
即使 NapCat 明明好好跑着。

**修复**：

```csharp
if (IsProtocolConnected()) return "协议端已在线，无需重启";
if (IsNapCatRunning())      return "NapCat 已在运行，保留当前登录状态";
```

---

## 三、被否掉的方案

### ❌ 设置 `NAPCAT_QUICK_ACCOUNT` 环境变量

看起来是最直接的办法（`napcat.mjs` L83244 明确读它），但有个致命副作用：

```js
// napcat.mjs L83241-83248
let a = !1;
try {
  const c = pe.getQQQuickLoginList() || [];
  (process.env.NAPCAT_QUICK_ACCOUNT || c.length > 0 || ...) && (a = !0),
  await pe.runWebUiConfigQuickFunction();
} catch (c) { ... }
!a && !t.isLogined && n.getQRCodePicture();   // ← a=true 时不调这个
```

设了这个变量 → `a = true` → **快速登录失败时连二维码兜底都不给**。
结果：卡在登录界面，既没快速登录成功，也没二维码可扫，彻底进不去。

**所以只用 `-q` 参数**（L83349-83351 解析），失败时会正常退回二维码。

### ❌ 保存 / 替换 `login.db`

QQ 的 `login.db` 是加密 + 被 QQ 进程独占锁定的（实测 `ReadAllBytes` 直接
`IOException: 文件正由另一进程使用`）。拷贝出来是拿不到有效内容的，
替换回去也会被 QQ 校验拒绝。

**正确的做法是让 QQ 自己好好退出**，它会自己把凭证写对。

### ❌ 用 `wmic process where` 按命令行区分两个 QQ

`wmic` 在部分环境不存在，且需要额外权限。改用端口探测（6099）更简单可靠。

---

## 四、代码改动清单

### `launcher/Launcher.cs`

| 新增 / 修改 | 作用 |
|---|---|
| `AnyProcess(name)` | 统一的进程存在判断（tasklist，受限权限下也可靠） |
| `CloseQQGracefully()` | 三步优雅关闭：WM_CLOSE → 等 10s → 强杀兜底 |
| `KillLeftoverQQ()` | 保留为兼容别名，内部调 `CloseQQGracefully()` |
| `GetBotQQ()` | 从 `.env` 读 `ONEBOT_SELF_ID` |
| `EnsureNapCatAutoLogin(qq)` | 把账号写进 `webui.json` |
| `IsNapCatRunning()` | 查 6099 端口，判断 NapCat 是否活着 |
| `KillNapCatHost()` | 只杀 `NapCatWinBootMain.exe`，不碰机器人的 node |
| `TestLagrange()` | 判据改为 healthz → 6099 → QQ 进程（三级） |
| `StartLagrange()` | 已在线/已运行就直接返回，不再杀 QQ；带 `-q` 参数 |
| `WatchdogTick()` | NapCat 活着就不重启协议端 |
| `StartAllAsync()` | NapCat 活着就跳过启动步骤 |
| `KillAllChildren()` | 把 `StopLagrange()` 提到最前，先保存登录态 |
| `FindQrCode()` | 用 `IsNapCatRunning()` 而非 `TestLagrange()` 判断二维码有效性 |
| 关闭对话框文案 | 说明会正常退出 QQ 以保存登录状态 |

### `napcat/napcat/config/`

| 文件 | 改动 |
|---|---|
| `webui.json` | `autoLoginAccount`: `""` → `"3462993809"` |
| `napcat.json` | `fileLog`: `false` → `true`（方便以后排查登录问题） |
| `napcat_3462993809.json` | 同上 |

### `launcher/build-and-sign.ps1`

| 修复 | 原因 |
|---|---|
| 加 UTF-8 BOM | PowerShell 5.1 无 BOM 时按 GBK 读，`.ico` 中文名变乱码导致编译失败 |
| 排除 `_trash*` | 构建残留被误识别为 GUI 版本，真正的大肥鱼.exe 没更新 |
| 优先匹配含中文的 exe | 确保永远部署到「大肥鱼.exe」 |

---

## 五、实测记录

### 配置验证

```
$ Select-String ...\webui.json -Pattern "autoLoginAccount"
webui.json:6:    "autoLoginAccount": "3462993809",     ✅

$ Select-String ...\.env -Pattern "ONEBOT_SELF_ID"
.env:4:ONEBOT_SELF_ID=3462993809                        ✅
```

### 构建验证

```
大肥鱼.exe     289360 bytes   2026/10/26 4:17:19
签名           Valid  CN=Qinai Chatmate Launcher
图标           32x32 embedded                          ✅
```

### 运行态验证

```
http://127.0.0.1:3000/healthz  → {"status":"connected"}   ✅
http://127.0.0.1:6099          → 200                     ✅
```

---

## 六、待用户验证

**这一步只能你来做**（会话是普通权限，杀不掉管理员权限的 QQ）：

1. 关掉当前「大肥鱼」窗口
2. 双击桌面「大肥鱼」
3. 观察：**是否还需要扫码**

| 结果 | 含义 |
|---|---|
| 直接连上、没弹二维码 | ✅ 修复生效 |
| 弹了二维码 | NapCat 的历史登录记录已失效，需要**最后扫一次**；扫完之后以后就不用再扫了 |

---

## 七、如果以后又掉登录

排查顺序：

1. **看 NapCat 是否被强杀过**
   ```powershell
   Get-Content "D:\Agent\HarnessWorkPlace\Deepseek\napcat\napcat\logs\*.log" -Tail 50
   ```
   （现在 `fileLog: true`，日志会写到 `napcat\napcat\logs\`）

2. **看 6099 端口是否在听**
   ```powershell
   netstat -ano | Select-String ":6099"
   ```
   不在 = NapCat 没起来；在但机器人连不上 = 机器人自己的问题，别动 QQ。

3. **看快速登录账号是否还在**
   ```powershell
   Select-String "D:\Agent\HarnessWorkPlace\Deepseek\napcat\napcat\config\webui.json" -Pattern "autoLoginAccount"
   Select-String "D:\Agent\HarnessWorkPlace\Deepseek\qq-netizen\.env" -Pattern "ONEBOT_SELF_ID"
   ```

4. **确认启动命令行带没带 `-q`**
   ```powershell
   Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" | Select-Object ProcessId, CommandLine
   ```
   注：QQ 自己不会显示 `-q`（那是给 NapCat 的），要看 NapCatWinBootMain：
   ```powershell
   Get-CimInstance Win32_Process -Filter "Name='NapCatWinBootMain.exe'" | Select-Object ProcessId, CommandLine
   ```

---

## 八、腾讯侧的限制（无法绕过）

即使我们做得再好，以下情况**一定**会掉登录：

| 情况 | 说明 |
|---|---|
| 手动改密码 | QQ 会让所有设备重新登录 |
| 在手机 QQ「退出登录」 | 同上 |
| 长时间不登录（约 30 天） | 腾讯的 session 过期 |
| 异地登录风控 | 换网络/换 IP 可能触发验证 |
| QQ 版本升级 | `versions\config.json` 变了会重置部分状态 |

这些不是 bug，是腾讯的安全策略。遇到了只能扫一次码。
