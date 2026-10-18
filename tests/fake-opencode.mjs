// Fake `opencode` for tests: `debug config` prints a resolved config; `acp` speaks a minimal
// Agent Client Protocol over stdio. Flags after the script path alter behaviour:
// --loose (config check reports bash: allow), --plugin (reports a plugin), --wrong-model (session uses openai).
import { createInterface } from 'node:readline';
const args = process.argv.slice(2), flag = f => args.includes(f);
const inline = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}');
if (args.includes('debug') && args.includes('config')) {
 const c = structuredClone(inline);
 if (flag('--loose')) c.permission.bash = 'allow';
 if (flag('--plugin')) c.plugin = ['evil-plugin'];
 process.stdout.write('INFO fake log line\n' + JSON.stringify(c, null, 2) + '\n');
 process.exit(0);
}
if (!args.includes('acp')) process.exit(2);
const send = x => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...x }) + '\n');
const session = 'fake-session';
let promptId, mode = '';
const chunk = text => send({ method: 'session/update', params: { sessionId: session, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
const end = (text, stopReason = 'end_turn') => { if (text) chunk(text); send({ id: promptId, result: { stopReason } }); };
const permission = (id, options, sessionId = session) => send({ id, method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'call1', title: 'SIMULATED echo opencode', kind: 'execute', status: 'pending', rawInput: { command: 'SIMULATED echo opencode' } }, options } });
const allOptions = [{ optionId: 'always', name: 'Always allow', kind: 'allow_always' }, { optionId: 'once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }];
createInterface({ input: process.stdin }).on('line', line => {
 const m = JSON.parse(line);
 if (m.jsonrpc !== '2.0') throw Error('Missing jsonrpc 2.0');
 if (!m.method && m.id === 900) {
  const id = m.result?.outcome?.optionId;
  if (id === 'once') end('SIMULATED action accepted once'); else if (id === 'always') end('ALWAYS GRANTED'); else end('', 'cancelled');
  return;
 }
 if (!m.method && [901, 902, 903].includes(m.id)) { end(m.error ? `refused ${m.id}: ${m.error.message}` : `ACCEPTED ${m.id}`); return; }
 if (m.method === 'initialize') {
  if (m.params.clientCapabilities?.terminal !== false || m.params.clientCapabilities?.fs?.writeTextFile !== false) throw Error('Client must not offer fs/terminal');
  send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
 }
 if (m.method === 'session/new') {
  if (!Array.isArray(m.params.mcpServers) || m.params.mcpServers.length) throw Error('MCP servers passed to session');
  send({ id: m.id, result: { sessionId: session, models: { currentModelId: flag('--wrong-model') ? 'openai/gpt-5' : inline.model, availableModels: [] } } });
 }
 if (m.method === 'session/cancel') { if (promptId !== undefined) end('', 'cancelled'); return; }
 if (m.method === 'session/prompt') {
  if (m.params.sessionId !== session) throw Error('Wrong session');
  promptId = m.id; mode = m.params.prompt[0].text;
  setTimeout(() => {
   if (mode === 'summary') { chunk('SIMULATED '); end('opencode summary'); }
   else if (mode === 'env') {
    const keys = Object.keys(process.env).sort();
    end(JSON.stringify({ keys, hasGemini: process.env.GOOGLE_GENERATIVE_AI_API_KEY === 'synthetic-gemini-key', configHome: process.env.XDG_CONFIG_HOME, dataHome: process.env.XDG_DATA_HOME, cwd: process.cwd() }));
   }
   else if (mode === 'always-only') permission(901, allOptions.filter(o => o.kind !== 'allow_once'));
   else if (mode === 'wrong-session') permission(902, allOptions, 'other-session');
   else if (mode === 'fs') send({ id: 903, method: 'fs/write_text_file', params: { sessionId: session, path: 'outside.txt', content: 'x' } });
   else permission(900, allOptions);
  }, 30);
 }
});
