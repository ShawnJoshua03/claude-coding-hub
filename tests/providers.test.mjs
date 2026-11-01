import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { GeminiWorker, geminiSettings, geminiReviewable, geminiProjectConfig } from '../dist/gemini.js';
import { GrokWorker, grokReviewable, grokProjectConfig, grokHomeProblems } from '../dist/grok.js';
import { OpenCodeWorker, OPENROUTER_PROFILE, checkOpenCodeConfig, openCodeConfig } from '../dist/opencode.js';
import { done } from '../dist/task.js';

const acp = resolve('tests/fake-acp.mjs'), fakeOpenCode = resolve('tests/fake-opencode.mjs');
const parse = r => { if (r.isError) throw Error(r.content[0].text); return JSON.parse(r.content[0].text); };
const GEM = { GEMINI_API_KEY: 'synthetic-gemini-key' };
function gitDir() { const d = realpathSync(mkdtempSync(join(tmpdir(), 'hub-prov-'))); execFileSync('git', ['init', '-q'], { cwd: d }); return d; }
const outside = (base, p) => { const r = relative(base, p); return r.startsWith('..') || isAbsolute(r); };
async function finish(w) {
 await new Promise((ok, fail) => { const t = setTimeout(() => fail(Error('timeout ' + w.state)), 10000); const check = () => { if (done(w.state)) { clearTimeout(t); ok(); } }; w.on('change', check); check(); });
 await w.cleanup; return w;
}
const gemini = async (prompt, extra = [], cwd = gitDir(), env = GEM) => { const w = new GeminiWorker(cwd, process.execPath, [acp, ...extra], env); void w.start(prompt); return finish(w); };
function grokHome(ready = true) { const h = mkdtempSync(join(tmpdir(), 'hub-grokhome-')); if (ready) { mkdirSync(join(h, '.grok'), { recursive: true }); writeFileSync(join(h, '.grok', 'auth.json'), '{}'); } return h; }
const grok = async (prompt, { home = grokHome(), cwd = gitDir(), extra = [] } = {}) => { const w = new GrokWorker(cwd, process.execPath, [acp, ...extra], { HUB_GROK_HOME: home }); void w.start(prompt); return finish(w); };

async function hub(t, answer, extraEnv = {}) {
 const db = join(mkdtempSync(join(tmpdir(), 'hub-')), 'hub.sqlite');
 const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/server.js')], cwd: process.cwd(), env: { ...process.env, ...GEM, HUB_DB_PATH: db, HUB_GEMINI_COMMAND: process.execPath, HUB_GEMINI_PREFIX_JSON: JSON.stringify([acp]), ...extraEnv }, stderr: 'pipe' });
 const client = new Client({ name: 'providers-test', version: '1' }, { capabilities: { elicitation: { form: {} } } });
 client.setRequestHandler(ElicitRequestSchema, answer ?? (async () => ({ action: 'decline' })));
 await client.connect(transport); t.after(() => client.close());
 return async (name, args = {}) => parse(await client.callTool({ name, arguments: args }));
}
const run = async (call, prompt, provider) => { const s = await call('start_worker', { prompt, provider }); return call('wait_for_worker', { taskId: s.taskId, seconds: 10 }); };

