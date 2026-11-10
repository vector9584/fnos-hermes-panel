import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const script=new URL('../../../cmd/main',import.meta.url),helper=new URL('../../../app/server/panel_lifecycle.py',import.meta.url);
test('fnOS entry retains three actions and delegates to scoped lifecycle without broad mutation',()=>{const source=readFileSync(script,'utf8');assert.equal(spawnSync('bash',['-n',script.pathname]).status,0);assert.match(source,/start\|stop\|status/);assert.match(source,/panel_lifecycle\.py/);for(const text of ['pkill','chown -R','chmod 777','rm -f','Started anyway'])assert.ok(!source.includes(text),text);});
test('lifecycle requires peer identity and pidfd rather than naked PID signal',()=>{const source=readFileSync(helper,'utf8');assert.match(source,/SO_PEERCRED/);assert.match(source,/pidfd_send_signal/);assert.match(source,/flock\(lock,fcntl.LOCK_EX\)/);assert.ok(!source.includes('os.kill('));assert.ok(!source.includes('shutil.chown'));});
