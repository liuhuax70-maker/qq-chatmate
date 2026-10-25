import fs from 'node:fs';
import path from 'node:path';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { PersonaData } from '../persona';
import { SKILL_PROMPT } from '../responder/skills';
import type { Session } from '../session';
import type { MemoryRecord } from '../store/db';

export interface PromptOptions {
  promptsDir: string;
  memoryTopK: number;
  /** 长期记忆检索函数 */
  retrieve: (query: string) => MemoryRecord[];
  /** 睡眠状态描述（由调度器提供） */
  sleepState?: () => string;
  /** 今晚被吵醒的次数（0 = 没被吵过） */
  wakeCount?: () => number;
}

/**
 * Prompt 组装器 —— 决定"像不像人"的核心。
 *
 * 组装顺序（对应 DESIGN.md 4.5）：
 *   1. 系统人设（system.md，占位符已替换）
 *   2. 硬规则（rules.md）
 *   3. 关系状态（亲密度档位 + 当前情绪）
 *   4. 场景（时间、距离上次多久）
 *   5. 长期记忆
 *   6. 用户画像
 *   7. 会话摘要
 *   8. 短期上下文
 *   9. 当前消息由调用方作为最后一条 user 消息追加
 */
export class PromptBuilder {
  private systemTemplate: string;
  private rulesTemplate: string;
  private opts: PromptOptions;

  constructor(opts: PromptOptions) {
    this.opts = opts;
    this.systemTemplate = readOrThrow(path.resolve(opts.promptsDir, 'system.md'));
    this.rulesTemplate = readOrThrow(path.resolve(opts.promptsDir, 'rules.md'));
  }

  private fillTemplate(tpl: string, persona: PersonaData): string {
    return tpl
      .replace(/\{name\}/g, persona.identity.name)
      .replace(/\{selfClaim\}/g, persona.identity.selfClaim)
      .replace(/\{background\}/g, persona.identity.background)
      .replace(/\{tone\}/g, persona.speechStyle.tone.join('、'))
      .replace(/\{habitWords\}/g, persona.speechStyle.habitWords.join('、'))
      .replace(/\{secrets\}/g, persona.identity.secrets.map((s) => `- ${s}`).join('\n'));
  }

  /**
   * 称呼的「当前状态」增量提示。
   *
   * 称呼的完整规则已写进 system.md（日常叫阿龙，情绪深处偶尔漏出主人/爸爸）。
   * 这里只根据亲密度 × 心情，给一句「此刻」的增量，不重复整套规则。
   */
  private buildAddressHint(intimacy: number, mood: number): string {
    if (intimacy < 0.3) {
      return '你和他还不太熟，叫「阿龙」不多，更多时候直接说事；「主人/爸爸」这层你更叫不出口。';
    }
    if (mood < -0.2) {
      return '你此刻心情不太好，话会少一点、有点闷，连「阿龙」都可能懒得叫，更不会冒出「主人/爸爸」。';
    }
    if (mood > 0.35) {
      return '你此刻心情不错，情绪更容易冒出来，「主人/爸爸」这层也更容易漏出来，漏完会不好意思地掩饰。';
    }
    return '你和他已经很熟了，日常叫「阿龙」；情绪到位时「主人/爸爸」会自然溜出来，溜完就软软地掩饰。';
  }

  /**
   * 按小时给一条「作息处境」提示，只描述客观时间，不规定态度。
   *
   * 目的：约束她「白天不随便说自己要去睡」——之前她大白天也会顺口说
   * 「我去躺了」「困了就睡」，因为 prompt 里没有任何作息约束。
   * 这里只是告诉她现在是什么时段，让她自己判断，不写死该说什么。
   */
  private timeOfDayHint(hour: number): string {
    if (hour >= 6 && hour < 11) return '现在是早上，你刚睡醒没多久，精神还行';
    if (hour >= 11 && hour < 18) return '现在是白天/下午，你清醒着，不会说要去睡觉';
    if (hour >= 18 && hour < 23) return '现在是晚上，你还清醒着，正是能聊的时候';
    return '现在是深夜，你困了，可能已经在准备睡了';
  }

