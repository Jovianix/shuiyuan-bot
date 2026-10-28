import { DatabaseSync } from 'node:sqlite';
import type { Answer, ContextPack, State, Task } from './types.js';

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string, readonly site: string, readonly petId: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY, site TEXT NOT NULL, pet_id TEXT NOT NULL, source_id INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued', mode TEXT NOT NULL, origin TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL DEFAULT 0,
        session_id TEXT, context TEXT, answer TEXT, error TEXT, sent_id INTEGER, send_started INTEGER,
        created_at INTEGER NOT NULL, UNIQUE(site,pet_id,source_id));
      CREATE TABLE IF NOT EXISTS experiences (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL,
        kind TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS task_state ON tasks(state,available_at);`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.db.close(); }
  getMeta<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as {value: string} | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }
  setMeta(key: string, value: unknown): void {
    this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, JSON.stringify(value));
  }
  /** A post already queued keeps its original task, so it is never answered twice. */
  enqueue(sourceId: number, mode: 'draft' | 'reply', origin: string, context: ContextPack | null = null): number {
    if (!Number.isSafeInteger(sourceId) || sourceId <= 0) throw new Error('Invalid source ID');
    this.db.prepare('INSERT OR IGNORE INTO tasks(site,pet_id,source_id,mode,origin,context,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(this.site, this.petId, sourceId, mode, origin, context && JSON.stringify(context), Date.now());
    return (this.db.prepare('SELECT id FROM tasks WHERE site=? AND pet_id=? AND source_id=?').get(this.site, this.petId, sourceId) as {id: number}).id;
  }
  task(id: number): Task {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as unknown as Task;
    if (!row) throw new Error('Task not found');
    return {...row, context: row.context ? JSON.parse(String(row.context)) as ContextPack : null,
      answer: row.answer ? JSON.parse(String(row.answer)) as Answer : null};
  }
  list(...states: State[]): Task[] {
    const rows = states.length
      ? this.db.prepare(`SELECT id FROM tasks WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY id`).all(...states)
      : this.db.prepare('SELECT id FROM tasks ORDER BY id').all();
    return rows.map(row => this.task(Number(row.id)));
  }
  update(id: number, patch: Partial<Omit<Task, 'id' | 'source_id' | 'created_at'>>): void {
    const entries = Object.entries(patch);
    if (!entries.length) return;
    const values = entries.map(([key, value]) => (key === 'context' || key === 'answer') && value !== null ? JSON.stringify(value) : value);
    this.db.prepare(`UPDATE tasks SET ${entries.map(([key]) => `${key}=?`).join(',')} WHERE id=?`).run(...values as (string | number | null)[], id);
  }
  /** The single task the worker should run now, without hydrating the whole table. */
  next(now: number, allowReply: boolean): Task | undefined {
    const row = this.db.prepare(`SELECT id FROM tasks WHERE available_at<=?
      AND (state='queued' OR (state='draft_ready' AND mode='reply' AND ?)) ORDER BY id LIMIT 1`)
      .get(now, allowReply ? 1 : 0) as {id: number} | undefined;
    return row ? this.task(row.id) : undefined;
  }
  counts(): Record<State, number> {
    const counts = {queued: 0, generating: 0, draft_ready: 0, sending: 0, sent: 0, delivery_unknown: 0, failed: 0, skipped: 0} as Record<State, number>;
    for (const row of this.db.prepare('SELECT state, COUNT(*) AS n FROM tasks GROUP BY state').all() as {state: State; n: number}[]) {
      if (row.state in counts) counts[row.state] = row.n;
    }
    return counts;
  }
  record(id: number, kind: string, data: unknown): void {
    this.db.prepare('INSERT INTO experiences(task_id,kind,data,at) VALUES (?,?,?,?)').run(id, kind, JSON.stringify(data), Date.now());
  }
}
