import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { BaseTask, terminal, filteredEnvironment, type Pending } from './task.js';

// OpenCode adapter (Gemini API key), speaking the Agent Client Protocol over `opencode acp` stdio.
// UNVERIFIED against a real OpenCode install: written from OpenCode's and ACP's documented
// interfaces and tested only against tests/fake-opencode.mjs. See README "OpenCode provider".
//
// OpenCode has NO OS sandbox: its bash and edit tools run as the hub user. The boundary is
// therefore OpenCode's own permission system, forced to "ask" for every bash command and edit,
// with web tools, subagents and paths outside the task folder denied. Every "ask" becomes one
// human decision through BaseTask; only the provider's allow_once option is ever selected.
// Before inference the hub reads OpenCode's resolved config and refuses to continue unless those
// settings were retained and no MCP servers, plugins, LSP servers, formatters or agent overrides
// are active.

export type Envelope = { jsonrpc?: string; id?: string | number; method?: string; params?: any; result?: any; error?: any };
export const OPENCODE_PERMISSIONS = { edit: 'ask', bash: 'ask', webfetch: 'deny', external_directory: 'deny' } as const;
// Newer permission keys; checked when OpenCode reports them (older versions drop unknown keys).
export const OPENCODE_OPTIONAL_PERMISSIONS = { websearch: 'deny', codesearch: 'deny', task: 'deny', skill: 'deny', doom_loop: 'ask' } as const;
const PROJECT_CONFIG = ['opencode.json', 'opencode.jsonc', '.opencode'];

export function openCodeConfig(model: string) {
  return {
    $schema: 'https://opencode.ai/config.json',
    model, small_model: model, enabled_providers: ['google'],
    autoupdate: false, share: 'disabled', lsp: false, formatter: false,
    mcp: {}, plugin: [], instructions: [],
    permission: { ...OPENCODE_PERMISSIONS, ...OPENCODE_OPTIONAL_PERMISSIONS },
  };
}

// Built from the shared allowlist, minus CODEX_HOME. OpenCode's config/data/state/cache dirs are
// redirected to a fresh hub-owned folder so no global config, plugin or stored auth.json is
// inherited. The only credential added is the Gemini key, taken from the hub's own environment.
export function openCodeEnvironment(home: string, apiKey: string, model: string): Record<string, string> {
  const { CODEX_HOME: _codex, ...base } = filteredEnvironment();
  return {
    ...base,
    XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'), XDG_CACHE_HOME: join(home, 'cache'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(openCodeConfig(model)),
    OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    GOOGLE_GENERATIVE_AI_API_KEY: apiKey,
  };
}

// OpenCode loads project config (which can add plugins, i.e. arbitrary code, MCP servers and agent
// permission overrides) from the task folder up to its git root. A worker can write these files,
// so refuse to start rather than trust an env flag to ignore them.
export function projectConfigFiles(cwd: string) {
  const found: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    for (const name of PROJECT_CONFIG) if (existsSync(join(dir, name))) found.push(join(dir, name));
    if (existsSync(join(dir, '.git')) || dirname(dir) === dir) return found;
  }
}

