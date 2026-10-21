import { execFile, spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import type { Logger } from 'pino';

/**
 * 本地控制面板：监控 + 启停四个组件。
 *
 * 组件：
 *   1. 主程序 qq-netizen（本进程，面板本身就跑在里面）
 *   2. Lagrange.OneBot（协议端，QQ 登录）
 *   3. ntqq-sign-server（Docker 签名服务）
 *   4. GPT-SoVITS TTS（语音合成）
 *
 * 监控是被动探测（端口 / 进程 / Docker 状态），安全且随时可查。
 * 控制是主动启停（spawn 子进程 / 调 docker CLI），失败不影响主程序。
 */

export interface PanelConfig {
  /** TTS 服务 */
  tts: {
    python: string;       // venv python.exe
    script: string;       // tts_server.py
    workdir: string;      // gpt-sovits 目录
    port: number;         // 默认 9880
  };
  /** Lagrange 协议端 */
  lagrange: {
    exe: string;          // Lagrange.OneBot.exe
    workdir: string;      // publish 目录
    bundleExtractBase?: string; // DOTNET_BUNDLE_EXTRACT_BASE_DIR
  };
  /** 签名服务 Docker 容器 */
  signServer: {
    container: string;    // 容器名
    port: number;         // 宿主端口 8090
  };
}

export interface ComponentStatus {
  key: 'bot' | 'lagrange' | 'sign' | 'tts';
  label: string;
  running: boolean;
  detail: string;
}

interface ManagedProc {
  proc: ChildProcess;
  key: 'lagrange' | 'tts';
  startedAt: number;
}

function canConnect(port: number, host = '127.0.0.1', timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: timeoutMs });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.once('error', () => { sock.destroy(); resolve(false); });
  });
}

function execShell(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ stdout: String(stdout ?? '').trim(), stderr: String(stderr ?? '').trim(), code: err ? (err as any).code ?? 1 : 0 });
    });
  });
}

export class ControlPanel {
  private cfg: PanelConfig;
  private logger: Logger;
  private procs = new Map<'lagrange' | 'tts', ManagedProc>();

  constructor(cfg: PanelConfig, logger: Logger) {
    this.cfg = cfg;
    this.logger = logger;
  }

  /** 探测四个组件状态 */
  /** TTS 的详细状态（是否加载完成） */
  private ttsDetail = '未运行';

