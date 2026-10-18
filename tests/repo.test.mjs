import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const parse = r => { if(r.isError) throw Error(r.content[0].text); return JSON.parse(r.content[0].text); };
const git = (cwd,...a) => execFileSync('git',a,{cwd,encoding:'utf8'}).trim();
function repo() {
 const base=realpathSync(mkdtempSync(join(tmpdir(),'hubrepo-'))), dir=join(base,'repo'); mkdirSync(dir);
 git(dir,'init','-q','-b','main'); git(dir,'config','user.email','t@example.com'); git(dir,'config','user.name','t');
 mkdirSync(join(dir,'.hooks')); writeFileSync(join(dir,'.hooks','pre-commit'),'#!/bin/sh\nexit 0\n'); writeFileSync(join(dir,'README.md'),'hello\n');
 git(dir,'config','core.hooksPath','.hooks'); git(dir,'add','-A'); git(dir,'commit','-q','-m','init');
 return {dir,base};
}
async function hub(t, {dir,base}, extraEnv={}, answer) {
 const transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/server.js')],cwd:process.cwd(),env:{...process.env,HUB_REPO_ROOT:dir,HUB_WORKTREE_ROOT:join(base,'worktrees'),HUB_DB_PATH:join(base,'hub.sqlite'),HUB_CODEX_COMMAND:process.execPath,HUB_CODEX_PREFIX_JSON:JSON.stringify([resolve('tests/fake-codex.mjs')]),...extraEnv},stderr:'pipe'});
 const client=new Client({name:'repo-test',version:'1'},{capabilities:{elicitation:{form:{}}}});
 client.setRequestHandler(ElicitRequestSchema,answer??(async()=>({action:'decline'})));
 await client.connect(transport); t.after(()=>client.close());
 return async(name,args={})=>parse(await client.callTool({name,arguments:args}));
}
const run = async (call, files) => { const s=await call('start_worker',{prompt:'write:'+JSON.stringify(files)}); const e=await call('wait_for_worker',{taskId:s.taskId,seconds:5}); assert.equal(e.state,'completed',e.error); return s; };

test('each task gets its own worktree and branch; user checkout untouched',async t=>{
 const r=repo(); const call=await hub(t,r);
 const a=await run(call,{'a.txt':'from a\n'}), b=await run(call,{'b.txt':'from b\n'});
 assert.notEqual(a.branch,b.branch); assert.match(a.branch,/^hub\//);
 const da=await call('get_worker_diff',{taskId:a.taskId}); assert.match(da.patch,/from a/); assert.doesNotMatch(da.patch,/from b/);
 assert.equal(existsSync(join(r.dir,'a.txt')),false); assert.equal(git(r.dir,'status','--porcelain'),''); assert.equal(git(r.dir,'branch','--show-current'),'main');
 const c=await call('commit_worker_changes',{taskId:a.taskId,message:'worker a'}); assert.equal(c.committed,true);
 assert.equal(git(r.dir,'show',`${a.branch}:a.txt`),'from a');
 await assert.rejects(call('remove_worker_workspace',{taskId:b.taskId}),/uncommitted/);
 const rm=await call('remove_worker_workspace',{taskId:a.taskId,deleteBranch:false}); assert.equal(rm.removed,true);
 assert.equal(git(r.dir,'show',`${a.branch}:a.txt`),'from a');
 await assert.rejects(call('get_worker_diff',{taskId:a.taskId}),/no workspace/);
});
test('host git never runs a hook the worker rewrote',async t=>{
 const r=repo(); const call=await hub(t,r); const marker=join(r.base,'PWNED').replaceAll('\\','/');
 const s=await run(call,{'.hooks/pre-commit':`#!/bin/sh\necho pwned > "${marker}"\n`,'.hooks/post-commit':`#!/bin/sh\necho pwned > "${marker}"\n`,'x.txt':'x\n'});
 const c=await call('commit_worker_changes',{taskId:s.taskId,message:'with hooks'}); assert.equal(c.committed,true);
 assert.equal(existsSync(join(r.base,'PWNED')),false);
});
test('worker redirecting its .git pointer cannot steer host git',async t=>{
 const r=repo(); const call=await hub(t,r); const marker=join(r.base,'PWNED2').replaceAll('\\','/');
 const s=await run(call,{'.git':'gitdir: evil\n','evil/HEAD':'ref: refs/heads/main\n','evil/config':`[core]\n\trepositoryformatversion = 0\n\tfsmonitor = "sh -c 'echo pwned > ${marker}'"\n\thooksPath = .hooks\n`,'evil/objects/.keep':'','evil/refs/heads/.keep':'','y.txt':'y\n'});
 const d=await call('get_worker_diff',{taskId:s.taskId}); assert.match(d.patch,/y\.txt/);
 const c=await call('commit_worker_changes',{taskId:s.taskId,message:'redirect attempt'}); assert.equal(c.committed,true);
 assert.equal(git(r.dir,'show',`${s.branch}:y.txt`),'y'); assert.equal(existsSync(join(r.base,'PWNED2')),false);
});
test('parallel limit counts only live workers; workspace ops wait for stop',async t=>{
 const r=repo(); const call=await hub(t,r,{HUB_MAX_WORKERS:'1'},()=>new Promise(()=>{}));
 const s=await call('start_worker',{prompt:'approval'}); await call('wait_for_worker',{taskId:s.taskId,seconds:1}).catch(()=>{});
 await assert.rejects(call('start_worker',{prompt:'summary'}),/limit reached/);
 await assert.rejects(call('get_worker_diff',{taskId:s.taskId}),/still running/);
 await call('cancel_worker',{taskId:s.taskId});
 const n=await call('start_worker',{prompt:'summary'}); assert.ok(n.taskId);
});
