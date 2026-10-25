/**
 * QQ 技能层。
 *
 * 设计意图：
 *   OneBot 11 有一大堆 API，但之前只用了 4 个（发消息、好友请求、退群）。
 *   这个模块把 NapCat 支持的能力包成「技能」，供上层（人格 / LLM）调用。
 *
 * 分层：
 *   - 这里只做「能不能做、怎么做」，不判断「该不该做」
 *   - 「该不该做」由人格层决定（比如被惹生气了才拉黑）
 *   - 所有方法都返回 { ok, data?, error? }，绝不抛异常打断对话
 *
 * 安全边界：
 *   - 危险操作（拉黑、删好友、退群）默认需要显式开关
 *   - 只对白名单用户生效，不会误伤陌生人
 */

import type { Logger } from 'pino';
import type { OneBotAdapter, OneBotMessageSegment } from './onebot';

export interface SkillResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** 技能元信息：给 LLM 看的「我会什么」 */
export interface SkillSpec {
  name: string;
  /** 中文说明，写进 prompt */
  desc: string;
  /** 危险等级：safe 随便用 / risky 需要理由 / destructive 需要强理由 */
  level: 'safe' | 'risky' | 'destructive';
  /** 参数说明 */
  args?: string;
}

export const SKILL_SPECS: SkillSpec[] = [
  // ── 消息类（safe：日常表达）──────────────────────────────
  { name: 'send_text', desc: '发文字消息', level: 'safe', args: 'text' },
  { name: 'send_image', desc: '发图片（本地路径 / URL / base64）', level: 'safe', args: 'file' },
  { name: 'send_face', desc: '发 QQ 小黄脸表情', level: 'safe', args: 'faceId' },
  { name: 'send_record', desc: '发语音', level: 'safe', args: 'file' },
  { name: 'send_video', desc: '发视频', level: 'safe', args: 'file' },
  { name: 'send_file', desc: '发文件', level: 'safe', args: 'file, name?' },
  { name: 'send_sticker', desc: '发收藏的表情包（图库随机/指定）', level: 'safe', args: 'url?' },
  { name: 'forward_msg', desc: '合并转发多条消息（像转发聊天记录）', level: 'safe', args: 'messages[]' },
  { name: 'recall_msg', desc: '撤回自己刚发的消息', level: 'risky', args: 'messageId' },

  // ── 互动类（safe：增加真实感）────────────────────────────
  { name: 'poke', desc: '戳一戳对方（QQ 的拍一拍）', level: 'safe', args: 'userId?' },
  { name: 'send_like', desc: '给对方的资料卡点赞', level: 'safe', args: 'times?' },

  // ── 资料类（risky：改了自己的资料要谨慎）────────────────
  { name: 'get_stranger_info', desc: '查对方资料（昵称、签名、等级）', level: 'safe', args: 'userId?' },
  { name: 'get_friend_list', desc: '查好友列表', level: 'safe' },
  { name: 'set_qq_profile', desc: '改自己的昵称/签名', level: 'risky', args: 'nickname?, personalNote?' },
  { name: 'set_qq_avatar', desc: '改自己的头像', level: 'risky', args: 'file' },

  // ── 社交类（destructive：会破坏关系）─────────────────────
  { name: 'set_friend_remark', desc: '给对方设置备注名', level: 'risky', args: 'remark' },
  { name: 'delete_friend', desc: '删除好友（拉黑前一步）', level: 'destructive', args: 'userId?' },
  { name: 'set_friend_add_request', desc: '同意/拒绝好友申请', level: 'risky', args: 'flag, approve' },

  // ── 群类（destructive：群操作影响面大）───────────────────
  { name: 'get_group_list', desc: '查自己所在的群', level: 'safe' },
  { name: 'send_group_msg', desc: '在群里发消息', level: 'risky', args: 'groupId, text' },
  { name: 'set_group_ban', desc: '群禁言', level: 'destructive', args: 'groupId, userId, duration' },
  { name: 'set_group_kick', desc: '踢人出群', level: 'destructive', args: 'groupId, userId' },
  { name: 'set_group_leave', desc: '退群', level: 'destructive', args: 'groupId' },
];

