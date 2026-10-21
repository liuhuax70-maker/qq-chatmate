// ConPTY 启动器：给无控制台的进程伪造一个真实伪终端
// 用法: dotnet run 或编译后 LagrangeHost.exe <exe路径> <工作目录>
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class Program
{
    [StructLayout(LayoutKind.Sequential)]
    private struct COORD { public short X; public short Y; }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int CreatePseudoConsole(COORD size, IntPtr hInput, IntPtr hOutput, uint flags, out IntPtr phPC);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern void ClosePseudoConsole(IntPtr hPC);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out IntPtr hReadPipe, out IntPtr hWritePipe, IntPtr lpPipeAttributes, uint nSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadFile(IntPtr hFile, byte[] lpBuffer, uint nNumberOfBytesToRead, out uint lpNumberOfBytesRead, IntPtr lpOverlapped);

    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint PSEUDOCONSOLE_INHERIT_CURSOR = 0x00000001;

    private static IntPtr _hPC = IntPtr.Zero;

    [DllImport("kernel32.dll")]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    private static int Main(string[] args)
    {
        if (args.Length < 2)
        {
            Console.Error.WriteLine("usage: LagrangeHost.exe <exe> <workdir>");
            return 2;
        }

        string exePath = args[0];
        string workDir = args[1];
        string logPath = args.Length > 2 ? args[2] : Path.Combine(workDir, "lagrange-console.log");

        // 1. 建两对管道
        if (!CreatePipe(out var inRead, out var inWrite, IntPtr.Zero, 0)) return Fail("CreatePipe(in)");
        if (!CreatePipe(out var outRead, out var outWrite, IntPtr.Zero, 0)) return Fail("CreatePipe(out)");

        SetHandleInformation(inWrite, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(outRead, HANDLE_FLAG_INHERIT, 0);

        // 2. 创建伪控制台
        var size = new COORD { X = 120, Y = 40 };
        int hr = CreatePseudoConsole(size, inRead, outWrite, PSEUDOCONSOLE_INHERIT_CURSOR, out _hPC);
        if (hr != 0) return Fail($"CreatePseudoConsole hr=0x{hr:X8}");

        CloseHandleSafe(inRead);
        CloseHandleSafe(outWrite);

        // 3. 启动子进程并挂到伪控制台上
        var si = new STARTUPINFOEX();
        si.StartupInfo.cb = Marshal.SizeOf<STARTUPINFOEX>();
        IntPtr attrList = IntPtr.Zero;
        IntPtr attrListMem = IntPtr.Zero;

        try
        {
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, out IntPtr attrSize);
            attrListMem = Marshal.AllocHGlobal(attrSize);
            if (!InitializeProcThreadAttributeList(attrListMem, 1, 0, out attrSize))
                return Fail("InitializeProcThreadAttributeList");

            // PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE
            //   = ProcThreadAttributeValue(22, FALSE, TRUE, FALSE)
            //   = (22 & 0xFFFF) | 0 | PROC_THREAD_ATTRIBUTE_INPUT(0x20000) | 0
            //   = 0x20016 = 131094
            const IntPtr PSEUDOCONSOLE_ATTR = (IntPtr)0x20016;
            if (!UpdateProcThreadAttribute(attrListMem, 0, PSEUDOCONSOLE_ATTR,
                _hPC, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
                return Fail("UpdateProcThreadAttribute");

            si.lpAttributeList = attrListMem;

            var pi = new PROCESS_INFORMATION();
            var sb = new StringBuilder("\"" + exePath + "\"");
            bool ok = CreateProcess(
                null, sb, IntPtr.Zero, IntPtr.Zero, true,
                0x00000010 /* EXTENDED_STARTUPINFO_PRESENT */ | 0x00000400 /* CREATE_UNICODE_ENVIRONMENT */,
                IntPtr.Zero, workDir, ref si, out pi);

            if (!ok) return Fail("CreateProcess");

            ulong pid = (ulong)pi.dwProcessId;
            // 写 pid 文件只是方便外部查，失败不该让 host 崩掉
            try { File.WriteAllText(Path.Combine(workDir, "lagrange.pid"), pid.ToString()); } catch { }
            Console.WriteLine($"[host] started pid={pid}");

            // 4. 读取伪控制台输出写日志
            var readThread = new Thread(() =>
            {
                var buf = new byte[4096];
                FileStream fs;
                try { fs = new FileStream(logPath, FileMode.Create, FileAccess.Write, FileShare.ReadWrite); }
                catch { return; }
                using var _fs = fs;
                using var sw = new StreamWriter(fs, Encoding.UTF8) { AutoFlush = true };
                while (true)
                {
                    if (!ReadFile(outRead, buf, (uint)buf.Length, out uint n, IntPtr.Zero)) break;
                    if (n == 0) break;
                    sw.Write(Encoding.UTF8.GetString(buf, 0, (int)n));
                }
            }) { IsBackground = true };
            readThread.Start();

            // 5. 等进程退出
            WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
            GetExitCodeProcess(pi.hProcess, out uint code);
            Console.WriteLine($"[host] child exited code={code}");
            CloseHandleSafe(pi.hProcess);
            CloseHandleSafe(pi.hThread);
            return (int)code;
        }
        finally
        {
            if (attrListMem != IntPtr.Zero) { DeleteProcThreadAttributeList(attrListMem); Marshal.FreeHGlobal(attrListMem); }
            if (_hPC != IntPtr.Zero) { ClosePseudoConsole(_hPC); _hPC = IntPtr.Zero; }
            CloseHandleSafe(inWrite);
            CloseHandleSafe(outRead);
        }
    }

    private static int Fail(string what)
    {
        int err = Marshal.GetLastWin32Error();
        Console.Error.WriteLine($"[host] {what} failed, win32err={err}");
        return 1;
    }

    private static void CloseHandleSafe(IntPtr h)
    {
        if (h != IntPtr.Zero) CloseHandle(h);
    }

    // ---- P/Invoke ----

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFO
    {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcess(string lpApplicationName, StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags,
        IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFOEX lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, out IntPtr lpSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr attribute,
        IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll")]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);
}
