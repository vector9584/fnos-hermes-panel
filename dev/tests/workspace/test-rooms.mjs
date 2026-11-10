import fs from 'node:fs';import vm from 'node:vm';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
const server=fs.existsSync(new URL('./custom_routes.js',import.meta.url))?new URL('./custom_routes.js',import.meta.url):new URL('../../../app/server/custom_routes.js',import.meta.url);
const source=fs.readFileSync(server,'utf8');
const at=source.indexOf('let roomExpertCatalog;'),end=source.indexOf('function saveRooms()',at);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hermes-room-test-'));
const file=path.join(root,'rooms.json');fs.writeFileSync(file,JSON.stringify([{id:'old',_chainBusy:true,members:[{key:'a',persona_id:'old-expert',label:'老专家'}],messages:[]}]));
const ctx=vm.createContext({console,ROOMS_FILE:file,VAR_DIR:root,APP_DIR:root,BUILTIN_EXPERTS_ALL:[{id:'old-expert',name:'老专家',prompt:'旧角色专长'}],readFileSync:fs.readFileSync,existsSync:fs.existsSync,writeFileSync:fs.writeFileSync,runInNewContext:vm.runInNewContext,log:()=>{}});
try{
 vm.runInContext('let roomsStore=[];'+source.slice(at,end)+'\nthis.getRooms=()=>roomsStore;',ctx);
 ctx.loadRooms();let rooms=ctx.getRooms();assert.match(rooms[0].members[0].system,/旧角色专长/);assert.equal(rooms[0]._chainBusy,undefined);
 rooms[0]._chainBusy=true;rooms[0].messages.push({text:'live'});ctx.loadRooms();assert.equal(ctx.getRooms()[0],rooms[0]);assert(ctx.getRooms()[0]._chainBusy);assert.equal(ctx.getRooms()[0].messages.length,1);
 assert.equal(ctx.roomMemberSystem({system:'snapshot'}),'snapshot');
 assert.equal((source.match(/system: roomMemberSystem\(m\)\.slice\(0, 60000\)/g)||[]).length,2);
 // Execute the real stream reader against a fake upstream; Latin words must survive.
 const start=source.indexOf('async function runRoomMember('),finish=source.indexOf('\nfunction readAppVersion',start);
 const frames='data: '+JSON.stringify({delta:'Object code test 完整英文 [object Object]'})+'\n\n';let saved;
 Object.assign(ctx,{TextDecoder,Date,AbortSignal,ROOMS_UI_PORT:0,ensureMemberSession:async()=> 'sid',broadcastRoom:()=>{},fetch:async()=>({ok:true,body:{getReader(){let sent=false;return {read:async()=>sent?{done:true}:(sent=true,{value:new TextEncoder().encode(frames),done:false})};}}}),_fixRoomArtifacts:x=>x,pushRoomMsg:(id,m)=>{saved=m;},DATA_DIR:root,appendFileSync:()=>{}});
 vm.runInContext(source.slice(start,finish),ctx);await ctx.runRoomMember('old',{key:'a',label:'老专家'},'test','role','','','sid');assert.equal(saved.text,'Object code test 完整英文 ');
 console.log('PASS: legacy prompt recovery, runtime lock/live objects survive polling, new member prompt persistence, English stream integrity');
}finally{fs.rmSync(root,{recursive:true,force:true});}
