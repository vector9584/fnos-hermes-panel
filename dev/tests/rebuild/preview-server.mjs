// Isolated integration harness. It never imports Monitor or starts a Gateway.
import {execFileSync} from 'node:child_process';
import {createCipheriv,randomBytes} from 'node:crypto';
import {createConnectorProbeHandler} from '../../../app/server/panel-connector-probe.js';
import {createConnectorToolsHandler} from '../../../app/server/panel-connector-tools.js';
import {ConnectorStore,createConnectorHandler} from '../../../app/server/panel-connectors.js';
import {CONNECTOR_CATALOG,getConnector} from '../../../app/server/connectors.js';
import {createMaintenanceHandler} from '../../../app/server/panel-maintenance.js';
import {createAuxiliaryHandler} from '../../../app/server/panel-auxiliary.js';
import {ModelChecks,createModelChecksHandler} from '../../../app/server/panel-model-checks.js';
import {LibraryReviews,createLibraryReviewHandler} from '../../../app/server/panel-library-reviews.js';
import {LibraryStore,createLibraryHandler} from '../../../app/server/panel-library.js';
import {createLibrarySources} from '../../../app/server/panel-library-sources.js';
import {PlanStore,createPlanHandler,createPlanLaunch} from '../../../app/server/panel-plans.js';
import {RoomStore,RoomRunner,createRoomHandler} from '../../../app/server/panel-rooms.js';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import * as fs from 'node:fs';
import {join, resolve, dirname, extname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {ChatQueue} from '../../../app/server/panel-queue.js';
import {interruptAssistantMessage} from '../../../app/server/panel-chat-recovery.js';
import {createQueueHandler} from '../../../app/server/panel-queue-http.js';
import {atomicWriteJSON} from '../../../app/server/panel-state.js';
import {createCronUpdateHandler, cronRevision} from '../../../app/server/panel-cron.js';
import {createUsageHandler} from '../../../app/server/panel-usage.js';
import {CronHooks, createCronHookHandler} from '../../../app/server/panel-cron-hooks.js';
import {createCronHistoryHandler} from '../../../app/server/panel-cron-history.js';
import {createEchoHandler} from '../../../app/server/panel-echo.js';
import {ChannelPairing,createPairingHandler} from '../../../app/server/panel-channel-pairing.js';
import {createChannelsService} from '../../../app/server/panel-channels.js';
import {createConfigRecovery} from '../../../app/server/panel-config-recovery.js';
import {createTypingHandler} from '../../../app/server/panel-typing.js';
import {createModelsService} from '../../../app/server/panel-models.js';
import {createMcpHandler} from '../../../app/server/panel-mcp.js';
import {PanelRuntime,createRuntimeHandler} from '../../../app/server/panel-runtime.js';
import {PanelAuth} from '../../../app/server/panel-auth.js';
import {createFileHandler,createFileRoots} from '../../../app/server/panel-files.js';

const root=process.env.PREVIEW_STATE_ROOT||fs.mkdtempSync(join(tmpdir(),'hermes-rebuild-preview-'));
if(!resolve(root).startsWith('/tmp/')&&!resolve(root).startsWith('/private/tmp/'))throw Error('Preview state must be under a temporary directory');
const app=resolve(dirname(fileURLToPath(import.meta.url)),'../../../app');
process.env.DATA_DIR=join(root,'legacy-readonly');process.env.VAR_DIR=join(root,'var');process.env.APP_DIR=app;
process.env.PANEL_PYTHON=process.env.TEST_PYTHON||'/vol1/@apphome/hermes-agent/data/venv/bin/python3';process.env.PANEL_SERVER_ROOT=app;
const {handleWorkspace,sessionSnapshot,bindSessionPlan}=await import('../../../app/server/panel-workspace.js');
const {getExpert}=await import('../../../app/server/panel-experts.js');
const sessionRoot=join(process.env.VAR_DIR,'chat/sessions');fs.mkdirSync(sessionRoot,{recursive:true});
const archivedRoot=join(process.env.VAR_DIR,'chat/archived-sessions');fs.mkdirSync(archivedRoot,{recursive:true});
const sessionFile=id=>join(sessionRoot,id+'.json');
const archivedFile=id=>join(archivedRoot,id+'.json');
for(const id of ['test-a','test-b'])if(!fs.existsSync(sessionFile(id)))atomicWriteJSON(sessionFile(id),{id,title:id==='test-a'?'维护讨论':'另一会话',created_at:Date.now(),updated_at:Date.now(),messages:[]});
const getSession=id=>JSON.parse(fs.readFileSync(sessionFile(id),'utf8'));
const writeSession=s=>atomicWriteJSON(sessionFile(s.id),{...s,updated_at:Date.now()});
const stats={executions:[],mutations:[]};
const fixtureLogs=new Map([['hermes.log','INFO fixture 保留日志 hermes.log']]),fixtureLogUndo=new Map();
let gate=true;
const q=new ChatQueue({root:join(root,'var/panel-state/queue'),available:()=>gate,execute:async(job,{emit,signal})=>{
  stats.executions.push(job.id);
  stats.execution_snapshots=stats.execution_snapshots||[];stats.execution_snapshots.push({id:job.id,session_id:job.session_id,snapshot:job.snapshot});
  const session=getSession(job.session_id),text=typeof job.payload.message==='string'?job.payload.message:job.payload.message.text;
  session.messages.push({role:'user',content:text,request_id:job.id,ts:Date.now(),...job.snapshot.user_identity});
  const reply={role:'assistant',content:'',request_id:job.id,ts:Date.now(),_streaming:true,...job.snapshot.identity,tools:[]};session.messages.push(reply);writeSession(session);
  const interruptedToolTest=text.includes('中断工具验收');
  const count=text.includes('长任务')?40:interruptedToolTest?20:5;
  for(let i=0;i<count;i++){
    if(signal.aborted)break;
    const delta=i===0?'已收到：'+text+'。':' 第'+i+'步已检查。';reply.content+=delta;
    emit({delta});
    if(i===1){const tool={tool:'read_file',toolCallId:job.id+'-tool',status:'completed',label:'隔离验收文件',result:'fixture verified'};reply.tools.push(tool);emit({tool_progress:tool});
      if(interruptedToolTest){const running={tool:'terminal',toolCallId:job.id+'-running-tool',status:'running',label:'隔离中的运行工具'};reply.tools.push(running);emit({tool_progress:running});}}
    writeSession(session);await new Promise(r=>setTimeout(r,120));
  }
  if(signal.aborted)interruptAssistantMessage(reply);else{delete reply._streaming;reply.queue_status='done';}writeSession(session);
  return {status:reply.queue_status};
}}).load().start();
const authEnabled=process.env.PREVIEW_AUTH==='1';
const previewAuth=new PanelAuth({file:join(root,'var/panel-state/auth.json'),legacyToken:'fixture-token'});
const authorized=req=>authEnabled?!!previewAuth.valid(req):(req.headers.get('x-monitor-token')==='fixture-token'||req.headers.get('cookie')?.includes('hermes_fixture=1'));
const fileHome=join(root,'file-home');fs.mkdirSync(join(fileHome,'workspace'),{recursive:true});fs.mkdirSync(join(fileHome,'uploads'),{recursive:true});fs.mkdirSync(join(root,'var/tmp'),{recursive:true});
if(!fs.existsSync(join(fileHome,'workspace/笔记.md')))fs.writeFileSync(join(fileHome,'workspace/笔记.md'),'工作区原文');
for(let index=0;index<91;index++)fs.writeFileSync(join(fileHome,'workspace','文件'+String(index).padStart(3,'0')+'.txt'),'内容 '+index);
fs.writeFileSync(join(fileHome,'workspace/preview.html'),'<h1>安全预览</h1><script>parent.window.filePreviewInjection=true</script>');
const filesHandler=createFileHandler({python:process.env.TEST_PYTHON||'/vol1/@apphome/hermes-agent/data/venv/bin/python3',serverRoot:join(app,'server'),state:join(root,'var/panel-state'),roots:createFileRoots({data:fileHome,varDir:join(root,'var')}),data:fileHome,varDir:join(root,'var'),checkToken:authorized});
const mcpConfig=join(root,'mcp-config.yaml');if(!fs.existsSync(mcpConfig)){fs.writeFileSync(mcpConfig,'mcp_servers:\n  manual:\n    url: https://fixture.invalid/mcp\n    headers: {Authorization: fixture-secret}\n    custom: {preserve: true}\n  conn-managed: {command: node}\n');fs.chmodSync(mcpConfig,0o666);}
fs.mkdirSync(join(root,'runtime-source/dev'),{recursive:true});fs.writeFileSync(join(root,'runtime-source/dev/hermes-dev.sh'),'fixture');
const recoveryService=createConfigRecovery({python:process.env.TEST_PYTHON||'/vol1/@apphome/hermes-agent/data/venv/bin/python3',serverRoot:join(app,'server'),home:join(root,'native-home'),state:join(root,'var/panel-state'),checkToken:authorized,changed:reason=>runtime.changed(reason)});
const fixtureHealth=()=>{try{return JSON.parse(fs.readFileSync(join(root,'service-health.json'),'utf8'));}catch{return null;}};
const runtime=new PanelRuntime({observation:fixtureHealth,busy:()=>fixtureHealth()?.gateway?.busy===true,recovery:()=>recoveryService.status(),root:join(root,'var/panel-state'),source:join(root,'runtime-source'),start:()=>{throw Error('fixture does not restart services');}});
const channelHome=join(root,'channel-home');fs.mkdirSync(channelHome,{recursive:true});if(!fs.existsSync(join(channelHome,'config.yaml')))fs.writeFileSync(join(channelHome,'config.yaml'),'# channel fixture\nplatforms: {qqbot: {enabled: true, extra: {app_id: fixture, dm_policy: allowlist, group_policy: disabled, stt: {provider: custom}}, channel_overrides: {room: {model: keep}}}}\n');if(!fs.existsSync(join(channelHome,'.env')))fs.writeFileSync(join(channelHome,'.env'),'QQ_APP_ID=fixture\nQQ_CLIENT_SECRET=fixture-channel-private-secret\n');
const channelsService=createChannelsService({observe:()=>{try{return JSON.parse(fs.readFileSync(join(root,'channel-runtime.json'),'utf8'));}catch{return {verified:false,reason:'gateway_stopped',platforms:{}};}},python:process.env.TEST_PYTHON||'/vol1/@apphome/hermes-agent/data/venv/bin/python3',serverRoot:join(app,'server'),getConfig:()=>join(channelHome,'config.yaml'),state:join(root,'var/panel-state'),checkToken:authorized,changed:reason=>runtime.changed(reason)});
let fixtureQQKey;
const fixturePairing=new ChannelPairing({root:join(root,'var/panel-state'),channels:channelsService,fetcher:async(url,options={})=>({ok:true,json:async()=>{
 if(url.includes('create_bind_task')){fixtureQQKey=Buffer.from(JSON.parse(options.body).key,'base64');return {retcode:0,data:{task_id:'fixture-qq'}};}
 if(url.includes('poll_bind_result')){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',fixtureQQKey,iv),encrypted=Buffer.concat([cipher.update('fixture-qr-private-token'),cipher.final()]);return {retcode:0,data:{status:2,bot_appid:'fixture-qq',bot_encrypt_secret:Buffer.concat([iv,encrypted,cipher.getAuthTag()]).toString('base64')}};}
 if(url.includes('get_bot_qrcode'))return {qrcode:'fixture-qr',qrcode_img_content:'https://example.invalid/fixture-qr'};
 if(url.includes('get_qrcode_status'))return {status:'confirmed',bot_token:'fixture-qr-private-token',ilink_bot_id:'fixture-weixin'};
 if(url.includes('/generate'))return {data:{scode:'fixture-wecom-qr',auth_url:'https://example.invalid/fixture-qr'}};
 if(url.includes('query_result'))return {data:{status:'success',bot_info:{botid:'fixture-wecom',secret:'fixture-qr-private-token'}}};
 if(url.includes('/telegram/pairings'))return options.method==='POST'?{pairing_id:'fixture-telegram',poll_token:'fixture-poll-secret',deep_link:'https://example.invalid/fixture-qr'}:{status:'ready',token:'fixture-qr-private-token',bot_username:'fixture-telegram',owner_user_id:123};
 throw Error('Unexpected fixture pairing request');
}})});
const pairingHandler=createPairingHandler({pairing:fixturePairing,checkToken:authorized});
const runtimeHandler=createRuntimeHandler({runtime,checkToken:authorized});
const modelsConfig=join(root,'models-config.yaml');if(!fs.existsSync(modelsConfig))fs.writeFileSync(modelsConfig,'# fixture preserved\nmodel: {provider: fixture, default: fixture-model}\nproviders:\n  fixture: {name: 隔离测试模型, base_url: https://fixture.invalid/v1, api_key: fixture-private-key, default_model: fixture-model, models: {fixture-model: {enabled: true}, second-model: {enabled: true}, discovered-model: {name: 已归档模型, enabled: false, context_window: 23456}}, extra_body: {keep: true}}\n  second: {name: 第二服务, base_url: https://second.invalid/v1, default_model: third-model, models: [third-model], api_key: other-private-key}\nfallback_providers: [{provider: second, model: third-model, api_key: fallback-private-key}]\n');
if(!fs.existsSync(join(root,'provider-models.json')))fs.writeFileSync(join(root,'provider-models.json'),JSON.stringify({fixture:[{id:'historical-model',name:'保留模型',enabled:false,context_window:12345},{id:'discovered-model',name:'已归档模型',enabled:false,context_window:23456}]}));
const modelsService=createModelsService({varRoot:root,python:process.env.TEST_PYTHON||'/vol1/@apphome/hermes-agent/data/venv/bin/python3',serverRoot:join(app,'server'),getConfig:()=>modelsConfig,state:join(root,'var/panel-state'),changed:reason=>runtime.changed(reason),fetcher:async(url,options)=>{if(options.headers.Authorization!=='Bearer fixture-private-key')throw Error('unexpected model discovery credential');if(url==='https://fixture.invalid/v1/models'||url==='http://192.168.1.20:11434/v1/models')return new Response(JSON.stringify({data:[{id:'discovered-model',name:'发现模型'},{id:'fixture-model',name:'已有模型'}]}),{headers:{'Content-Type':'application/json'}});throw Error('unexpected model discovery request');}});
const mcpHandler=createMcpHandler({python:process.env.TEST_PYTHON||'/vol1/@apphome/hermes-agent/data/venv/bin/python3',serverRoot:join(app,'server'),getConfig:()=>mcpConfig,state:join(root,'var/panel-state'),checkToken:authorized,changed:reason=>runtime.changed(reason)});
const typingHandler=createTypingHandler({python:process.env.TEST_PYTHON||'/vol1/@apphome/hermes-agent/data/venv/bin/python3',serverRoot:join(app,'server'),getConfig:()=>mcpConfig,state:join(root,'var/panel-state'),platforms:()=>({telegram:{name:'Telegram'},weixin:{name:'微信'}}),checkToken:authorized,changed:reason=>runtime.changed(reason)});
const legacyRooms=join(root,'legacy-rooms.json');
if(!fs.existsSync(legacyRooms))atomicWriteJSON(legacyRooms,[{id:'legacy-room',title:'原讨论记录',members:[{key:'exp_coder',persona_id:'coder',label:'程序员',system:'原专家快照',emoji:'💻'}],messages:Array.from({length:620},(_,index)=>({kind:'assistant',from:'exp_coder',label:'程序员',text:'历史讨论 '+index,ts:1700000000000+index})),shared_memory:[{text:'保留原讨论笔记'}]}]);
let fixtureRoomFailure=false;
const roomStore=new RoomStore({root:join(root,'var/panel-state'),legacyFile:legacyRooms,expert:getExpert,identity:()=>({user_name:'Vector',user_avatar:'👤'})});
const roomRunner=new RoomRunner({store:roomStore,execute:async(job,{signal,emit})=>{
 stats.room_calls=stats.room_calls||[];stats.room_calls.push({id:job.id,step:job.step,attempt:job.attempt,member:job.member.key,provider:job.provider,model:job.model,message:job.message});
 emit({delta:'讨论内容：'});emit({tool_progress:{tool:'read_file',status:'completed',result:'隔离验证证据'}});
 await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,1400);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(Error('stopped'));},{once:true});});
 if(fixtureRoomFailure)return {status:'failed',reply:'已保留部分回复',tools:[{tool:'read_file',status:'completed',result:'隔离验证证据'}],error:'模拟成员回复失败'};
 return {status:'done',reply:'讨论已完成：'+job.message.slice(0,120),tools:[{tool:'read_file',status:'completed',result:'隔离验证证据'}]};
}}).start();
const libraryHome=join(root,'library-home');fs.mkdirSync(join(libraryHome,'knowledge'),{recursive:true});fs.mkdirSync(join(libraryHome,'memories'),{recursive:true});fs.mkdirSync(join(libraryHome,'memory'),{recursive:true});fs.mkdirSync(join(libraryHome,'logs/curator/20261105'),{recursive:true});
for(let i=0;i<95;i++)fs.writeFileSync(join(libraryHome,'knowledge','笔记'+String(i).padStart(3,'0')+'.md'),'# 知识 '+i+'\n原始资料内容。全文检索标记 '+i+'\n');
fs.mkdirSync(join(libraryHome,'knowledge','项目甲','子目录'),{recursive:true});fs.writeFileSync(join(libraryHome,'knowledge','项目甲','索引.md'),'# 项目索引\n链接到 [[子目录/实施方案|方案]] 与 [[笔记000]]。\n');fs.writeFileSync(join(libraryHome,'knowledge','项目甲','子目录','实施方案.md'),'# 实施方案\n来自索引链接。\n');
fs.writeFileSync(join(libraryHome,'memories/MEMORY.md'),'长期记忆原文\n');fs.writeFileSync(join(libraryHome,'SOUL.md'),'持久身份基线');fs.writeFileSync(join(libraryHome,'notes.md'),'共享笔记');fs.writeFileSync(join(libraryHome,'memory/2026-11-04.md'),'完整日记'.repeat(700)+' 日记末尾');fs.writeFileSync(join(libraryHome,'logs/curator/20261105/REPORT.md'),'技能维护报告\n未应用修改。');
const libraryStore=new LibraryStore({root:join(root,'var/panel-state'),sources:createLibrarySources(libraryHome)}),libraryHandler=createLibraryHandler({store:libraryStore,checkToken:authorized});
const reviews=new LibraryReviews({root:join(root,'var/panel-state/library-reviews'),library:libraryStore,source:async()=>({target:{name:'隔离模型'}}),generate:async(target,{signal})=>{stats.review_calls=(stats.review_calls||0)+1;await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,1200);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(Error('cancelled'));},{once:true});});return {output:'# 整理记忆\n\n经审阅再应用的资料。\n',finish_reason:'stop'};}}).load();
const reviewHandler=createLibraryReviewHandler({reviews,checkToken:authorized});
const planLegacyConfig=join(root,'plan-config.json');atomicWriteJSON(planLegacyConfig,{extensions:{team_name:'现有专家分工',team:[{id:'coder',name:'程序员'}]}});
const planStore=new PlanStore({root:join(root,'var/panel-state'),legacyConfig:planLegacyConfig,legacyFlows:join(root,'legacy-flows'),expert:getExpert});
const planHandler=createPlanHandler({store:planStore,checkToken:authorized,launch:createPlanLaunch({queue:q,
 ensureSession:(id,title)=>{if(!fs.existsSync(sessionFile(id)))writeSession({id,title,created_at:Date.now(),messages:[]});},attachPlan:bindSessionPlan,capture:sessionSnapshot})});