function permissionValue(v: unknown) {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && Object.keys(v).length === 1 && '*' in v) return (v as Record<string, unknown>)['*'];
  return undefined;
}
// Fails closed: anything not positively matching the hub's settings stops the task before inference.
export function checkOpenCodeConfig(c: any, model: string) {
  const problems: string[] = [];
  const perm = c?.permission && typeof c.permission === 'object' ? c.permission : {};
  for (const [k, want] of Object.entries(OPENCODE_PERMISSIONS)) if (permissionValue(perm[k]) !== want) problems.push(`permission.${k} must be ${want}`);
  for (const [k, want] of Object.entries(OPENCODE_OPTIONAL_PERMISSIONS)) if (k in perm && permissionValue(perm[k]) !== want) problems.push(`permission.${k} must be ${want}`);
  if (Object.keys(c?.mcp ?? {}).length) problems.push('MCP servers configured');
  if ((c?.plugin ?? []).length) problems.push('plugins configured');
  if (c?.model !== model) problems.push('model not retained');
  if (JSON.stringify(c?.enabled_providers) !== '["google"]') problems.push('providers other than google enabled');
  if (c?.lsp !== false || c?.formatter !== false) problems.push('LSP servers or formatters enabled');
  if (c?.share !== 'disabled' || c?.autoupdate !== false) problems.push('sharing or autoupdate enabled');
  for (const a of [...Object.values(c?.agent ?? {}), ...Object.values(c?.mode ?? {})] as any[]) if (a?.permission || a?.tools) problems.push('agent permission/tool overrides configured');
  if (problems.length) throw new Error(`OpenCode did not retain the required human permissions/isolation: ${[...new Set(problems)].join('; ')}`);
}

