import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const parse = r => { if(r.isError) throw Error(r.content[0].text); return JSON.parse(r.content[0].text); };
// Real Codex lists user-config MCP servers even after the hub disables them; only inert, hub-disabled entries may pass.
async function run(t, mcp) {
 const transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/server.js')],cwd:process.cwd(),env:{...process.env,HUB_DB_PATH:join(mkdtempSync(join(tmpdir(),'hub-')),'hub.sqlite'),HUB_CODEX_COMMAND:process.execPath,HUB_CODEX_PREFIX_JSON:JSON.stringify([resolve('tests/fake-codex.mjs'),'mcp='+mcp])},stderr:'pipe'});
 const client=new Client({name:'mcp-inventory-test',version:'1'},{capabilities:{elicitation:{form:{}}}});
 client.setRequestHandler(ElicitRequestSchema,async()=>({action:'decline'}));
 await client.connect(transport); t.after(()=>client.close());
 const call=async(name,args)=>parse(await client.callTool({name,arguments:args}));
 const s=await call('start_worker',{prompt:'summary'}); return call('wait_for_worker',{taskId:s.taskId,seconds:5});
}
test('mcp: a user server the hub disabled and that never started does not block the task',async t=>{
 const end=await run(t,'inert'); assert.equal(end.state,'completed'); assert.match(end.result,/SIMULATED repository summary/);
});
test('mcp: a user server that stays connected despite being disabled stops the task before inference',async t=>{
 const end=await run(t,'ignored'); assert.equal(end.state,'failed'); assert.match(end.error,/inherited MCP integrations/); assert.equal(end.result,'');
});
test('mcp: a server the hub never saw in config (plugin or app) stops the task before inference',async t=>{
 const end=await run(t,'extra'); assert.equal(end.state,'failed'); assert.match(end.error,/inherited MCP integrations/); assert.equal(end.result,'');
});
