import {spawnSync} from 'node:child_process';
import * as fs from 'node:fs';
import {join} from 'node:path';

// Exact argv ownership checks. Substrings such as "hermes-agent-copy" or a
// mention of our path in another program's argument never establish ownership.
export function isApplicationService(argv,{hermesBin,venvBin}){
 const index=argv.indexOf(hermesBin);
 if(index>=0&&(index===0||(index===1&&[join(venvBin,'python'),join(venvBin,'python3')].includes(argv[0]))))return argv[index+1]==='dashboard'||(argv[index+1]==='gateway'&&argv[index+2]==='run');
 return [join(venvBin,'python'),join(venvBin,'python3')].includes(argv[0])&&argv[1]==='-m'&&argv[2]==='hermes_cli.main'&&(argv[3]==='dashboard'||argv[3]==='gateway'&&argv[4]==='run');
}
export function inspectServicePortConflicts({ports,hermesBin,venvBin,run=spawnSync,io=fs,proc='/proc'}){
 let result;try{result=run('ss',['-H','-ltnp'],{encoding:'utf8',timeout:3000,maxBuffer:1024*1024});}catch{return ports.map(port=>({port,reason:'inspection_failed'}));}
 if(result.error||result.status!==0)return ports.map(port=>({port,reason:'inspection_failed'}));
 const conflicts=[];
 for(const line of String(result.stdout||'').split('\n')){
  const address=line.trim().split(/\s+/)[3],port=Number(address?.match(/:(\d+)$/)?.[1]);if(!ports.includes(port))continue;
  const ids=[...line.matchAll(/pid=(\d+)/g)].map(m=>Number(m[1]));
  if(!ids.length){conflicts.push({port,reason:'owner_unavailable'});continue;}
  for(const pid of ids){let ours=false;try{ours=isApplicationService(io.readFileSync(join(proc,String(pid),'cmdline'),'utf8').split('\0').filter(Boolean),{hermesBin,venvBin});}catch{}
   if(!ours)conflicts.push({port,pid,reason:'foreign_listener'});
  }
 }
 return conflicts;
}
