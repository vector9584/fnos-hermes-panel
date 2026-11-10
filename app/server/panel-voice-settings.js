import {digest,stateError} from './panel-state.js';
const currentFields=current=>({id:String(current?.id||''),emo_auto:current?.emo_auto!==false});
export function createVoiceSettings({api,read,save,ledger}){
 let busy=false;
 async function inspect(){
  const preferences=read(),preference_revision=digest(preferences);let current=null,voices=[],bridge_error=null,bridge_revision=null,bridge_warning=null;
  try{const [list,active]=await Promise.all([api('/voices'),api('/voice/current')]);if(!Array.isArray(list.voices)||!active.current)throw Error();voices=list.voices.map(v=>({id:String(v.id),name:String(v.name||v.id)}));current=currentFields(active.current);bridge_revision=digest(active.current);if(active.current.pushed===false)bridge_warning='当前音色已选中，但参考音频尚未成功推送到Windows，请在语音工作台重试推送后再试听';}catch{bridge_error='Windows语音工作台暂不可用，仍可保存面板朗读偏好';}
  return {ok:true,preferences,preference_revision,current,voices,bridge_error,bridge_warning,bridge_revision,last_save:ledger.read()};
 }
 async function update(body){
  if(busy)throw stateError('另一项声音设置正在保存，请稍后重试',409);
  const preferences=body?.preferences;
  if(!preferences||!['windows','system'].includes(preferences.engine)||typeof preferences.fallback!=='boolean'||! /^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/.test(preferences.system_voice||''))throw stateError('声音偏好格式不正确');
  if(Object.keys(preferences).some(k=>!['engine','fallback','system_voice'].includes(k)))throw stateError('声音偏好包含不支持的设置');
  const remote=body.windows;
  if(remote!==undefined&&(!remote||typeof remote.id!=='string'||!remote.id||remote.id.length>200||typeof remote.emo_auto!=='boolean'))throw stateError('Windows音色设置格式不正确');
  if(body.preference_revision!==digest(read()))throw stateError('朗读偏好已在别处修改，输入已保留，请核对最新设置',409);
  busy=true;let phase='prepared',applied=[],bridgeRevision=body.bridge_revision;
  try{
   if(remote){
    const [list,active]=await Promise.all([api('/voices'),api('/voice/current')]);const before=currentFields(active.current);
    if(!active.current||body.bridge_revision!==digest(active.current))throw stateError('Windows声音已在工作台或其他页面改变，输入已保留，请核对最新设置',409);
    if(!list.voices?.some(v=>v.id===remote.id))throw stateError('所选Windows音色已不存在，请核对音色库',409);
    ledger.write({status:'saving',phase,at:Date.now()});
    if(before.id!==remote.id){phase='windows_voice';ledger.write({status:'saving',phase,at:Date.now()});await api('/voice/current',{id:remote.id});applied.push('音色');}
    // Read after each write; the workbench has no compare-and-swap API.
    const latestRaw=(await api('/voice/current')).current,latest=currentFields(latestRaw);
    if(latestRaw?.pushed===false)throw stateError('Windows参考音频推送失败，工作台可能已切换音色；请在工作台重试推送并核对后再保存',502);
    if(before.id===remote.id&&digest(latestRaw)!==digest(active.current))throw stateError('工作台声音参数在保存期间改变，请核对当前设置',409);
    if(latest.id!==remote.id||latest.emo_auto!==before.emo_auto)throw stateError('工作台声音在保存期间改变，请核对当前声音后重试',409);
    if(latest.emo_auto!==remote.emo_auto){phase='windows_emotion';ledger.write({status:'saving',phase,at:Date.now()});await api('/emo/auto',{on:remote.emo_auto});applied.push('自动语气');}
    const verifiedRaw=(await api('/voice/current')).current,verified=currentFields(verifiedRaw);
    if(verifiedRaw?.pushed===false)throw stateError('Windows参考音频尚未推送成功，请在工作台核对',502);
    if(digest({...latestRaw,emo_auto:remote.emo_auto})!==digest(verifiedRaw))throw stateError('工作台声音参数在保存期间改变，请核对当前设置',409);
    bridgeRevision=digest(verifiedRaw);
    if(digest(verified)!==digest(remote))throw stateError('工作台未确认目标声音设置，请重新读取核对',409);
   }
   if(body.preference_revision!==digest(read()))throw stateError('保存期间朗读偏好发生变化，请核对后重试',409);
   phase='preferences';ledger.write({status:'saving',phase,at:Date.now()});save(preferences);
   ledger.write({status:'saved',phase:'complete',at:Date.now()});return {ok:true,preferences:read(),preference_revision:digest(read()),bridge_revision:bridgeRevision};
  }catch(error){
   const uncertain=phase!=='prepared';const message=uncertain?(error.status?error.message+'；声音保存未全部确认，请核对最新设置':'声音保存未全部确认，Windows工作台可能已更新；面板输入已保留，请核对最新设置'):error.status?error.message:'Windows语音工作台读取失败，尚未保存声音设置';
   ledger.write({status:uncertain?'needs_review':'failed',phase,applied,at:Date.now(),message});throw stateError(message,error.status||503);
  }finally{busy=false;}
 }
 return {inspect,update};
}
