import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { BaseTask, terminal, type Pending } from './task.js';

export type Envelope = { jsonrpc?: string; id?: string | number; method?: string; params?: any; result?: any; error?: any };
export type Launch = { command: string; args: string[]; env: Record<string, string> };

// Agent Client Protocol (ACP) plumbing shared by every provider that speaks it over stdio.
// The client advertises no fs or terminal capability, so the agent can only act through its own tools,
// and every one of those that asks permission becomes exactly one human decision through BaseTask.
//
// ACP does not guarantee that a permission request shows what will actually run. Each adapter must say,
// in unreviewable(), which requests carry an exact, hub-verifiable view of the action; the rest are
// refused and never reach the human. Only the provider's allow_once option is ever selected.
export abstract class AcpTask extends BaseTask {
  sessionId = '';
  protected home = '';
  private seq = 0;
  private requests = new Map<number, { resolve: (x: any) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }>();

  // Preflight checks plus the exact process to run. Throw to fail closed before anything starts.
  protected abstract prepare(): Promise<Launch>;
  // Why this permission request cannot be shown to the human exactly (undefined when it can).
  protected abstract unreviewable(toolCall: any): string | undefined;
  protected async authenticate(): Promise<void> {}
  protected checkSession(_session: any): void {}
  protected get model(): string | undefined { return undefined; }
  protected details() { return { sessionId: this.sessionId, model: this.model }; }

  // A fresh hub-owned folder outside the task folder, removed once the process tree is confirmed stopped.
  protected makeHome(prefix: string) {
    const home = mkdtempSync(join(tmpdir(), prefix));
    const r = relative(this.cwd, home);
    if (r === '' || (!r.startsWith('..') && !isAbsolute(r))) throw new Error('Provider home must be outside the task folder');
    this.home = home; return home;
  }
  protected write(x: Envelope) { if (this.child && !this.child.stdin.destroyed && !this.child.stdin.writableEnded) this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...x }) + '\n'); }
  protected request(method: string, params: any, timeout = 120000) {
    const id = ++this.seq;
    return new Promise<any>((resolve, reject) => {
      const timer = timeout ? setTimeout(() => { this.requests.delete(id); reject(new Error(`Provider request timed out: ${method}`)); }, timeout) : undefined;
      this.requests.set(id, { resolve, reject, timer }); this.write({ id, method, params });
    });
  }
  protected spawnChild(command: string, args: string[], env: Record<string, string>) {
    const child = spawn(command, args, { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32', env });
    this.child = child; child.stderr.on('data', () => {}); return child;
  }

  async start(prompt: string) {
    this.deadline = setTimeout(() => { this.error = 'Pilot time limit reached (10 minutes)'; void this.cancel(); }, 600000);
    try {
      const launch = await this.prepare();
      if (terminal.has(this.state)) return;
      const child = this.spawnChild(launch.command, launch.args, launch.env);
      child.on('error', e => { this.stopped = true; this.fail(e); });
      child.stdin.on('error', e => { if (!terminal.has(this.state)) this.fail(e); });
      child.on('exit', () => { if (!terminal.has(this.state)) this.fail(new Error('Worker process exited before turn completion')); });
      createInterface({ input: child.stdout }).on('line', line => { try { this.receive(JSON.parse(line)); } catch { this.fail(new Error('Invalid provider protocol message')); } });
      const init = await this.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'claude_coding_hub', version: '0.3.0' } });
      if (init?.protocolVersion !== 1) throw new Error('Unsupported ACP protocol version');
      await this.authenticate();
      const session = await this.request('session/new', { cwd: this.cwd, mcpServers: [] });
      if (typeof session?.sessionId !== 'string' || !session.sessionId) throw new Error('Provider did not return a session');
      this.checkSession(session);
      this.sessionId = session.sessionId;
      if (terminal.has(this.state)) return;
      this.state = 'running'; this.changed();
      const turn = await this.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text: prompt }] }, 0);
      this.complete(turn?.stopReason === 'end_turn', turn?.stopReason === 'end_turn' ? '' : `Worker stopped: ${String(turn?.stopReason ?? 'unknown')}`);
    } catch (e) { if (!terminal.has(this.state)) this.fail(e); }
  }
  private refuse(id: string | number, message: string, code = -32000) { this.write({ id, error: { code, message } }); }
  private receive(m: Envelope) {
    if (m.id !== undefined && !m.method) {
      const r = this.requests.get(Number(m.id)); if (!r) return;
      clearTimeout(r.timer); this.requests.delete(Number(m.id));
      m.error ? r.reject(new Error(String(m.error.message ?? 'Provider rejected request'))) : r.resolve(m.result); return;
    }
    if (m.id !== undefined && m.method) { this.receiveRequest(m.id, m.method, m.params ?? {}); return; }
    if (m.method === 'session/update' && m.params?.sessionId === this.sessionId && this.sessionId) {
      const u = m.params.update;
      if (u?.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text' && typeof u.content.text === 'string') { this.result = (this.result + u.content.text).slice(-24000); this.changed(); }
    }
  }
  // Every provider request is either refused with an error or becomes exactly one human decision.
  // fs/* and terminal/* are refused: the client advertised neither capability.
  private receiveRequest(id: string | number, method: string, params: any) {
    if (terminal.has(this.state)) return;
    if (method !== 'session/request_permission' || JSON.stringify(params).length > 20000) { this.refuse(id, 'Request unsupported by this restricted pilot', -32601); return; }
    if (!this.sessionId || params.sessionId !== this.sessionId) { this.refuse(id, 'Wrong session'); return; }
    const call = params.toolCall, options = Array.isArray(params.options) ? params.options : [];
    const why = call && typeof call.toolCallId === 'string' ? this.unreviewable(call) : 'Permission request has no tool call';
    if (why) { this.refuse(id, `Permission request refused: ${why}`); return; }
    if (!options.some((o: any) => o?.kind === 'allow_once' && typeof o.optionId === 'string')) { this.refuse(id, 'Permission request lacks a reviewable one-shot option'); return; }
    if (this.pending.has(id)) { this.fail(new Error('Duplicate provider request id')); return; }
    this.addPending({ id, kind: 'approval', method, params: { sessionId: params.sessionId, toolCall: call, options } });
  }
  private option(p: Pending, kind: string) { return (p.params.options as any[]).find(o => o?.kind === kind && typeof o.optionId === 'string')?.optionId as string | undefined; }
  protected sendApprove(p: Pending) { this.write({ id: p.id, result: { outcome: { outcome: 'selected', optionId: this.option(p, 'allow_once') } } }); }
  // ACP has no client-side question request; questions never become Pending, so this is unreachable.
  protected sendAnswer(p: Pending) { this.refuse(p.id, 'Questions are unsupported'); }
  protected sendDecline(p: Pending) { const reject = this.option(p, 'reject_once'); this.write({ id: p.id, result: { outcome: reject ? { outcome: 'selected', optionId: reject } : { outcome: 'cancelled' } } }); }
  protected interrupt() { if (this.sessionId) this.write({ method: 'session/cancel', params: { sessionId: this.sessionId } }); }
  protected onFinish() { for (const r of this.requests.values()) { clearTimeout(r.timer); r.reject(new Error('Task stopped')); } this.requests.clear(); }
  protected finish() {
    super.finish();
    const home = this.home; if (!home) return;
    this.cleanup = this.cleanup.then(() => { if (this.stopped) try { rmSync(home, { recursive: true, force: true, maxRetries: 3 }); } catch {} });
  }
}
