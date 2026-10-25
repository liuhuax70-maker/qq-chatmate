import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  at: number;
}

export interface SessionRecord {
  sessionId: string;
  intimacy: number;
  mood: number;
  rollingSummary: string;
  summaryUpdatedAt: number;
  lastActiveAt: number;
  proactiveIgnoreStreak: number;
}

export interface MemoryRecord {
  id: number;
  scope: string;
  scopeId: string;
  type: string;
  content: string;
  importance: number;
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
}

/** 长期记忆类型 */
export type MemoryType = 'fact' | 'promise' | 'event' | 'preference' | 'opinion';

export class Store {
  private db: Database.Database;

  constructor(dbPath: string) {
    const abs = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    this.db = new Database(abs);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_state (
        session_id TEXT PRIMARY KEY,
        intimacy REAL DEFAULT 0,
        mood REAL DEFAULT 0,
        rolling_summary TEXT DEFAULT '',
        summary_updated_at INTEGER DEFAULT 0,
        last_active_at INTEGER DEFAULT 0,
        proactive_ignore_streak INTEGER DEFAULT 0,
        updated_at INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS user_profiles (
        user_id TEXT PRIMARY KEY,
        display_name TEXT,
        aliases TEXT DEFAULT '[]',
        traits TEXT DEFAULT '[]',
        preferences TEXT DEFAULT '[]',
        interaction_count INTEGER DEFAULT 0,
        first_seen_at INTEGER,
        last_seen_at INTEGER,
        last_topic TEXT
      );

      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT DEFAULT 'user',
        scope_id TEXT,
        type TEXT DEFAULT 'fact',
        content TEXT NOT NULL,
        importance REAL DEFAULT 0.5,
        created_at INTEGER,
        last_accessed_at INTEGER,
        access_count INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS chat_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        role TEXT,
        content TEXT,
        token_usage INTEGER,
        latency_ms INTEGER,
        created_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, scope_id);
      CREATE INDEX IF NOT EXISTS idx_logs_session ON chat_logs(session_id, created_at);

      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER DEFAULT 0
      );
    `);
  }

  // ── 通用 KV 存储（用于调度器状态等） ──────────────────────

  getKv(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM kv_store WHERE key = ?').get(key) as any;
    return row?.value;
  }

  setKv(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, Date.now());
  }

  // ── 会话状态 ────────────────────────────────────────────

  getSession(sessionId: string): SessionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM session_state WHERE session_id = ?').get(sessionId) as any;
    if (!row) return undefined;
    return {
      sessionId: row.session_id,
      intimacy: row.intimacy ?? 0,
      mood: row.mood ?? 0,
      rollingSummary: row.rolling_summary ?? '',
      summaryUpdatedAt: row.summary_updated_at ?? 0,
      lastActiveAt: row.last_active_at ?? 0,
      proactiveIgnoreStreak: row.proactive_ignore_streak ?? 0,
    };
  }

  saveSession(s: SessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO session_state
           (session_id, intimacy, mood, rolling_summary, summary_updated_at, last_active_at, proactive_ignore_streak, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           intimacy = excluded.intimacy,
           mood = excluded.mood,
           rolling_summary = excluded.rolling_summary,
           summary_updated_at = excluded.summary_updated_at,
           last_active_at = excluded.last_active_at,
           proactive_ignore_streak = excluded.proactive_ignore_streak,
           updated_at = excluded.updated_at`,
      )
      .run(
        s.sessionId,
        s.intimacy,
        s.mood,
        s.rollingSummary,
        s.summaryUpdatedAt,
        s.lastActiveAt,
        s.proactiveIgnoreStreak,
        Date.now(),
      );
  }

  // ── 对话日志 ────────────────────────────────────────────

  logChat(sessionId: string, role: 'user' | 'assistant', content: string, meta?: { tokens?: number; latencyMs?: number }): void {
    this.db
      .prepare('INSERT INTO chat_logs (session_id, role, content, token_usage, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sessionId, role, content, meta?.tokens ?? null, meta?.latencyMs ?? null, Date.now());
  }

  recentChats(sessionId: string, limit: number): StoredMessage[] {
    const rows = this.db
      .prepare('SELECT role, content, created_at FROM chat_logs WHERE session_id = ? ORDER BY id DESC LIMIT ?')
      .all(sessionId, limit) as any[];
    return rows.reverse().map((r) => ({ role: r.role, content: r.content, at: r.created_at }));
  }

  /**
   * 清理过期的对话日志。
   *
   * 问题：chat_logs 只增不删，跑几个月就是几十万行，
   * 不仅占磁盘，recentChats 的索引也会变慢。
   *
   * 策略：只保留最近 retentionDays 天。启动时和每 24 小时各跑一次。
   * 记忆表（memories）不动——那是提炼过的长期信息，才是真正要留的。
   */
  pruneChatLogs(retentionDays = 90): number {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const info = this.db.prepare('DELETE FROM chat_logs WHERE created_at < ?').run(cutoff);
    return info.changes;
  }

  // ── 记忆 ────────────────────────────────────────────────

  addMemory(m: { scope: string; scopeId: string; type: MemoryType; content: string; importance: number }): void {
    this.db
      .prepare(
        `INSERT INTO memories (scope, scope_id, type, content, importance, created_at, last_accessed_at, access_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(m.scope, m.scopeId, m.type, m.content, m.importance, Date.now(), Date.now());
  }

  /**
   * 检索记忆。v1 用关键词 + 重要度打分，不依赖向量服务。
   * 向量检索可作为后续增强（config.memory.vector）。
   */
  searchMemories(scopeId: string, query: string, topK: number): MemoryRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM memories WHERE scope_id = ? ORDER BY importance DESC, created_at DESC LIMIT 200')
      .all(scopeId) as any[];

    const q = query.toLowerCase();
    const tokens = q.split(/[\s，。,.!?！？~～]+/).filter((t) => t.length >= 1);

    const scored = rows.map((r) => {
      const content = String(r.content).toLowerCase();
      let score = r.importance * 0.5;
      for (const t of tokens) {
        if (t.length >= 2 && content.includes(t)) score += 0.5;
      }
      // 新近度加成
      const ageDays = (Date.now() - (r.created_at ?? 0)) / 86400000;
      score += Math.max(0, 0.2 - ageDays * 0.002);
      return { row: r, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const picked = scored.slice(0, topK).map((s) => s.row);

    // 更新访问计数
    const touch = this.db.prepare('UPDATE memories SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?');
    for (const p of picked) touch.run(Date.now(), p.id);

    return picked.map((r) => ({
      id: r.id,
      scope: r.scope,
      scopeId: r.scope_id,
      type: r.type,
      content: r.content,
      importance: r.importance,
      createdAt: r.created_at,
      lastAccessedAt: r.last_accessed_at,
      accessCount: r.access_count,
    }));
  }

  listPromisesDue(scopeId: string, horizonMs: number): MemoryRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM memories WHERE scope_id = ? AND type = 'promise' ORDER BY created_at DESC LIMIT 50")
      .all(scopeId) as any[];
    const now = Date.now();
    return rows
      .filter((r) => now - (r.created_at ?? 0) <= horizonMs)
      .map((r) => ({
        id: r.id,
        scope: r.scope,
        scopeId: r.scope_id,
        type: r.type,
        content: r.content,
        importance: r.importance,
        createdAt: r.created_at,
        lastAccessedAt: r.last_accessed_at,
        accessCount: r.access_count,
      }));
  }

  // ── 用户画像 ────────────────────────────────────────────

  getUserProfile(userId: string): Record<string, any> | undefined {
    const row = this.db.prepare('SELECT * FROM user_profiles WHERE user_id = ?').get(userId) as any;
    if (!row) return undefined;
    return {
      ...row,
      aliases: safeParse(row.aliases),
      traits: safeParse(row.traits),
      preferences: safeParse(row.preferences),
    };
  }

  upsertUserProfile(userId: string, displayName: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO user_profiles (user_id, display_name, interaction_count, first_seen_at, last_seen_at)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           display_name = excluded.display_name,
           interaction_count = interaction_count + 1,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(userId, displayName, now, now);
  }

  close(): void {
    this.db.close();
  }
}

function safeParse(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
