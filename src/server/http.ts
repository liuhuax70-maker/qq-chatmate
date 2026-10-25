import http from 'node:http';
import type { Logger } from 'pino';
import type { ControlPanel } from './panel';

export interface HttpOptions {
  host: string;
  port: number;
  authToken?: string;
}

export interface HttpContext {
  isAdapterConnected: () => boolean;
  getSession: () => { intimacy: number; mood: number; turns: number };
  /** 代理调用 OneBot API（用于调试） */
  callApi?: (action: string, params: Record<string, unknown>) => Promise<unknown>;
  /** 睡眠状态描述 */
  getSleepState?: () => string;
  /** LLM 用量统计 */
  getLlmStats?: () => Record<string, unknown>;
  /** 表情库管理 */
  stickerAdmin?: {
    list: () => Array<{ url: string; usedCount: number; tags: string[] }>;
    keepOnly: (urls: string[]) => { removed: number; kept: number };
    refresh: () => Promise<number>;
  };
  /** 日记：给启动器读今天写了什么、列出历史文件 */
  diary?: {
    enabled: boolean;
    dir: string;
    readToday: () => string;
    list: () => Array<{ date: string; file: string; size: number }>;
  };
  /** 控制面板（监控 + 启停） */
  panel?: ControlPanel;
}

/** 极简管理接口：健康检查 + 状态查看。仅监听本地。 */
export function startHttpServer(opts: HttpOptions, ctx: HttpContext, logger: Logger): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = req.url ?? '/';

      // 鉴权
      if (opts.authToken) {
        const auth = req.headers['authorization'];
        if (auth !== `Bearer ${opts.authToken}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
          return;
        }
      }

      if (url === '/healthz') {
        const connected = ctx.isAdapterConnected();
        res.writeHead(connected ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: connected,
            status: connected ? 'connected' : 'disconnected',
            up: process.uptime(),
          }),
        );
        return;
      }

      if (url === '/state') {
        const s = ctx.getSession();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            intimacy: Number(s.intimacy.toFixed(3)),
            mood: Number(s.mood.toFixed(3)),
            turns: s.turns,
            sleep: ctx.getSleepState?.() ?? 'n/a',
            diary: ctx.diary
              ? { enabled: ctx.diary.enabled, dir: ctx.diary.dir }
              : { enabled: false, dir: '' },
          }),
        );
        return;
      }

      // 日记：今天的内容 / 历史文件列表
      if (url === '/api/diary/today') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            enabled: ctx.diary?.enabled ?? false,
            dir: ctx.diary?.dir ?? '',
            content: ctx.diary?.readToday() ?? '',
          }),
        );
        return;
      }
      if (url === '/api/diary/list') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            enabled: ctx.diary?.enabled ?? false,
            dir: ctx.diary?.dir ?? '',
            files: ctx.diary?.list() ?? [],
          }),
        );
        return;
      }

      if (url === '/cost') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, llm: ctx.getLlmStats?.() ?? {} }, null, 2));
        return;
      }

      // ── 表情库管理 ──
      // GET  /stickers            列出当前表情库
      // POST /stickers/refresh    重新拉取收藏
      // POST /stickers/keep       只保留指定 URL（body: {"urls":[...]}）
      if (url === '/stickers' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, stickers: ctx.stickerAdmin?.list() ?? [] }, null, 2));
        return;
      }

      if (url === '/stickers/refresh' && req.method === 'POST') {
        if (!ctx.stickerAdmin) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'stickerAdmin not wired' }));
          return;
        }
        void ctx.stickerAdmin
          .refresh()
          .then((n) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, total: n }));
          })
          .catch((err) => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
          });
        return;
      }

      if (url === '/stickers/keep' && req.method === 'POST') {
        if (!ctx.stickerAdmin) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'stickerAdmin not wired' }));
          return;
        }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body || '{}');
            const urls: string[] = Array.isArray(parsed.urls) ? parsed.urls : [];
            const r = ctx.stickerAdmin!.keepOnly(urls);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, ...r }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
          }
        });
        return;
      }

      // ── 控制面板（必须在通用 /api/<action> 代理之前，否则会被吞掉） ──
      // GET  /panel                    可视化面板（HTML）
      // GET  /api/status               组件状态 JSON
      // POST /api/control/<comp>/<act> 启动/停止（act: start|stop；comp: tts|lagrange|sign|bot）
      if (url === '/panel' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PANEL_HTML);
        return;
      }

      if (url === '/api/status' && req.method === 'GET') {
        if (!ctx.panel) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'panel not wired' }));
          return;
        }
        void ctx.panel.status().then((components) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, components }));
        });
        return;
      }

      // 二维码：读协议端生成的 qr-*.png，转成 data URL 返回
      if (url === '/api/qrcode' && req.method === 'GET') {
        void (async () => {
          try {
            // 先看是否已登录，给准确的提示
            let connected = false;
            try {
              const h = await fetch('http://127.0.0.1:3000/healthz', { signal: AbortSignal.timeout(2000) });
              const j = (await h.json()) as { status?: string };
              connected = j?.status === 'connected';
            } catch { /* ignore */ }

            if (connected) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, reason: '✅ 已登录，机器人已连上' }));
              return;
            }

            const qr = await findQrDataUrl();
            if (!qr) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, reason: '等待二维码…（先启动 NapCat）' }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, dataUrl: qr }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
          }
        })();
        return;
      }

      const controlMatch = url.match(/^\/api\/control\/([a-z]+)\/(start|stop)$/);
      if (controlMatch && req.method === 'POST') {
        if (!ctx.panel) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'panel not wired' }));
          return;
        }
        const [, component, action] = controlMatch;
        void ctx.panel.control(component, action).then((msg) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, component, action, message: msg }));
        }).catch((err) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
        });
        return;
      }

      // 调试用：代理调用 OneBot API
      //   POST /api/<action>   body: { ...params }
      // 例：POST /api/fetch_custom_face   body: {}
      if (url.startsWith('/api/') && req.method === 'POST') {
        const action = url.slice('/api/'.length);
        if (!ctx.callApi) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'callApi not wired' }));
          return;
        }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', async () => {
          try {
            const params = body.trim() ? JSON.parse(body) : {};
            const data = await ctx.callApi!(action, params);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, action, data }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
          }
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
    });

    server.on('error', reject);
    server.listen(opts.port, opts.host, () => {
      logger.info(`管理接口已启动 http://${opts.host}:${opts.port}（/healthz, /state, /api/<action>）`);
      resolve(server);
    });
  });
}

