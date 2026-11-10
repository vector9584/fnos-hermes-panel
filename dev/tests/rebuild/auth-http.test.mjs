import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import {createRequire} from 'node:module';
import {PanelAuth} from '../../../app/server/panel-auth.js';
import {dispatchPanel,authorizePanelUpgrade,toPanelRequest,panelBodyLimit} from '../../../app/server/panel-http.js';
const require=createRequire(import.meta.url),{WebSocket,WebSocketServer}=require('../../../app/server/_vendor/ws');

async function fixture(t){const root=fs.mkdtempSync(join(tmpdir(),'hermes-auth-http-')),socket=join(root,'panel.sock'),auth=new PanelAuth({file:join(root,'state/auth.json'),legacyToken:'fixture-maintenance'}),calls=[];
 const handlers={auth,maintenance:async()=>null,custom:async req=>{calls.push(req.url);return new Response('private custom data');},main:async()=>new Response('main')};
 const serve=trustedUnix=>http.createServer(async(req,res)=>{try{const response=await dispatchPanel(req,res,{...handlers,trustedUnix});res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());}catch(error){res.writeHead(error.status||500);res.end(error.message);}});
 const unix=serve(true),tcp=serve(false);await new Promise(r=>unix.listen(socket,r));fs.chmodSync(socket,0o600);await new Promise(r=>tcp.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+tcp.address().port;
 const wss=new WebSocketServer({noServer:true});tcp.on('upgrade',(req,socket,head)=>{if(authorizePanelUpgrade(req,socket,{auth}))wss.handleUpgrade(req,socket,head,ws=>ws.send('authorized'));});
 t.after(async()=>{for(const client of wss.clients)client.terminate();wss.close();await Promise.all([new Promise(r=>tcp.close(r)),new Promise(r=>unix.close(r))]);fs.rmSync(root,{recursive:true,force:true});});
 const callUnix=path=>new Promise((resolve,reject)=>{http.get({socketPath:socket,path,headers:{host:'fnos.test'}},res=>{let body='';res.on('data',d=>body+=d);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));}).on('error',reject);});
 return {auth,url,callUnix,calls,root};
}

test('real Unix bootstrap and TCP ingress guard custom routes before dispatch',async t=>{const {url,callUnix,calls}=await fixture(t);const health=await fetch(url+'/api/health');assert.equal(health.status,200);assert.ok(!('token' in await health.json()));assert.equal((await fetch(url+'/api/provider-key')).status,401);assert.equal((await fetch(url+'/api/custom-writer',{method:'PATCH',body:'{}'})).status,401);assert.equal(calls.length,0);const bootstrap=await callUnix('/api/panel-auth/bootstrap'),token=JSON.parse(bootstrap.body).token;assert.equal(bootstrap.status,200);assert.equal((await fetch(url+'/api/custom-writer',{method:'PATCH',headers:{'x-monitor-token':token},body:'{}'})).status,200);assert.equal(calls.length,1);assert.equal((await fetch(url+'/api/custom-writer',{headers:{'x-monitor-token':token,origin:'https://evil.test'}})).status,403);assert.equal(calls.length,1);});

test('real websocket denies unauthenticated and cross-origin, closes on revoke',async t=>{const {url,callUnix}=await fixture(t),wsURL=url.replace('http:','ws:')+'/proxy/dashboard/api/ws';const bootstrap=JSON.parse((await callUnix('/api/panel-auth/bootstrap')).body);
 const rejected=options=>new Promise((resolve,reject)=>{const ws=new WebSocket(wsURL,options);ws.on('unexpected-response',(request,response)=>{resolve(response.statusCode);response.resume();ws.terminate();});ws.on('open',()=>{ws.close();reject(Error('unexpected acceptance'));});ws.on('error',()=>{});});
 assert.equal(await rejected(),401);assert.equal(await rejected({headers:{origin:'https://evil.test','x-monitor-token':bootstrap.token}}),401);
 const ws=new WebSocket(wsURL,{headers:{cookie:'hermes_panel_device='+bootstrap.token}});await new Promise((resolve,reject)=>{ws.once('message',data=>{assert.equal(data.toString(),'authorized');resolve();});ws.once('error',reject);});
 const closed=new Promise(resolve=>ws.once('close',resolve));const revoked=await fetch(url+'/api/panel-auth/revoke',{method:'POST',headers:{'Content-Type':'application/json','x-monitor-token':'fixture-maintenance'},body:JSON.stringify({id:bootstrap.device.id})});assert.equal(revoked.status,200);await closed;
});

test('oversized declared and streamed bodies fail without invoking route',async t=>{const {url,calls}=await fixture(t);const response=await fetch(url+'/api/custom-writer',{method:'POST',headers:{'x-monitor-token':'fixture-maintenance'},body:'x'.repeat(2*1024*1024+1)});assert.equal(response.status,413);assert.equal(calls.length,0);
 const {EventEmitter}=await import('node:events');const req=new EventEmitter();req.headers={};req.method='POST';req.url='/api/write';const result=toPanelRequest(req,{limit:10});req.emit('data',Buffer.from('123456'));req.emit('data',Buffer.from('123456'));req.emit('end');await assert.rejects(result,error=>error.status===413);
});

test('actual upload and text-edit endpoints accept legitimate bodies above the general limit',async t=>{const {url}=await fixture(t);
 for(const path of ['/api/chat/upload-image','/api/chat/upload-file','/api/panel-library/document','/api/files/write']){
  const response=await fetch(url+path,{method:'POST',headers:{'x-monitor-token':'fixture-maintenance'},body:'x'.repeat(3*1024*1024)});assert.equal(response.status,200,path);
 }
 assert.ok(panelBodyLimit('/api/chat/upload-file')>64*1024*1024);assert.ok(panelBodyLimit('/api/panel-library/document')>8*1024*1024*6);
 assert.equal(panelBodyLimit('/api/chat/upload-file/other'),2*1024*1024);
});

test('response disconnect propagates cancellation to the route request',async()=>{
 const {EventEmitter}=await import('node:events'),req=new EventEmitter(),response=new EventEmitter();req.headers={};req.method='GET';req.url='/api/stream';
 const waiting=toPanelRequest(req,{response});req.emit('end');const request=await waiting;assert.equal(request.signal.aborted,false);response.emit('close');assert.equal(request.signal.aborted,true);
});

test('authenticated restart ingress consumes native and legacy paths before custom proxy',async()=>{
 const {EventEmitter}=await import('node:events');let invoked=0,legacy=0;
 const {createRestartIngress}=await import('../../../app/server/panel-restart-ingress.js');
 const restart=createRestartIngress({checkToken:()=>true,runtime:{restart:()=>{invoked++;return {ok:true,restart_requested:true};}}});
 for(const path of ['/api/restart','/proxy/dashboard/api/gateway/restart']){
  const req=new EventEmitter(),res=new EventEmitter();Object.assign(req,{headers:{},method:'POST',url:path,socket:{remoteAddress:'127.0.0.1'}});
  const result=dispatchPanel(req,res,{auth:{remember:r=>r,gate:async()=>null,track:()=>{}},maintenance:async()=>null,restart,custom:async()=>{legacy++;},main:async()=>{legacy++;}});req.emit('end');assert.equal((await result).status,200);
 }
 assert.equal(invoked,2);assert.equal(legacy,0);
});
