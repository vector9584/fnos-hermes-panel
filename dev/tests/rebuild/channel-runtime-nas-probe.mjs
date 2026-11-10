// Read-only production observation. Output is intentionally limited to the
// same sanitized status fields shown to an authenticated panel user.
import * as fs from 'node:fs';
const {readFileSync}=fs;
import {createChannelRuntime} from '../../../app/server/panel-channel-runtime.js';
const home='/vol1/@apphome/hermes-agent/data';
const observe=createChannelRuntime({home,io:new Proxy(fs,{get(target,key){const value=target[key];if(typeof value!=='function')return value;return (...args)=>{try{return value(...args);}catch(error){console.error(JSON.stringify({operation:key,file:typeof args[0]==='string'?args[0].split('/').pop():null,code:error.code}));throw error;}};}}),hermesBin:home+'/venv/bin/hermes',gatewayPid:()=>{try{return Number(readFileSync('/vol1/@appdata/hermes-agent/gateway.pid','utf8').trim());}catch(error){console.error(JSON.stringify({operation:'monitor-pid',code:error.code}));throw error;}}});
console.log(JSON.stringify(observe()));
