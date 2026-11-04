import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpTask, type Launch } from './acp.js';
import { filteredEnvironment } from './task.js';

// Grok Build adapter, speaking ACP over `grok agent stdio`.
//
// UNVERIFIED: a real login, inference turn or permission request has not been observed. What was
// observed (Grok 1.0.70): the handshake works, and under an empty home it inherits no MCP servers.
//
// Under the user's real home Grok imports far more than its own config: the Claude Code permission
// allow-list (hundreds of rules), skills, hooks, plugins and memory. A worker started there would not be
// bounded by the hub. So Grok runs in a hub-owned home and logs in there once (scripts/grok-login.ps1).
// Its auth token is never copied from the user's real home.
//
// Grok has no OS sandbox here either. Its permission requests are forwarded only when they carry the
// exact tool input (rawInput), the same bar as OpenCode; everything else is refused.
const hubRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FOREIGN_CONFIG = ['.grok', join('.claude', 'settings.json'), join('.claude', 'settings.local.json')];
const HOME_STATE = ['hooks', 'installed-plugins', 'skills', 'plugins'];

export function grokHome(env: Record<string, string | undefined> = process.env) { return resolve(hubRoot, env.HUB_GROK_HOME ?? '.local/grok-home'); }

// Grok reads permission rules, hooks and plugins from the task folder; a worker can write there.
export function grokProjectConfig(cwd: string) {
  const found: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    for (const name of FOREIGN_CONFIG) if (existsSync(join(dir, name))) found.push(join(dir, name));
    if (existsSync(join(dir, '.git')) || dirname(dir) === dir) return found;
  }
}
// Anything installed into the hub-owned home after login would load into every worker.
export function grokHomeProblems(home: string) {
  const root = join(home, '.grok'), problems: string[] = [];
  if (!existsSync(join(root, 'auth.json'))) problems.push('not logged in; run scripts/grok-login.ps1 once');
  for (const name of HOME_STATE) { const p = join(root, name); if (existsSync(p) && readdirSync(p).length) problems.push(`${name} installed in the hub Grok home`); }
  return problems;
}
export function grokReviewable(call: any): string | undefined {
  const raw = call.rawInput;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.keys(raw).length) return 'request does not carry the exact tool input';
  return undefined;
}

export class GrokWorker extends AcpTask {
  readonly provider = 'grok';
  readonly modelId?: string;
  constructor(cwd: string, readonly command = 'grok', readonly prefix: string[] = [], private readonly env: Record<string, string | undefined> = process.env) {
    super(cwd);
    this.modelId = env.HUB_GROK_MODEL || undefined;
    if (this.modelId && !/^[A-Za-z0-9._-]+$/.test(this.modelId)) throw new Error('HUB_GROK_MODEL must be a plain model id');
  }
  protected get model() { return this.modelId; }
  protected async prepare(): Promise<Launch> {
    const foreign = grokProjectConfig(this.cwd);
    if (foreign.length) throw new Error(`Project config can set Grok permissions, hooks or plugins; remove it first: ${foreign.join(', ')}`);
    const home = grokHome(this.env); mkdirSync(home, { recursive: true });
    const problems = grokHomeProblems(home);
    if (problems.length) throw new Error(`Grok home is not ready: ${problems.join('; ')}`);
    const { CODEX_HOME: _codex, ...base } = filteredEnvironment();
    return {
      command: this.command,
      // --no-leader: a shared leader process would run outside this home and this process tree.
      args: [...this.prefix, 'agent', 'stdio', '--no-leader', ...(this.modelId ? ['--model', this.modelId] : [])],
      env: { ...base, HOME: home, USERPROFILE: home, APPDATA: join(home, 'Roaming'), LOCALAPPDATA: join(home, 'Local') },
    };
  }
  protected async authenticate() { await this.request('authenticate', { methodId: 'cached_token' }); }
  protected unreviewable(call: any) { return grokReviewable(call); }
}
