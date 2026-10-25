# 二维码问题的定位与解决

> 日期：2026-10-20
> 结论：**签名已通，二维码已生成，但被存成了 PNG 文件而非显示在窗口里**

---

## 1. 决定性证据

从签名服务的日志时间线可以确认，登录流程**已经走完了取二维码的阶段**：

```
16:13:42  GET  /appinfo                          200   ← 取应用信息
16:13:43  POST / cmd=wtlogin.trans_emp src=712   200   ← 请求二维码（第一次）
16:14:58  POST / cmd=wtlogin.trans_emp src=1424  200   ← 请求二维码（第二次，内容更长）
16:14:58  POST / cmd=wtlogin.login   src=4       200   ← 开始登录流程
```

`wtlogin.trans_emp` 就是**获取登录二维码**的命令。它连续成功了两次，说明：

- ✅ 签名服务工作正常
- ✅ 二维码数据已经从腾讯服务器拿到
- ✅ 程序已经进入登录流程

**问题不在登录，而在二维码的「显示方式」。**

---

## 2. 真正的原因

在临时目录里找到了二维码图片：

```
C:\Users\natasuki\AppData\Local\Temp\scoped_dir40428_1572056221\77E0A01C7499D3936B363AC2B42F1B2C98056196.png
```

41661 字节，是一张完整的二维码 PNG。

对应配置项：

```jsonc
"QrCode": {
  "ConsoleCompatibilityMode": true    // ← 这个
}
```

**`true` 的含义**：把二维码保存成 PNG 文件，而不是在控制台画 ASCII 字符块。

**所以你不是"没看到二维码"，是二维码被存成文件了，而程序没告诉你在哪。**

---

## 3. 已做的修改

```jsonc
"QrCode": {
  "ConsoleCompatibilityMode": false   // ← 改成在控制台直接画
}
```

改成 `false` 后，二维码会以字符块形式**直接打印在窗口里**，一眼就能看到。

---

## 4. 现在请你再启动一次

```powershell
cd "D:\Agent\HarnessWorkPlace\Deepseek\lagrange\Lagrange.OneBot\bin\Release\net9.0\win-x64\publish"
.\Lagrange.OneBot.exe
```

**双击也行。**

这次窗口里应该出现一大片由字符组成的方块图案——那就是二维码。

### 扫码

1. 手机 QQ 打开**扫一扫**
2. 扫窗口里的二维码
3. 手机上会弹出「确认登录 机器人QQ号」
4. 点确认

> 手机 QQ 用什么号登录都行，只要能在手机上确认这次登录即可。
> 二维码有效期很短（通常 1-2 分钟），过期了重启程序重新生成。

---

## 5. 成功后的现象

| 位置 | 现象 |
|---|---|
| Lagrange 窗口 | 出现 `Online`、`Protocol` 等字样，不再有 warn |
| 本程序窗口 | `协议端已连接` |
| `curl http://127.0.0.1:3000/healthz` | `{"ok":true,"status":"connected"}` |

---

## 6. 如果还是看不到

### 备选方案 A：用已有的 PNG

如果窗口里还是不显示，那就反过来——把 `ConsoleCompatibilityMode` 设回 `true`，然后在下面的目录里找最新生成的 PNG：

```powershell
Get-ChildItem "$env:TEMP" -Recurse -Filter "*.png" -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-5) } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 5 FullName, LastWriteTime
```

找到后用图片查看器打开，手机扫码。

### 备选方案 B：检查日志确认二维码已生成

打开 Debug 日志后，日志里会出现与二维码相关的记录。把日志贴过来，本鲸娘能精确定位它写到哪了。

---

## 7. 补充说明：之前踩过的三个坑（都已修复）

| # | 问题 | 状态 |
|---|---|---|
| ① | EventLog 写入权限导致崩溃 | ✅ 已用 `EventLog: None` 关闭 |
| ② | Console 句柄无效（仅影响自动化启动） | ✅ 手动启动不触发 |
| ③ | 签名服务不认 chunked 编码，返回 400 | ✅ 已修 `sign.py` 的 `do_POST` |

这三个都不再是阻塞项。现在唯一的问题是**二维码的呈现方式**。
