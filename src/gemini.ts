import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AcpTask, type Launch } from './acp.js';
import { filteredEnvironment } from './task.js';

// Gemini CLI adapter (API-key auth), speaking ACP over `gemini --acp`.
//
// Verified against Gemini CLI 0.65.0: handshake, isolated-home startup and session creation.
// NOT verified: a real inference turn or a real permission request (the stored key was rejected by Google).
//
// Gemini has no OS sandbox on Windows. The boundary is its own approval mode, forced to "default",
// with YOLO and "always allow" disabled by a system settings file that outranks user and workspace settings.
//
// The permission request is the weak point: it carries no rawInput. For shell commands the title is
// the command only when the command is short; for long ones Gemini substitutes the model-written
// description (ShellToolInvocation.getDescription). A title therefore cannot show the human what will
// run, so execute-style requests are refused outright. Only edits are forwarded, because their
// content carries the exact diff.
const WEB_TOOLS = ['web_fetch', 'google_web_search'];

export function geminiSettings() {
  return {
    mcpServers: {},
    general: { defaultApprovalMode: 'default', enableAutoUpdate: false, checkpointing: { enabled: false } },
    security: { disableYoloMode: true, disableAlwaysAllow: true },
    tools: { exclude: WEB_TOOLS },
    telemetry: { enabled: false }, privacy: { usageStatisticsEnabled: false },
  };
}

// Workspace settings, extensions and hooks load from .gemini/ inside the task folder, which a worker can write.
export function geminiProjectConfig(cwd: string) {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.gemini'))) return join(dir, '.gemini');
    if (existsSync(join(dir, '.git')) || dirname(dir) === dir) return undefined;
  }
}

// An edit is reviewable only when it names the file and carries the exact diff the human will see.
export function geminiReviewable(call: any): string | undefined {
  if (call.kind !== 'edit') return `this ${String(call.kind ?? 'unknown')} request does not show the exact action (Gemini may substitute a model-written description for the command)`;
  const diffs = (Array.isArray(call.content) ? call.content : []).filter((c: any) => c?.type === 'diff');
  if (!diffs.length || diffs.some((d: any) => typeof d.path !== 'string' || typeof d.newText !== 'string')) return 'edit request carries no exact diff';
  return undefined;
}

export class GeminiWorker extends AcpTask {
  readonly provider = 'gemini';
  private readonly apiKey: string; readonly modelId: string;
  constructor(cwd: string, readonly command = 'gemini', readonly prefix: string[] = [], env: Record<string, string | undefined> = process.env) {
    super(cwd);
    const key = env.GEMINI_API_KEY;
    if (!key) throw new Error('Gemini provider needs GEMINI_API_KEY in the hub environment');
    this.apiKey = key; this.modelId = env.HUB_GEMINI_MODEL || 'gemini-3-flash-preview';
    if (!/^[A-Za-z0-9._-]+$/.test(this.modelId)) throw new Error('HUB_GEMINI_MODEL must be a plain model id');
  }
  protected get model() { return this.modelId; }
  protected async prepare(): Promise<Launch> {
    const found = geminiProjectConfig(this.cwd);
    if (found) throw new Error(`Project Gemini config can load extensions, hooks and settings; remove it first: ${found}`);
    const home = this.makeHome('hub-gemini-');
    const settings = join(home, 'system-settings.json');
    mkdirSync(home, { recursive: true }); writeFileSync(settings, JSON.stringify(geminiSettings()));
    const { CODEX_HOME: _codex, ...base } = filteredEnvironment();
    return {
      command: this.command,
      // `-e none` loads no extensions; the approval mode is also set on the command line.
      args: [...this.prefix, '--acp', '--approval-mode', 'default', '--extensions', 'none', '--model', this.modelId],
      env: {
        ...base,
        HOME: home, USERPROFILE: home, APPDATA: join(home, 'Roaming'), LOCALAPPDATA: join(home, 'Local'),
        GEMINI_CLI_HOME: home, GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings, GEMINI_CLI_NO_RELAUNCH: 'true',
        GEMINI_API_KEY: this.apiKey,
      },
    };
  }
  // The ACP key travels in authenticate's _meta; sending it only via the environment gave a 401 in the probe.
  protected async authenticate() { await this.request('authenticate', { methodId: 'gemini-api-key', _meta: { 'api-key': this.apiKey } }); }
  protected checkSession(session: any) {
    if (session.modes?.currentModeId !== 'default') throw new Error('Gemini did not start in its prompting approval mode; pilot stopped before inference');
  }
  protected unreviewable(call: any) { return geminiReviewable(call); }
}
