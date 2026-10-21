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
    /// 管理四个组件：机器人主程序 / Lagrange 协议端 / 签名服务 / TTS
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
            try
            {
                var psi = new ProcessStartInfo("taskkill", "/PID " + pid + " /T /F")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };
                var p = Process.Start(psi);
                p.WaitForExit(5000);
            }
            catch { }
            Thread.Sleep(700);
            return !TestPort(port);
        }

        public static bool GetDockerReady()
        {
            var r = Exec("docker", new[] { "ps" }, 8000);
            return r.Item1;
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
            if (GetDockerReady()) return true;
            string exe = FindDockerDesktop();
            if (exe == null) return false;
            try
            {
                Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true, WindowStyle = ProcessWindowStyle.Minimized });
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
        public static bool TestLagrange()
        {
            string[] names = { "Lagrange.OneBot", "Lagrange.OneBot" };
            foreach (string n in names)
            {
                try
                {
                    var arr = Process.GetProcessesByName(n);
                    bool any = arr.Length > 0;
                    foreach (var p in arr) p.Dispose();
                    if (any) return true;
                }
                catch { }
            }
            // 兜底：用 tasklist 查（不受 .NET 权限枚举限制）
            try
            {
                var psi = new ProcessStartInfo("tasklist", "/FI \"IMAGENAME eq Lagrange.OneBot.exe\" /FO CSV /NH")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true
                };
                using (var p = Process.Start(psi))
                {
                    string o = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(5000);
                    return o.IndexOf("Lagrange.OneBot.exe", StringComparison.OrdinalIgnoreCase) >= 0;
                }
            }
            catch { return false; }
        }

        public static bool TestSignContainer()
        {
            if (!GetDockerReady()) return false;
            var r = Exec("docker", new[] { "ps", "--filter", "name=" + SignContainer, "--format", "{{.Names}}" }, 8000);
            return r.Item2.Contains(SignContainer);
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

        public static string StartLagrange()
        {
            if (TestLagrange()) return "协议端已在运行";
            string publish = Path.Combine(BaseDir, @"lagrange\Lagrange.OneBot\bin\Release\net9.0\win-x64\publish");
            string exe = Path.Combine(publish, "Lagrange.OneBot.exe");
            if (!File.Exists(exe)) return "找不到协议端：" + exe;

            // 必须用 cmd 起（给它真实控制台），否则 Console.get_BufferWidth 会崩
            string bundleDir = Path.Combine(BaseDir, @"lagrange\dotnet-tmp");
            if (!Directory.Exists(bundleDir)) Directory.CreateDirectory(bundleDir);
            string inner = "/c set DOTNET_BUNDLE_EXTRACT_BASE_DIR=" + bundleDir + " && \"" + exe + "\"";
            try
            {
                Process.Start(new ProcessStartInfo("cmd.exe", inner)
                {
                    WorkingDirectory = publish,
                    UseShellExecute = true,
                    WindowStyle = ProcessWindowStyle.Normal
                });
            }
            catch (Exception e) { return "启动失败：" + e.Message; }
            return "协议端启动中（首次需在弹出窗口扫码）";
        }

        public static string StopLagrange()
        {
            var arr = Process.GetProcessesByName("Lagrange.OneBot");
            if (arr.Length == 0) return "协议端本就没在运行";

            foreach (var p in arr)
            {
                try
                {
                    var psi = new ProcessStartInfo("taskkill", "/PID " + p.Id + " /T /F")
                    {
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true
                    };
                    var k = Process.Start(psi);
                    k.StandardOutput.ReadToEnd();
                    k.WaitForExit(5000);
                }
                catch { }
                finally { p.Dispose(); }
            }
            Thread.Sleep(800);

            var still = Process.GetProcessesByName("Lagrange.OneBot");
            if (still.Length > 0)
            {
                foreach (var p in still)
                {
                    try { p.Kill(); } catch { }
                    finally { p.Dispose(); }
                }
                Thread.Sleep(800);
            }

            var final = Process.GetProcessesByName("Lagrange.OneBot");
            bool alive = final.Length > 0;
            foreach (var p in final) p.Dispose();
            if (alive) return "⚠️ 协议端仍在运行（可能权限不足，请手动结束）";
            return "协议端已停止";
        }

        public static string StartSign()
        {
            if (TestSignContainer()) return "签名服务已在运行";
            if (!StartDockerIfNeeded()) return "Docker 未就绪，请先手动启动 Docker Desktop";
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
            PrintLine(lag, "Lagrange 协议端", lag && bot ? "在线" : (lag ? "未连上机器人" : "未运行"));
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

        private static readonly Color BgColor = Color.FromArgb(15, 23, 42);
        private static readonly Color CardColor = Color.FromArgb(30, 41, 59);
        private static readonly Color TextColor = Color.FromArgb(226, 232, 240);
        private static readonly Color MutedColor = Color.FromArgb(148, 163, 184);
        private static readonly Color GreenColor = Color.FromArgb(52, 211, 153);
        private static readonly Color RedColor = Color.FromArgb(248, 113, 113);
        private static readonly Color BlueColor = Color.FromArgb(96, 165, 250);

        public LauncherForm()
        {
            Text = "鲸奈 · QQ 网友 启动器";
            ClientSize = new Size(560, 570);
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
                Text = "四个组件一键启停 · 关掉本窗口不影响它们继续运行",
                ForeColor = MutedColor,
                Location = new Point(26, 50),
                Size = new Size(490, 20)
            };
            Controls.Add(sub);

            int y = 84;
            AddComponentRow("bot", "机器人主程序", y, () => Program.StartBot(), () => Program.StopBot());
            y += 64;
            AddComponentRow("lagrange", "Lagrange 协议端", y, () => Program.StartLagrange(), () => Program.StopLagrange());
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

            _timer = new System.Windows.Forms.Timer { Interval = 3000 };
            _timer.Tick += (s, e) => UpdateStatus();
            _timer.Start();

            Shown += (s, e) =>
            {
                UpdateStatus();
                SetStatus("就绪 · 点「一键全部启动」开始");
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
    }
}
