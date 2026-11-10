import {spawn} from 'node:child_process';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRestartWorker,launchRestartWorker} from './panel-restart-worker.js';
import {StateFile,stateError} from './panel-state.js';

export class PanelRuntime{
 constructor({root,source,started=Date.now(),available=()=>true,busy=()=>false,observation=()=>null,prepare=async()=>{},drain=null,receipt=null,worker=createRestartWorker(),recovery=()=>({ok:true,pending:null}),start=spawn,now=Date.now}){
  Object.assign(this,{root,source,started,available,busy,observation,prepare,drain,receipt,worker,recovery,start,now});this.timer=null;this.cleanupRetryAt=0;this.pendingFailure=null;
  this.file=new StateFile(join(root,'runtime-apply.json'),()=>({version:1,changes:[],restart:null}),{validate:d=>d?.version===1&&Array.isArray(d.changes)});
 }
 releaseDrain(restart){
  try{this.drain?.release(restart.id);restart.drain_cleanup={status:'released',at:this.now()};}
  catch{restart.drain_cleanup={status:'pending',at:this.now(),error:'暂停接收状态尚未释放，正在重试；释放完成前不能再次重启'};}
  this.cleanupRetryAt=this.now()+5000;
 }
 status(){if(this.pendingFailure){const pending=this.pendingFailure;this.failed(pending.id,pending.error);if(this.pendingFailure)throw stateError('重启结果暂时无法保存，请检查状态目录后重试',503);}const data=this.file.read(),restart=data.restart,healthy=this.available(),config_recovery=this.recovery();let dirty=false;
  if(restart?.drain_cleanup?.status==='pending'&&this.now()>=this.cleanupRetryAt){this.releaseDrain(restart);dirty=true;}
  const awaitingReceipt=restart?.status==='requested'||(restart?.status==='failed'&&restart.failure_reason==='timeout');
  if(awaitingReceipt&&(this.receipt?this.receipt.verify(restart.before,restart.id,restart.worker&&{pid:restart.worker.pid,start:restart.worker.start}):this.started>restart.requested_at)){restart.status='restarted';restart.observed_at=this.started;dirty=true;}
  if(restart?.status==='restarted'&&healthy&&config_recovery.ok&&!config_recovery.pending&&restart.drain_cleanup?.status!=='pending'){
   restart.status='ready';restart.ready_at=this.now();delete restart.error;delete restart.failure_reason;data.changes=data.changes.filter(change=>change.at>restart.requested_at);dirty=true;
  }
  if(['requested','restarted'].includes(restart?.status)&&this.now()-restart.requested_at>90000){
   restart.status='failed';restart.failure_reason='timeout';restart.error='应用未在预期时间内恢复健康，仍在核实恢复结果；请检查维护记录';
   if(!restart.drain_cleanup)this.releaseDrain(restart);dirty=true;
  }
  if(dirty)this.file.write(data);
  const worker_state=restart?.worker&&!restart.worker_finished?this.worker.observe(restart.worker).state:'exited';
  const restart_block_reason=restart?.drain_cleanup?.status==='pending'?restart.drain_cleanup.error:worker_state==='running'?'正式重启脚本仍在执行，正在核实结果；暂不能再次重启':worker_state==='unverified'?'暂时无法核实正式重启脚本是否结束，请检查运行状态后重试':null;
  return {...data,config_recovery,healthy,observation:this.observation(),busy:!!this.busy(),started_at:this.started,restart_pending:['requested','restarted'].includes(restart?.status),restart_worker_state:worker_state,restart_block_reason,restart_blocked:!!restart_block_reason,ready:restart?.status==='ready'&&healthy&&config_recovery.ok&&!config_recovery.pending};
 }
 changed(reason){return this.file.update(data=>{const label=String(reason||'配置修改').slice(0,120);const same=data.changes.find(item=>item.reason===label);if(same)same.at=this.now();else data.changes.push({id:randomUUID(),reason:label,at:this.now()});});}
 async requestRestart(body={}){await this.prepare();return this.restart(body);}
 restart(body={}){
  if(!body||typeof body!=='object'||Array.isArray(body)||('interrupt'in body&&typeof body.interrupt!=='boolean'))throw stateError('重启请求格式不正确');
  const interrupt=body.interrupt===true;
  const status=this.status();if(status.restart_blocked)throw stateError(status.restart_block_reason,409);if(status.restart_pending)throw stateError('应用重启已请求，请等待连接恢复',409);
  if(!status.config_recovery.ok||status.config_recovery.pending)throw stateError('有未处理的配置保存，请先到本地维护核对并恢复',409);
  if(status.observation?.gateway?.work_known===false&&!interrupt)throw stateError('暂时无法核实外部渠道与定时任务是否空闲，请稍后重试，或明确确认中断后重启',409);
  if(status.busy&&!interrupt)throw stateError('仍有任务在执行，请等待任务结束，或确认中断后应用',409);
  const script=join(this.source,'dev/hermes-dev.sh');if(!fs.existsSync(script))throw stateError('正式重启脚本不存在，尚未发起重启',503);
  const before=this.receipt?this.receipt.capture():null;const requested_at=this.now(),id=randomUUID();this.file.update(data=>{data.restart={id,status:'requested',requested_at,interrupt:!!interrupt,before};});
  // Respond before fnOS replaces this Monitor. Only the approved script controls
  // process lifecycle. On the next boot, status() observes a new Monitor start.
  this.timer=setTimeout(async()=>{
   let fd,drainResult;
   try{await this.prepare();const latest=this.status();if(latest.restart?.id!==id||latest.restart.status!=='requested')return;if(!latest.config_recovery.ok||latest.config_recovery.pending){this.failed(id,'执行重启前发现待恢复配置，尚未重启');return;}if(!interrupt&&(latest.busy||latest.observation?.gateway?.work_known===false)){this.failed(id,'执行重启前检测到新任务或无法核实任务状态，已取消重启；请核对后重试');return;}}catch{this.failed(id,'执行重启前无法核实运行状态，尚未重启');return;}
   try{if(this.drain)drainResult=await this.drain.begin(id,{interrupt});const latest=this.status();if(latest.restart?.id!==id||latest.restart.status!=='requested'||!latest.config_recovery.ok||latest.config_recovery.pending)throw stateError('排空期间运行状态或配置发生变化，已取消重启',409);if(!interrupt&&latest.busy)throw stateError('排空期间出现新的面板任务，已取消重启',409);}catch(error){this.failed(id,error.status?error.message:'重启排空未完成，尚未重启');return;}
   try{if(this.receipt){const current=this.receipt.capture();if(current.pid!==before.pid||current.start!==before.start)throw stateError('派发前Monitor身份已改变，尚未执行重启',409);}if(this.drain&&!drainResult?.skipped){this.drain.validate?.(id);this.drain.dispatch?.(id);}fs.mkdirSync(this.root,{recursive:true,mode:0o700});fd=fs.openSync(join(this.root,'restart.log'),'a',0o600);
    launchRestartWorker({start:this.start,source:this.source,fd,worker:this.worker,requestId:id,python:this.receipt?.python,app:this.receipt?.app,home:this.receipt?.home,varDir:this.receipt?.varDir,node:this.receipt?.node,
     persist:identity=>this.file.update(data=>{if(data.restart?.id!==id||data.restart.status!=='requested')throw Error('restart request changed');data.restart.worker=identity;}),
     onError:()=>this.failed(id,'正式重启脚本启动通道失败，请查看维护记录'),
     onExit:(code,signal)=>{try{this.file.update(data=>{if(data.restart?.id===id)data.restart.worker_finished={at:this.now(),code,signal:signal||null};});}catch{}if(code!==0)this.failed(id,signal?'正式重启脚本被中断，请查看维护记录':'正式重启脚本未成功退出，请查看维护记录');}
    });
   }catch(_){this.failed(id,'重启启动确认未完成，请检查状态存储与权限；正在核实子进程结果');}finally{if(fd!==undefined)fs.closeSync(fd);}
  },500);this.timer.unref?.();return {ok:true,restart_requested:true,id};
 }
 failed(id,error){
  // Ignore late events belonging to an older request or an already verified restart.
  try{this.file.update(data=>{if(data.restart?.id!==id||data.restart.status!=='requested')return;
   Object.assign(data.restart,{status:'failed',failure_reason:'execution',error});this.releaseDrain(data.restart);
  });this.pendingFailure=null;}catch{this.pendingFailure={id,error};}
 }
 stop(){clearTimeout(this.timer);}
}
export function createRuntimeHandler({runtime,checkToken}){
 return async(req,path)=>{if(!path.startsWith('/api/panel-runtime/'))return null;const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  if(!checkToken(req))return reply({ok:false,error:'请重新登录后管理运行状态'},401);
  try{if(path==='/api/panel-runtime/status'&&req.method==='GET')return reply({ok:true,...(await runtime.prepare(),runtime.status())});if(path==='/api/panel-runtime/restart'&&req.method==='POST')return reply(await runtime.requestRestart(await req.json()));throw stateError('运行状态操作不存在',404);}catch(error){return reply({ok:false,error:error.status?error.message:'运行状态读取失败，请重试'},error.status||503);}
 };
}
