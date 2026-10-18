import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { OpenCodeWorker, checkOpenCodeConfig, openCodeConfig, projectConfigFiles } from '../dist/opencode.js';
import { done } from '../dist/task.js';

const fake = resolve('tests/fake-opencode.mjs');
const parse = r => { if (r.isError) throw Error(r.content[0].text); return JSON.parse(r.content[0].text); };
const secrets = { OPENAI_API_KEY: 'synthetic-openai', ANTHROPIC_API_KEY: 'synthetic-anthropic', GITHUB_TOKEN: 'synthetic-gh', OPENCODE_CONFIG: 'C:/evil.json', OPENCODE_CONFIG_DIR: 'C:/evil' };
async function hub(t, answer, extraEnv = {}) {
 const db = join(mkdtempSync(join(tmpdir(), 'hub-')), 'hub.sqlite');
 const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/server.js')], cwd: process.cwd(), env: { ...process.env, ...secrets, HUB_DB_PATH: db, GEMINI_API_KEY: 'synthetic-gemini-key', HUB_OPENCODE_COMMAND: process.execPath, HUB_OPENCODE_PREFIX_JSON: JSON.stringify([fake]), ...extraEnv }, stderr: 'pipe' });
 const client = new Client({ name: 'opencode-test', version: '1' }, { capabilities: { elicitation: { form: {} } } });
 client.setRequestHandler(ElicitRequestSchema, answer ?? (async () => ({ action: 'decline' })));
 await client.connect(transport); t.after(() => client.close());
 return async (name, args = {}) => parse(await client.callTool({ name, arguments: args }));
}
const run = async (call, prompt) => { const s = await call('start_worker', { prompt, provider: 'opencode' }); return call('wait_for_worker', { taskId: s.taskId, seconds: 10 }); };
function gitDir() { const d = realpathSync(mkdtempSync(join(tmpdir(), 'hub-oc-'))); execFileSync('git', ['init', '-q'], { cwd: d }); return d; }
async function direct(prompt, prefix = [], cwd = gitDir()) {
 const w = new OpenCodeWorker(cwd, process.execPath, [fake, ...prefix], { GEMINI_API_KEY: 'synthetic-gemini-key' });
 void w.start(prompt);
 await new Promise((ok, fail) => { const t = setTimeout(() => fail(Error('timeout ' + w.state)), 10000); const check = () => { if (done(w.state)) { clearTimeout(t); ok(); } }; w.on('change', check); check(); });
 await w.cleanup; return w;
}

