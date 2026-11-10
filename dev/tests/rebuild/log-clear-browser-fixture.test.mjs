import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('log browser fixture distinguishes an empty log from a missing fixture',()=>{
 const server=readFileSync(new URL('./preview-server.mjs',import.meta.url),'utf8');
 const browser=readFileSync(new URL('./log-clear-browser.py',import.meta.url),'utf8');
 assert.match(server,/fixtureLogs\.has\(fileName\)\?fixtureLogs\.get\(fileName\):'INFO fixture 保留日志 '\+fileName/);
 assert.match(server,/content\?content\.split\('\\n'\):\[\]/);
 assert.match(browser,/locator\('#logUndoBtn'\)\.wait_for\(state='visible'\)/);
 assert.match(browser,/wait_fixture\(url,lambda value:len\(value\.get\('logClears'\) or \[\]\)==baseline\+1\)/);
 assert.match(browser,/cleared\[baseline:\]==\['hermes\.log'\]/);
});
