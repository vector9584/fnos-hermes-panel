import {spawn} from 'node:child_process';

// Each synthesis owns a new POSIX process group. Cancel only that group, never
// search by executable name: ffmpeg may also belong to unrelated applications.
export function runSpeechProcess(command,args,{signal,timeout=180000,maxBuffer=2*1024*1024,env=process.env}={}){
 return new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(Object.assign(Error('Speech cancelled'),{name:'AbortError'}));return;}
  const grouped=process.platform!=='win32';let child,finished=false,cancelled=false,timedOut=false,overflow=false,stdout='',stderr='',size=0,timer;
  const stop=()=>{if(finished||!child?.pid)return;try{if(grouped)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch(error){if(error.code!=='ESRCH')child.kill('SIGKILL');}};
  const abort=()=>{cancelled=true;stop();};
  const cleanup=()=>{finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);};
  try{child=spawn(command,args,{env,detached:grouped,stdio:['ignore','pipe','pipe']});}catch(error){cleanup();reject(error);return;}
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  timer=setTimeout(()=>{timedOut=true;stop();},timeout);timer.unref?.();
  for(const [stream,key]of [[child.stdout,'stdout'],[child.stderr,'stderr']])stream.on('data',part=>{
   size+=part.length;if(size>maxBuffer){overflow=true;stop();return;}
   if(key==='stdout')stdout+=part.toString();else stderr+=part.toString();
  });
  child.once('error',error=>{stop();cleanup();reject(error);});
  // A script that exits with descendants still holding pipes must not leave
  // those descendants alive, or keep the cancellation slot occupied forever.
  child.once('exit',()=>stop());
  child.once('close',(code)=>{
   if(finished)return;cleanup();
   if(cancelled)reject(Object.assign(Error('Speech cancelled'),{name:'AbortError'}));
   else if(timedOut||overflow||code!==0)reject(Object.assign(Error('Speech synthesis process failed'),{killed:timedOut,code,stderr}));
   else resolve({stdout,stderr});
  });
 });
}
