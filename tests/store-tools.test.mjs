import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Store } from '../dist/store.js';
const parse = r => { if(r.isError) throw Error(r.content[0].text); return JSON.parse(r.content[0].text); };
const ws = { id: 'w', path: '/tmp/w', branch: 'hub/w', base: 'abc', gitDir: '/tmp/g' };
async function session(t, dbPath) {
 const transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/server.js')],cwd:process.cwd(),env:{...process.env,HUB_DB_PATH:dbPath,HUB_CODEX_COMMAND:process.execPath,HUB_CODEX_PREFIX_JSON:JSON.stringify([resolve('tests/fake-codex.mjs')])},stderr:'pipe'});
 const client=new Client({name:'store-tools-test',version:'1'},{capabilities:{elicitation:{form:{}}}});
 client.setRequestHandler(ElicitRequestSchema,async()=>({action:'decline'}));
 await client.connect(transport); t.after(()=>client.close());
 return async(name,args={})=>parse(await client.callTool({name,arguments:args}));
}
const finish = async (call, prompt) => { const s=await call('start_worker',{prompt}); await call('wait_for_worker',{taskId:s.taskId,seconds:5}); return s.taskId; };

test('list returns newest first and respects the limit',()=>{
 const s=new Store(':memory:'); for(const id of ['a','b','c']) s.create(id,'p'+id);
 assert.deepEqual(s.list().map(t=>t.taskId),['c','b','a']); assert.deepEqual(s.list(2).map(t=>t.taskId),['c','b']);
});
test('update stores state, result and error, and ignores a non-string thread id',()=>{
 const s=new Store(':memory:'); s.create('a','p');
 s.update('a',{state:'failed',result:'partial',error:'boom',threadId:'th'});
 assert.deepEqual([s.get('a').state,s.get('a').result,s.get('a').error,s.get('a').threadId],['failed','partial','boom','th']);
 s.update('a',{state:'failed',result:'partial',error:'boom',threadId:42}); assert.equal(s.get('a').threadId,'');
});
test('provider defaults to codex and can be set',()=>{
 const s=new Store(':memory:'); s.create('a','p'); s.create('b','p','other');
 assert.equal(s.get('a').provider,'codex'); assert.equal(s.get('b').provider,'other');
});
test('workspace round-trips, shows its branch, and is cleared when removed',()=>{
 const s=new Store(':memory:'); s.create('a','p','codex',ws); s.create('b','p');
 assert.deepEqual(s.workspace('a'),ws); assert.equal(s.get('a').branch,'hub/w'); assert.equal(s.workspace('b'),undefined); assert.equal(s.get('b').branch,'');
 assert.deepEqual(s.events('a')[0].data,{promptChars:1,provider:'codex',branch:'hub/w',base:'abc'});
 s.setWorkspaceRemoved('a'); assert.equal(s.workspace('a'),undefined); assert.equal(s.get('a').branch,''); assert.equal(s.workspace('missing'),undefined);
});
test('events keep order per task, round-trip data, and honour the limit',()=>{
 const s=new Store(':memory:'); s.create('a','p'); s.create('b','p');
 s.event('a','x',{n:1,nested:{ok:true}}); s.event('b','y'); s.event('a','z');
 assert.deepEqual(s.events('a').map(e=>e.type),['created','x','z']); assert.deepEqual(s.events('a')[1].data,{n:1,nested:{ok:true}});
 assert.deepEqual(s.events('b').map(e=>e.type),['created','y']); assert.deepEqual(s.events('b')[1].data,{});
 assert.deepEqual(s.events('a',2).map(e=>e.type),['created','x']); assert.deepEqual(s.events('nope'),[]);
 const seqs=s.events('a').map(e=>e.seq); assert.deepEqual(seqs,[...seqs].sort((p,q)=>p-q));
});
test('recover covers every non-terminal state, explains why, and logs an event',()=>{
 const s=new Store(':memory:'); const terminal=['completed','failed','cancelled','denied','interrupted'];
 for(const [id,state] of [['t1','starting'],['t2','running'],['t3','waiting_for_user'],...terminal.map(x=>['d-'+x,x])]) { s.create(id,'p'); s.update(id,{state,result:'',error:'',threadId:''}); }
 assert.deepEqual(s.recover().sort(),['t1','t2','t3']);
 for(const id of ['t1','t2','t3']) { assert.equal(s.get(id).state,'interrupted'); assert.match(s.get(id).error,/Hub restarted/); assert.deepEqual(s.events(id).at(-1).data,{reason:'hub restart'}); }
 for(const state of terminal) { assert.equal(s.get('d-'+state).state,state); assert.equal(s.get('d-'+state).error,''); }
});
test('data persists when the database file is reopened',()=>{
 const db=join(mkdtempSync(join(tmpdir(),'store-')),'nested','hub.sqlite');
 const a=new Store(db); a.create('a','keep me','codex',ws); a.event('a','note',{k:1}); a.close();
 const b=new Store(db); assert.equal(b.get('a').prompt,'keep me'); assert.deepEqual(b.workspace('a'),ws); assert.deepEqual(b.events('a').map(e=>e.type),['created','note']); b.close();
});
test('an older database without provider and workspace columns is upgraded in place',()=>{
 const db=join(mkdtempSync(join(tmpdir(),'store-')),'old.sqlite'); const raw=new DatabaseSync(db);
 raw.exec(`CREATE TABLE tasks (task_id TEXT PRIMARY KEY, prompt TEXT NOT NULL, state TEXT NOT NULL, result TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', thread_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  INSERT INTO tasks (task_id,prompt,state,created_at,updated_at) VALUES ('old','legacy','completed','2020-01-01T00:00:00Z','2020-01-01T00:00:00Z');`); raw.close();
 const s=new Store(db); assert.equal(s.get('old').provider,'codex'); assert.equal(s.get('old').branch,''); assert.equal(s.workspace('old'),undefined);
 s.create('new','p','codex',ws); assert.equal(s.get('new').branch,'hub/w'); s.close();
});