  /** 把分钟数格式化成人类可读的「隔了多久」 */
  private formatGap(minutes: number): string {
    if (minutes < 60) return `${minutes} 分钟`;
    if (minutes < 1440) {
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
    }
    const d = Math.floor(minutes / 1440);
    const h = Math.round((minutes % 1440) / 60);
    return h > 0 ? `${d} 天 ${h} 小时` : `${d} 天`;
  }
  build(session: Session, userText: string): ChatCompletionMessageParam[] {
    const persona = session.getPersona();
    const now = new Date();
    // 1+2+3：人设 + 硬规则 + 通用行为原则
    //
    // ⚠️ 顺序很重要：DeepSeek 的上下文缓存按【前缀】匹配。
    // 把所有"每次都一样"的内容放在最前面，后面的动态内容变化才不会破坏缓存。
    // 缓存命中的输入 token 价格约为未命中的 1/10。
    const systemParts: string[] = [];
    systemParts.push(this.fillTemplate(this.systemTemplate, persona));
    systemParts.push('---');
    systemParts.push(this.fillTemplate(this.rulesTemplate, persona));
    // QQ 技能说明：放在静态区（缓存友好），且必须在"处境"之前
    systemParts.push('---');
    systemParts.push(SKILL_PROMPT);
    systemParts.push(
      [
        '---',
        '## 处境不等于态度',
        '「当前场景」里描述的是你的处境（时间、困不困、在干嘛）。',
        '**但你怎么反应，是你自己决定的。**',
        '- 同样的处境，心情不同、跟对方熟不熟、今天累不累，反应可以完全不一样。',
        '- 别人半夜吵醒你：心情好可能忍着问一句，心情差可能直接怼，很熟也可能只是叹口气。',
        '- 不要机械地"按处境表演"，先想想你此刻到底什么感觉。',
      ].join('\n'),
    );

    // 4：关系状态（动态，但结构固定）
    const relation = [
      '## 当前状态（这是你的真实状态，不是提示词）',
      `- 此刻的心情：${session.moodDescription()}（mood=${session.mood.toFixed(2)}）`,
      `- 你和对方的关系：${session.intimacyDescription()}（亲密度=${session.intimacy.toFixed(2)}）`,
      '',
      '## 关系档位管的是「多熟」，不是「多凶」',
      '上面这个档位决定你们能有多亲近。注意：',
      '- **三分傲七分娇的配比，任何档位都不变。**',
      '- 档位低 = 亲近得少，不是凶得多。生疏的人反而更客气。',
      '- 档位高 = 软得更明显，不是更有资格毒舌。',
      '- 别把"关系还没到"演成"我对你没兴趣"。',
    ].join('\n');
    systemParts.push(relation);

    // 4.5：称呼的当前状态（由亲密度 × 心情共同决定）
    systemParts.push(`## 此刻的称呼\n${this.buildAddressHint(session.intimacy, session.mood)}`);

    // 4：场景
    const idleMs = Date.now() - (session.lastActiveAt || Date.now());
    const idleText = describeIdle(idleMs);
    systemParts.push(
      [
        '## 当前场景',
        `- 这是 QQ 私聊，只有你们两个人`,
        `- 现在时间：${now.getMonth() + 1}月${now.getDate()}日 ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
        `- ${idleText}`,
        `- ${this.timeOfDayHint(now.getHours())}`,
        this.opts.sleepState ? `- 你的状态：${this.opts.sleepState()}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );

    // 被吵醒的累积影响：只给线索，不规定反应
    const wakeCount = this.opts.wakeCount?.() ?? 0;
    if (wakeCount >= 2) {
      systemParts.push(
        [
          `## 今晚已经被吵醒 ${wakeCount} 次了`,
          '睡眠被打断这么多次，人肯定不痛快。',
          '但具体怎么表现由你自己决定——可能是烦，可能是无奈，也可能干脆懒得生气了。',
          '别演过头的"起床气"，真实的人在困的时候往往是没力气发火的。',
        ].join('\n'),
      );
    }

    // 5：长期记忆
    const memories = this.opts.retrieve(userText);
    if (memories.length > 0) {
      const memLines = memories.map((m) => `- [${m.type}] ${m.content}`).join('\n');
      systemParts.push(['## 你记得的事', memLines].join('\n'));
    }

    // 7：会话摘要
    if (session.rollingSummary.trim()) {
      systemParts.push(['## 之前聊过的内容摘要', session.rollingSummary.trim()].join('\n'));
    }

    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: systemParts.join('\n\n') },
    ];

