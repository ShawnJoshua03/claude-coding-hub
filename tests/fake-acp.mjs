// Fake Gemini CLI / Grok for tests, speaking a minimal Agent Client Protocol over stdio.
// Which one it plays follows from argv, as for the real CLIs: `--acp` is Gemini, `agent stdio` is Grok.
// Extra flags after the script path alter behaviour: --yolo-mode (Gemini session starts in yolo),
// --bad-key (Gemini rejects authenticate). The prompt text selects the scenario.
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2), flag = f => args.includes(f);
const gemini = flag('--acp'), grok = flag('agent') && flag('stdio');
if (!gemini && !grok) process.exit(2);
const send = x => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...x }) + '\n');
const session = 'fake-session';
let promptId, mode = '';
const chunk = text => send({ method: 'session/update', params: { sessionId: session, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
const end = (text, stopReason = 'end_turn') => { if (text) chunk(text); send({ id: promptId, result: { stopReason } }); };
const options = [{ optionId: 'proceed_always', name: 'Allow for this session', kind: 'allow_always' }, { optionId: 'proceed_once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'cancel', name: 'No', kind: 'reject_once' }];
const permission = (id, toolCall, opts = options, sessionId = session) => send({ id, method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'call1', status: 'pending', ...toolCall }, options: opts } });
const editCall = { title: 'Writing to notes.txt', kind: 'edit', content: [{ type: 'diff', path: 'notes.txt', oldText: 'a', newText: 'SIMULATED new text' }] };
createInterface({ input: process.stdin }).on('line', line => {
 const m = JSON.parse(line);
 if (m.jsonrpc !== '2.0') throw Error('Missing jsonrpc 2.0');
 if (!m.method && m.id === 900) { const id = m.result?.outcome?.optionId; if (id === 'proceed_once') end('SIMULATED action accepted once'); else if (id === 'proceed_always') end('ALWAYS GRANTED'); else end('', 'cancelled'); return; }
 if (!m.method && m.id >= 901 && m.id <= 909) { end(m.error ? `refused ${m.id}: ${m.error.message}` : `ACCEPTED ${m.id}`); return; }
 if (m.method === 'initialize') {
  if (m.params.clientCapabilities?.terminal !== false || m.params.clientCapabilities?.fs?.writeTextFile !== false) throw Error('Client must not offer fs/terminal');
  send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: gemini ? [{ id: 'gemini-api-key', name: 'Gemini API key' }] : [{ id: 'cached_token', name: 'cached_token' }] } });
 }
 if (m.method === 'authenticate') {
  const ok = gemini ? m.params.methodId === 'gemini-api-key' && m.params._meta?.['api-key'] === 'synthetic-gemini-key' && !flag('--bad-key') : m.params.methodId === 'cached_token';
  send(ok ? { id: m.id, result: {} } : { id: m.id, error: { code: -32000, message: 'Authentication required' } });
 }
 if (m.method === 'session/new') {
  if (!Array.isArray(m.params.mcpServers) || m.params.mcpServers.length) throw Error('MCP servers passed to session');
  send({ id: m.id, result: { sessionId: session, ...(gemini ? { modes: { currentModeId: flag('--yolo-mode') ? 'yolo' : 'default' } } : {}) } });
 }
 if (m.method === 'session/cancel') { if (promptId !== undefined) end('', 'cancelled'); return; }
 if (m.method === 'session/prompt') {
  promptId = m.id; mode = m.params.prompt[0].text;
  setTimeout(() => {
   if (mode === 'summary') { chunk('SIMULATED '); end('summary'); }
   else if (mode === 'env') {
    let settings; try { settings = JSON.parse(readFileSync(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, 'utf8')); } catch {}
    end(JSON.stringify({ argv: args, keys: Object.keys(process.env).sort(), home: process.env.HOME, userHome: process.env.USERPROFILE, appData: process.env.APPDATA, geminiHome: process.env.GEMINI_CLI_HOME, settingsPath: process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, settings, cwd: process.cwd() }));
   }
   else if (mode === 'edit') permission(900, editCall);
   else if (mode === 'exec-title') permission(901, { title: 'SIMULATED harmless description', kind: 'execute', content: [] });
   else if (mode === 'exec-raw') permission(900, { title: 'SIMULATED echo grok', kind: 'execute', rawInput: { command: 'SIMULATED echo grok' } });
   else if (mode === 'no-raw') permission(901, { title: 'SIMULATED echo grok', kind: 'execute' });
   else if (mode === 'fetch') permission(901, { title: 'Fetching https://example.invalid', kind: 'fetch', content: [] });
   else if (mode === 'empty-diff') permission(901, { title: 'Writing', kind: 'edit', content: [] });
   else if (mode === 'always-only') permission(902, editCall, options.filter(o => o.kind !== 'allow_once'));
   else if (mode === 'wrong-session') permission(903, editCall, options, 'other-session');
   else if (mode === 'fs') send({ id: 904, method: 'fs/write_text_file', params: { sessionId: session, path: 'outside.txt', content: 'x' } });
   else permission(900, editCall);
  }, 30);
 }
});
