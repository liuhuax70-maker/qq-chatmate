/**
 * OneBot 11 适配层。
 *
 * 两种传输：
 *  - reverse-websocket：本程序起 WS 服务端，协议端（Lagrange.OneBot）主动连过来。
 *    这是 Lagrange 配置里 "ReverseWebSocket" 的含义。
 *  - forward-websocket：本程序作为客户端主动连协议端。
 *
 * 只暴露本项目需要的最小 API 面：发私聊消息、处理好友请求、退群、拒绝入群请求。
 */
import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import type { Logger } from 'pino';
import { maskQQ } from '../infra/logger';

export interface OneBotMessageSegment {
  type: string;
  data: Record<string, any>;
}

export interface OneBotEvent {
  post_type: 'message' | 'notice' | 'request' | 'meta_event';
  time: number;
  self_id: number;
  [key: string]: any;
}

export interface PrivateMessageEvent extends OneBotEvent {
  post_type: 'message';
  message_type: 'private';
  sub_type: 'friend' | 'group' | 'other';
  message_id: number;
  user_id: number;
  message: OneBotMessageSegment[];
  raw_message: string;
  sender: { user_id: number; nickname: string };
}

export interface GroupMessageEvent extends OneBotEvent {
  post_type: 'message';
  message_type: 'group';
  group_id: number;
  user_id: number;
  message: OneBotMessageSegment[];
  raw_message: string;
  sender: { user_id: number; nickname: string };
}

export interface NoticeEvent extends OneBotEvent {
  post_type: 'notice';
  notice_type: string;
  [key: string]: any;
}

export interface RequestEvent extends OneBotEvent {
  post_type: 'request';
  request_type: 'friend' | 'group';
  user_id: number;
  comment: string;
  flag: string;
  [key: string]: any;
}

export interface AdapterOptions {
  transport: 'reverse-websocket' | 'forward-websocket';
  listen: { host: string; port: number; path: string };
  url?: string;
  accessToken?: string;
  selfId: string;
  heartbeatIntervalMs: number;
}

/** 从消息链中提取纯文本 */
export function extractText(segments: OneBotMessageSegment[]): string {
  if (!Array.isArray(segments)) return '';
  return segments
    .filter((s) => s.type === 'text')
    .map((s) => String(s.data?.text ?? ''))
    .join('')
    .trim();
}

/** 消息里带的图片/表情段 */
export interface ReceivedImage {
  url: string;
  /** 是否为"表情包"（区别于普通图片） */
  isSticker: boolean;
  /** OneBot 原始数据，便于后续识别 */
  raw: Record<string, any>;
}

/**
 * 从消息链中提取图片和表情包。
 *
 * OneBot 11 里，图片可能是：
 *   - segment.type === 'image'，data 里有 url / file / summary
 *   - 表情包通常在 data.summary 里带 "[动画表情]" 标记
 *   - 部分实现用 'mface'（商城表情）表示
 */
export function extractImages(segments: OneBotMessageSegment[]): ReceivedImage[] {
  if (!Array.isArray(segments)) return [];
  const out: ReceivedImage[] = [];

  for (const seg of segments) {
    if (seg.type === 'image') {
      const d = seg.data ?? {};
      const url = String(d.url ?? d.file ?? '');
      if (!url) continue;
      const summary = String(d.summary ?? '');
      const isSticker = summary.includes('表情') || summary.includes('[动画表情]') || !!d.sub_type?.toString().includes('1');
      out.push({ url, isSticker, raw: d });
    } else if (seg.type === 'mface') {
      const d = seg.data ?? {};
      const url = String(d.url ?? '');
      if (!url) continue;
      out.push({ url, isSticker: true, raw: d });
    }
  }

  return out;
}

/** 判断整条消息是不是"纯表情包"（没有文字） */
export function isPureStickerMsg(segments: OneBotMessageSegment[]): boolean {
  if (!Array.isArray(segments) || segments.length === 0) return false;
  const hasText = segments.some((s) => s.type === 'text' && String(s.data?.text ?? '').trim());
  const hasImage = segments.some((s) => s.type === 'image' || s.type === 'mface');
  return hasImage && !hasText;
}

export class OneBotAdapter extends EventEmitter {
  private opts: AdapterOptions;
  private logger: Logger;
  private wss?: WebSocketServer;
  private client?: WebSocket;
  private sockets = new Set<WebSocket>();
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private echoSeq = 0;
  private heartbeatTimer?: NodeJS.Timeout;

  constructor(opts: AdapterOptions, logger: Logger) {
    super();
    this.opts = opts;
    this.logger = logger;
  }

  async start(): Promise<void> {
    if (this.opts.transport === 'reverse-websocket') {
      await this.startServer();
    } else {
      await this.startClient();
    }
  }

  private startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const { host, port, path } = this.opts.listen;
      this.wss = new WebSocketServer({ host, port, path });

      this.wss.on('listening', () => {
        this.logger.info(`OneBot 反向 WS 服务已启动 ws://${host}:${port}${path}（等待协议端连接）`);
        resolve();
      });

      this.wss.on('error', (err) => {
        this.logger.error({ err: err.message }, 'OneBot WS 服务错误');
        reject(err);
      });

