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

// ── 控制面板前端（单文件 HTML，无外部依赖） ──
const PANEL_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>鲸奈 · 控制面板</title>
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
  .toast { position:fixed; bottom:20px; right:20px; background:var(--card); border:1px solid var(--accent); border-radius:10px; padding:12px 16px; font-size:13px; opacity:0; transform:translateY(10px); transition:.25s; max-width:340px; }
  .toast.show { opacity:1; transform:none; }
</style>
</head>
<body>
<h1>鲸奈 · 控制面板</h1>
<div class="sub">监控 + 启停四个组件 · 每 3 秒自动刷新</div>
<div class="grid" id="grid"></div>
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

let t;
function toast(msg) {
  const e = document.getElementById('toast');
  e.textContent = msg;
  e.classList.add('show');
  clearTimeout(t);
  t = setTimeout(() => e.classList.remove('show'), 3000);
}

refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;

