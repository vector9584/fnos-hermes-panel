import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createFileHandler,createFileRoots,fileReference,openStaticFile} from '../../../app/server/panel-files.js';

test('bounded file routes and descriptor streams preserve attachments and deny secrets',async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'panel-files-http-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const data=join(root,'data'),varDir=join(root,'var');for(const path of [join(data,'workspace'),join(data,'uploads/files'),join(varDir,'tmp')])fs.mkdirSync(path,{recursive:true});
 fs.writeFileSync(join(data,'workspace','a & b.md'),'original');fs.writeFileSync(join(data,'config.yaml'),'secret');fs.writeFileSync(join(data,'uploads/files/a.html'),'<script>parent.injected=true</script>');fs.symlinkSync(join(data,'config.yaml'),join(data,'workspace','link.md'));
 const roots=createFileRoots({data,varDir}),handler=createFileHandler({python:process.env.TEST_PYTHON||'python3',serverRoot:resolve('app/server'),state:join(varDir,'panel-state'),roots,data,varDir,checkToken:req=>req.headers.get('x-monitor-token')==='test'});
 const call=async(path,body)=>handler(new Request('http://localhost'+path,{method:body?'POST':'GET',headers:{'x-monitor-token':'test','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}),path.split('?')[0]);
 const listed=await (await call('/api/files')).json();assert.equal(listed.items.length,1);const opened=openStaticFile(join(data,'workspace'),join(data,'workspace/a & b.md'));assert.equal(fs.readFileSync(opened.fd,'utf8'),'original');fs.closeSync(opened.fd);fs.symlinkSync(join(data,'workspace'),join(root,'ui-alias'));const aliased=openStaticFile(join(root,'ui-alias'),join(root,'ui-alias/a & b.md'));assert.equal(fs.readFileSync(aliased.fd,'utf8'),'original');fs.closeSync(aliased.fd);assert.throws(()=>openStaticFile(join(data,'workspace'),join(data,'workspace/link.md')),e=>e.status===403);assert.equal(listed.skipped,1);
 const reference=fileReference('/api/download?path='+encodeURIComponent(join(data,'workspace/a & b.md'))+'&name=test',{roots,data,varDir});assert.equal(reference.path,'a & b.md');
 const resolvedRoot=fs.realpathSync(root);assert.equal(fileReference(join(resolvedRoot,'data/workspace/a & b.md'),{roots,data,varDir}).absolute,join(resolvedRoot,'data/workspace/a & b.md'));
 const temporaryAlias=fileReference('/tmp/generated.txt',{roots,data,varDir});assert.equal(temporaryAlias.absolute,join(varDir,'tmp/generated.txt'));
 const uploaded=await handler.upload('', 'files','upload.txt',Buffer.from('uploaded'));assert.equal(uploaded.bytes,8);assert.equal(fs.readFileSync(join(data,'uploads/files/upload.txt'),'utf8'),'uploaded');
 assert.throws(()=>fileReference(join(data,'config.yaml'),{roots,data,varDir}),e=>e.status===403);
 const response=await call('/api/download?path='+encodeURIComponent(join(data,'workspace/a & b.md')));assert.equal(response.status,200);assert.equal(await response.text(),'original');assert.match(response.headers.get('content-disposition'),/^attachment/);
 assert.equal((await call('/api/preview?path='+encodeURIComponent(join(data,'workspace/link.md')))).status,403);
 assert.equal((await call('/data/config.yaml')).status,403);
 const html=await call('/uploads/files/a.html');assert.match(html.headers.get('content-security-policy'),/^sandbox;/);assert.equal(await html.text(),'<script>parent.injected=true</script>');
 assert.equal((await handler(new Request('http://localhost/api/files'),'/api/files')).status,401);
 const doc=await (await call('/api/files/read?root=workspace&path='+encodeURIComponent('a & b.md'))).json();assert.equal((await call('/api/files/write',{...doc,exists:true,content:'new',request_id:'save-http'})).status,200);assert.equal(fs.readFileSync(join(data,'workspace/a & b.md'),'utf8'),'new');
});
