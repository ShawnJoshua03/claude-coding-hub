// Terminal demo of the approval flow. No accounts, keys or phone needed.
//
// A SIMULATED worker (tests/fake-acp.mjs, playing Gemini CLI) is driven through the real hub over MCP.
// This script is the "native client": it shows each approval form and waits for YOU to answer.
//   npm run build && npm run demo
// Piped (non-interactive) input declines every form, so the demo is safe to run in CI.
import { resolve, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const root = resolve(import.meta.dirname, '..');
// Lines are queued as they arrive so piped input is not lost; end of input answers "no".
const rl = createInterface({ input: process.stdin });
const lines = [], waiting = []; let closed = false;
rl.on('line', l => (waiting.shift() ?? (x => lines.push(x)))(l));
rl.on('close', () => { closed = true; for (const w of waiting.splice(0)) w(''); });
const ask = q => { process.stdout.write(q); return new Promise(resolve => { if (lines.length) resolve(lines.shift()); else if (closed) resolve(''); else waiting.push(resolve); }); };
const bold = s => `\x1b[1m${s}\x1b[0m`, dim = s => `\x1b[2m${s}\x1b[0m`;
let formsShown = 0;

const transport = new StdioClientTransport({
  command: process.execPath, args: [join(root, 'dist/server.js')], cwd: root, stderr: 'pipe',
  env: { ...process.env, GEMINI_API_KEY: 'synthetic-gemini-key', HUB_DB_PATH: join(mkdtempSync(join(tmpdir(), 'hub-demo-')), 'hub.sqlite'), HUB_GEMINI_COMMAND: process.execPath, HUB_GEMINI_PREFIX_JSON: JSON.stringify([join(root, 'tests/fake-acp.mjs')]) },
});
const client = new Client({ name: 'terminal-demo', version: '1' }, { capabilities: { elicitation: { form: {} } } });
client.setRequestHandler(ElicitRequestSchema, async req => {
  formsShown++;
  console.log(`\n${bold('--- APPROVAL FORM (what the human sees) ---')}\n${req.params.message}\n`);
  const answer = (await ask(bold('Allow this exact request once? [y/N] '))).trim().toLowerCase();
  const allow = answer === 'y' || answer === 'yes';
  console.log(dim(allow ? 'You allowed it once.' : 'You declined. The whole task stops.'));
  return { action: 'accept', content: { decision: allow ? 'allow-once' : 'decline' } };
});
await client.connect(transport);
const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); if (r.isError) throw new Error(r.content[0].text); return JSON.parse(r.content[0].text); };
const scenario = async (title, prompt) => {
  console.log(`\n${bold('== ' + title)}\n${dim('worker prompt: ' + prompt)}`);
  const started = await call('start_worker', { prompt, provider: 'gemini' });
  const end = await call('wait_for_worker', { taskId: started.taskId, seconds: 20 });
  console.log(`${bold('result:')} state=${end.state}  report=${JSON.stringify(end.result)}`);
};

console.log(bold('claude-coding-hub terminal demo') + dim('  (simulated worker, real hub)'));
await scenario('1. A worker proposes a file edit. The form shows the exact diff.', 'edit');
const before = formsShown;
await scenario('2. A worker proposes a shell command, described only by its own words.', 'exec-title');
console.log(dim(formsShown === before
  ? '\nNo form appeared: the hub refused it, because Gemini can show the model\'s description instead of the real command.'
  : '\nA form appeared.'));
const history = await call('list_workers', { limit: 5 });
console.log(`\n${bold('Audit trail:')} ${history.length} tasks recorded; every decision above is in get_task_history.`);
rl.close(); await client.close();