test('list_workers reports tasks newest first, honours limit and truncates long prompts',async t=>{
 const call=await session(t,join(mkdtempSync(join(tmpdir(),'hub-')),'hub.sqlite'));
 assert.deepEqual(await call('list_workers'),[]);
 const first=await finish(call,'summary'); const second=await finish(call,'approval '+'x'.repeat(400));
 const all=await call('list_workers'); assert.deepEqual(all.map(w=>w.taskId),[second,first]);
 assert.equal(all[1].state,'completed'); assert.equal(all[1].provider,'codex'); assert.match(all[1].result,/SIMULATED repository summary/);
 assert.equal(all[0].prompt.length,200); assert.equal(all[0].state,'denied');
 assert.deepEqual((await call('list_workers',{limit:1})).map(w=>w.taskId),[second]);
 await assert.rejects(call('list_workers',{limit:0})); await assert.rejects(call('list_workers',{limit:101}));
});
test('get_task_history returns the task and its events in order, and honours limit',async t=>{
 const call=await session(t,join(mkdtempSync(join(tmpdir(),'hub-')),'hub.sqlite'));
 const id=await finish(call,'summary'); const h=await call('get_task_history',{taskId:id});
 assert.equal(h.task.taskId,id); assert.equal(h.task.state,'completed'); assert.equal(h.task.prompt,'summary');
 assert.equal(h.events[0].type,'created'); assert.equal(h.events[0].data.promptChars,7);
 assert.equal(h.events.at(-1).data.state,'completed'); assert.deepEqual(h.events.map(e=>e.seq),[...h.events.map(e=>e.seq)].sort((a,b)=>a-b));
 assert.equal((await call('get_task_history',{taskId:id,limit:1})).events.length,1);
 await assert.rejects(call('get_task_history',{taskId:id,limit:0})); await assert.rejects(call('get_task_history',{taskId:id,limit:501}));
});
test('get_task_history rejects an unknown task and records a declined approval as declined',async t=>{
 const call=await session(t,join(mkdtempSync(join(tmpdir(),'hub-')),'hub.sqlite'));
 await assert.rejects(call('get_task_history',{taskId:'nope'}),/Unknown task/);
 const id=await finish(call,'approval'); const h=await call('get_task_history',{taskId:id});
 assert.equal(h.task.state,'denied'); const d=h.events.find(e=>e.type==='human_decision'); assert.equal(d.data.allowed,false);
});
