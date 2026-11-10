import {digest,stateError} from './panel-state.js';

// Reuses the existing durable chat queue. Room progression never owns a second
// Gateway or a disposable browser stream; each member keeps an isolated session.
export function createRoomExecution({queue,ensureSession,userIdentity}){
 return async(job,{signal,emit})=>{
  const sessionId='room_'+digest([job.room_id,job.member.key]).slice(0,44);
  ensureSession(sessionId,job);
  if(job.attempt>0){for(const previous of queue.list(sessionId)){if(previous.status==='interrupted')queue.resolve(previous.id);}}
  const snapshot={system:job.system,identity:{sender:job.member.label,sender_avatar:job.member.emoji,sender_kind:'expert',expert_id:job.member.persona_id||''},user_identity:userIdentity()};
  queue.enqueue({session_id:sessionId,request_id:job.id,message:job.message,system:job.system,model:job.model||'',provider:job.provider||''},snapshot);
  return await new Promise((resolve,reject)=>{
   let unsubscribe,settled=false;
   const finish=error=>{if(settled)return;settled=true;unsubscribe?.();signal?.removeEventListener('abort',cancel);if(error){reject(error);return;}const saved=queue.get(job.id);resolve({status:saved.status,reply:saved.result.reply,reasoning:saved.result.reasoning,tools:saved.result.tools,error:saved.result.error});};
   const cancel=()=>{try{queue.cancel(job.id);}catch(error){finish(error);}};
   try{
    unsubscribe=queue.subscribe(job.id,event=>{
     try{
      if(event.snapshot){emit({snapshot:event.snapshot.result});if(['done','failed','cancelled','interrupted'].includes(event.snapshot.status)){finish();return;}}
      for(const packet of event.events||[])emit(packet);
      if(event.storage_error){finish(stateError(event.storage_error,503));return;}
      if(event.done)finish();
     }catch(error){finish(error);}
    });
    if(settled){unsubscribe?.();return;}
    signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
   }catch(error){finish(error);}
  });
 };
}
