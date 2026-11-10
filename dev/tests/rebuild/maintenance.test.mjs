import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createMaintenanceHandler} from '../../../app/server/panel-maintenance.js';

test('real Git history pages remain anchored while HEAD advances; working state is not modified',async()=>{
 const root=mkdtempSync(join(tmpdir(),'maintenance-test-'));
 const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
 try{
  git('init','-q');git('config','user.name','维护测试');git('config','user.email','fixture@example.invalid');
  for(let i=0;i<33;i++)git('commit','--allow-empty','-qm',`提交 ${i}\n\n说明 <script>bad()</script>`);
  writeFileSync(join(root,'pending.txt'),'保留的工作区变更');
  const handler=createMaintenanceHandler({repositories:[{id:'panel',name:'面板',path:root}],checkToken:()=>true});
  const get=async path=>(await handler(new Request('http://localhost'+path),path.split('?')[0])).json();
  const before=git('status','--porcelain');
  const repos=await get('/api/maintenance/repositories');assert.equal(repos.repositories[0].changes,1);
  const first=await get('/api/maintenance/history?repo=panel');assert.equal(first.commits.length,30);assert.equal(first.next,30);assert.equal(first.commits[0].subject,'提交 32');
  git('commit','--allow-empty','-qm','新增提交');
  const second=await get('/api/maintenance/history?repo=panel&ref='+first.ref+'&offset=30');
  assert.equal(second.commits.length,3);assert.equal(second.commits[0].subject,'提交 2');assert.equal(second.next,null);
  assert.equal(new Set([...first.commits,...second.commits].map(item=>item.hash)).size,33);
  assert.equal(git('status','--porcelain'),before);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('unauthorized, invalid parameters and retired upgrades never spawn a process',async()=>{
 let calls=0;const handler=createMaintenanceHandler({repositories:[{id:'panel',path:'/fixture'}],checkToken:req=>req.headers.get('x-monitor-token')==='yes',run:()=>{calls++;}});
 for(const [path,authorized,status] of [['/api/maintenance/repositories',false,401],['/api/maintenance/history?repo=../../etc',true,400],['/api/maintenance/history?repo=panel&ref=--all',true,400],['/api/maintenance/history?repo=panel&offset=-1',true,400],['/api/app/auto-update',true,410],['/api/app/hot-patch',true,410],['/api/hermes/update',true,410],['/api/app/update/run',true,410]]){
  const response=await handler(new Request('http://localhost'+path,{headers:authorized?{'X-Monitor-Token':'yes'}:{}}),path.split('?')[0]);assert.equal(response.status,status,path);
 }
 assert.equal(calls,0);
});

test('one unavailable repository does not suppress available history; errors do not expose shell output',async()=>{
 const handler=createMaintenanceHandler({repositories:[{id:'bad',name:'断开的仓库',path:'/bad'},{id:'good',name:'可用',path:'/good'}],checkToken:()=>true,
 run:(binary,args,options,callback)=>{assert.equal(options.env.GIT_OPTIONAL_LOCKS,'0');if(args.includes('/bad'))callback(Error('secret output'));else callback(null,args.includes('rev-parse')?'a'.repeat(40)+'\n':'');}});
 const body=await(await handler(new Request('http://localhost/api/maintenance/repositories'),'/api/maintenance/repositories')).json();
 assert.equal(body.repositories[0].available,false);assert.equal(body.repositories[1].available,true);assert.ok(!JSON.stringify(body).includes('secret output'));
});
