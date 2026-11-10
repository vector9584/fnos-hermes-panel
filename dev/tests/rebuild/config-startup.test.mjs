import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import vm from 'node:vm';
import {join} from 'node:path';
const source=fs.readFileSync(new URL('../../../app/server/monitor.js',import.meta.url),'utf8');
const start=source.indexOf('function spawnHermes(name, pidPath, args) {'),end=source.indexOf('  const logPath =',start);
const snippet=source.slice(start,end)+'\nreturn {ok:true,fixtureReached:true};}';
function fixture(fail){const calls=[];const context=vm.createContext({join,VENV_BIN:'/fixture/bin',APP_DIR:'/fixture/app',VAR_DIR:'/fixture/var',HERMES_CONFIG:'/fixture/home/config.yaml',configTransaction:options=>{calls.push(['recover',options]);if(fail)throw Error('fixture conflict');},serviceProcesses:{find:()=>null},writeFileSync:()=>{},foreignHermesPortConflicts:()=>{calls.push(['inspect-ports']);return [];},GATEWAY_PORT:8742,DASHBOARD_PORT:9219,PID_GATEWAY:'/gateway.pid',gatewayCrashLoop:false,readPid:()=>false,log:message=>calls.push(['log',message])});vm.runInContext(snippet,context);return {context,calls};}
test('native service startup resolves config journal before any lifecycle action',()=>{const f=fixture(false);assert.equal(f.context.spawnHermes('gateway','/gateway.pid',[]).fixtureReached,true);assert.equal(f.calls[0][0],'recover');assert.equal(f.calls[0][1].body.action,'recover');assert.equal(f.calls[1][0],'inspect-ports');});
test('disputed journal blocks startup without killing an existing service or exposing secrets',()=>{const f=fixture(true),result=f.context.spawnHermes('gateway','/gateway.pid',[]);assert.equal(result.ok,false);assert.match(result.error,/恢复未完成/);assert.ok(!f.calls.some(([name])=>name==='inspect-ports'));});

test('foreign port conflict prevents launch, and native replacement flag is removed',()=>{const f=fixture(false);f.context.foreignHermesPortConflicts=()=>[{port:8742,pid:99}];assert.equal(f.context.spawnHermes('gateway','/gateway.pid',['gateway','run','--replace']).ok,false);const capture=source.slice(start,end)+'\nreturn {ok:true,args};}';vm.runInContext(capture,f.context);f.context.foreignHermesPortConflicts=()=>[];assert.deepEqual(Array.from(f.context.spawnHermes('gateway','/gateway.pid',['gateway','run','--replace']).args),['gateway','run']);});

test('already running service does not inspect unrelated occupied ports',()=>{const f=fixture(false);f.context.readPid=()=>123;f.context.foreignHermesPortConflicts=()=>{throw Error('must not inspect');};assert.equal(f.context.spawnHermes('gateway','/gateway.pid',[]).msg,'already_running');});