export class OpenCodeWorker extends BaseTask {
  readonly provider = 'opencode'; sessionId = '';
  private seq = 0; private home = '';
  private requests = new Map<number, { resolve: (x: any) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }>();
  private readonly apiKey: string; readonly model: string;
  constructor(cwd: string, readonly command = 'opencode', readonly prefix: string[] = [], env: Record<string, string | undefined> = process.env) {
    super(cwd);
    const key = env.GEMINI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!key) throw new Error('OpenCode provider needs GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY) in the hub environment');
    this.apiKey = key; this.model = env.HUB_OPENCODE_MODEL || 'google/gemini-2.5-pro';
    if (!/^google\/[A-Za-z0-9._-]+$/.test(this.model)) throw new Error('HUB_OPENCODE_MODEL must be a google/<model> id');
  }
  protected details() { return { sessionId: this.sessionId, model: this.model }; }
  private write(x: Envelope) { if (this.child && !this.child.stdin.destroyed && !this.child.stdin.writableEnded) this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...x }) + '\n'); }
  private request(method: string, params: any, timeout = 120000) {
    const id = ++this.seq;
    return new Promise<any>((resolve, reject) => {
      const timer = timeout ? setTimeout(() => { this.requests.delete(id); reject(new Error(`Provider request timed out: ${method}`)); }, timeout) : undefined;
      this.requests.set(id, { resolve, reject, timer }); this.write({ id, method, params });
    });
  }
  private spawnChild(args: string[], env: Record<string, string>) {
    const child = spawn(this.command, [...this.prefix, ...args], { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32', env });
    this.child = child; child.stderr.on('data', () => {}); return child;
  }
  // Runs `opencode debug config` as the owned child, so cancellation kills it like the main worker.
  private resolvedConfig(env: Record<string, string>) {
    return new Promise<any>((resolve, reject) => {
      const child = this.spawnChild(['debug', 'config'], env); let out = '';
      const release = () => { clearTimeout(timer); if (this.child === child) this.child = undefined; };
      const timer = setTimeout(() => reject(new Error('OpenCode config check timed out')), 60000);
      child.stdin.on('error', () => {}); child.stdin.end();
      child.stdout.on('data', d => { out += d; if (out.length > 1_000_000) reject(new Error('OpenCode config output too large')); });
      child.on('error', e => { release(); reject(e); });
      child.on('exit', code => {
        release();
        if (code !== 0) { reject(new Error(`OpenCode config check exited with code ${code}`)); return; }
        try { resolve(JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))); } catch { reject(new Error('OpenCode config check output was not JSON')); }
      });
    });
  }
  async start(prompt: string) {
    this.deadline = setTimeout(() => { this.error = 'Pilot time limit reached (10 minutes)'; void this.cancel(); }, 600000);
    try {
      const found = projectConfigFiles(this.cwd);
      if (found.length) throw new Error(`Project OpenCode config can load plugins or override permissions; remove it first: ${found.map(f => relative(this.cwd, f) || f).join(', ')}`);
      this.home = mkdtempSync(join(tmpdir(), 'hub-opencode-'));
      const r = relative(this.cwd, this.home); if (r === '' || (!r.startsWith('..') && !isAbsolute(r))) throw new Error('OpenCode home must be outside the task folder');
      const env = openCodeEnvironment(this.home, this.apiKey, this.model);
      checkOpenCodeConfig(await this.resolvedConfig(env), this.model);
      if (terminal.has(this.state)) return;
      const child = this.spawnChild(['acp'], env);
      child.on('error', e => { this.stopped = true; this.fail(e); });
      child.stdin.on('error', e => { if (!terminal.has(this.state)) this.fail(e); });
      child.on('exit', () => { if (!terminal.has(this.state)) this.fail(new Error('Worker process exited before turn completion')); });
      createInterface({ input: child.stdout }).on('line', line => { try { this.receive(JSON.parse(line)); } catch { this.fail(new Error('Invalid provider protocol message')); } });
      const init = await this.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'claude_coding_hub_pilot', version: '0.1.0' } });
      if (init?.protocolVersion !== 1) throw new Error('Unsupported OpenCode ACP protocol version');
      const session = await this.request('session/new', { cwd: this.cwd, mcpServers: [] });
      if (typeof session?.sessionId !== 'string' || !session.sessionId) throw new Error('OpenCode did not return a session');
      const current = session.models?.currentModelId;
      if (current !== undefined && !String(current).startsWith('google/')) throw new Error('OpenCode session is not using the Gemini provider');
      this.sessionId = session.sessionId;
      if (terminal.has(this.state)) return;
      this.state = 'running'; this.changed();
      const turn = await this.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text: prompt }] }, 0);
      this.complete(turn?.stopReason === 'end_turn', turn?.stopReason === 'end_turn' ? '' : `OpenCode stopped: ${String(turn?.stopReason ?? 'unknown')}`);
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
    // The title is the agent's own description; the human must see the exact tool input, as Codex
    // approvals require the exact command or patch.
    const reviewable = call && typeof call.toolCallId === 'string' && call.rawInput && typeof call.rawInput === 'object' && !Array.isArray(call.rawInput) && Object.keys(call.rawInput).length;
    if (!reviewable || !options.some((o: any) => o?.kind === 'allow_once' && typeof o.optionId === 'string')) { this.refuse(id, 'Permission request lacks a reviewable one-shot option'); return; }
    if (this.pending.has(id)) { this.fail(new Error('Duplicate provider request id')); return; }
    this.addPending({ id, kind: 'approval', method, params: { sessionId: params.sessionId, toolCall: call, options } });
  }
  private option(p: Pending, kind: string) { return (p.params.options as any[]).find(o => o?.kind === kind && typeof o.optionId === 'string')?.optionId as string | undefined; }
  protected sendApprove(p: Pending) { this.write({ id: p.id, result: { outcome: { outcome: 'selected', optionId: this.option(p, 'allow_once') } } }); }
  // ACP has no client-side question request; questions never become Pending, so this is unreachable.
  protected sendAnswer(p: Pending) { this.refuse(p.id, 'Questions are unsupported for OpenCode'); }
  protected sendDecline(p: Pending) { const reject = this.option(p, 'reject_once'); this.write({ id: p.id, result: { outcome: reject ? { outcome: 'selected', optionId: reject } : { outcome: 'cancelled' } } }); }
  protected interrupt() { if (this.sessionId) this.write({ method: 'session/cancel', params: { sessionId: this.sessionId } }); }
  protected onFinish() { for (const r of this.requests.values()) { clearTimeout(r.timer); r.reject(new Error('Task stopped')); } this.requests.clear(); }
  // Removes the isolated OpenCode home once the process tree is confirmed stopped.
  protected finish() {
    super.finish();
    const home = this.home; if (!home) return;
    this.cleanup = this.cleanup.then(() => { if (this.stopped) try { rmSync(home, { recursive: true, force: true, maxRetries: 3 }); } catch {} });
  }
}
