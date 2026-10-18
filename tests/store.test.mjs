import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Store } from '../dist/store.js';
const parse = r => { if(r.isError) throw Error(r.content[0].text); return JSON.parse(r.content[0].text); };
async function session(dbPath, answer) {
 const transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/server.js')],cwd:process.cwd(),env:{...process.env,HUB_DB_PATH:dbPath,HUB_CODEX_COMMAND:process.execPath,HUB_CODEX_PREFIX_JSON:JSON.stringify([resolve('tests/fake-codex.mjs')])},stderr:'pipe'});
 const client=new Client({name:'store-test',version:'1'},{capabilities:{elicitation:{form:{}}}});
 client.setRequestHandler(ElicitRequestSchema,answer??(async()=>({action:'decline'})));
 await client.connect(transport);
 return {client,call:async(name,args={})=>parse(await client.callTool({name,arguments:args}))};
}
test('store records tasks and events in order',()=>{
 const s=new Store(':memory:'); s.create('a','do a'); s.update('a',{state:'running',result:'',error:'',threadId:'t'}); s.event('a','state',{state:'running'});
 assert.equal(s.get('a').state,'running'); assert.deepEqual(s.events('a').map(e=>e.type),['created','state']); assert.equal(s.get('nope'),undefined);
});
test('recover marks only non-terminal tasks interrupted',()=>{
 const s=new Store(':memory:'); s.create('live','x'); s.update('live',{state:'waiting_for_user',result:'',error:'',threadId:''});
 s.create('done','y'); s.update('done',{state:'completed',result:'ok',error:'',threadId:''});
 assert.deepEqual(s.recover(),['live']); assert.equal(s.get('live').state,'interrupted'); assert.equal(s.get('done').state,'completed'); assert.deepEqual(s.recover(),[]);
});
test('task history survives a hub restart and logs the exact human decision',async t=>{
 const db=join(mkdtempSync(join(tmpdir(),'hub-')),'hub.sqlite');
 const a=await session(db,async()=>({action:'accept',content:{decision:'allow-once'}}));
 const start=await a.call('start_worker',{prompt:'approval'}); const end=await a.call('wait_for_worker',{taskId:start.taskId,seconds:5}); assert.equal(end.state,'completed');
 await a.client.close();
 const b=await session(db); t.after(()=>b.client.close());
 const list=await b.call('list_workers'); assert.equal(list[0].taskId,start.taskId); assert.equal(list[0].state,'completed');
 const hist=await b.call('get_task_history',{taskId:start.taskId});
 const decision=hist.events.find(e=>e.type==='human_decision'); assert.equal(decision.data.allowed,true); assert.match(JSON.stringify(decision.data.request),/SIMULATED echo pilot/);
 assert.ok(hist.events.some(e=>e.type==='state'&&e.data.state==='waiting_for_user'));
});
test('task active when the hub dies is reported interrupted after restart',async()=>{
 const db=join(mkdtempSync(join(tmpdir(),'hub-')),'hub.sqlite'); let arrived; const began=new Promise(r=>arrived=r);
 const a=await session(db,async()=>{arrived();return new Promise(()=>{});});
 const start=await a.call('start_worker',{prompt:'approval'}); void a.call('wait_for_worker',{taskId:start.taskId,seconds:30}).catch(()=>{}); await began;
 const s=new Store(db); assert.equal(s.get(start.taskId).state,'waiting_for_user'); s.close();
 await a.client.close();
 const b=await session(db); const hist=await b.call('get_task_history',{taskId:start.taskId});
 assert.ok(['interrupted','cancelled'].includes(hist.task.state)); await b.client.close();
});
