import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../../../app/ui/index.html',import.meta.url),'utf8');
const localStart=html.indexOf("apiGet('/api/extensions/skills/local')");
const localEnd=html.indexOf('\n  }\n}',localStart);
const localRenderer=html.slice(localStart,localEnd);
const configStart=html.indexOf('function renderSkillConfigModal(s)');
const configEnd=html.indexOf('\nfunction renderSkillConfigFields',configStart);
const configRenderer=html.slice(configStart,configEnd);

test('local skill inventory does not expose a nonfunctional enable toggle',()=>{
  assert.ok(localRenderer.length>0);
  assert.doesNotMatch(localRenderer,/toggleSkill\s*\(/);
  assert.match(localRenderer,/目录加载/);
  assert.doesNotMatch(localRenderer,/openSkillConfigLocal/);
  assert.doesNotMatch(html,/function toggleSkill\(i\)/, 'legacy fake toggle should be removed');
});

test('local skills do not expose native-only configuration controls',()=>{
  assert.doesNotMatch(html,/openSkillConfigLocal/);
  assert.match(configRenderer,/toggleSkillCfgEnabled/);
  assert.doesNotMatch(configRenderer,/toggleSkillCfgCli/);
  assert.doesNotMatch(configRenderer,/Disabled for CLI/);
  assert.doesNotMatch(configRenderer,/skills_config/);
});

test('native skill toggle treats HTTP and API errors as failures',()=>{
  const start=html.indexOf('function toggleNativeSkill(name)');
  const end=html.indexOf('\nfunction ',start+10);
  const source=html.slice(start,end);
  assert.match(source,/if\(!r\.ok\) throw new Error/);
  assert.match(source,/result\.ok===false/);
  assert.match(source,/s\.enabled=newOn/);
  assert.ok(source.indexOf('s.enabled=newOn')>source.indexOf('result.ok===false'));
});

test('native skill configuration does not persist unsupported CLI state',()=>{
  assert.doesNotMatch(configRenderer,/cli_disabled/);
  assert.match(html,/技能配置未保存/);
  assert.doesNotMatch(configRenderer,/保存到本地配置/);
});
