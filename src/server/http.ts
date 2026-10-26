import http from 'node:http';
import type { Logger } from 'pino';

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