/**
 * 技能执行器。
 *
 * 只做一件事：把技能名 + 参数翻译成 OneBot API 调用。
 * 权限判断、情绪判断、频率限制都在调用方。
 */
export class QqSkills {
  private adapter: OneBotAdapter;
  private logger: Logger;
  private selfId: string;

  /** 最近发出去的消息 id（用于撤回） */
  private recentSentIds: number[] = [];

  /** 危险技能是否启用（默认关，需要人格层显式打开） */
  private destructiveEnabled = false;

  constructor(adapter: OneBotAdapter, logger: Logger, selfId: string) {
    this.adapter = adapter;
    this.logger = logger;
    this.selfId = selfId;
  }

  /** 打开危险技能（拉黑/删好友/退群等） */
  enableDestructive(): void {
    this.destructiveEnabled = true;
  }

  /** 给 LLM 的技能清单文本 */
  describeSkills(): string {
    return SKILL_SPECS.filter((s) => s.level !== 'destructive' || this.destructiveEnabled)
      .map((s) => `- ${s.name}：${s.desc}${s.args ? `（参数：${s.args}）` : ''}`)
      .join('\n');
  }

  /** 记录发出去的消息 id，供撤回用 */
  rememberSent(id: number | undefined): void {
    if (typeof id === 'number') {
      this.recentSentIds.push(id);
      if (this.recentSentIds.length > 20) this.recentSentIds.shift();
    }
  }

  // ── 消息类 ──────────────────────────────────────────────

  async sendText(userId: string, text: string): Promise<SkillResult> {
    return this.wrap('send_text', async () => {
      const r = await this.adapter.sendPrivateMessage(userId, text);
      this.rememberSent(r?.message_id);
      return r;
    });
  }

  async sendImage(userId: string, file: string): Promise<SkillResult> {
    return this.wrap('send_image', async () => {
      const seg: OneBotMessageSegment = { type: 'image', data: { file } };
      const r = await this.adapter.sendPrivateMessageSegments(userId, [seg]);
      this.rememberSent(r?.message_id);
      return r;
    });
  }

  async sendFace(userId: string, faceId: number): Promise<SkillResult> {
    return this.wrap('send_face', () => this.adapter.sendFace(userId, faceId));
  }

  async sendRecord(userId: string, file: string): Promise<SkillResult> {
    return this.wrap('send_record', async () => {
      const seg: OneBotMessageSegment = { type: 'record', data: { file } };
      return this.adapter.sendPrivateMessageSegments(userId, [seg]);
    });
  }

  async sendVideo(userId: string, file: string): Promise<SkillResult> {
    return this.wrap('send_video', async () => {
      const seg: OneBotMessageSegment = { type: 'video', data: { file } };
      return this.adapter.sendPrivateMessageSegments(userId, [seg]);
    });
  }

  async sendFile(userId: string, file: string, name?: string): Promise<SkillResult> {
    return this.wrap('send_file', () =>
      this.adapter.call('upload_private_file', {
        user_id: Number(userId),
        file,
        name: name ?? file.split(/[\\/]/).pop() ?? 'file',
      }),
    );
  }

  async sendSticker(userId: string, url: string): Promise<SkillResult> {
    return this.sendImage(userId, url);
  }

  /** 合并转发：把多条消息打包成一条「聊天记录」 */
  async forwardMsg(userId: string, messages: string[]): Promise<SkillResult> {
    return this.wrap('forward_msg', async () => {
      // 构造转发节点
      const nodes = messages.map((text) => ({
        type: 'node',
        data: {
          user_id: Number(this.selfId),
          nickname: '大肥鱼',
          content: [{ type: 'text', data: { text } }],
        },
      }));
      return this.adapter.call('send_private_forward_msg', {
        user_id: Number(userId),
        messages: nodes,
      });
    });
  }

  /** 撤回消息。不传 id 就撤最近一条自己发的。 */
  async recallMsg(userId: string, messageId?: number): Promise<SkillResult> {
    const target = messageId ?? this.recentSentIds[this.recentSentIds.length - 1];
    if (!target) return { ok: false, error: '没有可撤回的消息' };
    return this.wrap('recall_msg', () => this.adapter.call('delete_msg', { message_id: target }));
  }