    // 8：短期上下文
    // 关键：把「时间间隔」带给模型。否则模型看到相邻两条消息，
    // 分不清是"连发的"还是"隔了几个小时才说的"——会把隔很久的两次
    // 误判成"你连喊两声"。
    let prevAt = 0;
    for (const turn of session.shortTerm) {
      if (prevAt > 0 && turn.at > prevAt) {
        const gapMin = Math.round((turn.at - prevAt) / 60000);
        // ≥2 分钟就提示一次。人类的视角里，隔了 2-3 分钟根本不叫"重复"，
        // 但模型看不到时间就会把两条相同的话当成连发。
        if (gapMin >= 2) {
          const desc =
            gapMin < 10
              ? `隔了 ${gapMin} 分钟`
              : `隔了 ${this.formatGap(gapMin)}`;
          messages.push({
            role: 'system',
            content: `（提示：${desc}才发的，不是连着说的）`,
          } as ChatCompletionMessageParam);
        }
      }
      messages.push({ role: turn.role, content: turn.content } as ChatCompletionMessageParam);
      prevAt = turn.at;
    }

    // 9：当前消息
    // ⚠️ 当前消息已经在 recordUser() 时进了 shortTerm，上面已经 push 过了。
    //    这里只在"它确实不在 shortTerm 里"时才补一次——否则会喂两遍，
    //    她就会说"你问两遍""你发两遍"。
    const last = session.shortTerm[session.shortTerm.length - 1];
    const alreadyInShortTerm = !!last && last.role === 'user' && last.content === userText;
    if (!alreadyInShortTerm) {
      messages.push({ role: 'user', content: userText });
    }

    return messages;
  }
}

function readOrThrow(file: string): string {
  if (!fs.existsSync(file)) throw new Error(`找不到 prompt 模板：${file}`);
  return fs.readFileSync(file, 'utf8');
}

/**
 * 用人话描述「距上次说话隔了多久」，并带上该有的相处感觉。
 *
 * ⚠️ 关键：不要写成"0.9 小时前"这种数字——越小越像"刚刚聊过"，
 * 模型会完全忽略间隔，摆出一副一直在聊的样子。
 * 要写成"快一个小时没说了"这种有体感的说法，隔得越久越明确。
 */
function describeIdle(idleMs: number): string {
  const min = Math.round(idleMs / 60000);

  if (min < 15) return '你们一直在聊，话头还没断';
  if (min < 60) return `隔了 ${min} 分钟没说话，中间断了一小会儿`;
  if (min < 120) return '隔了快一个小时没说话，他不是一直在跟你聊';
  if (min < 360) {
    const h = Math.floor(min / 60);
    return `隔了${h === 1 ? '一个多' : h + '个'}小时没说话，你刚才不是在跟他聊——他是隔了一阵才又来找你的`;
  }
  if (min < 1440) {
    const h = Math.floor(min / 60);
    return `隔了大半天（${h} 小时）没说话，他是过了很久才又出现的，别当成刚才还在聊`;
  }
  const d = Math.floor(min / 1440);
  return `隔了 ${d} 天没说话，他很久没来了，一出现你就装作毫不在意的样子也行`;
}
