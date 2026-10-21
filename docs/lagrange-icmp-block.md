# Lagrange 登录失败：ICMP Ping 被拦截

> 记录：2026-10-21
> 状态：**已定位，需在安全软件侧加例外**（非代码问题）

---

## 现象

Lagrange.OneBot 启动后立刻退出，报：

```
Unhandled exception. System.Net.NetworkInformation.PingException:
  An exception occurred during a Ping request.
 ---> System.ComponentModel.Win32Exception (5): 拒绝访问。
   at System.Net.NetworkInformation.Ping.GetStatusFromCode(Int32 statusCode)
   at System.Net.NetworkInformation.Ping.DoSendPingCore(...)
   at Lagrange.Core.Utility.Network.Icmp.PingAsync(Uri hostIp, Int32 timeout)
   at Lagrange.Core.Internal.Context.SocketContext.OptimumServer(Boolean requestMsf, Boolean useIPv6Network)
   at Lagrange.Core.Internal.Context.SocketContext.Connect()
   at Lagrange.Core.Internal.Context.Logic.Implementation.WtExchangeLogic.LoginByEasy(...)
   at Lagrange.OneBot.Utility.Fallbacks.FallbackAsync.ExecuteAsync(...)
   at Lagrange.OneBot.Core.Login.LoginService.StartAsync(...)
```

---

## 排查过程与证据

| 测试 | 结果 | 说明 |
|---|---|---|
| `ping 223.5.5.5` 命令 | ✅ 成功 29ms | 系统 ICMP 能力正常 |
| .NET `Ping.Send()` 类 | ✅ 成功 29ms | **和 Lagrange 用的是同一个 API** |
| `Lagrange.OneBot.exe` 内调用 | ❌ Win32Exception(5) | 只有它被拒 |
| 安全软件检查 | ⚠️ 卡巴斯基 `avp.exe` 在运行 | 应用控制拦截 |

### 关键推理

1. 系统层面 ICMP 是通的（ping 命令成功）
2. .NET 的 Ping 类在本机也是通的（单独测成功）
3. 唯独 `Lagrange.OneBot.exe` 这个进程被拒 → **是进程级拦截，不是能力缺失**
4. 机器上跑着卡巴斯基 → 卡巴斯基「应用程序控制 / 入侵防御」按 exe 粒度管控网络

### 为什么改 GetOptimumServer 没用

试过把 `appsettings.json` 的 `"GetOptimumServer": true` 改成 `false`，仍然崩。

原因：从调用栈看，`SocketContext.Connect()` 里**无条件**调用 `OptimumServer(requestMsf, useIPv6Network)`。
这个配置项并不控制该调用（或当前版本未绑定此字段）。
所以"关掉最优服务器选择"这条路走不通，必须解决 Ping 本身。

---

## 解决方案

### 方案 A：给卡巴斯基加例外（推荐）

1. 打开卡巴斯基 → 设置 → 安全 → **入侵防御 / 应用程序控制**
2. 找到 `Lagrange.OneBot.exe`（或"未识别程序"分类）
3. 把它的**网络规则**改为「允许」/ 加入信任
4. 或者直接在「排除项」里加入这个 exe 的完整路径

### 方案 B：以管理员身份运行

右键 `Lagrange.OneBot.exe` → **以管理员身份运行**。
管理员进程通常能绕过用户级应用控制规则。

### 方案 C：临时验证

临时退出卡巴斯基（或暂停保护）后再启动。
如果能正常登录，即可确认是它拦截，再回到方案 A 做持久例外。

---

## 附带发现：Lagrange 必须有真实控制台

排查过程中还确认了另一件事：

```
System.IO.IOException: 句柄无效。
   at System.ConsolePal.GetBufferInfo(...)
   at System.Console.get_BufferWidth()
   at Lagrange.OneBot.Program.Main(String[] args)
```

`Lagrange.OneBot.exe` 是 78MB 的 **.NET 单文件自包含应用**，启动时无条件读
`Console.BufferWidth`，**没有真实控制台就崩溃**。

尝试过 ConPTY 伪终端（见 `tools/lagrange-host/`），对普通控制台程序有效
（实测 exit 0），但对单文件应用无效——apphost fork 的子进程不继承伪终端句柄，
仍然崩在 `0xE0434352`。

**结论：必须用有真实控制台窗口的方式启动**
（双击 exe，或用 `start` 命令开窗口，不能后台静默启动）。

---

## 相关配置

`appsettings.json` 里当前设置为：

```jsonc
"Account": {
  "Uin": 3462993809,
  "Protocol": "Linux",
  "AutoReconnect": true,
  "GetOptimumServer": false   // 已改为 false（但对本次问题无效，见上文）
},
"QrCode": {
  "ConsoleCompatibilityMode": false   // 必须 false，设 true 会导致二维码输出异常
}
```

`launcher/patch-lagrange-config.bat` 可以一键校正这两项（幂等）。
---

## 更新：2026-10-21 20:10 加例外后

用户已在卡巴斯基里给 `Lagrange.OneBot.exe` 加了例外。加完之后立即验证：

```
=== 同步 Ping ===
✅ .NET Ping: Success 31ms
=== 异步 PingAsync（Lagrange 用的就是这个）===
✅ PingAsync: Success 29ms
```

两项都通了，说明**例外确实生效**。

注意：这只能验证"当前 PowerShell 进程"的 ICMP 能力正常。
Lagrange 自己的进程是否也被放行，需要实际启动它才能确认——
不同进程的应用控制规则是独立评估的。

