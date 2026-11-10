// Read-only authenticated local endpoints. Secrets never leave this process.
import {readFileSync} from 'node:fs';
import {ServiceHealth} from '../../../app/server/panel-service-health.js';
import {createServiceProcesses} from '../../../app/server/panel-service-process.js';
const bin='/vol1/@apphome/hermes-agent/data/venv/bin',root='/vol1/@appdata/hermes-agent';
const processes=createServiceProcesses({hermesBin:bin+'/hermes',venvBin:bin,pidFiles:{gateway:root+'/gateway.pid',dashboard:root+'/dashboard.pid'},signal:()=>{throw Error('probe read-only');}});
const health=new ServiceHealth({gateway:{url:'http://127.0.0.1:8742/health/detailed',token:()=>readFileSync(root+'/monitor.token','utf8').trim()},dashboard:{url:'http://127.0.0.1:9219/api/status',token:()=>readFileSync(root+'/dashboard.token','utf8').trim()},identity:kind=>processes.read(kind)||processes.find(kind)});
console.log(JSON.stringify(await health.refresh()));