      this.wss.on('connection', (ws, req) => {
        // 校验 access token
        const expected = this.opts.accessToken;
        if (expected) {
          const auth = req.headers['authorization'];
          const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
          if (token !== expected) {
            this.logger.warn('协议端连接被拒绝：access token 不匹配');
            ws.close(1008, 'invalid access token');
            return;
          }
        }
        this.logger.info('协议端已连接');
        this.attach(ws);
        resolve();
      });
    });
  }

  private async startClient(): Promise<void> {
    if (!this.opts.url) throw new Error('forward-websocket 模式必须配置 adapter.url');
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.opts.url!, {
        headers: this.opts.accessToken ? { Authorization: `Bearer ${this.opts.accessToken}` } : {},
      });
      ws.on('open', () => {
        this.logger.info(`已连接协议端 ${this.opts.url}`);
        this.attach(ws);
        resolve();
      });
      ws.on('error', (err) => {
        this.logger.error({ err: err.message }, '连接协议端失败');
        reject(err);
      });
    });
  }

  private attach(ws: WebSocket): void {
    this.client = ws;
    this.sockets.add(ws);
    this.emit('connected');

    ws.on('message', (raw) => {
      let data: any;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        this.logger.warn('收到无法解析的 WS 消息');
        return;
      }

      // API 响应
      if (data.echo !== undefined && this.pending.has(String(data.echo))) {
        const p = this.pending.get(String(data.echo))!;
        this.pending.delete(String(data.echo));
        if (data.status === 'ok' || data.retcode === 0) p.resolve(data.data);
        else p.reject(new Error(`OneBot API 错误 retcode=${data.retcode} ${data.message ?? ''}`));
        return;
      }

      // 事件
      if (data.post_type) this.emit('event', data as OneBotEvent);
    });

    ws.on('close', (code) => {
      this.sockets.delete(ws);
      this.logger.warn({ code }, '协议端连接已关闭');
      this.emit('disconnected');
    });

    ws.on('error', (err) => this.logger.error({ err: err.message }, 'WS 连接错误'));
  }

  /** 调用 OneBot API */
  call(action: string, params: Record<string, unknown> = {}, timeoutMs = 10000): Promise<any> {
    return new Promise((resolve, reject) => {
      const ws = this.client;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return this.waitForConnection(timeoutMs).then(
          () => this.call(action, params, timeoutMs).then(resolve, reject),
          () => reject(new Error(`协议端未连接，无法调用 ${action}`)),
        );
      }
      const echo = `echo-${++this.echoSeq}`;
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot API 超时：${action}`));
      }, timeoutMs);

      this.pending.set(echo, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });

      ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  /** 等协议端连接就绪（供测试与启动流程使用） */
  waitForReady(timeoutMs = 10000): Promise<void> {
    return this.waitForConnection(timeoutMs);
  }

  /** 等待协议端建立连接，最多等 timeoutMs */
  private waitForConnection(timeoutMs: number): Promise<void> {
    if (this.isConnected()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('connected', onConnected);
        reject(new Error('等待协议端连接超时'));
      }, timeoutMs);
      const onConnected = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once('connected', onConnected);
    });
  }

  /** 发送私聊消息，返回 OneBot 的响应数据（含 message_id） */
  async sendPrivateMessage(userId: string | number, text: string): Promise<{ message_id?: number } | undefined> {
    return this.call('send_private_msg', {
      user_id: Number(userId),
      message: [{ type: 'text', data: { text } }],
    });
  }

  /**
   * 发送私聊消息，支持混合消息段（文本 + QQ 表情）。
   * segments 由 responder 的 emoji 模块解析产生。
   */
  async sendPrivateMessageSegments(
    userId: string | number,
    segments: OneBotMessageSegment[],
  ): Promise<{ message_id?: number } | undefined> {
    return this.call('send_private_msg', {
      user_id: Number(userId),
      message: segments,
    });
  }

  /** 发送 QQ 小黄脸表情 */
  async sendFace(userId: string | number, faceId: number): Promise<{ message_id?: number } | undefined> {
    return this.call('send_private_msg', {
      user_id: Number(userId),
      message: [{ type: 'face', data: { id: String(faceId) } }],
    });
  }

  /**
   * 发送语音消息（record 段）。
   *
   * OneBot 11 的 record 段：`{ type: 'record', data: { file: ... } }`。
   * file 支持本地路径 / URL / base64:// 数据 URI。Lagrange 对 base64 支持较好，
   * 所以这里统一走 base64，避免本地文件路径与协议端工作目录不一致的问题。
   */
  async sendPrivateVoice(
    userId: string | number,
    audio: Buffer,
    format = 'wav',
  ): Promise<{ message_id?: number } | undefined> {
    const b64 = audio.toString('base64');
    return this.call('send_private_msg', {
      user_id: Number(userId),
      message: [{ type: 'record', data: { file: `base64://${b64}`, format } }],
    });
  }

  async setFriendAddRequest(flag: string, approve: boolean, remark = ''): Promise<void> {
    await this.call('set_friend_add_request', { flag, approve, remark });
  }

  async setGroupAddRequest(flag: string, approve: boolean, reason = ''): Promise<void> {
    await this.call('set_group_add_request', { flag, sub_type: 'invite', approve, reason });
  }

  async leaveGroup(groupId: string | number): Promise<void> {
    await this.call('set_group_leave', { group_id: Number(groupId), is_dismiss: false });
  }

  isConnected(): boolean {
    return !!this.client && this.client.readyState === WebSocket.OPEN;
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const ws of this.sockets) ws.close(1000, 'shutdown');
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
  }

  describePeer(userId: string | number): string {
    return maskQQ(userId);
  }
}