const roomHandler=createRoomHandler({store:roomStore,runner:roomRunner,checkToken:authorized,modelCatalog:()=>modelChecks.source({action:"catalog"})});
const auxiliaryFile=join(root,'native-home/config.yaml');
const auxiliaryHandler=createAuxiliaryHandler({python:process.env.TEST_PYTHON||'python3',serverRoot:join(app,'server'),getConfig:()=>auxiliaryFile,backupRoot:join(root,'auxiliary-backups'),checkToken:authorized});
let fixtureModelFailure=false;
const modelChecks=new ModelChecks({root:join(root,'model-checks'),source:async body=>body.action==='catalog'?{ok:true,providers:[{id:'fixture-a',name:'服务甲',models:['same-model']},{id:'fixture-b',name:'服务乙',models:['same-model']}]}:{ok:true,target:{provider:body.provider,name:body.provider==='fixture-a'?'服务甲':'服务乙',model:body.model,api_mode:'chat_completions'}},
 probe:async(target,{signal})=>{stats.model_probes=stats.model_probes||[];stats.model_probes.push({provider:target.provider,model:target.model});await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,1800);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(Error('cancelled'));},{once:true});});if(fixtureModelFailure)throw Object.assign(Error('服务拒绝凭证（HTTP 401）'),{status:502});return {output:'HERMES_OK',exact_match:true,latency_ms:1800,response_model:target.model,usage:{total_tokens:12}};}}).load();
