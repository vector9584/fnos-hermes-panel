import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createCronUpdateHandler, cronRevision} from '../../../app/server/panel-cron.js';

test('revision is identical across Python and JS, unaffected by completion count', () => {
  const script = fileURLToPath(new URL('../../../app/server/panel-cron.py', import.meta.url));
  const job = {name: '原任务 🕰', schedule: {kind: 'interval', minutes: 30}, repeat: {times: 10, completed: 4}};
  const result = execFileSync(process.env.TEST_PYTHON || 'python3', ['-B', '-c',
    'import runpy,json,sys; scope=runpy.run_path(sys.argv[1]); print(scope["revision"](json.load(sys.stdin)))', script],
    {input: JSON.stringify(job), encoding: 'utf8'}).trim();
  assert.equal(cronRevision(job), result);
  assert.equal(cronRevision({...job, repeat: {times: 10, completed: 5}}), result);
  assert.notEqual(cronRevision({...job, name: '新名称'}), result);
});

test('PATCH sends only supplied fields to native update, with original job ID', async () => {
  let received;
  const handler = createCronUpdateHandler({python: 'python3', serverRoot: '/app/server', nativeRoot: '/app/hermes-src',
    backupRoot: '/var/panel-state/cron-backups', getHome: () => '/tmp/fixture', checkToken: () => true,
    start(binary, args) {
      assert.equal(args[2], '/tmp/fixture');
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      child.stdin.on('data', chunk => { received = JSON.parse(String(chunk)); });
      child.stdin.on('finish', () => { child.stdout.write('{"ok":true,"job":{"id":"original"}}'); child.emit('close', 0); });
      return child;
    }});
  const response = await handler(new Request('http://localhost/api/cron-jobs/original', {method: 'PATCH',
    body: JSON.stringify({name: '新名称', revision: 'a'.repeat(64), action: 'remove', scriptInjection: true})}), '/api/cron-jobs/original');
  assert.equal(response.status, 200);
  assert.deepEqual(received, {name: '新名称', revision: 'a'.repeat(64), action: 'update', job_id: 'original'});
});

test('invalid identifiers, stale forms and unauthorized writes never start a subprocess', async () => {
  for (const [authorized, id, body, status] of [[false, 'job', {}, 401], [true, '..', {}, 400], [true, 'job', {}, 409]]) {
    const handler = createCronUpdateHandler({checkToken: () => authorized, start: () => { throw Error('must not execute'); }});
    const response = await handler(new Request('http://localhost/api/cron-jobs/job', {method: 'PATCH', body: JSON.stringify(body)}), '/api/cron-jobs/' + id);
    assert.equal(response.status, status);
  }
});