test('opencode: fake ACP worker result comes back through MCP', async t => {
 const call = await hub(t); const end = await run(call, 'summary');
 assert.equal(end.provider, 'opencode'); assert.equal(end.state, 'completed', end.error); assert.equal(end.result, 'SIMULATED opencode summary');
});
test('opencode: human allow-once selects only the allow_once option', async t => {
 let count = 0; const call = await hub(t, async req => { count++; assert.match(req.params.message, /REAL OPENCODE APPROVAL/); assert.match(req.params.message, /SIMULATED echo opencode/); return { action: 'accept', content: { decision: 'allow-once' } }; });
 const end = await run(call, 'approval'); assert.equal(end.state, 'completed', end.error); assert.equal(count, 1); assert.match(end.result, /accepted once/); assert.doesNotMatch(end.result, /ALWAYS/);
});
test('opencode: decline stops the task', async t => {
 let count = 0; const call = await hub(t, async () => { count++; return { action: 'decline' }; });
 const end = await run(call, 'approval'); assert.equal(end.state, 'denied'); assert.equal(count, 1); assert.equal(end.result, ''); assert.deepEqual(end.pending, []);
});
test('opencode: worker env carries only the allowlist, the Gemini key and isolated OpenCode dirs', async t => {
 const call = await hub(t); const end = await run(call, 'env'); assert.equal(end.state, 'completed', end.error);
 const r = JSON.parse(end.result);
 for (const k of [...Object.keys(secrets), 'GEMINI_API_KEY', 'CODEX_HOME', 'HUB_DB_PATH', 'HUB_OPENCODE_COMMAND']) assert.ok(!r.keys.includes(k), `${k} leaked`);
 const allowed = /^(PATH|Path|PATHEXT|SYSTEMROOT|SystemRoot|WINDIR|COMSPEC|USERPROFILE|HOME|APPDATA|LOCALAPPDATA|TEMP|TMP|LANG|XDG_(CONFIG|DATA|STATE|CACHE)_HOME|OPENCODE_CONFIG_CONTENT|OPENCODE_DISABLE_[A-Z_]+|GOOGLE_GENERATIVE_AI_API_KEY)$/;
 // Windows injects these into every child even from a minimal env (Codex workers get them too); none is a credential.
 const osAdded = new Set(['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE', 'USERDOMAIN', 'USERNAME']);
 for (const k of r.keys.filter(k => !k.startsWith('=') && !(process.platform === 'win32' && osAdded.has(k)))) assert.match(k, allowed);
 assert.equal(r.hasGemini, true);
 const rel = relative(r.cwd, r.configHome); assert.ok(rel.startsWith('..') || isAbsolute(rel), 'OpenCode config home must be outside the task folder');
});
test('opencode: missing Gemini key refuses to start', async t => {
 const call = await hub(t, undefined, { GEMINI_API_KEY: '', GOOGLE_GENERATIVE_AI_API_KEY: '' });
 await assert.rejects(call('start_worker', { prompt: 'summary', provider: 'opencode' }), /GEMINI_API_KEY/);
});
test('opencode: loosened permissions or plugins stop the task before inference', async () => {
 const loose = await direct('summary', ['--loose']); assert.equal(loose.state, 'failed'); assert.match(loose.error, /permission\.bash must be ask/); assert.equal(loose.sessionId, ''); assert.equal(loose.result, '');
 const plugin = await direct('summary', ['--plugin']); assert.equal(plugin.state, 'failed'); assert.match(plugin.error, /plugins/); assert.equal(plugin.result, '');
 assert.equal(loose.busy(), false);
});
test('opencode: session on a non-Gemini model is refused', async () => {
 const w = await direct('summary', ['--wrong-model']); assert.equal(w.state, 'failed'); assert.match(w.error, /Gemini/); assert.equal(w.result, '');
});
test('opencode: project config in the task folder is refused before any process starts', async () => {
 for (const name of ['opencode.json', '.opencode']) {
  const d = gitDir(); if (name === '.opencode') { mkdirSync(join(d, name, 'plugin'), { recursive: true }); writeFileSync(join(d, name, 'plugin', 'x.js'), 'export default {}'); } else writeFileSync(join(d, name), '{"permission":{"bash":"allow"}}');
  assert.equal(projectConfigFiles(d).length, 1);
  const w = await direct('summary', [], d); assert.equal(w.state, 'failed'); assert.match(w.error, /Project OpenCode config/); assert.equal(w.busy(), false);
 }
});
test('opencode: permission without allow_once, wrong session, and fs requests are refused, never presented', async () => {
 for (const [mode, id] of [['always-only', 901], ['wrong-session', 902], ['fs', 903]]) {
  const w = await direct(mode); assert.equal(w.state, 'completed', w.error); assert.match(w.result, new RegExp(`refused ${id}`)); assert.equal(w.pending.size, 0);
 }
});
test('opencode: config check accepts only the hub settings', () => {
 const model = 'google/gemini-2.5-pro'; checkOpenCodeConfig(openCodeConfig(model), model);
 const bad = c => assert.throws(() => checkOpenCodeConfig(c, model), /did not retain/);
 bad({ ...openCodeConfig(model), permission: { ...openCodeConfig(model).permission, edit: { '*': 'ask', 'src/**': 'allow' } } });
 bad({ ...openCodeConfig(model), permission: { ...openCodeConfig(model).permission, webfetch: 'ask' } });
 bad({ ...openCodeConfig(model), mcp: { x: { type: 'local', command: ['x'] } } });
 bad({ ...openCodeConfig(model), agent: { build: { permission: { bash: 'allow' } } } });
 bad({ ...openCodeConfig(model), enabled_providers: ['google', 'openai'] });
 bad({ ...openCodeConfig(model), formatter: {} });
 bad(undefined);
 assert.throws(() => new OpenCodeWorker(gitDir(), 'opencode', [], { GEMINI_API_KEY: 'k', HUB_OPENCODE_MODEL: 'openai/gpt-5' }), /google/);
 assert.equal(existsSync(fake), true);
});