const modelChecksHandler=createModelChecksHandler({checks:modelChecks,checkToken:authorized});
const fixtureConnectorCatalog=[...CONNECTOR_CATALOG,
 {kind:'fixture-connected',name:'已配置测试连接器',fields:[{key:'token'}],tools:[],mcp_mode:'gateway'},
 {kind:'fixture-empty',name:'未配置测试连接器',fields:[{key:'token'}],tools:[],mcp_mode:'gateway'}];
const legacyConnectors=join(root,'legacy-connectors.json');
atomicWriteJSON(legacyConnectors,{'tencent-news':{api_key:'fixture-secret'},'fixture-connected':{token:'fixture'}});
const fixtureConnectorStore=new ConnectorStore(join(root,'var/panel-state'),legacyConnectors);
let fixtureApplyFails=false;
const fixtureProbe=async()=>{stats.probes=(stats.probes||0)+1;};
const connectorToolsHandler=createConnectorToolsHandler({getConnector,readState:()=>fixtureConnectorStore.all(),checkToken:authorized,
 call:async(kind,creds,tool,args)=>{stats.connector_calls=stats.connector_calls||[];stats.connector_calls.push({tool,args});return '隔离查询结果';}});
const connectorProbeHandler=createConnectorProbeHandler({checkToken:authorized,getConnector,readState:()=>fixtureConnectorStore.all(),probe:fixtureProbe});
const connectorHandler=createConnectorHandler({catalog:fixtureConnectorCatalog,store:fixtureConnectorStore,checkToken:authorized,probe:fixtureProbe,
 apply:async()=>{stats.connector_applies=(stats.connector_applies||0)+1;if(fixtureApplyFails)throw Error('fixture application failure');}});
