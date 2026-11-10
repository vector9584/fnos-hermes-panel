import {createServiceProcesses} from '../../../app/server/panel-service-process.js';
const bin='/vol1/@apphome/hermes-agent/data/venv/bin',root='/vol1/@appdata/hermes-agent';
const processes=createServiceProcesses({hermesBin:bin+'/hermes',venvBin:bin,pidFiles:{gateway:root+'/gateway.pid',dashboard:root+'/dashboard.pid'},signal:()=>{throw Error('Read-only probe cannot signal');}});
console.log(JSON.stringify(Object.fromEntries(['gateway','dashboard'].map(kind=>[kind,{record_matches:!!processes.read(kind),discovered:!!processes.find(kind)}]))));
