import { createInterface } from 'node:readline';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
const send = x => process.stdout.write(JSON.stringify(x)+'\n');
let mode = '', thread = 'fake-thread', turn = 'fake-turn';
const finish = text => { send({method:'item/completed',params:{threadId:thread,turnId:turn,item:{type:'agentMessage',text}}}); send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}}); };
createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if (!m.method && m.id === 500) { if (m.result?.decision === 'accept') finish('SIMULATED action accepted once'); else if(m.result?.answers) finish(JSON.stringify(m.result.answers)); return; }
 if(m.method === 'initialize') send({id:m.id,result:{}});
 if(m.method==='config/read') send({id:m.id,result:{config:{features:Object.fromEntries(['hooks','plugins','remote_plugin','apps','multi_agent','browser_use','computer_use'].map(k=>[k,false])),notify:[],mcp_servers:{},model_provider:'openai',forced_login_method:'chatgpt'}}});
 if(m.method==='account/read') send({id:m.id,result:{account:{type:'chatgpt'}}});
 if(m.method==='mcpServerStatus/list') send({id:m.id,result:{data:[],nextCursor:null}});
 if(m.method === 'thread/start') {
  if(m.params.sandbox !== 'workspace-write') throw Error('Invalid thread SandboxMode: expected workspace-write');
  if(m.params.approvalsReviewer !== 'user' || m.params.approvalPolicy !== 'on-request') throw Error('Missing human permissions');
  send({id:m.id,result:{thread:{id:thread},approvalsReviewer:'user',approvalPolicy:'on-request',cwd:process.cwd(),sandbox:{type:'workspaceWrite',networkAccess:false}}});
 }
 if(m.method === 'turn/start') {
  if(m.params.sandboxPolicy.type !== 'workspaceWrite') throw Error('Invalid turn SandboxPolicy discriminant');
  if(m.params.sandboxPolicy.networkAccess !== false) throw Error('Network enabled');
  mode=m.params.input[0].text;
  send({id:m.id,result:{turn:{id:turn}}});
  setTimeout(()=>{
   if(mode==='summary') finish('SIMULATED repository summary');
   else if(mode.startsWith('write:')) { for(const [f,body] of Object.entries(JSON.parse(mode.slice(6)))) { mkdirSync(dirname(join(process.cwd(),f)),{recursive:true}); rmSync(join(process.cwd(),f),{force:true}); writeFileSync(join(process.cwd(),f),body); } finish('SIMULATED wrote files'); }
   else if(mode==='question') send({id:500,method:'item/tool/requestUserInput',params:{threadId:thread,turnId:turn,itemId:'q1',questions:[{id:'color',header:'Color',question:'Which color?',isSecret:false,isOther:false,options:[{label:'Blue',description:'Blue'}]}]}});
   else send({id:500,method:'item/commandExecution/requestApproval',params:{threadId:thread,turnId:turn,itemId:'exec1',command:'SIMULATED echo pilot',cwd:process.cwd()}});
  },30);
 }
 if(m.method==='turn/interrupt') send({id:m.id,result:{}});
});


