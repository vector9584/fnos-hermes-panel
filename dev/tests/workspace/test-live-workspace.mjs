import fs from 'node:fs';import assert from 'node:assert/strict';
const base='http://127.0.0.1:8650',token=fs.readFileSync('/vol1/@appdata/hermes-agent/monitor.token','utf8').trim();
import {createRequire} from 'node:module';const WebSocket=createRequire(import.meta.url)('/vol1/@appcenter/hermes-agent/server/_vendor/ws');
async function req(method,p,body){let r=await fetch(base+p,{method,headers:{'Content-Type':'application/json','X-Monitor-Token':token},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});assert(r.ok,`${p}: ${r.status}`);return r.json();}
const pause=ms=>new Promise(r=>setTimeout(r,ms));let sids=[],folders=[],rid;
async function finish(sid,marker){const deadline=Date.now()+120000;while(Date.now()<deadline){let s=await req('GET','/api/sessions/'+sid),m=s.messages.findLast(m=>m.role==='assistant');if(m&&!m._streaming){assert.equal(m.sender,'验收 专家');assert.equal(m.sender_avatar,'🧪');assert(m.content.includes(marker),'role instruction did not reach response');return m;}await pause(500);}throw Error('model timeout');}
try{
 const a=(await req('POST','/api/workspace-ui/folders',{name:'验收临时目录'})).folder;folders.push(a.id);
 const b=(await req('POST','/api/workspace-ui/folders',{name:'子目录',parent_id:a.id})).folder;folders.push(b.id);
 for(const transport of ['SSE','WS']){
  let sid=(await req('POST','/api/sessions',{})).id;sids.push(sid);let marker='ROLE_OK_'+transport;
  await req('PUT','/api/workspace-ui/session',{id:sid,folder_id:b.id,expert:{id:'acceptance',name:'验收 专家',emoji:'🧪',prompt:'这是连接验证。无论用户问什么，都只回复 '+marker+'，不要使用任何工具。'}});
  let stream,ws;
  if(transport==='SSE')stream=fetch(base+'/api/chat/stream',{method:'POST',headers:{'Content-Type':'application/json','X-Monitor-Token':token},body:JSON.stringify({session_id:sid,message:'请回答当前角色的约定标记。'}),signal:AbortSignal.timeout(120000)}).then(async r=>{for await(const c of r.body){}});
  else{await req('POST','/api/chat/ws-send',{session_id:sid,message:'请回答当前角色的约定标记。'});ws=new WebSocket(`ws://127.0.0.1:8650/api/chat/ws?session_id=${sid}&token=${token}`);ws.on('error',()=>{});}
  await finish(sid,marker);if(ws)ws.close();if(stream)await stream;
  await req('PUT','/api/workspace-ui/session',{id:sid,expert:null});let saved=await req('GET','/api/sessions/'+sid);assert.equal(saved.messages.at(-1).sender,'验收 专家');
  let found=await req('GET','/api/workspace-ui/search?q='+marker);assert(found.results.some(x=>x.session_id===sid&&x.message_index===1));
  console.log('PASS LIVE',transport,'persisted expert prompt, complete name/avatar, historical signature, indexed search');
 }
 let r=await req('POST','/api/rooms',{title:'验收临时群聊',members:[{key:'acceptance',label:'验收成员',emoji:'🧪',persona_id:'acceptance',system:'仅回复 ROOM_ROLE_OK，不要调用工具。'}]});rid=r.room.id;assert.equal(r.room.members[0].system,'仅回复 ROOM_ROLE_OK，不要调用工具。');
 await req('POST','/api/rooms/'+rid+'/send',{text:'请按当前设定回复连接验证标记。',at:[{key:'acceptance'}]});
 await req('POST','/api/rooms/'+rid+'/autopilot',{active:false,limit:1});
 let done=false;for(let i=0;i<240;i++){
  let room=(await req('GET','/api/rooms/'+rid)).room;
  for(let m of room.members)if(m.session_id&&!sids.includes(m.session_id))sids.push(m.session_id);
  const m=room.messages.findLast(m=>m.kind==='assistant');if(m){assert(m.text.includes('ROOM_ROLE_OK'),m.text);done=true;break;}await pause(500);
 }
 assert(done,'room response timeout');console.log('PASS LIVE ROOM: stored member prompt reaches model; English result preserved');
 const voice=await fetch(base+'/api/workspace-ui/speak',{method:'POST',headers:{'Content-Type':'application/json','X-Monitor-Token':token},body:JSON.stringify({text:'你好，面板语音已经接通。'}),signal:AbortSignal.timeout(180000)});
 assert(voice.ok,await voice.clone().text());const size=(await voice.arrayBuffer()).byteLength;assert(size>500);console.log('PASS LIVE WINDOWS speech route',size,'bytes');
}finally{
 if(rid){await req('POST','/api/rooms/'+rid+'/autopilot',{active:false});await req('DELETE','/api/rooms/'+rid);}
 for(let sid of sids){try{if((await req('GET','/api/chat/active?session_id='+sid)).active)await req('POST','/api/chat/stop',{session_id:sid});await req('DELETE','/api/sessions/'+sid);}catch{}}
 for(let id of folders.reverse())await req('DELETE','/api/workspace-ui/folders',{id});
 console.log('CLEANED temporary sessions, room, folders');
}