const fixtureRepository=join(root,'fixture-repository');
fs.mkdirSync(fixtureRepository,{recursive:true});
const fixtureGit=(...args)=>execFileSync('git',['-C',fixtureRepository,...args],{stdio:'pipe'});
fixtureGit('init','-q');fixtureGit('config','user.name','隔离维护');fixtureGit('config','user.email','fixture@example.invalid');
for(let index=0;index<33;index++)fixtureGit('commit','--allow-empty','-qm','修复 '+index+'\n\n<script>window.commitInjected=true</script>完整说明');
const maintenanceHandler=createMaintenanceHandler({checkToken:authorized,repositories:[
 {id:'panel',name:'面板源码仓库',path:fixtureRepository},
 {id:'python',name:'Hermes Python 内核',path:join(root,'missing-repository')},
]});
const echoFile=join(root,'echo/tasks.json');
if(!fs.existsSync(echoFile))atomicWriteJSON(echoFile,{version:1,seq:0,tasks:[]});
const echoHandler=createEchoHandler({python:process.env.TEST_PYTHON||'python3',serverRoot:join(app,'server'),queueFile:echoFile,backupRoot:join(root,'echo-backups'),draftFile:join(root,'echo-drafts.json'),checkToken:authorized});
const cronFile=join(root,'native-home/cron/jobs.json');
const readCron=()=>JSON.parse(fs.readFileSync(cronFile,'utf8')).jobs;
const cronHandler=createCronUpdateHandler({python:process.env.TEST_PYTHON||'python3',serverRoot:join(app,'server'),
  nativeRoot:process.env.HERMES_TEST_NATIVE_ROOT||'',backupRoot:join(root,'cron-backups'),getHome:()=>join(root,'native-home'),checkToken:authorized});
