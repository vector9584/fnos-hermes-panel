import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../../../app/ui/index.html',import.meta.url),'utf8');
const start=html.indexOf('function renderToolsets(');
const end=html.indexOf('\nfunction skillIcon',start);
const source=html.slice(start,end);

test('tool cards only expose configuration when real fields exist',()=>{
  assert.match(source,/var configurable=!!\(t\.config_fields&&t\.config_fields\.length\)/);
  assert.match(source,/configurable\?'<button class="action secondary"/);
  assert.match(source,/function extCardHTML\(id, name, desc, on, onclick, icon, configurable, stateText, mode, syncAction, key\)/);
});

test('tool enable state changes only after a successful dashboard response',()=>{
  const toggle=source.slice(source.indexOf('function toggleToolset'),source.indexOf('\nfunction renderToolConfigModal'));
  assert.match(toggle,/mode==='saved'\|\|\(!mode&&_toolNativeFallback\)[\s\S]*?saveConfig\(\)/);
  assert.match(toggle,/_toolNativeLoadGeneration\+\+[\s\S]*?保存失败，已恢复原配置：/);
  assert.doesNotMatch(toggle,/_toolNative\[id\]\.enabled = newOn/);
  assert.match(toggle,/result&&result\.ok===false/);
  assert.match(toggle,/_toolNative\[id\]\.enabled=newOn/);
  assert.match(toggle,/工具状态未保存/);
  assert.match(toggle,/_toolNativeFallback=true;_toolNative=null/);
  assert.match(toggle,/仪表盘状态更新失败/);
  assert.match(toggle,/ts\[id\]=configBefore/);
  assert.match(toggle,/mode==='runtime'\|\|!mode/);
  assert.match(toggle,/if\(mode==='runtime'&&\(!_toolNative\|\|!_toolNative\[id\]\)\)/);
  assert.match(toggle,/_toolActionBusy\[id\]/);
  assert.match(toggle,/setToolActionDisabled\(id,true\)/);
  assert.match(toggle,/typeof expectedOn==='boolean'&&_toolNative\[id\]\.enabled!==expectedOn/);
});

test('tool fallback is labeled as saved configuration and save failure restores the prior value',()=>{
  assert.match(html,/<div id="toolsetFeedback" class="maintenance-feedback" role="status" aria-live="polite"><\/div>/);
  assert.match(source,/Dashboard is authoritative for runtime state/);
  assert.match(source,/以下显示的是已保存配置/);
  assert.match(source,/配置已启用（待应用）/);
  assert.match(source,/配置未启用（待应用）/);
  assert.match(source,/var previous=!!ts\[id\]/);
  assert.match(source,/if\(!result\|\|result\.ok!==true\)throw Error/);
  assert.match(source,/ts\[id\]=previous;renderToolsets\(/);
  assert.match(source,/保存失败，已恢复原配置：/);
  assert.match(source,/data-toggle-mode=/);
  assert.match(source,/syncToolsetConfig\(/);
  assert.match(source,/重启后将/);
  assert.match(source,/运行状态已更新，但重启配置保存失败/);
  assert.match(source,/仪表盘状态更新失败/);
  assert.match(source,/ts\[id\]=configBefore/);
  assert.match(source,/var disabled=_toolActionBusy\[id\]\?' disabled':''/);
  assert.match(source,/data-toolset-id=/);
  assert.match(source,/data-runtime-enabled=/);
  assert.match(source,/!_toolNative\[id\]\|\|!!_toolNative\[id\]\.enabled!==!!enabled/);
  assert.match(source,/querySelector\('\[data-toolset-id=/);
});

test('a late dashboard read cannot overwrite a newer tool availability view',()=>{
  assert.match(html,/var _toolNativeLoadGeneration = 0/);
  assert.match(source,/var generation=\+\+_toolNativeLoadGeneration/);
  assert.equal((source.match(/generation!==_toolNativeLoadGeneration/g)||[]).length,2);
});

test('tool configuration has no duplicate enable switch and no local fallback success',()=>{
  const modal=source.slice(source.indexOf('function renderToolConfigModal'),source.indexOf('\nfunction skillIcon'));
  assert.doesNotMatch(modal,/toolCfgEnable/);
  assert.doesNotMatch(modal,/toggleToolCfgEnable/);
  assert.doesNotMatch(modal,/tools_config\]\[id\]\s*=/);
  assert.match(modal,/工具配置未保存/);
  assert.match(modal,/finally\(function\(\)/);
});
