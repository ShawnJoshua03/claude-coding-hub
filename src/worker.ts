import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { realpathSync } from 'node:fs';
import { BaseTask, terminal, filteredEnvironment, type Pending, type Question } from './task.js';
export { done, filteredEnvironment, type Pending } from './task.js';
export { fixtureRoot } from './workspace.js';
export type Envelope = { id?: string | number; method?: string; params?: any; result?: any; error?: any };
// SandboxMode is kebab-case; SandboxPolicy.type is camelCase in the installed protocol.
export const THREAD_SANDBOX_MODE = 'workspace-write';
const identityMethods = ['turn/started','turn/completed','item/started','item/completed','item/commandExecution/requestApproval','item/fileChange/requestApproval','item/tool/requestUserInput','serverRequest/resolved'];

// Codex app-server adapter: translates the Codex JSON-RPC protocol onto BaseTask.
export class CodexWorker extends BaseTask {
 readonly provider = 'codex'; threadId = ''; turnId = '';
 private seq = 0;
 private requests = new Map<number, { resolve: (x: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
 private early: Envelope[] = []; private items = new Map<string, any>();
 constructor(cwd: string, readonly command = 'codex', readonly prefix: string[] = []) { super(cwd); }
 protected details() { return { threadId: this.threadId, turnId: this.turnId }; }
 private write(x: Envelope) { if (this.child && !this.child.stdin.destroyed && !this.child.stdin.writableEnded) this.child.stdin.write(JSON.stringify(x) + '\n'); }
 private request(method: string, params: any) {
  const id = ++this.seq;
  return new Promise<any>((resolve, reject) => { const timer = setTimeout(() => { this.requests.delete(id); reject(new Error(`Provider request timed out: ${method}`)); }, 30000); this.requests.set(id, { resolve, reject, timer }); this.write({ id, method, params }); });
 }
 async start(prompt: string) {
  const overrides = ['mcp_servers={}','features.apps=false','features.multi_agent=false','features.hooks=false','features.plugins=false','features.remote_plugin=false','features.browser_use=false','features.computer_use=false','notify=[]','forced_login_method="chatgpt"','model_provider="openai"'];
  this.child = spawn(this.command, [...this.prefix, 'app-server', '--stdio', ...overrides.flatMap(x => ['-c',x])], { cwd: this.cwd, stdio: ['pipe','pipe','pipe'], windowsHide: true, detached: process.platform !== 'win32', env: filteredEnvironment() });
  this.child.on('error', e => { this.stopped = true; this.fail(e); });
  this.child.stdin.on('error', e => { if (!terminal.has(this.state)) this.fail(e); });
  this.child.on('exit', () => { if (!terminal.has(this.state)) this.fail(new Error('Worker process exited before turn completion')); });
  this.child.stderr.on('data', () => {});
  createInterface({ input: this.child.stdout }).on('line', line => { try { this.receive(JSON.parse(line)); } catch { this.fail(new Error('Invalid provider protocol message')); } });
  this.deadline = setTimeout(() => { this.error = 'Pilot time limit reached (10 minutes)'; void this.cancel(); }, 600000);
  try {
   await this.request('initialize', { clientInfo: { name: 'claude_coding_hub_pilot', version: '0.1.0' }, capabilities: { experimentalApi: true } }); this.write({ method: 'initialized', params: {} });
   const effective = (await this.request('config/read', { cwd: this.cwd, includeLayers: false })).config;
   const flags = ['hooks','plugins','remote_plugin','apps','multi_agent','browser_use','computer_use'];
   if (flags.some(k => effective.features?.[k] !== false) || (effective.notify?.length ?? 0) !== 0) throw new Error('Worker integrations/hooks were not disabled');
   const account = await this.request('account/read', { refreshToken: false });
   if (account.account?.type !== 'chatgpt' || effective.model_provider !== 'openai' || effective.forced_login_method !== 'chatgpt') throw new Error('Pilot requires native ChatGPT subscription authentication and OpenAI provider');
   // Exactly one local environment rooted in the task folder; [] would leave the worker with no shell or file tools.
   const environments = [{ environmentId: 'local', cwd: this.cwd, runtimeWorkspaceRoots: [this.cwd] }];
   const disabledMcp = Object.fromEntries(Object.keys(effective.mcp_servers ?? {}).map(k => [k,{ enabled: false }]));
   const thread = await this.request('thread/start', { cwd: this.cwd, runtimeWorkspaceRoots: [this.cwd], approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: THREAD_SANDBOX_MODE, ephemeral: true, environments, config: { mcp_servers: disabledMcp, sandbox_workspace_write: { writable_roots: [this.cwd], network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true } }, developerInstructions: 'You are a bounded worker for Claude. Work only in the assigned folder. Do not spawn agents, access external accounts, install dependencies or run git commands that change history. Never retry a denied action. Return a concise report with changes and checks.' });
   this.threadId = thread.thread.id;
   if (thread.approvalsReviewer !== 'user' || thread.approvalPolicy !== 'on-request' || realpathSync(thread.cwd) !== this.cwd || thread.sandbox?.type !== 'workspaceWrite' || thread.sandbox.networkAccess !== false || (thread.sandbox.writableRoots ?? []).some((p: string) => realpathSync(p) !== this.cwd)) throw new Error('Provider did not retain the required human permissions or workspace sandbox');
   // Codex still lists servers it was told to disable; accept only those, and only if they never started and expose nothing.
   const inventory = await this.request('mcpServerStatus/list', { threadId: this.threadId });
   const inert = (s: any) => Object.hasOwn(disabledMcp, s?.name) && s.runtimeStatus === 'disabled' && !s.pluginId && !s.httpOrigin && !s.serverInfo && !s.serverCapabilities && !Object.keys(s.tools ?? {}).length && !(s.resources ?? []).length && !(s.resourceTemplates ?? []).length;
   if (!Array.isArray(inventory.data) || inventory.nextCursor || !inventory.data.every(inert)) throw new Error('Worker inherited MCP integrations; pilot stopped before inference');
   if (terminal.has(this.state)) return;
   this.state = 'running';
   const turn = await this.request('turn/start', { threadId: this.threadId, cwd: this.cwd, runtimeWorkspaceRoots: [this.cwd], input: [{ type: 'text', text: prompt, text_elements: [] }], approvalPolicy: 'on-request', approvalsReviewer: 'user', environments, sandboxPolicy: { type: 'workspaceWrite', writableRoots: [this.cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } });
   this.turnId = turn.turn.id; for (const event of this.early.splice(0)) this.receive(event); this.changed();
  } catch(e) { if (!terminal.has(this.state)) this.fail(e); }
 }
 private refuse(id: string | number, message: string, code = -32000) { this.write({ id, error: { code, message } }); }
 private receive(m: Envelope) {
  if (m.id !== undefined && !m.method) { const r = this.requests.get(Number(m.id)); if (!r) return; clearTimeout(r.timer); this.requests.delete(Number(m.id)); m.error ? r.reject(new Error(String(m.error.message ?? 'Provider rejected request'))) : r.resolve(m.result); return; }
  if (m.method && identityMethods.includes(m.method)) {
   const p = m.params, turnId = p?.turnId ?? p?.turn?.id;
   if (p?.threadId !== this.threadId || (this.turnId && turnId && turnId !== this.turnId)) { if(m.id !== undefined) this.refuse(m.id, 'Wrong task or stale turn'); return; }
   if (!this.turnId && m.method !== 'serverRequest/resolved') { if(this.early.length >= 1000) this.fail(new Error('Provider startup event limit exceeded')); else this.early.push(m); return; }
   if (m.method !== 'serverRequest/resolved' && !turnId) return;
  }
  if (m.method === 'item/started') this.items.set(m.params.item.id, m.params.item);
  if (m.id !== undefined && m.method) { this.receiveRequest(m.id, m.method, m.params ?? {}); return; }
  if (m.method === 'serverRequest/resolved') this.withdraw(m.params?.requestId);
  if (m.method === 'item/completed' && m.params?.item?.type === 'agentMessage') { this.result=(this.result+'\n'+m.params.item.text).slice(-24000);this.changed(); }
  if (m.method === 'turn/completed') this.complete(m.params.turn.status === 'completed', m.params.turn.error?.message ?? '');
 }
 // Every provider request is either refused with an error or becomes exactly one human decision.
 private receiveRequest(id: string | number, method: string, params: any) {
  if (terminal.has(this.state)) return;
  if (!['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/tool/requestUserInput'].includes(method) || JSON.stringify(params).length > 20000) { this.refuse(id, 'Request unsupported by this restricted pilot', -32601); return; }
  if (this.pending.has(id)) { this.fail(new Error('Duplicate provider request id')); return; }
  if (method === 'item/commandExecution/requestApproval') {
   if ((params.kind && params.kind !== 'command') || !params.command || !params.cwd || params.networkApprovalContext || (params.availableDecisions && !params.availableDecisions.includes('accept'))) { this.refuse(id, 'Approval lacks a reviewable one-shot command'); return; }
   this.addPending({ id, kind: 'approval', method, params }); return;
  }
  if (method === 'item/fileChange/requestApproval') {
   const item = this.items.get(params.itemId);
   if (!item || item.type !== 'fileChange' || !item.changes?.length || params.grantRoot) { this.refuse(id, 'Exact file patch unavailable or persistent grant requested'); return; }
   const withPatch = { ...params, changes: item.changes };
   if (JSON.stringify(withPatch).length > 20000) { this.refuse(id, 'Patch too large for this pilot approval form'); return; }
   this.addPending({ id, kind: 'approval', method, params: withPatch }); return;
  }
  const raw = params.questions ?? [];
  if (!raw.length || raw.some((q: any) => q.isSecret || typeof q.id !== 'string')) { this.refuse(id, 'Secret or malformed worker questions are unsupported'); return; }
  const questions: Question[] = raw.map((q: any) => ({ id: q.id, header: q.header, question: q.question, options: q.options?.length && !q.isOther ? q.options.map((o: any) => o.label) : undefined }));
  this.addPending({ id, kind: 'question', method, params, questions });
 }
 protected sendApprove(p: Pending) { this.write({ id: p.id, result: { decision: 'accept' } }); }
 protected sendAnswer(p: Pending, answers: Record<string, string>) { this.write({ id: p.id, result: { answers: Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, { answers: [v] }])) } }); }
 protected sendDecline(p: Pending) { this.write({ id: p.id, result: p.kind === 'question' ? { answers: {} } : { decision: 'decline' } }); }
 protected interrupt() { if (this.threadId && this.turnId) this.write({ id: ++this.seq, method: 'turn/interrupt', params: { threadId: this.threadId, turnId: this.turnId } }); }
 protected onFinish() { for (const r of this.requests.values()) { clearTimeout(r.timer); r.reject(new Error('Task stopped')); } this.requests.clear(); }
}
// Kept for the existing tests and scripts.
export { CodexWorker as Worker };
