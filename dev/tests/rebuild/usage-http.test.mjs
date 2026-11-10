import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createUsageHandler} from '../../../app/server/panel-usage.js';

const request = () => new Request('http://localhost/api/usage');
test('concurrent usage reads share one process and subsequent refresh reads again', async () => {
  let calls = 0;
  let finish;
  const handler = createUsageHandler({python: 'python3', serverRoot: '/app/server', dataRoot: '/home/data',
    run(binary, args, options, callback) {
      calls++;
      assert.equal(binary, 'python3');
      assert.deepEqual(args, ['-B', '/app/server/panel-usage.py', '/home/data/state.db']);
      assert.equal(options.timeout, 15000);
      finish = callback;
    }});
  const first = handler(request(), '/api/usage');
  const second = handler(request(), '/api/usage');
  assert.equal(calls, 1);
  finish(null, JSON.stringify({ok: true, usage: {totals: {input_tokens: 123}}}));
  for (const response of await Promise.all([first, second])) {
    assert.equal(response.status, 200);
    assert.equal((await response.json()).usage.totals.input_tokens, 123);
  }
  const refresh = handler(request(), '/api/usage');
  assert.equal(calls, 2);
  finish(null, JSON.stringify({ok: true, usage: {}}));
  await refresh;
});

test('process failure, corrupt output and timeout are observable errors', async () => {
  for (const [error, stdout] of [[new Error('failed'), '{"ok":false,"error":"读取失败"}'],
    [null, 'not json'], [Object.assign(new Error('timeout'), {killed: true}), '']]) {
    const handler = createUsageHandler({run: (binary, args, options, callback) => callback(error, stdout),
      python: 'python3', serverRoot: '/app', dataRoot: '/data'});
    const response = await handler(request(), '/api/usage');
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.ok(body.error);
    assert.equal(body.usage, undefined);
  }
});
test('concurrent requests also share pending worker and worker failure is retryable',async()=>{let scans=0,processes=0,complete;const handler=createUsageHandler({python:'fixture',serverRoot:'/fixture',dataRoot:'/fixture',panelRoot:'/panel',run:(_b,_a,_o,cb)=>{processes++;cb(null,'{"ok":true,"usage":{"totals":{"input_tokens":20}}}');},readExtra:()=>{scans++;return new Promise((resolve,reject)=>complete={resolve,reject});}});const a=handler(request(),'/api/usage'),b=handler(request(),'/api/usage');assert.equal(scans,1);assert.equal(processes,1);complete.reject(Error('统计超时，请重试'));assert.equal((await a).status,503);assert.equal((await b).status,503);const retry=handler(request(),'/api/usage');assert.equal(scans,2);complete.resolve({records:1});const result=await (await retry).json();assert.equal(result.usage.totals.input_tokens,20);assert.equal(result.usage.panel_requests.records,1);});