const usageHandler=createUsageHandler({python:process.env.TEST_PYTHON||'python3',serverRoot:join(app,'server'),dataRoot:join(root,'native-home')});
const hookHandler=createCronHookHandler({hooks:new CronHooks(join(root,'var/cron-hooks.json'),join(root,'legacy-hooks.json')),
  checkToken:authorized,jobExists:id=>readCron().some(job=>job.id===id)});
const historyHandler=createCronHistoryHandler({checkToken:authorized,getHome:()=>join(root,'native-home')});
const queueHandler=createQueueHandler({queue:q,checkToken:authorized,sessionExists:id=>fs.existsSync(sessionFile(id)),capture:p=>sessionSnapshot(p.session_id,p.system||'')});
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
async function handle(req){
 const u=new URL(req.url),path=u.pathname;
 if(path.startsWith('/api/panel-rooms/')&&path.endsWith('/draft')){stats.draft_requests=stats.draft_requests||[];stats.draft_requests.push({method:req.method,path,body:req.method==='PUT'?await req.clone().json():null});}
 const typingResponse=await typingHandler(req,path);if(typingResponse)return typingResponse;
 const pairingResponse=await pairingHandler(req,path);if(pairingResponse)return pairingResponse;
 const channelsResponse=await channelsService.handle(req,path);if(channelsResponse)return channelsResponse;
 const recoveryResponse=await recoveryService.handle(req,path);if(recoveryResponse)return recoveryResponse;
 const runtimeResponse=await runtimeHandler(req,path);if(runtimeResponse)return runtimeResponse;
 const modelsResponse=await modelsService.handle(req,path,authorized);if(modelsResponse)return modelsResponse;
 const mcpResponse=await mcpHandler(req,path);if(mcpResponse)return mcpResponse;
 const filesResponse=await filesHandler(req,path);if(filesResponse)return filesResponse;
 const reviewResponse=await reviewHandler(req,path);if(reviewResponse)return reviewResponse;
 const libraryResponse=await libraryHandler(req,path);if(libraryResponse)return libraryResponse;
 const planResponse=await planHandler(req,path);if(planResponse)return planResponse;
 const roomResponse=await roomHandler(req,path);if(roomResponse)return roomResponse;
 const checksResponse=await modelChecksHandler(req,path);if(checksResponse)return checksResponse;
 const auxiliaryResponse=await auxiliaryHandler(req,path);if(auxiliaryResponse)return auxiliaryResponse;
 const connectorToolsResponse=await connectorToolsHandler(req,path);if(connectorToolsResponse)return connectorToolsResponse;
 const connectorResponse=await connectorHandler(req,path);if(connectorResponse)return connectorResponse;
 const probeResponse=await connectorProbeHandler(req,path);if(probeResponse)return probeResponse;
 const maintenanceResponse=await maintenanceHandler(req,path);if(maintenanceResponse)return maintenanceResponse;
 const echoResponse=await echoHandler(req,path);if(echoResponse)return echoResponse;
 const maintenance=await cronHandler(req,path)||await usageHandler(req,path)||await hookHandler(req,path)||await historyHandler(req,path);if(maintenance)return maintenance;
 const response=await queueHandler(req,path)||await handleWorkspace(req,authorized,path);if(response)return response;
 if(path==='/__fixture/connector-failure'&&req.method==='POST'){fixtureApplyFails=(await req.json()).fail;return json({ok:true});}
 if(path==='/__fixture/log-reset'&&req.method==='POST'){fixtureLogUndo.clear();fixtureLogs.set('hermes.log','INFO fixture 保留日志 hermes.log');stats.logClears=[];stats.logRestores=[];stats.logClearFailure=null;return json({ok:true});}
 if(path==='/__fixture/log-failure'&&req.method==='POST'){stats.logClearFailure=await req.json();return json({ok:true});}
 if(path==='/__fixture/model-failure'&&req.method==='POST'){fixtureModelFailure=(await req.json()).fail;return json({ok:true});}
 if(path==='/__fixture/room-failure'&&req.method==='POST'){fixtureRoomFailure=(await req.json()).fail;return json({ok:true});}
 if(path==='/__fixture/library-change'&&req.method==='POST'){fs.appendFileSync(join(libraryHome,'memories/MEMORY.md'),'内核新增记忆\n');return json({ok:true});}
 if(path==='/__fixture/stats')return json(stats);
 if(path==='/__fixture/gate'&&req.method==='POST'){gate=(await req.json()).open;q.wake();return json({ok:true});}
 if(path==='/api/health')return json({ok:true});
 if(path==='/api/logs/clear'&&req.method==='POST'){const body=await req.json();stats.logClears=stats.logClears||[];stats.logClears.push(body.file);const failure=stats.logClearFailure;if(failure?.file===body.file){const content=fixtureLogs.get(body.file)||'INFO fixture 原始日志 '+body.file;if(failure.mode==='partial'){fixtureLogs.set(body.file,'INFO fixture partial '+body.file);const undo='fixture-uncertain-'+randomBytes(6).toString('hex');fixtureLogUndo.set(undo,{file:body.file,content,clear_state:'uncertain'});return new Response(JSON.stringify({error:'模拟截断后报错',undo_id:undo}),{status:500,headers:{'Content-Type':'application/json'}});}return json({error:'模拟日志清空失败'},503);}const undo='fixture-undo-'+randomBytes(6).toString('hex'),content=fixtureLogs.get(body.file)||'INFO fixture 原始日志 '+body.file;fixtureLogs.set(body.file,'');fixtureLogUndo.set(undo,{file:body.file,content});return json({ok:true,undo_id:undo,bytes:Buffer.byteLength(content)});}
 if(path==='/api/logs/clear/undo'&&req.method==='GET')return json({items:[...fixtureLogUndo].map(([id,item])=>({id,file:item.file,clear_state:item.clear_state||'cleared'}))});
 if(path==='/api/logs/restore'&&req.method==='POST'){const body=await req.json(),item=fixtureLogUndo.get(body.id);if(!item)return json({error:'撤销记录不存在'},404);if(item.clear_state==='uncertain')return json({error:'清空结果未能确认，未自动恢复；请先读取当前日志，确认后再重试'},409);const current=fixtureLogs.get(item.file)||'';fixtureLogs.set(item.file,(current?current+'\n--- 已恢复日志 ---\n':'')+item.content);fixtureLogUndo.delete(body.id);stats.logRestores=stats.logRestores||[];stats.logRestores.push(item.file);return json({ok:true,file:item.file,restored_bytes:Buffer.byteLength(item.content)});}
 if(path==='/api/logs/read'){const fileName=u.searchParams.get('file'),content=fixtureLogs.has(fileName)?fixtureLogs.get(fileName):'INFO fixture 保留日志 '+fileName;return json({lines:content?content.split('\n'):[]});}
 if(path==='/api/panel-auth/bootstrap')return new Response(JSON.stringify({ok:true,token:'fixture-token'}),{headers:{'Content-Type':'application/json','Set-Cookie':'hermes_fixture=1; Path=/; SameSite=Strict; HttpOnly'}});
 if(path==='/api/panel-auth/devices')return json({ok:true,current:'fixture',devices:[{id:'fixture',name:'隔离浏览器',expires_at:Date.now()+86400000}]});
 if(path==='/api/cron-jobs'&&req.method==='GET')return json({ok:true,jobs:readCron().map(job=>({...job,panel_revision:cronRevision(job)})),webhooks:{}});
 if(path==='/api/status')return json({gateway:{running:true,healthy:true},dashboard:{running:true,healthy:true},version:'0.21.149',uptime:100});
 if(path==='/api/gateway/health')return json({ok:true});
 if(path==='/api/learning-trajectory')return json({ok:true,skills:[],relations:[]});
 if(path==='/api/chat/active')return json({active:q.list(u.searchParams.get('session_id')).some(j=>j.status==='running')});
 if(path==='/api/chat/config')return json({providers:[{id:'fixture',name:'隔离测试模型',model:'fixture-model',models:['fixture-model'],enabled:true}],extensions:{}});
 if(path==='/api/config')return json({...await modelsService.execute({action:'read'}),extensions:{}});
 if(path==='/api/profiles')return json({ok:true,profiles:[{id:'default',name:'默认助手',is_active:true}]});
 if(path==='/api/experts')return json({ok:true,experts:[{id:'expert-test',slug:'expert-test',name:'程序员',emoji:'💻',prompt:'先验证需求，再提供可运行实现。',desc:'软件开发与代码检查',skills:[]}],overrides:{}});
 if(path==='/api/sessions'){
 if(req.method==='POST'){const id='test-'+Date.now()+'-'+randomBytes(4).toString('hex');const s={id,title:'New Chat',created_at:Date.now(),messages:[]};writeSession(s);return json(s);}
  return json({sessions:fs.readdirSync(sessionRoot).filter(n=>n.endsWith('.json')).map(n=>{const s=getSession(n.slice(0,-5));return {...s,messages:undefined,message_count:s.messages.length};})});
 }
 if(path==='/api/sessions/rename'&&req.method==='POST'){
  const body=await req.json(),session=getSession(body.id);session.title=String(body.title||'').trim();writeSession(session);return json({ok:true,title:session.title});
 }
 if(path==='/api/sessions/archived'&&req.method==='GET')return json({sessions:fs.readdirSync(archivedRoot).filter(n=>n.endsWith('.json')).map(n=>{const s=JSON.parse(fs.readFileSync(join(archivedRoot,n),'utf8'));return {...s,messages:undefined,message_count:(s.messages||[]).length,archived:true};}).sort((a,b)=>b.updated_at-a.updated_at)});
 const restore=path.match(/^\/api\/sessions\/([^/]+)\/restore$/);
 if(restore&&req.method==='POST'){
   const id=restore[1];if(!fs.existsSync(archivedFile(id)))return json({error:'归档会话不存在'},404);if(fs.existsSync(sessionFile(id)))return json({error:'当前已有同 ID 会话，无法覆盖恢复'},409);
   fs.renameSync(archivedFile(id),sessionFile(id));const s=getSession(id);return json({ok:true,session:{id:s.id,title:s.title,updated_at:s.updated_at,message_count:s.messages.length}});
 }
 if(path.startsWith('/api/sessions/')){
  if(req.method==='DELETE'){const id=path.split('/')[3];if(!fs.existsSync(sessionFile(id)))return json({error:'会话不存在'},404);if(q.list(id).some(j=>j.status==='pending'||j.status==='running'))return json({error:'会话仍有进行中的回复或排队消息，请完成或取消后再归档'},409);if(fs.existsSync(archivedFile(id)))return json({error:'会话已经归档'},409);fs.renameSync(sessionFile(id),archivedFile(id));return json({ok:true,archived:true});}
  const [,id,action]=path.match(/^\/api\/sessions\/([^/]+)(?:\/(sync))?$/)||[];
  if(id&&fs.existsSync(sessionFile(id))){const s=getSession(id);return json(action?{sig:s.messages.length+'|'+s.messages.at(-1)?.content?.length+'|'+s.updated_at}:s);}
 }
 if(path.startsWith('/api/')){
  if(req.method!=='GET'){stats.mutations.push({path,body:await req.text()});return json({error:'隔离验收不允许此操作'},404);}
  return json({});
 }
 const file=resolve(app,'ui',path==='/'?'index.html':path.slice(1));
 if(!file.startsWith(join(app,'ui')+'/')||!fs.existsSync(file))return new Response('Not Found',{status:404});
 return new Response(fs.readFileSync(file),{headers:{'Content-Type':mime[extname(file)]||'application/octet-stream'}});
}
const server=createServer(async(req,res)=>{
 try{
  const chunks=[];for await(const c of req)chunks.push(c);
  const controller=new AbortController();res.on('close',()=>controller.abort());
  const body=Buffer.concat(chunks),request=new Request('http://127.0.0.1:'+server.address().port+req.url,{method:req.method,headers:req.headers,body:body.length?body:undefined,signal:controller.signal});
  if(authEnabled)previewAuth.remember(request,{trustedUnix:req.headers['x-fixture-unix']==='1',remoteAddress:req.socket.remoteAddress});
  const response=(authEnabled?await previewAuth.gate(request):null)||await handle(request);res.writeHead(response.status,Object.fromEntries(response.headers));
  if(response.body)Readable.fromWeb(response.body).on('error',()=>res.end()).pipe(res);else res.end();
 }catch(e){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}
});
const portValue=process.env.PREVIEW_PORT;
if(portValue===undefined||portValue===''||!/^\d+$/.test(portValue)||Number(portValue)>65535){throw new Error('PREVIEW_PORT must be an explicit port from 0 to 65535');}
server.listen(Number(portValue),'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port,root})));
async function stop(){runtime.stop();await Promise.all([q.stop(),roomRunner.stop()]);server.close(()=>process.exit(0));}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
