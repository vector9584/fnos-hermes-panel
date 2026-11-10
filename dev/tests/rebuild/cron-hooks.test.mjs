import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CronHooks, webhookText} from '../../../app/server/panel-cron-hooks.js';

function fixture(test) {
  const root = fs.mkdtempSync(join(tmpdir(), 'cron-hooks-'));
  test.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const legacy = join(root, 'legacy.json');
  fs.writeFileSync(legacy, JSON.stringify({job: [{url: 'https://example.com/hook', message: '{output}', label: '旧目标'}]}));
  return {legacy, hooks: new CronHooks(join(root, 'var/hooks.json'), legacy)};
}
test('legacy file is unchanged while overrides persist and deletions mask old values', test => {
  const {hooks, legacy} = fixture(test), before = fs.readFileSync(legacy);
  const current = hooks.get('job');
  hooks.put('job', {revision: current.revision, hooks: [{...current.hooks[0], label: '新目标'}]});
  assert.equal(hooks.get('job').hooks[0].label, '新目标');
  assert.deepEqual(fs.readFileSync(legacy), before);
  hooks.put('job', {revision: hooks.get('job').revision, hooks: []});
  assert.deepEqual(hooks.get('job').hooks, []);
  assert.deepEqual(fs.readFileSync(legacy), before);
});
test('in-flight result never overwrites concurrent address change or resurrects removed target', test => {
  const {hooks} = fixture(test), snapshot = hooks.get('job');
  hooks.put('job', {revision: snapshot.revision, hooks: [{...snapshot.hooks[0], url: 'https://example.com/new'}]});
  assert.equal(hooks.record('job', snapshot.hooks[0], {last_status: 'ok'}), false);
  assert.equal(hooks.get('job').hooks[0].url, 'https://example.com/new');
  const next = hooks.get('job');
  hooks.put('job', {revision: next.revision, hooks: []});
  assert.equal(hooks.record('job', next.hooks[0], {last_status: 'ok'}), false);
  assert.deepEqual(hooks.get('job').hooks, []);
});
test('status changes preserve configuration revision and errors persist', test => {
  const {hooks} = fixture(test), snapshot = hooks.get('job');
  assert.equal(hooks.record('job', snapshot.hooks[0], {last_status: 'error', last_error: 'timeout'}), true);
  assert.equal(hooks.get('job').revision, snapshot.revision);
  assert.equal(hooks.get('job').hooks[0].last_error, 'timeout');
  assert.throws(() => hooks.put('job', {revision: 'stale', hooks: []}), /其他页面修改/);
});
test('bad addresses and malformed legacy data fail without changing storage', test => {
  const {hooks, legacy} = fixture(test), snapshot = hooks.get('job');
  for (const url of ['file:///tmp/foo', 'https://user:password@example.com', 'not a url']) {
    assert.throws(() => hooks.put('job', {revision: snapshot.revision, hooks: [{url}]}));
  }
  fs.writeFileSync(legacy, '{corrupt');
  assert.throws(() => hooks.readAll());
  assert.equal(fs.readFileSync(legacy, 'utf8'), '{corrupt');
});
test('output interpolation does not append duplicate output', () => {
  assert.equal(webhookText('结果：{output}', 'hello'), '结果：hello');
  assert.equal(webhookText('', 'hello'), 'hello');
  assert.equal(webhookText('结果', 'hello'), '结果\n\nhello');
});