/**
 * 找到协议端当前有效的二维码，转成 data URL 给面板显示。
 *
 * Lagrange 会把二维码写到 publish 目录的 qr-<uin>.png（约 147x147 的纯黑白图）。
 * 这里读最新的一个，超过 5 分钟视为过期。
 */
async function findQrDataUrl(): Promise<string | null> {
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');

  // NapCat 的二维码位置（优先）
  const napcatQr = pathMod.resolve(process.cwd(), '..', 'napcat', 'napcat', 'cache', 'qrcode.png');

  // 机器人是否已连上协议端（最权威的"登录成功"判据）
  let connected = false;
  try {
    const h = await fetch('http://127.0.0.1:3000/healthz', { signal: AbortSignal.timeout(2000) });
    const j = (await h.json()) as { status?: string };
    connected = j?.status === 'connected';
  } catch { /* ignore */ }

  // 已登录 → 不需要二维码
  if (connected) return null;

  // NapCat 是否在跑：QQ 进程存在（不用 wmic，部分环境没有）
  let napcatAlive = false;
  try {
    const { execSync } = await import('node:child_process');
    for (const img of ['QQ.exe', 'QQEX.exe']) {
      try {
        const out = execSync(`tasklist /FI "IMAGENAME eq ${img}" /FO CSV /NH`, {
          encoding: 'utf8', timeout: 6000, windowsHide: true,
        });
        if (out.toLowerCase().includes(img.toLowerCase())) { napcatAlive = true; break; }
      } catch { /* 继续试下一个 */ }
    }
  } catch { /* ignore */ }

  // NapCat 没在跑 → 不返回旧码（否则"已停止却还能扫码"）
  if (!napcatAlive) return null;

  try {
    if (fsMod.existsSync(napcatQr)) {
      const age = Date.now() - fsMod.statSync(napcatQr).mtimeMs;
      if (age < 5 * 60 * 1000) {
        const buf = fsMod.readFileSync(napcatQr);
        return `data:image/png;base64,${buf.toString('base64')}`;
      }
    }
  } catch { /* 继续试 Lagrange */ }

  // 从 control 配置里拿 lagrange 的 workdir，退回默认路径
  const candidates = [
    pathMod.resolve(process.cwd(), '..', 'lagrange', 'Lagrange.OneBot', 'bin', 'Release', 'net9.0', 'win-x64', 'publish'),
    'D:\\Agent\\HarnessWorkPlace\\Deepseek\\lagrange\\Lagrange.OneBot\\bin\\Release\\net9.0\\win-x64\\publish',
  ];
  for (const dir of candidates) {
    try {
      if (!fsMod.existsSync(dir)) continue;
      const files = fsMod.readdirSync(dir).filter((f) => f.startsWith('qr-') && f.endsWith('.png'));
      if (files.length === 0) continue;
      const withTime = files.map((f) => ({ f, t: fsMod.statSync(pathMod.join(dir, f)).mtimeMs }));
      withTime.sort((a, b) => b.t - a.t);
      const newest = withTime[0];
      if (Date.now() - newest.t > 5 * 60 * 1000) continue; // 过期
      const buf = fsMod.readFileSync(pathMod.join(dir, newest.f));
      return `data:image/png;base64,${buf.toString('base64')}`;
    } catch {
      // 继续试下一个候选路径
    }
  }
  return null;
}
// ── 控制面板前端（单文件 HTML，无外部依赖） ──
const PANEL_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>大肥鱼 · 控制面板</title>
<style>
  :root { --bg:#0f172a; --card:#1e293b; --ok:#34d399; --bad:#f87171; --muted:#94a3b8; --accent:#60a5fa; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:#e2e8f0; font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif; padding:24px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:var(--muted); font-size:13px; margin-bottom:20px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:14px; }
  .card { background:var(--card); border-radius:12px; padding:16px; display:flex; flex-direction:column; gap:10px; }
  .card .name { font-size:15px; font-weight:600; }
  .dot { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:7px; vertical-align:1px; }
  .dot.on { background:var(--ok); box-shadow:0 0 8px var(--ok); }
  .dot.off { background:var(--bad); box-shadow:0 0 8px var(--bad); }
  .status { font-size:13px; color:var(--muted); }
  .status.on { color:var(--ok); }
  .status.off { color:var(--bad); }
  .row { display:flex; gap:8px; }
  button { flex:1; border:none; border-radius:8px; padding:8px 0; cursor:pointer; font-size:13px; font-weight:600; color:#0f172a; transition:opacity .15s; }
  button.start { background:var(--ok); }
  button.stop { background:var(--bad); }
  button:disabled { opacity:.35; cursor:not-allowed; }
  .hint { font-size:12px; color:var(--muted); }
  .bulk { display:flex; gap:12px; margin-top:18px; }
  .bulk button { flex:1; border:none; border-radius:10px; padding:12px 0; cursor:pointer; font-size:14px; font-weight:700; }
  .bulk-start { background:var(--accent); color:#0f172a; }
  .bulk-stop { background:#475569; color:#e2e8f0; }
  .qrwrap { background:var(--card); border-radius:12px; padding:16px; margin-top:16px; }
  .qrtitle { font-size:13px; color:var(--muted); margin-bottom:12px; }
  .qrbox { display:flex; align-items:center; justify-content:center; min-height:240px; background:#334155; border-radius:8px; }
  .qrbox img { width:220px; height:220px; image-rendering:pixelated; }
  .toast { position:fixed; bottom:20px; right:20px; background:var(--card); border:1px solid var(--accent); border-radius:10px; padding:12px 16px; font-size:13px; opacity:0; transform:translateY(10px); transition:.25s; max-width:340px; }
  .toast.show { opacity:1; transform:none; }
</style>
</head>
<body>
<h1>大肥鱼 · 控制面板</h1>
<div class="sub">监控 + 启停四个组件 · 每 3 秒自动刷新</div>
<div class="grid" id="grid"></div>

<div class="bulk">
  <button class="bulk-start" onclick="allStart()">一键全部启动</button>
  <button class="bulk-stop" onclick="allStop()">全部停止</button>
</div>

<div class="qrwrap">
  <div class="qrtitle">登录二维码（协议端启动后自动出现）</div>
  <div class="qrbox"><img id="qrimg" alt="" style="display:none"><span id="qrhint">等待二维码…</span></div>
</div>

<div class="toast" id="toast"></div>
<script>
const COMPONENTS = [
  { key:'bot', label:'主程序 qq-netizen', controllable:false, hint:'面板本身跑在主程序里，无法从这里自启停' },
  { key:'lagrange', label:'Lagrange.OneBot', controllable:true, hint:'协议端 · 首次启动需在弹出窗口扫码' },
  { key:'sign', label:'签名服务 sign-server', controllable:true, hint:'Docker 容器 ntqq-sign-server' },
  { key:'tts', label:'TTS 语音', controllable:true, hint:'GPT-SoVITS · 启动后加载模型约 2-3 秒' },
];

function el(key, st) {
  const meta = COMPONENTS.find(c => c.key === key);
  const on = st.running;
  const card = document.createElement('div');
  card.className = 'card';
  const name = document.createElement('div');
  name.className = 'name';
  name.innerHTML = '<span class="dot ' + (on?'on':'off') + '"></span>' + meta.label;
  const status = document.createElement('div');
  status.className = 'status ' + (on?'on':'off');
  status.textContent = (on?'● 运行中 · ':'○ 已停止 · ') + st.detail;
  card.appendChild(name);
  card.appendChild(status);
  if (meta.controllable) {
    const row = document.createElement('div');
    row.className = 'row';
    const bStart = document.createElement('button');
    bStart.className = 'start';
    bStart.textContent = '启动';
    bStart.disabled = on;
    bStart.onclick = () => act(key, 'start');
    const bStop = document.createElement('button');
    bStop.className = 'stop';
    bStop.textContent = '停止';
    bStop.disabled = !on;
    bStop.onclick = () => act(key, 'stop');
    row.appendChild(bStart); row.appendChild(bStop);
    card.appendChild(row);
  }
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = meta.hint;
  card.appendChild(hint);
  return card;
}

async function refresh() {
  try {
    const r = await fetch('/api/status');
    const j = await r.json();
    const grid = document.getElementById('grid');
    grid.innerHTML = '';
    for (const c of j.components) grid.appendChild(el(c.key, c));
  } catch (e) {
    document.getElementById('grid').innerHTML = '<div class="status off">无法连接面板后端</div>';
  }
}

async function act(component, action) {
  const r = await fetch('/api/control/' + component + '/' + action, { method:'POST' });
  const j = await r.json();
  toast(j.message || (j.ok ? '已执行' : '失败'));
  refresh();
}

async function allStart() {
  toast("正在启动全部组件…");
  for (const k of ["sign","lagrange","bot","tts"]) {
    try { await fetch("/api/control/" + k + "/start", { method:"POST" }); } catch {}
  }
  toast("已触发全部启动");
  setTimeout(refresh, 2000);
}

async function allStop() {
  toast("正在停止全部组件…");
  for (const k of ["bot","lagrange","tts","sign"]) {
    try { await fetch("/api/control/" + k + "/stop", { method:"POST" }); } catch {}
  }
  toast("已触发全部停止");
  setTimeout(refresh, 2000);
}

// 二维码：读后端 /api/qrcode，用 blob 显示
let lastQr = "";
async function refreshQr() {
  try {
    const r = await fetch("/api/qrcode");
    const j = await r.json();
    const img = document.getElementById("qrimg");
    const hint = document.getElementById("qrhint");
    if (!j.ok || !j.dataUrl) {
      img.style.display = "none";
      hint.style.display = "";
      hint.textContent = j.reason || "等待二维码…";
      return;
    }
    if (j.dataUrl === lastQr) return;
    lastQr = j.dataUrl;
    img.src = j.dataUrl;
    img.style.display = "";
    hint.style.display = "none";
  } catch {}
}

let t;
function toast(msg) {
  const e = document.getElementById('toast');
  e.textContent = msg;
  e.classList.add('show');
  clearTimeout(t);
  t = setTimeout(() => e.classList.remove('show'), 3000);
}

refresh();
refreshQr();
setInterval(refresh, 3000);
setInterval(refreshQr, 2500);
</script>
</body>
</html>`;

