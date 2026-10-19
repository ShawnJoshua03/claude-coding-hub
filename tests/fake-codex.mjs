import { createInterface } from 'node:readline';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
const send = x => process.stdout.write(JSON.stringify(x)+'\n');
let mode = '', thread = 'fake-thread', turn = 'fake-turn', threadMcp = {};
// mcp=inert|ignored|extra: report a user-config MCP server the way real Codex does (listed, disabled, never started).
const mcp = process.argv.find(a => a.startsWith('mcp='))?.slice(4) ?? '';
const configMcp = mcp ? {'user-mem':{command:'node',args:['mem.js'],enabled:true}} : {};
const entry = (name, live) => ({name,runtimeStatus:live?'connected':'disabled',pluginId:null,httpOrigin:null,serverInfo:live?{name}:null,serverCapabilities:live?{tools:{}}:null,tools:live?{read:{name:'read'}}:{},toolsError:null,resources:[],resourceTemplates:[],authStatus:null});
const inventory = () => [...(mcp ? [entry('user-mem', mcp === 'ignored' || threadMcp['user-mem']?.enabled !== false)] : []), ...(mcp === 'extra' ? [entry('plugin-repl', true)] : [])];
// Real Codex: [] means no shell or file tools; the worker must get exactly one local environment in its own folder.
const checkEnvironments = p => { const e = p.environments; if(!Array.isArray(e) || e.length !== 1 || e[0].environmentId !== 'local' || e[0].cwd !== process.cwd() || JSON.stringify(e[0].runtimeWorkspaceRoots) !== JSON.stringify([process.cwd()])) throw Error('Worker environment must be exactly the local task folder'); };
const finish = text => { send({method:'item/completed',params:{threadId:thread,turnId:turn,item:{type:'agentMessage',text}}}); send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}}); };
createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if (!m.method && m.id === 500) { if (m.result?.decision === 'accept') finish('SIMULATED action accepted once'); else if(m.result?.answers) finish(JSON.stringify(m.result.answers)); return; }
 if(m.method === 'initialize') send({id:m.id,result:{}});
 if(m.method==='config/read') send({id:m.id,result:{config:{features:Object.fromEntries(['hooks','plugins','remote_plugin','apps','multi_agent','browser_use','computer_use'].map(k=>[k,false])),notify:[],mcp_servers:configMcp,model_provider:'openai',forced_login_method:'chatgpt'}}});
 if(m.method==='account/read') send({id:m.id,result:{account:{type:'chatgpt'}}});
 if(m.method==='mcpServerStatus/list') send({id:m.id,result:{data:inventory(),nextCursor:null}});
 if(m.method === 'thread/start') {
  if(m.params.sandbox !== 'workspace-write') throw Error('Invalid thread SandboxMode: expected workspace-write');
  if(m.params.approvalsReviewer !== 'user' || m.params.approvalPolicy !== 'on-request') throw Error('Missing human permissions');
  threadMcp = m.params.config?.mcp_servers ?? {};
  checkEnvironments(m.params);
  send({id:m.id,result:{thread:{id:thread},approvalsReviewer:'user',approvalPolicy:'on-request',cwd:process.cwd(),sandbox:{type:'workspaceWrite',networkAccess:false}}});
 }
 if(m.method === 'turn/start') {
  if(m.params.sandboxPolicy.type !== 'workspaceWrite') throw Error('Invalid turn SandboxPolicy discriminant');
  if(m.params.sandboxPolicy.networkAccess !== false) throw Error('Network enabled');
  checkEnvironments(m.params);
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