因此下一步是：双击 `Lagrange.OneBot.exe`，观察是否还报 `PingException`。

如果仍报错，说明例外没覆盖到它，需要检查：
- 例外加的是不是同一个路径的 exe
- 卡巴斯基是否把该 exe 归到别的分组（比如"未识别程序"）而那个分组仍受限
- 是否有第二层拦截（Windows 防火墙出站规则、其它安全软件）

## 验证 ICMP 能力的可复用方法

```powershell
# 同步
$p = New-Object System.Net.NetworkInformation.Ping
$p.Send("223.5.5.5", 2000)

# 异步（Lagrange 内部用的就是这个）
$task = (New-Object System.Net.NetworkInformation.Ping).SendPingAsync("223.5.5.5", 2000)
$task.Wait(3000) | Out-Null
$task.Result.Status
```
---

## 更新：2026-10-21 20:15 加了例外仍然失败 → 找到真正原因

用户在卡巴斯基加了例外后重新启动，**仍然报同样的 PingException**。
于是做了决定性对照实验。

### 实验：同一个 Ping API，不同进程

| 调用位置 | 结果 |
|---|---|
| PowerShell 进程内直接调 `Ping.Send()` | ✅ Success 29ms |
| 独立编译的 `pingtest.exe`（我写的测试程序） | ❌ Win32Exception(5) 拒绝访问 |
| `pingtest.exe` 由 cmd 启动 | ❌ 同样失败 |
| `pingtest.exe` 由 powershell 启动 | ❌ 同样失败 |
| `pingtest.exe` 加 asInvoker manifest 重编 | ❌ 同样失败 |
| 系统 `ping` 命令 | ✅ 成功 |

### 结论

**不是权限级别问题，是程序信任等级问题。**

当前进程身份完全相同（`FURINA\natasuki`，Medium 完整性级别），
差异只在**程序本身**：

- `powershell.exe` —— 微软签名，卡巴斯基默认信任 → 放行 ICMP
- 未签名 exe（`pingtest.exe`、`Lagrange.OneBot.exe`）→ 归入「未识别/低限制」
  → 应用程序控制拦截其 ICMP 原始套接字操作

**重要：卡巴斯基的「排除项 / 文件白名单」管的是杀毒扫描，不覆盖应用程序控制的网络规则。**
这就是为什么加了例外仍然失败——加错了位置。

### 正确的放行方法

卡巴斯基 → 设置 → 安全 → **入侵防御 → 管理应用程序**
→ 找到「未识别程序」或「低限制」分组里的 `Lagrange.OneBot.exe`
→ 右键 → **限制** → 改为「**受信任**」

需要改的是**程序分组**，不是文件排除列表。

### 备选方案

1. **以管理员身份运行** —— 管理员进程通常不受用户级应用程序控制约束
2. **换协议端** —— NapCat 登录时不做 ICMP 探测，没有这个依赖

---

## 补充：为什么改 GetOptimumServer 完全无效

反编译检查 exe 内嵌的默认配置模板，确认 `GetOptimumServer` 是合法字段。
但从调用栈看 `SocketContext.Connect()` **无条件**调用
`OptimumServer(requestMsf, useIPv6Network)`，该配置项在当前版本没有参与这个分支的判定。

所以"关掉最优服务器选择"这条路是死的，必须解决 Ping 本身。
---

## 更新：2026-10-21 20:30 加入受信任后

用户已在卡巴斯基把 `Lagrange.OneBot.exe` 加入**受信任**分组。
但通过我自己的测试程序验证，未签名 exe 的 ICMP 仍然被拒：

```
pingtest.exe（未加白）        → FAIL 拒绝访问
_Lagrange同目录下的 ptest.exe  → FAIL 拒绝访问
PowerShell 进程内             → ✅ Success 28ms
```

说明卡巴斯基的信任是**按文件哈希/签名精确匹配**的，
不会因为我放在同一目录、或复制一份就继承信任。
`pingtest.exe` 不是被信任的那个文件，所以仍被拦——这符合预期，不代表 Lagrange 也被拦。

### 无法在我这边完成最终验证的原因

尝试了所有能创建控制台的方式，都被同一个 Windows 行为挡住：

| 方式 | 结果 |
|---|---|
| `CREATE_NEW_CONSOLE` + 输出重定向 | ❌ 崩在 `Console.get_BufferWidth` |
| ConPTY 伪终端 | ❌ 崩在 `0xE0434352` |
| 重定向到文件 | ❌ 崩在 `Console.get_BufferWidth` |

**根因：一旦重定向 stdout，Windows 就不再分配真实控制台句柄。**
而 Lagrange 启动时无条件读 `Console.BufferWidth`，所以：
- 有真实可见窗口 → 能跑，但输出抓不到
- 想抓输出做重定向 → 崩在控制台检查

这是个死循环，在我的无窗口环境里无解。

### 最终验证必须由用户完成

双击 `Lagrange.OneBot.exe`，观察：
1. 不再出现 `PingException` → 信任生效
2. 出现二维码 → 完整跑通
3. 若仍报 PingException → 信任没覆盖到，需检查是否加对了文件

### 验证进展的判据

不同错误对应不同阶段，据此可判断修到哪一步了：

| 报错 | 含义 |
|---|---|
| `PingException / Win32Exception(5)` | 卡在 ICMP，信任未生效 |
| `Console.get_BufferWidth` | 没有真实控制台（不是程序问题） |
| 出现二维码 | 登录流程启动成功 |
| `Signer server returned ...` | 到了签名阶段，检查 ntqq-sign-server |