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
        static string BaseDir;
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
            // NapCat Shell 模式会拉起 QQ.exe，同时 NapCat 的 node 也在跑
            foreach (string img in new[] { "QQ.exe", "QQEX.exe", "node.exe" })
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
                        if (o.IndexOf(img, StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            // node.exe 太泛了（机器人也是 node），这里只认 QQ 系
                            if (img.StartsWith("QQ")) return true;
                        }
                    }
                }
                catch { }
            }
            // 兜底：8080 有反向 WS 连接说明协议端在线
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
        /// publish 目录下的 qr-{uin}.png，直接读它比解析控制台可靠得多。
        /// </summary>
        public static string FindQrCode()
        {
            try
            {
                string publish = LagrangePublish;
                if (string.IsNullOrEmpty(publish))
                    publish = Path.Combine(BaseDir, @"lagrange\Lagrange.OneBot\bin\Release\net9.0\win-x64\publish");
                if (!Directory.Exists(publish)) return null;

                var files = Directory.GetFiles(publish, "qr-*.png");
                if (files.Length == 0) return null;

                // 取最新的一个，并且要求是近期生成的（旧码已失效）
                string newest = null;
                DateTime newestTime = DateTime.MinValue;
                foreach (string f in files)
                {
                    var t = File.GetLastWriteTime(f);
                    if (t > newestTime) { newestTime = t; newest = f; }
                }
                // 超过 5 分钟的二维码视为过期
                if ((DateTime.Now - newestTime).TotalMinutes > 5) return null;
                return newest;
            }
            catch { return null; }
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
        public static string StartLagrange()
        {
            // NapCat 版：启动 NapCat（hook QQ）
            string napDir = Path.Combine(BaseDir, "napcat");
            NapCatDir = napDir;
            if (!Directory.Exists(napDir)) return "找不到 NapCat 目录：" + napDir;

            string launcher = Path.Combine(napDir, @"napcat\launcher-user.bat");
            if (!File.Exists(launcher)) return "找不到 launcher-user.bat：" + launcher;

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
        private PictureBox _qrBox;
        private Label _qrHint;
        private string _lastQrPath;
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

            // ── 二维码显示区 ───────────────────────────────
            // Lagrange 登录前会把二维码写到 qr-*.png，这里直接读出来显示，
            // 你就不用去管那个弹出的控制台窗口了。
            var qrPanel = new Panel
            {
                Location = new Point(20, y + 118),
                Size = new Size(504, 290),
                BackColor = CardColor
            };
            Controls.Add(qrPanel);

            var qrTitle = new Label
            {
                Text = "登录二维码（协议端启动后自动出现）",
                ForeColor = MutedColor,
                Location = new Point(12, 8),
                Size = new Size(470, 20)
            };
            qrPanel.Controls.Add(qrTitle);

            _qrBox = new PictureBox
            {
                Location = new Point(140, 32),
                Size = new Size(220, 220),
                SizeMode = PictureBoxSizeMode.Zoom,
                BackColor = Color.FromArgb(51, 65, 85),
                BorderStyle = BorderStyle.None
            };
            qrPanel.Controls.Add(_qrBox);

            _qrHint = new Label
            {
                Text = "等待二维码…",
                ForeColor = MutedColor,
                TextAlign = ContentAlignment.MiddleCenter,
                Location = new Point(12, 258),
                Size = new Size(470, 20)
            };
            qrPanel.Controls.Add(_qrHint);

            _timer = new System.Windows.Forms.Timer { Interval = 3000 };
            _timer.Tick += (s, e) => { UpdateStatus(); UpdateQr(); };
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
                    SetStatus("已自动启动 · 双击任务栏图标可查看");
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

        private void StartAllAsync()
        {
            SetStatus("正在启动全部组件…");
            var t = new Thread(() =>
            {
                string[] msgs = new string[4];
                msgs[0] = Program.StartSign();
                Thread.Sleep(2000);
                msgs[1] = Program.StartLagrange();
                Thread.Sleep(2000);
                msgs[2] = Program.StartBot();
                Thread.Sleep(2000);
                msgs[3] = Program.StartTts();
                BeginInvoke((Action)(() =>
                {
                    SetStatus("已触发全部启动（签名/协议端/机器人/TTS）");
                    UpdateStatus();
                }));
            });
            t.IsBackground = true;
            t.Start();
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
        private void UpdateQr()
        {
            try
            {
                string qr = Program.FindQrCode();

                if (qr == null)
                {
                    // 没二维码：要么协议端没启动，要么已经登录成功
                    bool lagUp = Program.TestLagrange();
                    if (lagUp)
                    {
                        _qrHint.Text = "✅ 已登录（无需扫码）";
                        _qrHint.ForeColor = GreenColor;
                    }
                    else
                    {
                        _qrHint.Text = "等待二维码…（先启动协议端）";
                        _qrHint.ForeColor = MutedColor;
                    }
                    _qrBox.Image = null;
                    _lastQrPath = null;
                    return;
                }

                // 路径没变就不重复加载，避免闪烁
                if (qr == _lastQrPath && _qrBox.Image != null) return;

                // 释放旧图，避免句柄泄漏
                if (_qrBox.Image != null)
                {
                    var old = _qrBox.Image;
                    _qrBox.Image = null;
                    old.Dispose();
                }

                // 用 FileStream 读，避免 Image.FromFile 锁文件导致协议端写不进去
                Image raw;
                using (var fs = new FileStream(qr, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                using (var ms = new MemoryStream())
                {
                    fs.CopyTo(ms);
                    ms.Position = 0;
                    raw = Image.FromStream(ms);
                }

                // 关键：Lagrange 输出的 qr-*.png 只有 147x147，尺寸太小手机难扫。
                // 它是纯黑白二值图，用最近邻放大 6 倍（不插值、不模糊）就清晰可扫。
                int scale = Math.Max(1, 600 / Math.Max(raw.Width, raw.Height));
                var big = new Bitmap(raw.Width * scale, raw.Height * scale);
                using (var g = Graphics.FromImage(big))
                {
                    g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.NearestNeighbor;
                    g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.Half;
                    g.DrawImage(raw, 0, 0, big.Width, big.Height);
                }
                raw.Dispose();
                _qrBox.Image = big;

                _lastQrPath = qr;
                _qrHint.Text = "用手机 QQ 扫码登录（码 5 分钟内有效）";
                _qrHint.ForeColor = BlueColor;
            }
            catch
            {
                _qrHint.Text = "二维码读取失败，稍后重试";
                _qrHint.ForeColor = RedColor;
            }
        }
    }
}
