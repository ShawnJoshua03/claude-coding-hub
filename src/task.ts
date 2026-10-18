import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

export const terminal = new Set(['completed', 'failed', 'cancelled', 'denied']);
export function done(state: string) { return terminal.has(state); }

export type Question = { id: string; header: string; question: string; options?: string[] };
// A decision the worker is blocked on. `params` is the exact provider request shown to the human;
// `kind` is all the server needs to pick a form. Provider-specific replies stay inside the adapter.
export type Pending = { id: string | number; kind: 'approval' | 'question'; method: string; params: any; questions?: Question[]; claimed: boolean; abort?: AbortController };

// Provider-neutral task lifecycle. Invariants every adapter inherits:
// - a decision is answered at most once, and never after the task reaches a terminal state;
// - declining (or cancelling, or failing) stops the whole task and invalidates pending decisions;
// - the workspace stays locked (busy) until the worker process tree is confirmed stopped.
export abstract class BaseTask extends EventEmitter {
  readonly id = randomUUID(); state = 'starting'; result = ''; error = '';
  readonly pending = new Map<string | number, Pending>();
  abstract readonly provider: string;
  protected child?: ChildProcessWithoutNullStreams; protected stopped = false; protected deadline?: NodeJS.Timeout;
  cleanup: Promise<void> = Promise.resolve();
  constructor(readonly cwd: string) { super(); }

  abstract start(prompt: string): Promise<void>;
  protected abstract sendApprove(p: Pending): void;
  protected abstract sendAnswer(p: Pending, answers: Record<string, string>): void;
  protected abstract sendDecline(p: Pending): void;
  // Best-effort polite stop before the process tree is killed.
  protected abstract interrupt(): void;
  protected details(): Record<string, unknown> { return {}; }

  busy() { return !terminal.has(this.state) || !this.stopped; }
  snapshot() {
    return { taskId: this.id, provider: this.provider, state: this.state, processStopped: this.stopped, ...this.details(), pending: [...this.pending.values()].map(p => ({ requestId: p.id, kind: p.kind, method: p.method, params: p.params })), result: this.result, error: this.error };
  }
  protected changed() { this.emit('change'); }

  // Removes `p` if it is still the live decision. Returns false for stale, duplicate or late answers.
  private settle(p: Pending) {
    if (this.pending.get(p.id) !== p || terminal.has(this.state)) return false;
    this.pending.delete(p.id); return true;
  }
  private resume() { this.state = this.pending.size ? 'waiting_for_user' : 'running'; this.changed(); }
  protected addPending(p: Omit<Pending, 'claimed'>) {
    if (this.pending.has(p.id)) { this.fail(new Error('Duplicate provider request id')); return; }
    this.pending.set(p.id, { ...p, claimed: false }); this.state = 'waiting_for_user'; this.changed();
  }
  // Provider withdrew its own request (e.g. it timed out); never treat that as acceptance.
  protected withdraw(id: string | number) {
    const p = this.pending.get(id); if (!p) return;
    p.abort?.abort(); this.pending.delete(id); if (!terminal.has(this.state)) this.resume();
  }
  approve(p: Pending) { if (p.kind !== 'approval' || !this.settle(p)) return false; this.sendApprove(p); this.resume(); return true; }
  answer(p: Pending, answers: Record<string, string>) { if (p.kind !== 'question' || !this.settle(p)) return false; this.sendAnswer(p, answers); this.resume(); return true; }
  async deny(p: Pending) {
    if (!this.settle(p)) return;
    this.sendDecline(p); this.state = 'denied'; this.finish(); await this.cleanup;
  }
  async cancel() { if (terminal.has(this.state)) { await this.cleanup; return; } this.state = 'cancelled'; this.finish(); await this.cleanup; }
  protected fail(e: unknown) { if (terminal.has(this.state)) return; this.state = 'failed'; this.error = e instanceof Error ? e.message : 'Worker failed'; this.finish(); }
  protected complete(ok: boolean, error = '') { if (terminal.has(this.state)) return; this.state = ok ? 'completed' : 'failed'; this.error = error; this.finish(); }

  protected finish() {
    for (const p of this.pending.values()) p.abort?.abort(); this.pending.clear(); clearTimeout(this.deadline);
    this.onFinish();
    const child = this.child;
    if (child && this.state !== 'completed') this.interrupt();
    this.cleanup = new Promise<void>(resolve => {
      if (!child?.pid) { this.stopped = true; resolve(); return; }
      if (child.exitCode !== null) { this.error = 'Worker exited unexpectedly; descendant cleanup unconfirmed. Workspace remains locked until this MCP session is closed and owned processes are checked.'; resolve(); return; }
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => { this.error = 'Process tree cleanup failed; workspace stays locked'; resolve(); });
        killer.on('exit', code => { this.stopped = code === 0; if (!this.stopped) this.error = 'Process tree cleanup unconfirmed; workspace stays locked'; this.changed(); resolve(); });
      } else { child.once('exit', () => { this.stopped = true; this.changed(); resolve(); }); try { process.kill(-child.pid, 'SIGKILL'); } catch { this.error = 'Process group cleanup unconfirmed; workspace stays locked'; resolve(); } }
    });
    this.changed();
  }
  // Adapter hook for rejecting its own in-flight protocol requests.
  protected onFinish() {}
}

export function filteredEnvironment() {
  const allowed = ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'CODEX_HOME', 'LANG'];
  return Object.fromEntries(allowed.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]!]));
}
