import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const client=new Client({name:'coding-hub-native-smoke',version:'0.1.0'},{capabilities:{elicitation:{form:{}}}});
client.setRequestHandler(ElicitRequestSchema,async()=>({action:'decline'}));
const transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/server.js')],cwd:process.cwd(),env:{...process.env,HUB_FIXTURE_ROOT:resolve('fixtures/pilot'),HUB_CODEX_COMMAND:'codex',HUB_CODEX_PREFIX_JSON:'[]'},stderr:'pipe'});
const call=async(name,args)=>{const r=await client.callTool({name,arguments:args});if(r.isError)throw Error(r.content[0].text);return JSON.parse(r.content[0].text);};
let taskId;
try{
 await client.connect(transport);
 const start=await call('start_worker',{prompt:'Read README.md in this disposable fixture and summarize its purpose in one sentence. Do not edit anything, install dependencies, use external tools or delegate. This is a bounded native-subscription connectivity test.'});taskId=start.taskId;
 let state=start;const deadline=Date.now()+120000;
 while(!['completed','failed','cancelled','denied'].includes(state.state)&&Date.now()<deadline)state=await call('wait_for_worker',{taskId,seconds:15});
 console.log(JSON.stringify({nativeCodex:true,synthetic:false,state:state.state,result:state.result,error:state.error},null,2));
 assert.equal(state.state,'completed');assert.ok(state.result.trim());
}finally{if(taskId)await call('cancel_worker',{taskId}).catch(()=>{});await client.close();}