  // ── 互动类 ──────────────────────────────────────────────

  /** 戳一戳（QQ 的"拍一拍"） */
  async poke(userId?: string): Promise<SkillResult> {
    const target = userId ?? this.selfId;
    return this.wrap('poke', () =>
      this.adapter.call('friend_poke', { user_id: Number(target) }),
    );
  }

  /** 资料卡点赞 */
  async sendLike(userId: string, times = 1): Promise<SkillResult> {
    return this.wrap('send_like', () =>
      this.adapter.call('send_like', { user_id: Number(userId), times: Math.min(times, 10) }),
    );
  }

  // ── 资料类 ──────────────────────────────────────────────

  async getStrangerInfo(userId?: string): Promise<SkillResult> {
    const target = userId ?? this.selfId;
    return this.wrap('get_stranger_info', () =>
      this.adapter.call('get_stranger_info', { user_id: Number(target), no_cache: false }),
    );
  }

  async getFriendList(): Promise<SkillResult> {
    return this.wrap('get_friend_list', () => this.adapter.call('get_friend_list', {}));
  }

  async setProfile(nickname?: string, personalNote?: string): Promise<SkillResult> {
    return this.wrap('set_qq_profile', () =>
      this.adapter.call('set_qq_profile', {
        ...(nickname ? { nickname } : {}),
        ...(personalNote ? { personal_note: personalNote } : {}),
      }),
    );
  }

  async setAvatar(file: string): Promise<SkillResult> {
    return this.wrap('set_qq_avatar', () => this.adapter.call('set_qq_avatar', { file }));
  }

  // ── 社交类（危险）────────────────────────────────────────

  async setFriendRemark(userId: string, remark: string): Promise<SkillResult> {
    return this.wrap('set_friend_remark', () =>
      this.adapter.call('set_friend_remark', { user_id: Number(userId), remark }),
    );
  }

  /** 删除好友。需要 destructive 已启用。 */
  async deleteFriend(userId: string): Promise<SkillResult> {
    if (!this.destructiveEnabled) return { ok: false, error: '危险技能未启用' };
    return this.wrap('delete_friend', () =>
      this.adapter.call('delete_friend', { user_id: Number(userId) }),
    );
  }

  // ── 群类（危险）──────────────────────────────────────────

  async getGroupList(): Promise<SkillResult> {
    return this.wrap('get_group_list', () => this.adapter.call('get_group_list', {}));
  }

  async sendGroupMsg(groupId: string, text: string): Promise<SkillResult> {
    return this.wrap('send_group_msg', () =>
      this.adapter.call('send_group_msg', {
        group_id: Number(groupId),
        message: [{ type: 'text', data: { text } }],
      }),
    );
  }

  async setGroupBan(groupId: string, userId: string, durationSec: number): Promise<SkillResult> {
    if (!this.destructiveEnabled) return { ok: false, error: '危险技能未启用' };
    return this.wrap('set_group_ban', () =>
      this.adapter.call('set_group_ban', {
        group_id: Number(groupId),
        user_id: Number(userId),
        duration: durationSec,
      }),
    );
  }

  async setGroupKick(groupId: string, userId: string): Promise<SkillResult> {
    if (!this.destructiveEnabled) return { ok: false, error: '危险技能未启用' };
    return this.wrap('set_group_kick', () =>
      this.adapter.call('set_group_kick', {
        group_id: Number(groupId),
        user_id: Number(userId),
        reject_add_request: false,
      }),
    );
  }

  async leaveGroup(groupId: string): Promise<SkillResult> {
    if (!this.destructiveEnabled) return { ok: false, error: '危险技能未启用' };
    return this.wrap('set_group_leave', () => this.adapter.leaveGroup(groupId));
  }

  // ── 内部 ────────────────────────────────────────────────

  /** 统一包装：不抛异常，只返回 ok/error */
  private async wrap(name: string, fn: () => Promise<unknown>): Promise<SkillResult> {
    try {
      const data = await fn();
      this.logger.info({ skill: name }, 'QQ 技能执行成功');
      return { ok: true, data };
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.warn({ skill: name, err: msg }, 'QQ 技能执行失败');
      return { ok: false, error: msg };
    }
  }
}
