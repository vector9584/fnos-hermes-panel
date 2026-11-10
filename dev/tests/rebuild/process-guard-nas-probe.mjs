import {inspectServicePortConflicts} from '../../../app/server/panel-process-guard.js';
const bin='/vol1/@apphome/hermes-agent/data/venv/bin';
console.log(JSON.stringify({conflicts:inspectServicePortConflicts({ports:[8742,9219],hermesBin:bin+'/hermes',venvBin:bin})}));