// ---- Gemini ----
test('gemini: result comes back through MCP and the provider is named', async t => {
 const end = await run(await hub(t), 'summary', 'gemini');
 assert.equal(end.provider, 'gemini'); assert.equal(end.state, 'completed', end.error); assert.equal(end.result, 'SIMULATED summary');
});
test('gemini: an edit is shown with its exact diff and allow-once selects only proceed_once', async t => {
 let count = 0;
 const call = await hub(t, async req => { count++; assert.match(req.params.message, /REAL GEMINI APPROVAL/); assert.match(req.params.message, /SIMULATED new text/); assert.match(req.params.message, /notes\.txt/); return { action: 'accept', content: { decision: 'allow-once' } }; });
 const end = await run(call, 'edit', 'gemini'); assert.equal(end.state, 'completed', end.error); assert.equal(count, 1);
 assert.match(end.result, /accepted once/); assert.doesNotMatch(end.result, /ALWAYS/);
});
test('gemini: decline stops the task', async t => {
 let count = 0; const call = await hub(t, async () => { count++; return { action: 'decline' }; });
 const end = await run(call, 'edit', 'gemini'); assert.equal(end.state, 'denied'); assert.equal(count, 1); assert.equal(end.result, ''); assert.deepEqual(end.pending, []);
});
test('gemini: a shell request showing only a title is refused and never reaches the human', async t => {
 let count = 0; const call = await hub(t, async () => { count++; return { action: 'accept', content: { decision: 'allow-once' } }; });
 const end = await run(call, 'exec-title', 'gemini');
 assert.equal(count, 0, 'the human must not be asked to approve something they cannot see'); assert.match(end.result, /refused 901/); assert.match(end.result, /does not show the exact action/);
});
test('gemini: other refusals (fetch, empty diff, no allow_once, wrong session, fs request)', async () => {
 for (const [mode, id] of [['fetch', 901], ['empty-diff', 901], ['always-only', 902], ['wrong-session', 903], ['fs', 904]]) {
  const w = await gemini(mode); assert.equal(w.state, 'completed', w.error); assert.match(w.result, new RegExp(`refused ${id}`)); assert.equal(w.pending.size, 0);
 }
});
test('gemini: environment is isolated, locked-down settings apply and the key is the only credential', async () => {
 process.env.SYNTHETIC_SECRET = 'x'; process.env.OPENAI_API_KEY = 'y'; process.env.GITHUB_TOKEN = 'z';
 const cwd = gitDir(); const w = await gemini('env', [], cwd); assert.equal(w.state, 'completed', w.error);
 const r = JSON.parse(w.result);
 for (const k of ['SYNTHETIC_SECRET', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'CODEX_HOME']) assert.ok(!r.keys.includes(k), `${k} leaked`);
 assert.ok(r.keys.includes('GEMINI_API_KEY'));
 for (const dir of [r.home, r.userHome, r.appData, r.geminiHome, r.settingsPath]) assert.ok(outside(r.cwd, dir), 'Gemini home must be outside the task folder');
 assert.deepEqual(r.settings, geminiSettings());
 assert.equal(r.settings.security.disableYoloMode, true); assert.equal(r.settings.security.disableAlwaysAllow, true); assert.deepEqual(r.settings.mcpServers, {});
 assert.ok(r.settings.tools.exclude.includes('web_fetch'));
 const i = r.argv.indexOf('--approval-mode'); assert.equal(r.argv[i + 1], 'default'); assert.equal(r.argv[r.argv.indexOf('--extensions') + 1], 'none'); assert.ok(!r.argv.includes('--yolo') && !r.argv.includes('-y'));
});
test('gemini: missing key, bad model, a rejected key and a yolo session all stop the task', async () => {
 assert.throws(() => new GeminiWorker(gitDir(), 'gemini', [], {}), /GEMINI_API_KEY/);
 assert.throws(() => new GeminiWorker(gitDir(), 'gemini', [], { ...GEM, HUB_GEMINI_MODEL: '../x' }), /plain model id/);
 const bad = await gemini('summary', ['--bad-key']); assert.equal(bad.state, 'failed'); assert.match(bad.error, /Authentication/); assert.equal(bad.result, '');
 const yolo = await gemini('summary', ['--yolo-mode']); assert.equal(yolo.state, 'failed'); assert.match(yolo.error, /approval mode/); assert.equal(yolo.result, '');
});
test('gemini: a .gemini folder in the task tree is refused before any process starts', async () => {
 const d = gitDir(); mkdirSync(join(d, '.gemini')); writeFileSync(join(d, '.gemini', 'settings.json'), '{"security":{"disableYoloMode":false}}');
 assert.ok(geminiProjectConfig(d));
 const w = await gemini('summary', [], d); assert.equal(w.state, 'failed'); assert.match(w.error, /Project Gemini config/); assert.equal(w.busy(), false); assert.equal(w.result, '');
});
test('gemini: only edits with an exact diff are reviewable', () => {
 assert.equal(geminiReviewable({ kind: 'edit', content: [{ type: 'diff', path: 'a', newText: '' }] }), undefined);
 for (const call of [{ kind: 'execute' }, { kind: 'execute', title: 'x', content: [{ type: 'content', content: { type: 'text', text: 'rm -rf' } }] }, { kind: 'edit' }, { kind: 'edit', content: [{ type: 'diff' }] }, { kind: 'edit', content: [{ type: 'diff', path: 'a' }] }, {}]) assert.ok(geminiReviewable(call), JSON.stringify(call));
});

