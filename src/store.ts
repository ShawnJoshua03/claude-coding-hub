import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Workspace } from './workspace.js';

export type TaskRow = { taskId: string; prompt: string; state: string; provider: string; branch: string; result: string; error: string; threadId: string; createdAt: string; updatedAt: string };
export type EventRow = { seq: number; taskId: string; at: string; type: string; data: unknown };
const terminal = ['completed', 'failed', 'cancelled', 'denied', 'interrupted'];

// Durable task list and audit log. The live process handle stays in memory; only facts needed
// to report on and audit a task after a restart are stored here.
export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY, prompt TEXT NOT NULL, state TEXT NOT NULL, result TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '', thread_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, at TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_task ON events (task_id, seq);`);
    const columns = new Set((this.db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(c => c.name));
    if (!columns.has('provider')) this.db.exec("ALTER TABLE tasks ADD COLUMN provider TEXT NOT NULL DEFAULT 'codex'");
    if (!columns.has('workspace')) this.db.exec("ALTER TABLE tasks ADD COLUMN workspace TEXT NOT NULL DEFAULT ''");
  }
  create(taskId: string, prompt: string, provider = 'codex', workspace?: Workspace) {
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO tasks (task_id, prompt, state, provider, workspace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(taskId, prompt, 'starting', provider, workspace ? JSON.stringify(workspace) : '', now, now);
    this.event(taskId, 'created', { promptChars: prompt.length, provider, branch: workspace?.branch, base: workspace?.base });
  }
  update(taskId: string, f: { state: string; result: string; error: string; threadId?: unknown }) {
    this.db.prepare('UPDATE tasks SET state = ?, result = ?, error = ?, thread_id = ?, updated_at = ? WHERE task_id = ?')
      .run(f.state, f.result, f.error, typeof f.threadId === 'string' ? f.threadId : '', new Date().toISOString(), taskId);
  }
  workspace(taskId: string): Workspace | undefined {
    const r = this.db.prepare('SELECT workspace FROM tasks WHERE task_id = ?').get(taskId) as { workspace: string } | undefined;
    return r?.workspace ? JSON.parse(r.workspace) : undefined;
  }
  setWorkspaceRemoved(taskId: string) { this.db.prepare("UPDATE tasks SET workspace = '' WHERE task_id = ?").run(taskId); }
  event(taskId: string, type: string, data: unknown = {}) {
    this.db.prepare('INSERT INTO events (task_id, at, type, data) VALUES (?, ?, ?, ?)').run(taskId, new Date().toISOString(), type, JSON.stringify(data));
  }
  private toTask(r: any): TaskRow {
    return { taskId: r.task_id, prompt: r.prompt, state: r.state, provider: r.provider, branch: r.workspace ? JSON.parse(r.workspace).branch : '', result: r.result, error: r.error, threadId: r.thread_id, createdAt: r.created_at, updatedAt: r.updated_at };
  }
  get(taskId: string): TaskRow | undefined {
    const r = this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
    return r ? this.toTask(r) : undefined;
  }
  list(limit = 20): TaskRow[] {
    return this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit).map(r => this.toTask(r));
  }
  events(taskId: string, limit = 100): EventRow[] {
    return this.db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY seq ASC LIMIT ?').all(taskId, limit)
      .map((r: any) => ({ seq: r.seq, taskId: r.task_id, at: r.at, type: r.type, data: JSON.parse(r.data) }));
  }
  // Tasks left non-terminal by a previous process cannot still be running under us, so mark them
  // interrupted instead of leaving them looking alive.
  recover(): string[] {
    const marks = terminal.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT task_id FROM tasks WHERE state NOT IN (${marks})`).all(...terminal) as { task_id: string }[];
    for (const { task_id } of rows) {
      this.db.prepare("UPDATE tasks SET state = 'interrupted', error = ?, updated_at = ? WHERE task_id = ?")
        .run('Hub restarted while this task was active; its worker process was not recovered. Check the fixture before retrying.', new Date().toISOString(), task_id);
      this.event(task_id, 'interrupted', { reason: 'hub restart' });
    }
    return rows.map(r => r.task_id);
  }
  close() { this.db.close(); }
}
