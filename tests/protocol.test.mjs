import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { filteredEnvironment, fixtureRoot } from '../dist/worker.js';
const parse = r => { if(r.isError) throw Error(r.content[0].text); return JSON.parse(r.content[0].text); };
async function connect(t, handler, forms=true, dbPath=join(mkdtempSync(join(tmpdir(),'hub-')),'hub.sqlite')) {
 const transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/server.js')],cwd:process.cwd(),env:{...process.env,HUB_DB_PATH:dbPath,HUB_CODEX_COMMAND:process.execPath,HUB_CODEX_PREFIX_JSON:JSON.stringify([resolve('tests/fake-codex.mjs')])},stderr:'pipe'});
 const client=new Client({name:'pilot-test-client',version:'1'}, {capabilities:forms?{elicitation:{form:{}}}:{}});
 if(forms) client.setRequestHandler(ElicitRequestSchema,handler??(async()=>({action:'decline'})));
 await client.connect(transport); t.after(()=>client.close());
 return {client,dbPath,call:async(name,args={})=>parse(await client.callTool({name,arguments:args}))};
}
test('dedicated fixture boundary and filtered credentials',()=>{
 assert.throws(()=>fixtureRoot(resolve('fixtures/pilot'),resolve('.')));
 process.env.OPENAI_API_KEY='synthetic-secret'; assert.equal(filteredEnvironment().OPENAI_API_KEY,undefined); delete process.env.OPENAI_API_KEY;
});
test('real MCP transport + fake Codex background result',async t=>{
 const c=await connect(t); const start=await c.call('start_worker',{prompt:'summary'});
 assert.ok(start.taskId); const end=await c.call('wait_for_worker',{taskId:start.taskId,seconds:5}); assert.equal(end.state,'completed'); assert.match(end.result,/SIMULATED repository summary/);
 const tools=await c.client.listTools(); assert.ok(!tools.tools.some(x=>/approve|answer/.test(x.name)));
});
test('one-shot human form maps to provider accept',async t=>{
 let count=0; const c=await connect(t,async req=>{count++;assert.match(req.params.message,/SIMULATED echo pilot/); return {action:'accept',content:{decision:'allow-once'}};});
 const start=await c.call('start_worker',{prompt:'approval'}); const end=await c.call('wait_for_worker',{taskId:start.taskId,seconds:5}); assert.equal(end.state,'completed'); assert.equal(count,1); assert.match(end.result,/accepted once/);
});
test('decline stops task and no rephrased retry follows',async t=>{
 let count=0; const c=await connect(t,async()=>{count++;return {action:'decline'};}); const start=await c.call('start_worker',{prompt:'approval'}); const end=await c.call('wait_for_worker',{taskId:start.taskId,seconds:5}); assert.equal(end.state,'denied');assert.equal(count,1);assert.equal(end.result,'');assert.deepEqual(end.pending,[]);
});
test('worker question is answered by human client, not model tool args',async t=>{
 const c=await connect(t,async req=>{assert.equal(req.params.requestedSchema.properties.color.enum[0],'Blue');return {action:'accept',content:{color:'Blue'}};});const start=await c.call('start_worker',{prompt:'question'});const end=await c.call('wait_for_worker',{taskId:start.taskId,seconds:5});assert.equal(end.state,'completed');assert.match(end.result,/Blue/);
});
test('concurrent waits elicit once; cancellation invalidates late response',async t=>{
 let count=0,release;let arrived;const began=new Promise(r=>arrived=r);
 const c=await connect(t,async()=>{count++;arrived();return new Promise(r=>release=r);});const start=await c.call('start_worker',{prompt:'approval'});
 const first=c.call('wait_for_worker',{taskId:start.taskId,seconds:5}); await began;
 const second=c.call('wait_for_worker',{taskId:start.taskId,seconds:1});
 const cancelled=await c.call('cancel_worker',{taskId:start.taskId});assert.equal(cancelled.state,'cancelled');release({action:'accept',content:{decision:'allow-once'}});
 await Promise.allSettled([first,second]); const end=await c.call('get_worker',{taskId:start.taskId});assert.equal(end.state,'cancelled');assert.equal(count,1);assert.equal(end.result,'');assert.deepEqual(end.pending,[]);
});
test('unsupported client cannot silently grant worker approval',async t=>{
 const c=await connect(t,null,false);const start=await c.call('start_worker',{prompt:'approval'});await assert.rejects(c.call('wait_for_worker',{taskId:start.taskId,seconds:5}),/elicitation is unavailable/);const pending=await c.call('get_worker',{taskId:start.taskId});assert.equal(pending.state,'waiting_for_user');assert.equal(pending.pending.length,1);await c.call('cancel_worker',{taskId:start.taskId});
});