  async status(): Promise<ComponentStatus[]> {
    const [lagrangeWs, signPort, ttsPort] = await Promise.all([
      canConnect(8080),   // 协议端连上主程序的 8080（reverse-ws）
      canConnect(this.cfg.signServer.port),
      canConnect(this.cfg.tts.port),
    ]);

    // TTS 端口通了不代表模型加载完，顺手查一下 /health 的 loaded 字段
    if (ttsPort) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1200);
        let resp: Response;
        try {
          resp = await fetch(`http://127.0.0.1:${this.cfg.tts.port}/health`, { signal: ctrl.signal });
        } finally {
          clearTimeout(t);
        }
        const j = (await resp.json()) as { loaded?: boolean; device?: string };
        this.ttsDetail = j?.loaded ? `服务就绪（${j.device ?? 'cpu'}）` : '模型加载中…';
      } catch {
        this.ttsDetail = '服务就绪';
      }
    } else {
      this.ttsDetail = '未运行';
    }

    // Lagrange：进程在 且 已连上 8080
    const lagrangeProc = await this.findProcess('Lagrange.OneBot');
    const signContainer = await this.signContainerRunning();

    return [
      {
        key: 'bot',
        label: '主程序 qq-netizen',
        running: true,
        detail: lagrangeWs ? '协议端已连接' : '运行中（等待协议端）',
      },
      {
        key: 'lagrange',
        label: 'Lagrange.OneBot',
        running: lagrangeProc && lagrangeWs,
        detail: lagrangeProc ? (lagrangeWs ? '在线' : '进程在，但未连接') : '未运行',
      },
      {
        key: 'sign',
        label: '签名服务 sign-server',
        running: signContainer && signPort,
        detail: signContainer ? (signPort ? '容器健康' : '容器在，端口未映射') : '容器未运行',
      },
      {
        key: 'tts',
        label: 'TTS 语音',
        running: ttsPort,
        detail: ttsPort ? '服务就绪' : '未运行',
      },
    ];
  }

  async startTts(): Promise<string> {
    if (await canConnect(this.cfg.tts.port)) return 'TTS 已在运行';
    if (this.procs.has('tts')) return 'TTS 正在启动中';

    const proc = spawn(this.cfg.tts.python, [this.cfg.tts.script, String(this.cfg.tts.port)], {
      cwd: this.cfg.tts.workdir,
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    proc.on('exit', () => this.procs.delete('tts'));
    proc.on('error', (e) => this.logger.warn({ err: e.message }, 'TTS 启动失败'));
    this.procs.set('tts', { proc, key: 'tts', startedAt: Date.now() });
    proc.unref();
    return 'TTS 启动中（模型加载约 2-3 秒）';
  }

  async stopTts(): Promise<string> {
    const m = this.procs.get('tts');
    if (m) {
      try { m.proc.kill(); } catch { /* ignore */ }
      this.procs.delete('tts');
    }
    // 兜底：按端口找到并结束 python 进程
    const pid = await this.pidByPort(this.cfg.tts.port);
    if (pid) {
      await execShell('taskkill', ['/PID', String(pid), '/T', '/F']).catch(() => void 0);
      return 'TTS 已停止';
    }
    return m ? 'TTS 已停止' : 'TTS 本就没在运行';
  }

  async startLagrange(): Promise<string> {
    if (this.procs.has('lagrange')) return 'Lagrange 正在启动中';
    const env = { ...process.env };
    if (this.cfg.lagrange.bundleExtractBase) env.DOTNET_BUNDLE_EXTRACT_BASE_DIR = this.cfg.lagrange.bundleExtractBase;

    // 关键：stdio 用 ignore，让它拿到真实控制台（之前 Console.get_BufferWidth 崩溃
    // 就是因为在无控制台 + 输出重定向环境下启动）。
    const proc = spawn(this.cfg.lagrange.exe, [], {
      cwd: this.cfg.lagrange.workdir,
      env,
      stdio: 'ignore',
      detached: true,
      windowsHide: false,
    });
    proc.on('exit', () => this.procs.delete('lagrange'));
    proc.on('error', (e) => this.logger.warn({ err: e.message }, 'Lagrange 启动失败'));
    this.procs.set('lagrange', { proc, key: 'lagrange', startedAt: Date.now() });
    proc.unref();
    return 'Lagrange 已启动（若首次登录需在弹出的窗口扫码）';
  }

  async stopLagrange(): Promise<string> {
    const m = this.procs.get('lagrange');
    if (m) {
      try { m.proc.kill(); } catch { /* ignore */ }
      this.procs.delete('lagrange');
    }
    const pid = await this.findProcessPid('Lagrange.OneBot');
    if (pid) {
      await execShell('taskkill', ['/PID', String(pid), '/T', '/F']).catch(() => void 0);
      return 'Lagrange 已停止';
    }
    return m ? 'Lagrange 已停止' : 'Lagrange 本就没在运行';
  }

  async startSignServer(): Promise<string> {
    const running = await this.signContainerRunning();
    if (running) return '签名服务已在运行';
    const r = await execShell('docker', ['start', this.cfg.signServer.container]);
    return r.code === 0 ? '签名服务已启动' : `启动失败：${r.stderr || r.stdout}`;
  }

  async stopSignServer(): Promise<string> {
    const running = await this.signContainerRunning();
    if (!running) return '签名服务本就没在运行';
    const r = await execShell('docker', ['stop', this.cfg.signServer.container]);
    return r.code === 0 ? '签名服务已停止' : `停止失败：${r.stderr || r.stdout}`;
  }

  /** 面板调度入口：POST /api/control/<component>/<action> */
  async control(component: string, action: string): Promise<string> {
    if (component === 'tts') return action === 'start' ? this.startTts() : this.stopTts();
    if (component === 'lagrange') return action === 'start' ? this.startLagrange() : this.stopLagrange();
    if (component === 'sign') return action === 'start' ? this.startSignServer() : this.stopSignServer();
    if (component === 'bot') return '主程序即面板宿主，无法从这里自启停；请用命令行重启 npm run dev';
    return `未知组件：${component}`;
  }

  // ── 内部探测工具 ──

  private async findProcess(name: string): Promise<boolean> {
    return (await this.findProcessPid(name)) !== null;
  }

  private async findProcessPid(name: string): Promise<number | null> {
    // tasklist 输出 CSV：`"ImageName","PID","SessionName","Session#","Mem Usage"`
    // 取第二个字段（PID）。
    const r = await execShell('tasklist', ['/FI', `IMAGENAME eq ${name}.exe`, '/FO', 'CSV', '/NH']);
    if (r.code !== 0 || !r.stdout) return null;
    for (const line of r.stdout.split(/\r?\n/)) {
      const fields = line.match(/"([^"]*)"/g);
      if (fields && fields.length >= 2) {
        const pid = parseInt(fields[1].replace(/"/g, ''), 10);
        if (!Number.isNaN(pid) && pid > 0) return pid;
      }
    }
    return null;
  }

  private async pidByPort(port: number): Promise<number | null> {
    const r = await execShell('netstat', ['-ano', '-p', 'TCP']);
    if (r.code !== 0) return null;
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = line.trim().match(new RegExp(`127\\.0\\.0\\.1:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`));
      if (m) {
        const pid = parseInt(m[1], 10);
        if (!Number.isNaN(pid)) return pid;
      }
    }
    return null;
  }

  private async signContainerRunning(): Promise<boolean> {
    const r = await execShell('docker', ['ps', '--filter', `name=${this.cfg.signServer.container}`, '--format', '{{.Names}}']);
    return r.code === 0 && r.stdout.includes(this.cfg.signServer.container);
  }

  /** 面板退出时清理子进程 */
  dispose(): void {
    for (const m of this.procs.values()) {
      try { m.proc.kill(); } catch { /* ignore */ }
    }
    this.procs.clear();
  }
}