// ---- Grok ----
test('grok: refuses to start until the hub-owned home is logged in', async () => {
 const w = await grok('summary', { home: grokHome(false) }); assert.equal(w.state, 'failed'); assert.match(w.error, /not logged in/); assert.equal(w.result, ''); assert.equal(w.busy(), false);
});
test('grok: with a ready home it runs in that home, with no leader and no inherited credentials', async () => {
 process.env.XAI_API_KEY = 'must-not-leak'; process.env.OPENAI_API_KEY = 'must-not-leak';
 const home = grokHome(); const w = await grok('env', { home }); assert.equal(w.state, 'completed', w.error);
 const r = JSON.parse(w.result);
 assert.equal(r.home, home); assert.equal(r.userHome, home); assert.ok(outside(r.cwd, home));
 assert.ok(r.argv.includes('--no-leader')); assert.ok(!r.argv.includes('--always-approve'));
 for (const k of ['XAI_API_KEY', 'OPENAI_API_KEY', 'CODEX_HOME', 'GEMINI_API_KEY']) assert.ok(!r.keys.includes(k), `${k} leaked`);
});
test('grok: project permission rules, hooks and installed plugins are refused', async () => {
 const d1 = gitDir(); mkdirSync(join(d1, '.claude')); writeFileSync(join(d1, '.claude', 'settings.json'), '{"permissions":{"allow":["Bash(*)"]}}');
 assert.equal(grokProjectConfig(d1).length, 1);
 const a = await grok('summary', { cwd: d1 }); assert.equal(a.state, 'failed'); assert.match(a.error, /Project config/);
 const d2 = gitDir(); mkdirSync(join(d2, '.grok')); const b = await grok('summary', { cwd: d2 }); assert.equal(b.state, 'failed');
 const home = grokHome(); mkdirSync(join(home, '.grok', 'hooks')); writeFileSync(join(home, '.grok', 'hooks', 'evil.json'), '{}');
 assert.match(grokHomeProblems(home).join(), /hooks/);
 const c = await grok('summary', { home }); assert.equal(c.state, 'failed'); assert.match(c.error, /hooks installed/); assert.equal(c.result, '');
});
test('grok: a request without the exact tool input is refused; with it, the human decides', async () => {
 const none = await grok('no-raw'); assert.equal(none.state, 'completed', none.error); assert.match(none.result, /refused 901/);
 const w = new GrokWorker(gitDir(), process.execPath, [acp], { HUB_GROK_HOME: grokHome() }); void w.start('exec-raw');
 await new Promise((ok, fail) => { const t = setTimeout(() => fail(Error('no pending ' + w.state)), 10000); const check = () => { if (w.pending.size) { clearTimeout(t); ok(); } }; w.on('change', check); check(); });
 const p = [...w.pending.values()][0]; assert.equal(p.params.toolCall.rawInput.command, 'SIMULATED echo grok');
 w.approve(p); await finish(w); assert.equal(w.state, 'completed', w.error); assert.match(w.result, /accepted once/); assert.doesNotMatch(w.result, /ALWAYS/);
 assert.ok(grokReviewable({}) && grokReviewable({ rawInput: [] }) && !grokReviewable({ rawInput: { a: 1 } }));
});

// ---- OpenRouter (OpenCode with another provider profile) ----
const openrouter = async (prompt, env = { OPENROUTER_API_KEY: 'synthetic-or-key' }) => { const w = new OpenCodeWorker(gitDir(), process.execPath, [fakeOpenCode], env, OPENROUTER_PROFILE); void w.start(prompt); return finish(w); };
test('openrouter: runs through OpenCode with its own key, provider and model, and no Google credentials', async () => {
 process.env.GEMINI_API_KEY = 'must-not-leak';
 const w = await openrouter('env'); assert.equal(w.state, 'completed', w.error); assert.equal(w.provider, 'openrouter'); assert.equal(w.model, 'openrouter/qwen/qwen3-coder');
 const r = JSON.parse(w.result);
 assert.ok(r.keys.includes('OPENROUTER_API_KEY')); for (const k of ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY']) assert.ok(!r.keys.includes(k), `${k} leaked`);
 const summary = await openrouter('summary'); assert.equal(summary.result, 'SIMULATED opencode summary');
});
test('openrouter: needs its own key, only openrouter models, and the config check pins the provider', async () => {
 assert.throws(() => new OpenCodeWorker(gitDir(), 'opencode', [], { GEMINI_API_KEY: 'k' }, OPENROUTER_PROFILE), /OPENROUTER_API_KEY/);
 for (const model of ['google/gemini-2.5-pro', 'openrouter/..', 'openrouter/x y/z', 'openrouter/onlyone']) assert.throws(() => new OpenCodeWorker(gitDir(), 'opencode', [], { OPENROUTER_API_KEY: 'k', HUB_OPENROUTER_MODEL: model }, OPENROUTER_PROFILE), /openrouter/, model);
 const model = 'openrouter/qwen/qwen3-coder';
 checkOpenCodeConfig(openCodeConfig(model, 'openrouter'), model, 'openrouter');
 assert.throws(() => checkOpenCodeConfig(openCodeConfig(model, 'google'), model, 'openrouter'), /providers other than openrouter/);
 assert.throws(() => checkOpenCodeConfig({ ...openCodeConfig(model, 'openrouter'), enabled_providers: ['openrouter', 'openai'] }, model, 'openrouter'), /providers other than/);
});
