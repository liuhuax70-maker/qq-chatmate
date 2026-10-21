# NapCat 部署说明

> 协议端从 Lagrange 迁移到 NapCat，解决 ICMP 拦截 + 控制台依赖两个死结。

## 版本

- NapCat v4.18.41（NapCat.Shell.Windows.Node.zip）
- QQ NT 9.9.33（腾讯官方 CDN，`qqdl.gtimg.cn/qqfile/QQNT/9.9.33/release/497e2f1f/QQ_9.9.33_260813_x64_01.exe`）

## 目录结构

```
napcat\
├── QQ\                          QQ 9.9.33（解包自官方安装器）
│   ├── QQ.exe
│   └── versions\9.9.33-52230\resources\app\
├── napcat\                      NapCat 核心
│   ├── napcat.mjs               主程序
│   ├── loadNapCat.js            注入入口
│   ├── NapCatWinBootMain.exe    启动器（hook QQ）
│   ├── NapCatWinBootHook.dll    hook 库
│   ├── qqnt.json                patch 包（version 已改 9.9.33-52230）
│   ├── config\onebot11.json     OneBot 配置
│   └── launcher-napcat-qq.bat   定制启动脚本（指向 napcat\QQ\QQ.exe）
├── wrapper.node                 QQ native 模块
└── node.exe                     Node 运行时
```

## OneBot 配置

`config\onebot11.json`：

```json
{
  "network": {
    "websocketClients": [{
      "name": "qq-netizen",
      "enable": true,
      "url": "ws://127.0.0.1:8080/onebot/v11/ws",
      "messagePostFormat": "array",
      "reconnectInterval": 5000,
      "token": "<与机器人 .env 的 ONEBOT_ACCESS_TOKEN 一致>",
      "heartInterval": 30000
    }]
  }
}
```

NapCat 是反向 WS 客户端，主动连机器人的 8080，与 Lagrange 的 reverse-websocket 行为一致，机器人代码无需改动。

## 启动

双击 `napcat\napcat\launcher-napcat-qq.bat`（首次会弹 QQ 登录窗口扫码）。

## 为什么换掉 Lagrange

1. **ICMP 拦截**：Lagrange 登录时用 `GetOptimumServer` 做 ICMP Ping 探测，
   未签名 exe 被卡巴斯基拦（`Win32Exception(5) 拒绝访问`），改配置无效
   （`Connect()` 无条件调 `OptimumServer()`）。
2. **控制台依赖**：Lagrange 是 .NET 单文件应用，启动无条件读
   `Console.BufferWidth`，没有真实控制台就崩，ConPTY 也绕不过。

NapCat 两者都没有：不做 ICMP 探测，可静默运行。
---

## 更新：GPU 崩溃修复（error_code=18）

### 现象

NapCat 启动 QQ 后，QQ 崩在 GPU：

```
GPU process launch failed: error_code=18
FATAL: content\browser\gpu\gpu_data_manager_impl_private.cc:415 GPU process isn't usable. Goodbye.
```

### 根因

error_code=18 是 Electron 沙箱隔离导致无法调用系统 GPU API，
在无显卡 / 远程桌面 / 虚拟机环境常见。

### 修复

NapCatWinBootMain.exe 硬编码给 QQ 加 `--enable-logging`，没有 `--no-sandbox`。
用二进制 patch 把 `--enable-logging`（UTF-16，偏移 20848，16字符/32字节）
替换成 `--no-sandbox`（11字符/22字节，剩余填 null）。

patch 脚本：`napcat\napcat\patch-gpu-fix.bat`（幂等，改动前备份 .bak）

### 验证

patch 后 QQ 不再崩 GPU，进程存活。