import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {skillInstallName} from '../../../app/server/panel-skill-path.js';

test('skill install names stay within one safe directory component',()=>{
 for(const value of ['../outside','..','.', ''])assert.equal(skillInstallName(value),null,value);
 assert.equal(skillInstallName('folder/name'),'folder_name');
 assert.equal(skillInstallName('folder\\name'),'folder_name');
 assert.equal(skillInstallName('@vendor/my skill'),'_vendor_my_skill');
 assert.equal(skillInstallName('safe_skill-1.2'),'safe_skill-1.2');
 assert.equal(skillInstallName('safe..skill'),'safe..skill');
 assert.equal(skillInstallName('x'.repeat(101)),null);
});

test('all skill installation routes validate before network or filesystem side effects',()=>{
 const monitor=fs.readFileSync(new URL('../../../app/server/monitor.js',import.meta.url),'utf8');
 const custom=fs.readFileSync(new URL('../../../app/server/custom_routes.js',import.meta.url),'utf8');
 const market=monitor.slice(monitor.indexOf('if (path === "/api/extensions/skills/install-package"'),monitor.indexOf('if (path === "/api/extensions/skills/uninstall"'));
 const legacy=monitor.slice(monitor.indexOf('if (path === "/api/extensions/skills/install"'),monitor.indexOf('if (path === "/api/extensions/skills/market-catalog"'));
 const customLegacy=custom.slice(custom.indexOf('if (path === "/api/extensions/skills/install"'),custom.indexOf('// ── 平台频道 / 通讯'));
 for(const [route,body,sideEffect] of [
  ['market installer',market,'fetch(apiBase'],
  ['monitor remote installer',legacy,'mkdirSync(destDir'],
  ['custom remote installer',customLegacy,'mkdirSync(destDir'],
 ]){
  const validation=body.indexOf('skillInstallName('),firstEffect=body.indexOf(sideEffect);
  assert.ok(validation>=0&&firstEffect>validation,`${route}: validate before ${sideEffect}`);
 }
 for(const [route,body] of [['monitor remote installer',legacy],['custom remote installer',customLegacy]]){
  assert.ok(body.indexOf('skillInstallName(')<body.indexOf('mkdirSync(destDir'),`${route}: validate before directory creation`);
 }
});
