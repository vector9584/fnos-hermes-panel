import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {stateError} from './panel-state.js';

export class PanelDrain {
 constructor({root,identity,health,python='python3',now=Date.now,delay=ms=>new Promise(r=>setTimeout(r,ms))}){Object.assign(this,{identity,health,python,now,delay});this.path=join(root,'gateway-drain.json');}
 async begin(id,{interrupt=false}={}){
  const process=this.identity();
  if(!process){if(interrupt)return {skipped:true};throw stateError('网关进程尚未核实，未开始排空',409);}
  const initial=await this.health.refresh();
  if(initial.gateway.state==='draining')throw stateError('网关已由其他操作暂停接收消息，请先完成或取消该操作',409);
  const stamp=this.now();
  const lease={version:1,action:'drain',phase:'preparing',id,pid:process.pid,start:process.start,created_at:stamp,expires_at:stamp+60000};
  this.mutate({action:'begin',id,lease,now:stamp});
  try{
   const deadline=stamp+8000;
   while(this.now()<deadline){
    const current=this.identity();if(!current||current.pid!==process.pid||current.start!==process.start)throw stateError('网关进程已改变，已取消本次重启',409);
    const observed=await this.health.refresh();
    if(observed.gateway.verified&&observed.gateway.state==='draining'&&observed.gateway.work_known){
     if(!interrupt&&observed.gateway.busy)throw stateError('暂停接收后仍有任务运行，已取消重启，请等待任务完成',409);
     return {id,expires_at:lease.expires_at};
    }
    await this.delay(200);
   }
   throw stateError('网关未确认暂停接收新任务，已取消重启',503);
  }catch(error){this.release(id);throw error;}
 }
 validate(id){
  const current=this.identity();let lease;try{lease=JSON.parse(fs.readFileSync(this.path,'utf8'));}catch{throw stateError('排空标记无法核实，尚未执行重启',409);}
  if(lease.id!==id||!current||lease.pid!==current.pid||lease.start!==current.start||lease.expires_at-this.now()<30000)throw stateError('排空确认已失效或剩余时间不足，尚未执行重启，请重新操作',409);
  return true;
 }
 mutate(body){
  const result=spawnSync(this.python,['-B',fileURLToPath(new URL('./panel_drain_store.py',import.meta.url)),this.path],{input:JSON.stringify(body),encoding:'utf8',timeout:5000,maxBuffer:16384,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  let data;try{data=JSON.parse(result.stdout);}catch{throw stateError('排空状态服务未返回确认，请核对后重试',503);}
  if(result.status!==0||!data.ok)throw stateError(data.error||'排空状态未能更新',409);
 }
 dispatch(id){this.validate(id);this.mutate({action:'dispatch',id,identity:this.identity(),now:this.now()});}
 release(id){this.mutate({action:'release',id});}
}
