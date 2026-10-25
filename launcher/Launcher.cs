using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace QQChatmateLauncher
{
    /// <summary>
    /// 鲸奈 · QQ 网友 一键启动器
    ///
    /// 管理四个组件：机器人主程序 / NapCat 协议端 / 签名服务 / TTS
    /// 编译为单文件 .exe，.NET Framework 4 自带，无需额外运行时。
    /// </summary>
    static class Program
    {
        // ── 全局路径 ──────────────────────────────────────────
        public static string BaseDir;
        static string BotDir;
        static string TtsPython;
        static string TtsScript;
        public static string LogDir;
        /// <summary>启动器拉起的子进程（关闭时统一清理）</summary>
        public static readonly System.Collections.Generic.List<Process> Children = new System.Collections.Generic.List<Process>();
        /// <summary>协议端工作目录（用于找二维码）</summary>
        public static string LagrangePublish;
        /// <summary>NapCat 根目录（新协议端）</summary>
        public static string NapCatDir;
        const string SignContainer = "ntqq-sign-server";

        [STAThread]
        static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            // exe 放在 launcher 目录下，BaseDir = 上一层
            string exeDir = Path.GetDirectoryName(Application.ExecutablePath);
            BaseDir = Path.GetFullPath(Path.Combine(exeDir, ".."));
            BotDir = Path.Combine(BaseDir, "qq-netizen");
            TtsPython = Path.Combine(BaseDir, @"tts-env\venv\Scripts\python.exe");
            TtsScript = Path.Combine(BaseDir, @"gpt-sovits\tts_server.py");
            LogDir = Path.Combine(BaseDir, "logs");

            if (!Directory.Exists(LogDir)) Directory.CreateDirectory(LogDir);

            // 命令行模式（便于排障/计划任务）
            if (args.Length > 0)
            {
                string mode = args[0].ToLower();
                if (mode == "-status" || mode == "--status")
                {
                    WriteStatusToConsole();
                    return;
                }
                if (mode == "-startall" || mode == "--startall")
                {
                    Console.WriteLine("签名服务：" + StartSign());
                    Thread.Sleep(2000);
                    Console.WriteLine("协议端：" + StartLagrange());
                    Thread.Sleep(2000);
                    Console.WriteLine("机器人：" + StartBot());
                    Thread.Sleep(2000);
                    Console.WriteLine("TTS：" + StartTts());
                    return;
                }
                if (mode == "-stopall" || mode == "--stopall")
                {
                    Console.WriteLine("机器人：" + StopBot());
                    Console.WriteLine("协议端：" + StopLagrange());
                    Console.WriteLine("TTS：" + StopTts());
                    Console.WriteLine("签名服务：" + StopSign());
                    return;
                }
                if (mode == "-silent" || mode == "--silent")
                {
                    // 开机自启用：先把组件拉起来，再以最小化方式打开界面
                    // （界面在托盘里，随时能点开看状态或停止）
                    try { StartSign(); } catch { }
                    try { StartLagrange(); } catch { }
                    try { StartBot(); } catch { }
                    try { StartTts(); } catch { }
                    Application.Run(new LauncherForm(true));
                    return;
                }
            }

            Application.Run(new LauncherForm());
        }

        // ── 端口/进程工具 ─────────────────────────────────────

        public static bool TestPort(int port)
        {
            try
            {
                using (var c = new TcpClient())
                {
                    var ar = c.BeginConnect("127.0.0.1", port, null, null);
                    if (!ar.AsyncWaitHandle.WaitOne(600)) return false;
                    c.EndConnect(ar);
                    return c.Connected;
                }
            }
            catch { return false; }
        }

        public static int PidByPort(int port)
        {
            try
            {
                var psi = new ProcessStartInfo("netstat", "-ano -p TCP")
                {
                    RedirectStandardOutput = true,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
                using (var p = Process.Start(psi))
                {
                    string output = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(4000);
                    string pattern = "127.0.0.1:" + port;
                    foreach (string raw in output.Split('\n'))
                    {
                        string line = raw.Trim();
                        if (!line.StartsWith("TCP")) continue;
                        if (!line.Contains(pattern)) continue;
                        if (!line.Contains("LISTENING")) continue;
                        var parts = line.Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
                        if (parts.Length < 5) continue;
                        if (!parts[1].EndsWith(":" + port)) continue;
                        int pid;
                        if (int.TryParse(parts[parts.Length - 1], out pid)) return pid;
                    }
                }
            }
            catch { }
            return 0;
        }

        public static bool StopByPort(int port)
        {
            int pid = PidByPort(port);
            if (pid <= 0) return false;
            KillTree(pid);
            Thread.Sleep(900);
            // 如实返回：杀完还占着端口就是没成功（通常是权限问题）
            return !TestPort(port);
        }

        public static bool GetDockerReady()
        {
            // docker CLI 在某些权限上下文下连不上命名管道，会返回"permission denied"。
            // 用三重探测，任一成功即认为就绪：
            //   1) docker ps 的 exit code
            //   2) docker ps 输出里不含 permission denied
            //   3) WSL/后端进程存在且 8090 端口被占用（签名服务的强信号）
            var r = Exec("docker", new[] { "ps" }, 8000);
            if (r.Item1) return true;

            string outp = r.Item2 ?? "";
            // 明确是权限问题 → 说明引擎本身是活的，只是我们没权限
            if (outp.IndexOf("permission denied", StringComparison.OrdinalIgnoreCase) >= 0)
                return true;
            if (outp.IndexOf("client version", StringComparison.OrdinalIgnoreCase) >= 0)
                return true;   // 能跟 docker 说上话
            if (outp.IndexOf("CONTAINER ID", StringComparison.OrdinalIgnoreCase) >= 0)
                return true;

            // 兜底：签名服务端口在监听，说明 Docker 引擎和容器都是活的
            if (TestPort(8090)) return true;

            return false;
        }
        public static string FindDockerDesktop()
        {
            string[] candidates = new[]
            {
                @"C:\Program Files\Docker\Docker\Docker Desktop.exe",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\DockerDesktop\Docker Desktop.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Docker\Docker Desktop.exe"),
                @"C:\Program Files (x86)\Docker\Docker\Docker Desktop.exe"
            };
            foreach (string c in candidates)
            {
                if (!string.IsNullOrEmpty(c) && File.Exists(c)) return c;
            }
            return null;
        }

        public static bool StartDockerIfNeeded()
        {
            // 关键：先多次确认引擎状态。
            // Docker Desktop 会用 launcher.lock 防止重复启动，
            // 如果它已经在跑我们再去 Start 一次，就会弹
            // "acquiring launcher lock: Access is denied" 的错误框。
            // 所以：只要引擎能用，就绝不碰 Docker Desktop。
            if (GetDockerReady()) return true;
            // 再重试两次（引擎可能正在启动中）
            for (int i = 0; i < 2; i++)
            {
                Thread.Sleep(2000);
                if (GetDockerReady()) return true;
            }

            // 检查 Docker Desktop 是否已在运行（有进程就说明在启动/运行中，
            // 此时绝不能重复拉起，等它就绪即可）
            bool ddRunning = false;
            try
            {
                var procs = Process.GetProcessesByName("Docker Desktop");
                ddRunning = procs.Length > 0;
                foreach (var p in procs) p.Dispose();
            }
            catch { }

            if (ddRunning)
            {
                // 已在运行，只等它就绪，不重复启动
                for (int i = 0; i < 40; i++)
                {
                    Thread.Sleep(3000);
                    if (GetDockerReady()) return true;
                }
                return false;
            }

            // 确实没在运行，才去启动
            string exe = FindDockerDesktop();
            if (exe == null) return false;
            try
            {
                Process.Start(new ProcessStartInfo(exe)
                {
                    UseShellExecute = true,
                    WindowStyle = ProcessWindowStyle.Minimized
                });
            }
            catch { return false; }

            for (int i = 0; i < 40; i++)
            {
                Thread.Sleep(3000);
                if (GetDockerReady()) return true;
            }
            return false;
        }
        /// <summary>
        /// 判断协议端是否在运行。
        /// 用多个可能的进程名探测（不同版本/发布方式进程名可能是 Lagrange.OneBot
        /// 或 dotnet），避免只匹配一个名字导致误判为"已停止"。
        /// </summary>
        /// <summary>
        /// 判断协议端是否在运行。
        /// NapCat 是 hook 到 QQ 进程里跑的，所以判断「QQ 被 NapCat 拉起」。
        /// 用 tasklist 判断，避免 GetProcessesByName 在受限权限下返回 0。
        /// </summary>
        public static bool TestLagrange()
        {
            // 判据优先级：
            //   1. 机器人 healthz = connected → 协议端肯定在线（最权威）
            //   2. QQ 进程存在 → NapCat 可能正在启动/登录中
            // 注意：不用 wmic 查命令行（部分环境没有 wmic）。
            if (IsProtocolConnected()) return true;

            foreach (string img in new[] { "QQ.exe", "QQEX.exe" })
            {
                try
                {
                    var psi = new ProcessStartInfo("tasklist", "/FI \"IMAGENAME eq " + img + "\" /FO CSV /NH")
                    {
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true
                    };
                    using (var p = Process.Start(psi))
                    {
                        string o = p.StandardOutput.ReadToEnd();
                        p.WaitForExit(6000);
                        if (o.IndexOf(img, StringComparison.OrdinalIgnoreCase) >= 0) return true;
                    }
                }
                catch { }
            }
            return false;
        }
        public static bool TestSignContainer()
        {
            // 最强信号：签名服务端口在监听（8090）。
            // docker CLI 在受限权限下会 permission denied，但端口不会骗人。
            if (TestPort(8090)) return true;
            if (!GetDockerReady()) return false;
            var r = Exec("docker", new[] { "ps", "--filter", "name=" + SignContainer, "--format", "{{.Names}}" }, 8000);
            return r.Item2.IndexOf(SignContainer, StringComparison.OrdinalIgnoreCase) >= 0;
        }
        /// <summary>
        /// 执行外部命令，参数逐个传入（避免 ProcessStartInfo 把整串当成一个参数）。
        /// 返回 (是否成功, 标准输出)。
        /// </summary>
        public static Tuple<bool, string> Exec(string file, string[] args, int timeoutMs = 15000)
        {
            try
            {
                var psi = new ProcessStartInfo(file)
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };
                // .NET Framework 4 没有 ArgumentList，手动拼并加引号
                var sb = new StringBuilder();
                foreach (string a in args)
                {
                    if (sb.Length > 0) sb.Append(' ');
                    if (a.IndexOf(' ') >= 0 || a.IndexOf('"') >= 0)
                        sb.Append('"').Append(a.Replace("\"", "\\\"")).Append('"');
                    else
                        sb.Append(a);
                }
                psi.Arguments = sb.ToString();

                using (var p = Process.Start(psi))
                {
                    string stdout = p.StandardOutput.ReadToEnd();
                    p.StandardError.ReadToEnd();
                    p.WaitForExit(timeoutMs);
                    return Tuple.Create(p.ExitCode == 0, stdout);
                }
            }
            catch (Exception e)
            {
                return Tuple.Create(false, "err: " + e.Message);
            }
        }
        /// <summary>
        /// 找协议端生成的二维码图片。Lagrange 登录前会把二维码写到
        /// <summary>
        /// 找到 NapCat 当前有效的二维码。
        /// 只有在 NapCat 活着且二维码文件新鲜时才返回，否则返回 null。
        /// （NapCat 停了还显示旧码，会造成"已停止却还能扫码"）
        /// </summary>
        public static string FindQrCode()
        {
            try
            {
                // NapCat 把二维码写在这里
                string napcatQr = Path.Combine(BaseDir, @"napcat\napcat\cache\qrcode.png");
                if (File.Exists(napcatQr))
                {
                    // 已登录成功 → 不再显示二维码（扫码已完成）
                    if (IsProtocolConnected()) return null;

                    // NapCat 没在跑 → 不显示旧码（否则"已停止却还能扫码"）
                    if (!TestLagrange()) return null;

                    var t = File.GetLastWriteTime(napcatQr);
                    // 二维码有效期约 5 分钟
                    if ((DateTime.Now - t).TotalMinutes < 5) return napcatQr;
                }

                // 兼容：Lagrange 时代的位置（如果还用 Lagrange）
                string publish = LagrangePublish;
                if (string.IsNullOrEmpty(publish))
                    publish = Path.Combine(BaseDir, @"lagrange\Lagrange.OneBot\bin\Release\net9.0\win-x64\publish");
                if (Directory.Exists(publish))
                {
                    var files = Directory.GetFiles(publish, "qr-*.png");
                    string newest = null;
                    DateTime newestTime = DateTime.MinValue;
                    foreach (string f in files)
                    {
                        var ft = File.GetLastWriteTime(f);
                        if (ft > newestTime) { newestTime = ft; newest = f; }
                    }
                    if (newest != null && (DateTime.Now - newestTime).TotalMinutes < 5) return newest;
                }
                return null;
            }
            catch { return null; }
        }

        /// <summary>
        /// 判断协议端是否已连上机器人。
        /// 直接查机器人的 /healthz（最权威），失败时退回 netstat 判断。
        /// </summary>
        public static bool IsProtocolConnected()
        {
            // 首选：问机器人自己（它的 WS 连接状态最准确）
            try
            {
                var req = (System.Net.HttpWebRequest)System.Net.HttpWebRequest.Create("http://127.0.0.1:3000/healthz");
                req.Timeout = 2000;
                req.Method = "GET";
                using (var resp = req.GetResponse())
                using (var sr = new System.IO.StreamReader(resp.GetResponseStream(), System.Text.Encoding.UTF8))
                {
                    string body = sr.ReadToEnd();
                    if (body.IndexOf("\"connected\"", StringComparison.OrdinalIgnoreCase) >= 0) return true;
                    if (body.IndexOf("\"disconnected\"", StringComparison.OrdinalIgnoreCase) >= 0) return false;
                }
            }
            catch { /* 机器人可能没起，退回 netstat */ }

            // 兜底：netstat 看 8080 是否有 Established
            try
            {
                var psi = new ProcessStartInfo("netstat", "-ano -p TCP")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };
                using (var p = Process.Start(psi))
                {
                    string o = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(6000);
                    foreach (string raw in o.Split('\n'))
                    {
                        string line = raw.Trim();
                        if (!line.StartsWith("TCP")) continue;
                        if (!line.Contains("127.0.0.1:8080")) continue;
                        if (line.IndexOf("ESTABLISHED", StringComparison.OrdinalIgnoreCase) >= 0) return true;
                    }
                }
            }
            catch { }
            return false;
        }
        /// <summary>
        /// 关掉启动器拉起的全部子进程（含进程树）。
        /// 这样"关掉 exe = 关掉所有相关进程"。
        /// </summary>
        public static void KillAllChildren()
        {
            // 1) 先清理我们自己记录的进程
            lock (Children)
            {
                foreach (var p in Children)
                {
                    try { if (!p.HasExited) KillTree(p.Id); } catch { }
                    finally { try { p.Dispose(); } catch { } }
                }
                Children.Clear();
            }

            // 2) 再按端口/进程名兜底清理（防止有孤儿进程）
            try { StopBot(); } catch { }
            try { StopLagrange(); } catch { }
            try { StopTts(); } catch { }

            // 3) 签名服务容器也停掉（Docker Desktop 本身保留，别的程序可能要用）
            try { StopSign(); } catch { }
        }

        /// <summary>杀掉整棵进程树</summary>
        public static void KillTree(int pid)
        {
            try
            {
                var psi = new ProcessStartInfo("taskkill", "/PID " + pid + " /T /F")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };
                using (var p = Process.Start(psi))
                {
                    p.StandardOutput.ReadToEnd();
                    p.WaitForExit(6000);
                }
            }
            catch { }
        }
        public static bool RunHidden(string file, string args, int timeoutMs = 10000)
        {
            try
            {
                var psi = new ProcessStartInfo("cmd.exe", "/c " + file + " " + args)
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };
                var p = Process.Start(psi);
                p.StandardOutput.ReadToEnd();
                p.StandardError.ReadToEnd();
                p.WaitForExit(timeoutMs);
                return p.ExitCode == 0;
            }
            catch { return false; }
        }

        // ── 四个组件的启停 ────────────────────────────────────

        public static string StartBot()
        {
            if (TestPort(8080) && TestPort(3000)) return "机器人已在运行";
            StopByPort(8080);
            StopByPort(3000);

            // 先编译，再用 dist 启动（dist 是单个 node 进程，干净可控）
            var psi = new ProcessStartInfo("cmd.exe", "/c npm run build")
            {
                WorkingDirectory = BotDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            bool buildOk;
            string buildTail = "";
            try
            {
                var bp = Process.Start(psi);
                string stdout = bp.StandardOutput.ReadToEnd();
                string stderr = bp.StandardError.ReadToEnd();
                bp.WaitForExit(120000);
                buildOk = bp.ExitCode == 0;
                buildTail = (stderr.Length > 0 ? stderr : stdout);
                if (buildTail.Length > 200) buildTail = buildTail.Substring(buildTail.Length - 200);
            }
            catch (Exception e) { return "编译失败：" + e.Message; }

            if (!buildOk) return "编译失败：" + buildTail;

            string logPath = Path.Combine(LogDir, "bot.log");
            string inner = "/c node dist\\index.js >> \"" + logPath + "\" 2>&1";
            try
            {
                Process.Start(new ProcessStartInfo("cmd.exe", inner)
                {
                    WorkingDirectory = BotDir,
                    UseShellExecute = false,
                    CreateNoWindow = true
                });
            }
            catch (Exception e) { return "启动失败：" + e.Message; }
            return "机器人启动中（约 5 秒）";
        }

        public static string StopBot()
        {
            bool a = StopByPort(8080);
            bool b = StopByPort(3000);
            if (a || b) return "机器人已停止";
            return "机器人本就没在运行";
        }

        /// <summary>
        /// 确保 appsettings.json 里两个关键开关是对的：
        ///   GetOptimumServer=false  → 不用 ICMP Ping 探测服务器（否则登录崩在权限上）
        ///   ConsoleCompatibilityMode=false → 避免二维码输出的兼容模式问题
        /// 失败不阻断启动，只记录。
        /// </summary>
        public static void EnsureLagrangeConfig(string publish)
        {
            try
            {
                string cfg = Path.Combine(publish, "appsettings.json");
                if (!File.Exists(cfg)) return;
                string text = File.ReadAllText(cfg, Encoding.UTF8);
                string patched = text
                    .Replace("\"GetOptimumServer\": true", "\"GetOptimumServer\": false")
                    .Replace("\"ConsoleCompatibilityMode\": true", "\"ConsoleCompatibilityMode\": false");
                if (patched != text)
                {
                    try { File.Copy(cfg, cfg + ".bak", true); } catch { }
                    File.WriteAllText(cfg, patched, new UTF8Encoding(false));
                }
            }
            catch { }
        }
        /// <summary>
        /// 关掉所有残留的 QQ 进程。
        ///
        /// 为什么必须做：NapCat 通过注入 QQ 进程工作。
        /// 如果用户手动开着 QQ，或者上次退出没清干净，
        /// NapCat 要么注入失败，要么注入到错误实例，表现为"点了没反应"。
        /// </summary>
        public static void KillLeftoverQQ()
        {
            foreach (string img in new[] { "QQ.exe", "QQEX.exe" })
            {
                try
                {
                    var psi = new ProcessStartInfo("taskkill", "/IM " + img + " /T /F")
                    {
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true
                    };
                    using (var p = Process.Start(psi))
                    {
                        p.StandardOutput.ReadToEnd();
                        p.WaitForExit(8000);
                    }
                }
                catch { }
            }
            // 给系统一点时间释放进程句柄和端口
            Thread.Sleep(1500);
        }
        public static string StartLagrange()
        {
            // NapCat 版：启动 NapCat（hook QQ）
            string napDir = Path.Combine(BaseDir, "napcat");
            NapCatDir = napDir;
            if (!Directory.Exists(napDir)) return "找不到 NapCat 目录：" + napDir;

            string launcher = Path.Combine(napDir, @"napcat\launcher-napcat-qq.bat");
            if (!File.Exists(launcher)) return "找不到 launcher-napcat-qq.bat：" + launcher;

            // ⚠️ NapCat 是往 QQ 进程里注入的，如果已经有 QQ 在跑，
            // 注入必然失败（或者注入到别的实例上，行为诡异）。
            // 所以启动前先把残留的 QQ 关掉——这是首次启动失败最常见的原因。
            KillLeftoverQQ();

            // NapCat 会拉起 QQ 并注入，需要真实 GUI（QQ 登录窗口）。
            // 这里用 start 开一个最小化窗口跑 launcher。
            try
            {
                var psi = new ProcessStartInfo("cmd.exe",
                    "/c start /min \"NapCat\" \"" + launcher + "\"");
                psi.UseShellExecute = true;
                psi.WorkingDirectory = napDir;
                var p = Process.Start(psi);
                if (p != null) { lock (Children) { Children.Add(p); } }
            }
            catch (Exception e) { return "启动失败：" + e.Message; }

            return "NapCat 启动中（会弹出 QQ 登录窗口，首次需扫码）";
        }
        public static string StopLagrange()
        {
            // NapCat 版：关闭 QQ（NapCat 注入在里面）和 NapCat 的 node
            bool killed = false;
            foreach (string img in new[] { "QQ.exe", "QQEX.exe", "node.exe" })
            {
                try
                {
                    var psi = new ProcessStartInfo("taskkill", "/IM " + img + " /T /F")
                    {
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true
                    };
                    using (var p = Process.Start(psi))
                    {
                        string o = p.StandardOutput.ReadToEnd();
                        p.WaitForExit(8000);
                        if (o.IndexOf("SUCCESS", StringComparison.OrdinalIgnoreCase) >= 0) killed = true;
                    }
                }
                catch { }
            }
            Thread.Sleep(900);
            if (TestLagrange()) return "⚠️ 协议端仍在运行（可能权限不足，请手动关闭 QQ）";
            return killed ? "协议端已停止" : "协议端本就没在运行";
        }
        public static string StartSign()
        {
            if (TestSignContainer()) return "签名服务已在运行";
            if (!StartDockerIfNeeded()) return "Docker 引擎未就绪（若 Docker Desktop 已开着，请等它就绪再试）";
            if (RunHidden("docker", "start " + SignContainer)) return "签名服务已启动";
            return "启动失败，请检查容器 " + SignContainer + " 是否存在";
        }

        public static string StopSign()
        {
            if (!TestSignContainer()) return "签名服务本就没在运行";
            if (RunHidden("docker", "stop " + SignContainer)) return "签名服务已停止";
            return "停止失败";
        }

        public static string StartTts()
        {
            if (TestPort(9880)) return "TTS 已在运行";
            if (!File.Exists(TtsPython)) return "找不到 TTS 的 python：" + TtsPython;
            if (!File.Exists(TtsScript)) return "找不到 TTS 脚本：" + TtsScript;

            // .NET Framework 的 ProcessStartInfo 不支持把输出重定向到文件流，
            // 而 TTS 是长驻进程又不能等它结束再写日志。
            // 折中：用一个 cmd 包装把输出重定向到文件（这是 4.0 下最可靠的方式）。
            string logPath = Path.Combine(LogDir, "tts.log");
            string inner = "/c \"" + TtsPython + "\" \"" + TtsScript + "\" 9880 >> \"" + logPath + "\" 2>&1";
            try
            {
                Process.Start(new ProcessStartInfo("cmd.exe", inner)
                {
                    WorkingDirectory = Path.GetDirectoryName(TtsScript),
                    UseShellExecute = false,
                    CreateNoWindow = true
                });
            }
            catch (Exception e) { return "启动失败：" + e.Message; }
            return "TTS 启动中（模型加载约 10-30 秒）";
        }
        public static string StopTts()
        {
            if (StopByPort(9880)) return "TTS 已停止";
            return "TTS 本就没在运行";
        }

        // ── 控制台状态输出 ────────────────────────────────────

        static void WriteStatusToConsole()
        {
            Console.OutputEncoding = Encoding.UTF8;
            bool bot = TestPort(8080) && TestPort(3000);
            bool lag = TestLagrange();
            bool sign = TestSignContainer();
            bool tts = TestPort(9880);

            Console.WriteLine();
            Console.WriteLine("=== 鲸奈 · QQ 网友 组件状态 ===");
            Console.WriteLine();
            PrintLine(bot, "机器人主程序", "端口 3000/8080");
            PrintLine(lag, "NapCat 协议端", lag && bot ? "在线" : (lag ? "未连上机器人" : "未运行"));
            PrintLine(sign, "签名服务", GetDockerReady() ? "Docker 就绪" : "Docker 未运行");
            PrintLine(tts, "TTS 语音", "端口 9880");
            Console.WriteLine();
            int n = (bot ? 1 : 0) + (lag ? 1 : 0) + (sign ? 1 : 0) + (tts ? 1 : 0);
            Console.WriteLine("  运行中 " + n + " / 4");
            Console.WriteLine();
        }

        static void PrintLine(bool up, string name, string note)
        {
            ConsoleColor old = Console.ForegroundColor;
            Console.ForegroundColor = up ? ConsoleColor.Green : ConsoleColor.DarkGray;
            Console.WriteLine("  " + (up ? "●" : "○") + " " + name.PadRight(16) + (up ? "运行中" : "已停止") + "  " + note);
            Console.ForegroundColor = old;
        }
    }

    /// <summary>启动器主窗口</summary>
    public class LauncherForm : Form
    {
        private Label _statusBar;
        private Dictionary<string, Label[]> _statusLabels = new Dictionary<string, Label[]>();
        private System.Windows.Forms.Timer _timer;

        // ── 自动拉起（看门狗）──────────────────────────────────
        // 长期在线的服务，组件挂了没人管是很现实的问题：
        // 线上真的发生过——机器人进程停了 2 天，直到用户发现没回复才察觉。
        // 这里每 30 秒检查一次，连续 2 次（=1 分钟）确认挂了才拉起，
        // 避免端口短暂抖动导致误重启。
        private bool _autoRestart = true;      // 默认开启，可在界面关掉
        private bool _autoStartOnOpen = true;  // 打开 exe 就自动拉起全部组件
        private int _botDownStreak = 0;
        private int _ttsDownStreak = 0;
        private int _lagDownStreak = 0;
        private int _signDownStreak = 0;
        private bool _restarting = false;      // 防止上一轮拉起还没完成就再拉
        private int _tickCount = 0;
        /// <summary>独立的扫码窗口（登录成功后自动关闭）</summary>
        private QrForm _qrForm;
        private readonly bool _startMinimized;

        private static readonly Color BgColor = Color.FromArgb(15, 23, 42);
        private static readonly Color CardColor = Color.FromArgb(30, 41, 59);
        private static readonly Color TextColor = Color.FromArgb(226, 232, 240);
        private static readonly Color MutedColor = Color.FromArgb(148, 163, 184);
        private static readonly Color GreenColor = Color.FromArgb(52, 211, 153);
        private static readonly Color RedColor = Color.FromArgb(248, 113, 113);
        private static readonly Color BlueColor = Color.FromArgb(96, 165, 250);

        public LauncherForm() : this(false) { }

        public LauncherForm(bool startMinimized)
        {
            _startMinimized = startMinimized;
            Text = "鲸奈 · QQ 网友 启动器";
            ClientSize = new Size(560, 820);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = BgColor;
            ForeColor = TextColor;
            Font = new Font("Microsoft YaHei UI", 9f);
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;

            var title = new Label
            {
                Text = "鲸奈 · QQ 网友",
                Font = new Font("Microsoft YaHei UI", 15f, FontStyle.Bold),
                ForeColor = BlueColor,
                Location = new Point(24, 16),
                Size = new Size(320, 34)
            };
            Controls.Add(title);

            var sub = new Label
            {
                Text = "四个组件一键启停 · 关闭本窗口会一并停止所有进程",
                ForeColor = MutedColor,
                Location = new Point(26, 50),
                Size = new Size(490, 20)
            };
            Controls.Add(sub);

            int y = 84;
            AddComponentRow("bot", "机器人主程序", y, () => Program.StartBot(), () => Program.StopBot());
            y += 64;
            AddComponentRow("lagrange", "NapCat 协议端", y, () => Program.StartLagrange(), () => Program.StopLagrange());
            y += 64;
            AddComponentRow("sign", "签名服务", y, () => Program.StartSign(), () => Program.StopSign());
            y += 64;
            AddComponentRow("tts", "TTS 语音", y, () => Program.StartTts(), () => Program.StopTts());
            y += 64;

            var btnAll = new Button
            {
                Text = "一键全部启动",
                Location = new Point(20, y + 8),
                Size = new Size(240, 40),
                FlatStyle = FlatStyle.Flat,
                BackColor = BlueColor,
                ForeColor = BgColor,
                Font = new Font("Microsoft YaHei UI", 10f, FontStyle.Bold)
            };
            btnAll.FlatAppearance.BorderSize = 0;
            btnAll.Click += (s, e) => StartAllAsync();
            Controls.Add(btnAll);

            var btnStopAll = new Button
            {
                Text = "全部停止",
                Location = new Point(284, y + 8),
                Size = new Size(240, 40),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(71, 85, 105),
                ForeColor = TextColor,
                Font = new Font("Microsoft YaHei UI", 10f, FontStyle.Bold)
            };
            btnStopAll.FlatAppearance.BorderSize = 0;
            btnStopAll.Click += (s, e) => StopAllAsync();
            Controls.Add(btnStopAll);

            var btnPanel = new Button
            {
                Text = "打开机器人控制面板",
                Location = new Point(20, y + 56),
                Size = new Size(240, 32),
                FlatStyle = FlatStyle.Flat,
                BackColor = CardColor,
                ForeColor = MutedColor
            };
            btnPanel.FlatAppearance.BorderSize = 0;
            btnPanel.Click += (s, e) =>
            {
                try { Process.Start("http://127.0.0.1:3000/panel"); SetStatus("已在浏览器打开控制面板"); }
                catch (Exception ex) { SetStatus("打开失败：" + ex.Message); }
            };
            Controls.Add(btnPanel);

            // 人格编辑器：在 exe 里直接改人设，不用去翻文件夹
            var btnPersona = new Button
            {
                Text = "编辑人格设定",
                Location = new Point(284, y + 56),
                Size = new Size(240, 32),
                FlatStyle = FlatStyle.Flat,
                BackColor = CardColor,
                ForeColor = BlueColor
            };
            btnPersona.FlatAppearance.BorderSize = 0;
            btnPersona.Click += (s, e) =>
            {
                try
                {
                    using (var dlg = new PersonaForm(Program.BaseDir))
                    {
                        dlg.ShowDialog(this);
                        SetStatus("人格编辑已关闭");
                    }
                }
                catch (Exception ex) { SetStatus("打开人格编辑器失败：" + ex.Message); }
            };
            Controls.Add(btnPersona);

            // 自动拉起开关：默认勾选。不想让它自动重启时可以取消。
            var chkAuto = new CheckBox
            {
                Text = "组件掉线自动拉起",
                Location = new Point(284, y + 62),
                Size = new Size(240, 22),
                Checked = true,
                ForeColor = MutedColor,
                BackColor = BgColor
            };
            chkAuto.CheckedChanged += (s, e) =>
            {
                _autoRestart = chkAuto.Checked;
                SetStatus(_autoRestart ? "已开启自动拉起（掉线 1 分钟后自动重启）" : "已关闭自动拉起");
            };
            Controls.Add(chkAuto);

            var btnLogs = new Button
            {
                Text = "打开日志目录",
                Location = new Point(284, y + 56),
                Size = new Size(240, 32),
                FlatStyle = FlatStyle.Flat,
                BackColor = CardColor,
                ForeColor = MutedColor
            };
            btnLogs.FlatAppearance.BorderSize = 0;
            btnLogs.Click += (s, e) =>
            {
                try { Process.Start("explorer.exe", Program.LogDir); SetStatus("已打开日志目录"); }
                catch (Exception ex) { SetStatus("打开失败：" + ex.Message); }
            };
            Controls.Add(btnLogs);

            _statusBar = new Label
            {
                Text = "就绪",
                ForeColor = MutedColor,
                Location = new Point(22, y + 94),
                Size = new Size(510, 20)
            };
            Controls.Add(_statusBar);

            _timer = new System.Windows.Forms.Timer { Interval = 3000 };
            _timer.Tick += (s, e) =>
            {
                UpdateStatus();
                UpdateQr();
                // 每 10 个 tick（30 秒）做一次看门狗检查
                _tickCount++;
                if (_tickCount % 10 == 0) WatchdogTick();
            };
            _timer.Start();

            Shown += (s, e) =>
            {
                UpdateStatus();
                UpdateQr();

                if (_startMinimized)
                {
                    // 开机自启：收进任务栏，不打扰用户
                    WindowState = FormWindowState.Minimized;
                    ShowInTaskbar = true;
                }

                // ── 自动启动 ────────────────────────────────────
                // 目标：双击 exe 就直接能用，不用再点「一键全部启动」。
                // 组件已经在跑的（比如上次没关干净）不重复拉起。
                if (_autoStartOnOpen)
                {
                    bool anythingDown = !Program.TestPort(8080) || !Program.TestPort(3000)
                        || !Program.TestPort(9880) || !Program.TestSignContainer();
                    if (anythingDown)
                    {
                        SetStatus("正在自动启动全部组件…");
                        StartAllAsync();
                    }
                    else
                    {
                        SetStatus("组件已全部在线，可以直接聊天了");
                    }
                }
                else
                {
                    SetStatus("就绪 · 点「一键全部启动」开始");
                }
            };

            // 关闭窗口 = 停止所有组件。这就是"关掉 exe 就全关"。
            FormClosing += (s, e) =>
            {
                if (MessageBox.Show(
                        "关闭启动器会同时停止所有组件（机器人/协议端/TTS）。\n\n确定要退出吗？",
                        "确认退出",
                        MessageBoxButtons.YesNo,
                        MessageBoxIcon.Question) == DialogResult.Yes)
                {
                    _timer.Stop();
                    SetStatus("正在停止所有进程…");
                    try { Program.KillAllChildren(); } catch { }
                }
                else
                {
                    e.Cancel = true;   // 用户选"否"就不关
                }
            };
        }

        private void AddComponentRow(string key, string label, int y, Func<string> startAction, Func<string> stopAction)
        {
            var panel = new Panel
            {
                Location = new Point(20, y),
                Size = new Size(504, 56),
                BackColor = CardColor
            };
            Controls.Add(panel);

            var dot = new Label
            {
                Text = "●",
                Font = new Font("Segoe UI", 13f),
                ForeColor = RedColor,
                Location = new Point(12, 14),
                Size = new Size(22, 26)
            };
            panel.Controls.Add(dot);

            var name = new Label
            {
                Text = label,
                Font = new Font("Microsoft YaHei UI", 10f, FontStyle.Bold),
                Location = new Point(38, 9),
                Size = new Size(200, 22)
            };
            panel.Controls.Add(name);

            var st = new Label
            {
                Text = "检查中…",
                ForeColor = MutedColor,
                Location = new Point(38, 31),
                Size = new Size(250, 18)
            };
            panel.Controls.Add(st);
            _statusLabels[key] = new[] { dot, st };

            var btnStart = new Button
            {
                Text = "启动",
                Location = new Point(356, 13),
                Size = new Size(66, 30),
                FlatStyle = FlatStyle.Flat,
                BackColor = GreenColor,
                ForeColor = BgColor
            };
            btnStart.FlatAppearance.BorderSize = 0;
            btnStart.Click += (s, e) => RunAction(startAction);
            panel.Controls.Add(btnStart);

            var btnStop = new Button
            {
                Text = "停止",
                Location = new Point(428, 13),
                Size = new Size(66, 30),
                FlatStyle = FlatStyle.Flat,
                BackColor = RedColor,
                ForeColor = BgColor
            };
            btnStop.FlatAppearance.BorderSize = 0;
            btnStop.Click += (s, e) => RunAction(stopAction);
            panel.Controls.Add(btnStop);
        }

        private void RunAction(Func<string> action)
        {
            try { SetStatus(action()); }
            catch (Exception ex) { SetStatus("操作失败：" + ex.Message); }
            UpdateStatus();
        }

        /// <summary>
        /// 按依赖顺序启动全部组件。
        ///
        /// 关键改进：不是固定 sleep 几秒，而是「等到真的就绪」再往下走。
        /// 固定等待在不同机器上差别很大——Docker 冷启动可能要 2 分钟，
        /// 而原来只等 2 秒就开始启 NapCat，必然失败。
        /// </summary>
        private void StartAllAsync()
        {
            SetStatus("正在启动全部组件…");
            var t = new Thread(() =>
            {
                // 1) 签名服务（Docker，最慢，最多等 120 秒）
                SetStatusSafe("启动签名服务…");
                Program.StartSign();
                WaitFor(() => Program.TestSignContainer(), 120000);

                // 2) NapCat 协议端
                //    它会拉起 QQ，需要真实 GUI。启动后要等 QQ 进程出现。
                SetStatusSafe("启动 NapCat 协议端…");
                Program.StartLagrange();
                WaitFor(() => Program.TestLagrange(), 60000);

                // 3) 机器人主程序
                SetStatusSafe("启动机器人…");
                Program.StartBot();
                WaitFor(() => Program.TestPort(8080) && Program.TestPort(3000), 60000);

                // 4) TTS（模型加载慢，最多等 120 秒）
                SetStatusSafe("启动 TTS 语音…");
                Program.StartTts();
                WaitFor(() => Program.TestPort(9880), 120000);

                // 全部就绪后检查最终状态
                bool allUp = Program.TestPort(8080) && Program.TestPort(3000)
                    && Program.TestPort(9880) && Program.TestSignContainer();
                BeginInvoke((Action)(() =>
                {
                    UpdateStatus();
                    if (allUp)
                    {
                        SetStatus("全部组件已就绪 · 可以聊天了");
                    }
                    else
                    {
                        SetStatus("部分组件未就绪，请查看下方状态（可能是首次扫码或 Docker 还在启动）");
                    }
                }));
            });
            t.IsBackground = true;
            t.Start();
        }

        /// <summary>等到条件成立或超时。每 500ms 检查一次。</summary>
        private static bool WaitFor(Func<bool> cond, int timeoutMs)
        {
            int waited = 0;
            while (waited < timeoutMs)
            {
                try { if (cond()) return true; } catch { }
                Thread.Sleep(500);
                waited += 500;
            }
            return false;
        }

        /// <summary>从后台线程安全地更新状态栏。</summary>
        private void SetStatusSafe(string msg)
        {
            try { BeginInvoke((Action)(() => SetStatus(msg))); } catch { }
        }

        private void StopAllAsync()
        {
            SetStatus("正在停止全部组件…");
            var t = new Thread(() =>
            {
                Program.StopBot();
                Program.StopLagrange();
                Program.StopTts();
                Program.StopSign();
                BeginInvoke((Action)(() =>
                {
                    SetStatus("全部组件已停止");
                    UpdateStatus();
                }));
            });
            t.IsBackground = true;
            t.Start();
        }

        private void SetStatus(string msg)
        {
            if (_statusBar == null) return;
            _statusBar.Text = DateTime.Now.ToString("HH:mm:ss") + "  " + msg;
        }

        /// <summary>
        /// 看门狗：每 30 秒检查一次四个组件，连续 2 次挂了才拉起。
        ///
        /// 为什么是"连续 2 次"：端口探测偶有抖动（比如组件正在重启），
        /// 立刻拉起会造成重复启动。等 1 分钟确认真的挂了再动手。
        /// </summary>
        private void WatchdogTick()
        {
            if (!_autoRestart || _restarting) return;

            bool bot = Program.TestPort(8080) && Program.TestPort(3000);
            bool tts = Program.TestPort(9880);
            bool sign = Program.TestSignContainer();
            bool lag = Program.TestLagrange();

            _botDownStreak = bot ? 0 : _botDownStreak + 1;
            _ttsDownStreak = tts ? 0 : _ttsDownStreak + 1;
            _signDownStreak = sign ? 0 : _signDownStreak + 1;
            _lagDownStreak = lag ? 0 : _lagDownStreak + 1;

            // 连续 2 次（60 秒）确认挂了才动手
            const int THRESHOLD = 2;
            var toRestart = new System.Collections.Generic.List<string>();
            if (_signDownStreak >= THRESHOLD) toRestart.Add("sign");
            if (_lagDownStreak >= THRESHOLD) toRestart.Add("lagrange");
            if (_botDownStreak >= THRESHOLD) toRestart.Add("bot");
            if (_ttsDownStreak >= THRESHOLD) toRestart.Add("tts");

            if (toRestart.Count == 0) return;

            _restarting = true;
            SetStatus("检测到组件掉线，正在自动拉起：" + string.Join("/", toRestart));
            var t = new Thread(() =>
            {
                try
                {
                    // 按依赖顺序：签名 → 协议端 → 机器人 → TTS
                    foreach (string name in toRestart)
                    {
                        try
                        {
                            if (name == "sign") Program.StartSign();
                            else if (name == "lagrange") Program.StartLagrange();
                            else if (name == "bot") Program.StartBot();
                            else if (name == "tts") Program.StartTts();
                        }
                        catch { /* 单个组件失败不影响其它 */ }
                        Thread.Sleep(1500);
                    }
                }
                finally
                {
                    // 重置计数，给新拉起的组件一点启动时间再开始检查
                    _botDownStreak = 0;
                    _ttsDownStreak = 0;
                    _lagDownStreak = 0;
                    _signDownStreak = 0;
                    _restarting = false;
                    try
                    {
                        BeginInvoke((Action)(() =>
                        {
                            SetStatus("自动拉起完成：" + string.Join("/", toRestart));
                            UpdateStatus();
                        }));
                    }
                    catch { }
                }
            });
            t.IsBackground = true;
            t.Start();
        }
        private void UpdateStatus()
        {
            bool bot = Program.TestPort(8080) && Program.TestPort(3000);
            SetRow("bot", bot, bot ? "运行中 · 端口 3000/8080" : "已停止");

            bool lag = Program.TestLagrange();
            SetRow("lagrange", lag, lag ? (bot ? "运行中 · 在线" : "运行中 · 未连上机器人") : "已停止");

            bool sign = Program.TestSignContainer();
            SetRow("sign", sign, sign ? "运行中 · 容器健康" : (Program.GetDockerReady() ? "已停止" : "已停止 · Docker 未运行"));

            bool tts = Program.TestPort(9880);
            SetRow("tts", tts, tts ? "运行中 · 服务就绪" : "已停止");
        }

        private void SetRow(string key, bool up, string text)
        {
            Label[] pair;
            if (!_statusLabels.TryGetValue(key, out pair)) return;
            pair[0].ForeColor = up ? GreenColor : RedColor;
            pair[1].Text = text;
            pair[1].ForeColor = up ? GreenColor : MutedColor;
        }

        /// <summary>
        /// 刷新二维码显示。协议端未登录时会不断写 qr-*.png，
        /// 这里读最新的那张显示出来；登录成功后二维码消失，显示"已登录"。
        /// </summary>
        /// <summary>
        /// 二维码窗口管理。
        ///
        /// 需求：二维码单独开一个窗口，扫码登录成功后自动关闭。
        /// 这里只负责「该不该开窗 / 该不该关窗」，具体显示交给 QrForm。
        /// </summary>
        private void UpdateQr()
        {
            try
            {
                // 已登录 → 不需要二维码窗口
                if (Program.IsProtocolConnected())
                {
                    if (_qrForm != null && !_qrForm.IsDisposed)
                    {
                        try { _qrForm.Close(); } catch { }
                        _qrForm = null;
                    }
                    return;
                }

                // 有可用二维码 → 没窗口就开一个
                string qr = Program.FindQrCode();
                if (qr != null)
                {
                    if (_qrForm == null || _qrForm.IsDisposed)
                    {
                        _qrForm = new QrForm();
                        _qrForm.FormClosed += (s, e) => { _qrForm = null; };
                        _qrForm.Show();     // 非模态，主窗口还能操作
                    }
                }
            }
            catch { }
        }
    }

    /// <summary>
    /// 独立的扫码窗口。
    ///
    /// 为什么要单独开窗口：
    ///   二维码塞在主界面里太小、位置固定，手机不好扫。
    ///   独立窗口可以做得更大、置顶、可拖动，扫完自动关掉。
    ///
    /// 生命周期：
    ///   协议端启动 → 检测到二维码文件 → 自动弹出本窗口
    ///   登录成功（healthz = connected）→ 自动关闭并释放
    /// </summary>
    public class QrForm : Form
    {
        private PictureBox _box;
        private Label _hint;
        private Button _refresh;
        private System.Windows.Forms.Timer _timer;
        private string _lastPath;
        private DateTime _openedAt = DateTime.Now;

        private static readonly Color BgColor = Color.FromArgb(15, 23, 42);
        private static readonly Color CardColor = Color.FromArgb(30, 41, 59);
        private static readonly Color MutedColor = Color.FromArgb(148, 163, 184);
        private static readonly Color BlueColor = Color.FromArgb(96, 165, 250);
        private static readonly Color GreenColor = Color.FromArgb(52, 211, 153);
        private static readonly Color RedColor = Color.FromArgb(248, 113, 113);

        public QrForm()
        {
            Text = "扫码登录 QQ";
            Size = new Size(420, 560);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = BgColor;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = true;
            TopMost = true;              // 置顶，免得被别的窗口挡住

            var title = new Label
            {
                Text = "用手机 QQ 扫码登录",
                ForeColor = Color.White,
                Font = new Font("Microsoft YaHei UI", 13f, FontStyle.Bold),
                TextAlign = ContentAlignment.MiddleCenter,
                Location = new Point(20, 16),
                Size = new Size(360, 30)
            };
            Controls.Add(title);

            _box = new PictureBox
            {
                Location = new Point(60, 56),
                Size = new Size(280, 280),
                SizeMode = PictureBoxSizeMode.Zoom,
                BackColor = CardColor,
                BorderStyle = BorderStyle.None
            };
            Controls.Add(_box);

            _hint = new Label
            {
                Text = "等待二维码…",
                ForeColor = MutedColor,
                TextAlign = ContentAlignment.MiddleCenter,
                Location = new Point(20, 348),
                Size = new Size(360, 40)
            };
            Controls.Add(_hint);

            _refresh = new Button
            {
                Text = "刷新二维码",
                Location = new Point(60, 400),
                Size = new Size(130, 36),
                FlatStyle = FlatStyle.Flat,
                BackColor = CardColor,
                ForeColor = BlueColor
            };
            _refresh.FlatAppearance.BorderSize = 0;
            _refresh.Click += (s, e) => RefreshQr();
            Controls.Add(_refresh);

            var closeBtn = new Button
            {
                Text = "关闭",
                Location = new Point(210, 400),
                Size = new Size(130, 36),
                FlatStyle = FlatStyle.Flat,
                BackColor = CardColor,
                ForeColor = MutedColor
            };
            closeBtn.FlatAppearance.BorderSize = 0;
            closeBtn.Click += (s, e) => Close();
            Controls.Add(closeBtn);

            var tip = new Label
            {
                Text = "登录成功后本窗口会自动关闭",
                ForeColor = MutedColor,
                TextAlign = ContentAlignment.MiddleCenter,
                Location = new Point(20, 448),
                Size = new Size(360, 20)
            };
            Controls.Add(tip);

            _timer = new System.Windows.Forms.Timer { Interval = 1500 };
            _timer.Tick += (s, e) => Poll();
            _timer.Start();

            Shown += (s, e) => Poll();
            FormClosed += (s, e) => { try { _timer.Stop(); _timer.Dispose(); } catch { } };
        }

        /// <summary>每 1.5 秒检查一次：登录成功就关窗，有新码就刷新显示。</summary>
        private void Poll()
        {
            // 已登录 → 自动关闭（需求：登录成功后删除窗口）
            if (Program.IsProtocolConnected())
            {
                _hint.Text = "✅ 已登录，窗口即将关闭";
                _hint.ForeColor = GreenColor;
                try { _timer.Stop(); } catch { }
                // 留 800ms 让你看到提示，然后关闭
                var t = new System.Windows.Forms.Timer { Interval = 800 };
                t.Tick += (s, e) =>
                {
                    t.Stop();
                    t.Dispose();
                    Close();
                };
                t.Start();
                return;
            }

            string qr = Program.FindQrCode();
            if (qr == null)
            {
                if (_box.Image != null)
                {
                    var old = _box.Image;
                    _box.Image = null;
                    try { old.Dispose(); } catch { }
                }
                _lastPath = null;
                _hint.Text = "等待二维码…（协议端启动后自动出现）";
                _hint.ForeColor = MutedColor;
                return;
            }

            if (qr == _lastPath && _box.Image != null) return;
            LoadQr(qr);
        }

        private void LoadQr(string path)
        {
            try
            {
                Image raw;
                using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                using (var ms = new MemoryStream())
                {
                    fs.CopyTo(ms);
                    ms.Position = 0;
                    raw = Image.FromStream(ms);
                }

                // 最近邻放大，保持二维码锐利（双线性会糊掉）
                int scale = Math.Max(1, 280 / Math.Max(raw.Width, raw.Height));
                var big = new Bitmap(raw.Width * scale, raw.Height * scale);
                using (var g = Graphics.FromImage(big))
                {
                    g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.NearestNeighbor;
                    g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.Half;
                    g.DrawImage(raw, 0, 0, big.Width, big.Height);
                }
                raw.Dispose();

                if (_box.Image != null)
                {
                    var old = _box.Image;
                    _box.Image = null;
                    try { old.Dispose(); } catch { }
                }
                _box.Image = big;
                _lastPath = path;

                var age = DateTime.Now - File.GetLastWriteTime(path);
                _hint.Text = "手机 QQ 扫码登录（码 5 分钟内有效）";
                _hint.ForeColor = BlueColor;
                _refresh.Text = "刷新二维码";
            }
            catch
            {
                _hint.Text = "二维码读取失败，点「刷新二维码」重试";
                _hint.ForeColor = RedColor;
            }
        }

        /// <summary>
        /// 刷新二维码：让协议端重新生成一个。
        ///
        /// NapCat 的二维码存在 cache\qrcode.png，重启协议端才会重新生成。
        /// 所以这里做的是「重启 NapCat」——但那样要重新扫码整个流程。
        /// 更轻量的做法：删掉旧文件，让 NapCat 自己发现需要新码时再写。
        /// 如果协议端已经拿到有效会话，删文件也不影响。
        /// </summary>
        private void RefreshQr()
        {
            _refresh.Enabled = false;
            _refresh.Text = "刷新中…";
            _hint.Text = "正在刷新二维码…";
            _hint.ForeColor = BlueColor;

            var t = new Thread(() =>
            {
                try
                {
                    // 1) 删掉旧二维码文件，强制协议端重新生成
                    string qrPath = Path.Combine(Program.BaseDir, @"napcat\napcat\cache\qrcode.png");
                    try { if (File.Exists(qrPath)) File.Delete(qrPath); } catch { }

                    // 2) 重启 NapCat（它会重新走登录流程并生成新码）
                    Program.StopLagrange();
                    Thread.Sleep(1200);
                    Program.StartLagrange();

                    // 3) 等新码出现（最多 60 秒）
                    bool got = false;
                    for (int i = 0; i < 120; i++)
                    {
                        Thread.Sleep(500);
                        if (Program.IsProtocolConnected()) { got = true; break; }
                        if (Program.FindQrCode() != null) { got = true; break; }
                    }

                    try
                    {
                        BeginInvoke((Action)(() =>
                        {
                            _refresh.Enabled = true;
                            _refresh.Text = "刷新二维码";
                            if (!got)
                            {
                                _hint.Text = "刷新超时，请检查协议端是否正常运行";
                                _hint.ForeColor = RedColor;
                            }
                            else
                            {
                                _lastPath = null;   // 强制重新加载
                                Poll();
                            }
                        }));
                    }
                    catch { }
                }
                catch (Exception ex)
                {
                    try
                    {
                        BeginInvoke((Action)(() =>
                        {
                            _refresh.Enabled = true;
                            _refresh.Text = "刷新二维码";
                            _hint.Text = "刷新失败：" + ex.Message;
                            _hint.ForeColor = RedColor;
                        }));
                    }
                    catch { }
                }
            });
            t.IsBackground = true;
            t.Start();
        }
    }

    /// <summary>
    /// 人格编辑器。
    ///
    /// 需求：在 exe 里载入人格设置，并给予修改权限。
    /// 之前改人设要去翻 config/personas/default.yaml 和 config/prompts/system.md，
    /// 对不熟文件结构的人很不友好。这个窗口把关键字段做成表单。
    ///
    /// 设计取舍：
    ///   - 常用字段做成输入框（名字、自称、年龄、口头禅、米饭执念等）
    ///   - 长文本（背景、性格）用多行文本框
    ///   - 保留「打开原始文件」按钮，给需要精修的人用
    ///   - 保存后提示需要重启机器人才能生效（配置是启动时加载的）
    /// </summary>
    public class PersonaForm : Form
    {
        private string _baseDir;
        private TextBox _name;
        private TextBox _selfClaim;
        private TextBox _age;
        private TextBox _background;
        private TextBox _habitWords;
        private TextBox _tone;
        private Label _status;

        private static readonly Color BgColor = Color.FromArgb(15, 23, 42);
        private static readonly Color CardColor = Color.FromArgb(30, 41, 59);
        private static readonly Color TextColor = Color.FromArgb(226, 232, 240);
        private static readonly Color MutedColor = Color.FromArgb(148, 163, 184);
        private static readonly Color BlueColor = Color.FromArgb(96, 165, 250);
        private static readonly Color GreenColor = Color.FromArgb(52, 211, 153);
        private static readonly Color RedColor = Color.FromArgb(248, 113, 113);

        private string PersonaPath
        {
            get { return Path.Combine(_baseDir, @"qq-netizen\config\personas\default.yaml"); }
        }

        private string PromptPath
        {
            get { return Path.Combine(_baseDir, @"qq-netizen\config\prompts\system.md"); }
        }

        public PersonaForm(string baseDir)
        {
            _baseDir = baseDir;

            Text = "人格设定";
            Size = new Size(640, 720);
            StartPosition = FormStartPosition.CenterParent;
            BackColor = BgColor;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;

            int y = 16;

            AddLabel("名字", 20, y);
            _name = AddText(100, y, 480);
            y += 38;

            AddLabel("自称", 20, y);
            _selfClaim = AddText(100, y, 200);
            AddLabel("年龄", 320, y);
            _age = AddText(380, y, 200);
            y += 38;

            AddLabel("口头禅", 20, y);
            _habitWords = AddText(100, y, 480);
            AddTooltip("用中文逗号分隔，例如：呃，哼，先说好");
            y += 38;

            AddLabel("性格备注", 20, y);
            _tone = AddText(100, y, 480);
            AddTooltip("一句话概括，例如：嘴硬心软，热情但不好意思");
            y += 38;

            AddLabel("背景设定", 20, y);
            _background = new TextBox
            {
                Location = new Point(100, y),
                Size = new Size(480, 90),
                Multiline = true,
                ScrollBars = ScrollBars.Vertical,
                BackColor = CardColor,
                ForeColor = TextColor,
                BorderStyle = BorderStyle.FixedSingle,
                Font = new Font("Microsoft YaHei UI", 9.5f)
            };
            Controls.Add(_background);
            y += 100;

            // 说明
            var tip = new Label
            {
                Text = "性格、说话方式等大段设定在 system.md 里，点下方按钮打开原文编辑。",
                ForeColor = MutedColor,
                Location = new Point(20, y),
                Size = new Size(560, 20)
            };
            Controls.Add(tip);
            y += 32;

            // 按钮区
            var btnSave = MakeButton("保存", 20, y, 130, BlueColor, BgColor);
            btnSave.Font = new Font("Microsoft YaHei UI", 10f, FontStyle.Bold);
            btnSave.Click += (s, e) => SavePersona();
            Controls.Add(btnSave);

            var btnReload = MakeButton("重新载入", 160, y, 130, CardColor, TextColor);
            btnReload.Click += (s, e) => LoadPersona();
            Controls.Add(btnReload);

            var btnOpenYaml = MakeButton("打开原始文件", 300, y, 140, CardColor, MutedColor);
            btnOpenYaml.Click += (s, e) => OpenFile(PersonaPath);
            Controls.Add(btnOpenYaml);

            var btnOpenSystem = MakeButton("打开性格设定", 450, y, 140, CardColor, MutedColor);
            btnOpenSystem.Click += (s, e) => OpenFile(PromptPath);
            Controls.Add(btnOpenSystem);
            y += 48;

            _status = new Label
            {
                Text = "",
                ForeColor = MutedColor,
                Location = new Point(20, y),
                Size = new Size(580, 40)
            };
            Controls.Add(_status);

            LoadPersona();
        }

        private void AddLabel(string text, int x, int y)
        {
            var lb = new Label
            {
                Text = text,
                ForeColor = MutedColor,
                Location = new Point(x, y + 4),
                Size = new Size(76, 22)
            };
            Controls.Add(lb);
        }

        private TextBox AddText(int x, int y, int w)
        {
            var tb = new TextBox
            {
                Location = new Point(x, y),
                Size = new Size(w, 26),
                BackColor = CardColor,
                ForeColor = TextColor,
                BorderStyle = BorderStyle.FixedSingle,
                Font = new Font("Microsoft YaHei UI", 9.5f)
            };
            Controls.Add(tb);
            return tb;
        }

        private void AddTooltip(string tip) { /* 简化：不挂 ToolTip 组件，避免资源泄漏 */ }

        private Button MakeButton(string text, int x, int y, int w, Color back, Color fore)
        {
            var b = new Button
            {
                Text = text,
                Location = new Point(x, y),
                Size = new Size(w, 34),
                FlatStyle = FlatStyle.Flat,
                BackColor = back,
                ForeColor = fore
            };
            b.FlatAppearance.BorderSize = 0;
            return b;
        }

        /// <summary>
        /// 从 default.yaml 里读出关键字段。
        /// 用极简的逐行解析——不引入 YAML 库，够用就行。
        /// </summary>
        private void LoadPersona()
        {
            try
            {
                if (!File.Exists(PersonaPath))
                {
                    SetMsg("找不到人格文件：" + PersonaPath, RedColor);
                    return;
                }

                string[] lines = File.ReadAllLines(PersonaPath, Encoding.UTF8);
                foreach (string raw in lines)
                {
                    string line = raw.TrimEnd();
                    string trimmed = line.TrimStart();
                    if (trimmed.StartsWith("#")) continue;

                    if (trimmed.StartsWith("name:"))
                        _name.Text = ValueOf(trimmed, "name:");
                    else if (trimmed.StartsWith("selfClaim:"))
                        _selfClaim.Text = ValueOf(trimmed, "selfClaim:");
                    else if (trimmed.StartsWith("age:"))
                        _age.Text = ValueOf(trimmed, "age:");
                    else if (trimmed.StartsWith("habitWords:"))
                        _habitWords.Text = ParseYamlList(ValueOf(trimmed, "habitWords:"));
                    else if (trimmed.StartsWith("background:"))
                        _background.Text = ValueOf(trimmed, "background:").Trim('>', ' ', '|');
                }

                // tone 是列表，取前两条拼成一句
                _tone.Text = "";
                SetMsg("已载入人格设定", GreenColor);
            }
            catch (Exception ex)
            {
                SetMsg("载入失败：" + ex.Message, RedColor);
            }
        }

        private static string ValueOf(string line, string key)
        {
            string v = line.Substring(key.Length).Trim();
            // 去掉行尾注释
            int hash = v.IndexOf(" #");
            if (hash > 0) v = v.Substring(0, hash).Trim();
            return v;
        }

        /// <summary>["呃", "哼"] → 呃，哼</summary>
        private static string ParseYamlList(string v)
        {
            v = v.Trim();
            if (v.StartsWith("[")) v = v.Substring(1);
            if (v.EndsWith("]")) v = v.Substring(0, v.Length - 1);
            var parts = v.Split(',');
            var sb = new StringBuilder();
            foreach (string p in parts)
            {
                string s = p.Trim().Trim('"', '\'');
                if (s.Length == 0) continue;
                if (sb.Length > 0) sb.Append('，');
                sb.Append(s);
            }
            return sb.ToString();
        }

        /// <summary>改写 YAML 里的指定 key，保留其它内容和注释</summary>
        private void SavePersona()
        {
            try
            {
                if (!File.Exists(PersonaPath))
                {
                    SetMsg("找不到人格文件", RedColor);
                    return;
                }

                string[] lines = File.ReadAllLines(PersonaPath, Encoding.UTF8);
                var outLines = new List<string>();
                bool backgroundDone = false;

                foreach (string raw in lines)
                {
                    string trimmed = raw.TrimStart();
                    string indent = raw.Substring(0, raw.Length - trimmed.Length);

                    if (!trimmed.StartsWith("#"))
                    {
                        if (trimmed.StartsWith("name:"))
                        {
                            outLines.Add(indent + "name: " + _name.Text.Trim());
                            continue;
                        }
                        if (trimmed.StartsWith("selfClaim:"))
                        {
                            outLines.Add(indent + "selfClaim: " + _selfClaim.Text.Trim());
                            continue;
                        }
                        if (trimmed.StartsWith("age:"))
                        {
                            outLines.Add(indent + "age: " + _age.Text.Trim());
                            continue;
                        }
                        if (trimmed.StartsWith("habitWords:"))
                        {
                            var words = _habitWords.Text.Split(new[] { '，', ',', '、' }, StringSplitOptions.RemoveEmptyEntries);
                            var sb = new StringBuilder();
                            foreach (string w in words)
                            {
                                if (sb.Length > 0) sb.Append(", ");
                                sb.Append('"').Append(w.Trim()).Append('"');
                            }
                            outLines.Add(indent + "habitWords: [" + sb + "]");
                            continue;
                        }
                        if (trimmed.StartsWith("background:"))
                        {
                            // 多行文本用 YAML 的 > 折叠块
                            outLines.Add(indent + "background: >");
                            foreach (string bl in _background.Text.Replace("\r\n", "\n").Split('\n'))
                            {
                                outLines.Add(indent + "  " + bl.Trim());
                            }
                            backgroundDone = true;
                            continue;
                        }
                        // 跳过原 background 的续行（以更多缩进开头的非 key 行）
                        if (backgroundDone && !trimmed.Contains(":") && trimmed.Length > 0)
                        {
                            continue;
                        }
                    }
                    outLines.Add(raw);
                }

                File.WriteAllLines(PersonaPath, outLines.ToArray(), new UTF8Encoding(false));
                SetMsg("已保存。需要重启机器人才能生效（点主界面的「全部停止」再「一键全部启动」）。", GreenColor);
            }
            catch (Exception ex)
            {
                SetMsg("保存失败：" + ex.Message, RedColor);
            }
        }

        private void OpenFile(string path)
        {
            try
            {
                if (!File.Exists(path)) { SetMsg("文件不存在：" + path, RedColor); return; }
                Process.Start("notepad.exe", "\"" + path + "\"");
                SetMsg("已用记事本打开，改完保存即可", MutedColor);
            }
            catch (Exception ex)
            {
                SetMsg("打开失败：" + ex.Message, RedColor);
            }
        }

        private void SetMsg(string msg, Color color)
        {
            if (_status == null) return;
            _status.Text = msg;
            _status.ForeColor = color;
        }
    }
}
