import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createCronHistoryHandler} from '../../../app/server/panel-cron-history.js';

function fixture(test) {
  const root = fs.mkdtempSync(join(tmpdir(), 'cron-history-'));
  test.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const home = join(root, 'home');
  const output = join(home, 'cron/output/job');
  fs.mkdirSync(output, {recursive: true});
  fs.writeFileSync(join(home, 'cron/jobs.json'), JSON.stringify({jobs: [{id: 'job', name: '任务',
    last_status: 'ok', last_delivery_error: '投递超时', panel_archived: true}]}));
  const handler = createCronHistoryHandler({getHome: () => home, checkToken: req => req.headers.get('x-monitor-token') === 'fixture'});
  async function request(suffix = '', authorized = true) {
    const url = new URL('http://localhost/api/cron-jobs/job/history' + suffix);
    return handler(new Request(url, {headers: authorized ? {'x-monitor-token': 'fixture'} : {}}), url.pathname);
  }
  return {root, home, output, request};
}
test('lists both output layouts, pages without duplication and keeps execution distinct from delivery', async test => {
  const {home, output, request} = fixture(test);
  for (let index = 0; index < 35; index++) fs.writeFileSync(join(output, index + '.md'), 'output ' + index);
  const legacy = join(home, 'cron/job/outputs'); fs.mkdirSync(legacy, {recursive: true});
  fs.writeFileSync(join(legacy, 'old.md'), '旧产物');
  const first = await (await request()).json();
  assert.equal(first.total, 36); assert.equal(first.records.length, 30);
  assert.equal(first.job.last_status, 'ok'); assert.equal(first.job.last_delivery_error, '投递超时');
  const second = await (await request('?after=' + first.next)).json();
  assert.equal(second.records.length, 6); assert.equal(second.next, null);
  assert.equal(new Set([...first.records, ...second.records].map(row => row.id)).size, 36);
  const old = [...first.records, ...second.records].find(row => row.name === 'old.md');
  assert.equal((await (await request('/' + old.id)).json()).content, '旧产物');
  assert.equal((await request('?after=stale')).status, 409);
});
test('requires authentication and refuses external symlink directory and symlink files', async test => {
  const {root, output, request} = fixture(test);
  assert.equal((await request('', false)).status, 401);
  const secret = join(root, 'secret.md'); fs.writeFileSync(secret, 'secret');
  fs.symlinkSync(secret, join(output, 'linked.md'));
  assert.equal((await (await request()).json()).records.length, 0);
  fs.rmSync(output, {recursive: true});
  fs.symlinkSync(root, output);
  assert.equal((await request()).status, 403);
});
test('reads raw text without transformation and reports removed outputs', async test => {
  const {output, request} = fixture(test);
  const content = '<script>alert(1)</script>\n# 完整产物';
  fs.writeFileSync(join(output, 'result.md'), content);
  const record = (await (await request()).json()).records[0];
  assert.equal((await (await request('/' + record.id)).json()).content, content);
  fs.unlinkSync(join(output, 'result.md'));
  assert.equal((await request('/' + record.id)).status, 404);
});
test('corrupt job store is an error rather than empty successful history', async test => {
  const {home, request} = fixture(test);
  fs.writeFileSync(join(home, 'cron/jobs.json'), '{broken');
  const response = await request();
  assert.equal(response.status, 500);
  assert.equal((await response.json()).ok, false);
});
test('output directory cannot point at other private data inside the same home', async test => {
  const {home, output, request} = fixture(test);
  const memory = join(home, 'memories'); fs.mkdirSync(memory);
  fs.writeFileSync(join(memory, 'MEMORY.md'), 'private memory');
  fs.rmSync(output, {recursive: true}); fs.symlinkSync(memory, output);
  assert.equal((await request()).status, 403);
});
