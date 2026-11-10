const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm'), assert = require('assert/strict');
const source = fs.readFileSync(process.argv[2], 'utf8');
function between(a,b){return source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));}
const code = between('function createSSEParser(', '// ─',) ;
const parser=source.slice(source.indexOf('function createSSEParser('),source.indexOf('\n}\n',source.indexOf('function createSSEParser('))+3);
const functions = parser + '\n' + between('function checkpointAssistantMessage(', 'function createWaitStream(') + '\n' + between('async function runChatWS(', '// The durable queue is the owner');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hermes-tools-test-')); let passes=0;let accounting;
async function run(transport,mode){
 const file=path.join(temp,`${transport}-${mode}.json`), timers=new Map(); let nextTimer=0, clock=Date.now(), observed=false, injected=false, crashSnapshot, writes=0;
 fs.writeFileSync(file,JSON.stringify({id:'scratch',title:mode==='outer-error'?'New Chat':'test',messages:[]}));
 const read=()=>JSON.parse(fs.readFileSync(file));
 const write=s=>{writes++;fs.writeFileSync(file,JSON.stringify(s));};
 const frames=[
  'event: hermes.tool.progress\ndata: '+JSON.stringify({tool:'terminal',toolCallId:'call-1',status:'running',label:'printf safe',emoji:'🔧'})+'\n\n',
  'event: hermes.tool.progress\ndata: '+JSON.stringify({tool:'terminal',toolCallId:'call-1',status:'completed',result:'safe'})+'\n\n',
  'event: hermes.tool.progress\ndata: '+JSON.stringify({tool:'read_file',toolCallId:'call-2',status:'running',label:'scratch.txt'})+'\n\n',
 ];
 if(mode!=='tools-only') frames.push('data: '+JSON.stringify({choices:[{delta:{content:'partial text'}}]})+'\n\n');
 const sandbox={recordGatewaySession:accounting.recordGatewaySession,usageSummary:accounting.usageSummary,console, TextEncoder, TextDecoder, ReadableStream, AbortController, Date:class extends Date{static now(){return clock;}},
  sessionIdentity:()=>({sender:'测试 专家',sender_avatar:'🔧',sender_kind:'expert'}),sessionSystem:(sid,s)=>(s||'')+'\n角色设定',
  _userStopped:new Set(), _streamGenMap:new Map(), _streamResultCache:new Map(), activeChatStreams:new Map(),wsClients:new Map(),
  getSession:read,saveSession:write,log:()=>{},normalizeMessage:async m=>m,buildChatHistory:()=>[],UI_CAPABILITIES_PROMPT:'',
  getChatConfig:()=>{if(mode==='setup-error')throw Error('setup failure');return {};},resolveChatProviders:()=>[{name:'mock'}],
  _msgFp:()=> 'fp',_isStale:()=>false,_cacheCleanup:()=>{},PROVIDER_TIMEOUT_MS:300000,combineSignals:()=>new AbortController().signal,
  appendFileSync:()=>{},DATA_DIR:temp,
  setInterval:(f,ms)=>{const id=++nextTimer;timers.set(id,{f,ms});return id;},clearInterval:id=>{const t=timers.get(id);timers.delete(id);if(mode==='outer-error'&&t&&t.ms===1000&&!injected){injected=true;throw Error('cleanup failure');}},
  setTimeout:()=>++nextTimer,clearTimeout:()=>{},
  autoTitle:()=>Promise.resolve('test'),
  chatRequest:async()=>({headers:{get:()=> 'api_fixture_session'},body:{getReader(){let i=0;return {
   async read(){
    if(i===1){assert.equal(read().messages.at(-1).tools.length,1,'start event persisted before next read');observed=true;}
    if(i===2){const t=read().messages.at(-1).tools;assert.equal(t.length,1);assert.equal(t[0].status,'completed');assert.equal(t[0].label,'printf safe');assert.equal(t[0].result,'safe');}
    if(i===3){crashSnapshot=JSON.parse(fs.readFileSync(file));clock+=65000;for(const t of timers.values())if(t.ms===1000)t.f(); const m=read().messages.at(-1);assert.equal(m.tools.length,2);assert.equal(m.ts,clock,'tool-only heartbeat refreshed');}
    if(i<frames.length)return {done:false,value:new TextEncoder().encode(frames[i++])};
    if(mode==='request-error')throw Error('upstream disconnected');
    return {done:true};
   },releaseLock(){},cancel(){return Promise.resolve();}
  };}}})
 };
 const ctx=vm.createContext(sandbox);vm.runInContext(functions,ctx);
 if(transport==='WS') await ctx.runChatWS({data:{},send(){},ping(){},close(){}},'scratch','hello');
 else {const reader=ctx.createChatStream('scratch','hello').getReader();while(!(await reader.read()).done){}}
 const result=read();
 if(mode==='setup-error'){assert.equal(result.messages.length,2,'initial checkpoint survives setup error');}
 else {
  assert.equal(result.gateway_usage_sessions[0].id,'api_fixture_session');
  assert(observed);assert.equal(result.messages.length,2,'no duplicate or stale session overwrite');
  assert.equal(result.messages.at(-1).sender,'测试 专家');assert.equal(result.messages.at(-1).sender_avatar,'🔧');
  assert.equal(result.messages.at(-1).tools.length,2);
  assert.equal(result.messages.at(-1).tools[0].result,'safe');
  if(['request-error','outer-error'].includes(mode))assert.equal(result.messages.at(-1).tools[1].status,'interrupted');
  assert(!result.messages.at(-1)._streaming);
  // A fresh disk read after loss of all stream-local state still contains tool records.
  crashSnapshot.messages.at(-1).ts=clock-65001;write(crashSnapshot);
  const recovered=read();ctx.sweepZombieStreams(recovered);
  assert.match(read().messages.at(-1).content,/这条回复在生成过程中被打断/);
  assert.equal(read().messages.at(-1).tools[0].status,'completed');
  assert.equal(read().messages.at(-1).tools[1].status,'interrupted');
  assert.equal(read().messages.at(-1).tools[0].result,'safe');
 }
 assert.equal(timers.size,0,'all interval timers cleared');
 console.log('PASS',transport,mode,`writes=${writes}`);passes++;
}
(async()=>{try{accounting=await import(require('url').pathToFileURL(path.resolve(path.dirname(process.argv[2]),'panel-chat-accounting.js')).href);
 for(const transport of ['SSE','WS'])for(const mode of ['normal','tools-only','request-error','outer-error','setup-error'])await run(transport,mode);
 console.log(`${passes} scenarios passed`);
}finally{fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
