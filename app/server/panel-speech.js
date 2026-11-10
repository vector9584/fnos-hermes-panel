import {mkdtempSync,writeFileSync,readFileSync,rmSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runSpeechProcess} from './panel-speech-process.js';
import {randomUUID} from 'node:crypto';
import {stateError} from './panel-state.js';
const idPattern=/^[a-zA-Z0-9_-]{8,100}$/;
export function createSpeechService({data,voice,windowsCurrent,execute=runSpeechProcess,temp=tmpdir(),now=Date.now,maxAudio=32*1024*1024}){
 const active=new Map(),cancelled=new Map();
 function sweep(){for(const [id,at]of cancelled)if(now()-at>180000)cancelled.delete(id);}
 function cancel(id){if(!idPattern.test(id||''))throw stateError('朗读请求编号不正确');sweep();if(cancelled.size>=1000)throw stateError('取消请求过多，请稍后重试',429);cancelled.set(id,now());active.get(id)?.abort();return {ok:true,cancelled:true};}
 async function synthesize(body,engine,signal){
  const text=typeof body?.text==='string'?body.text.trim():'';const id=body?.request_id||randomUUID();
  if(!idPattern.test(id)||!['windows','system'].includes(engine))throw stateError('朗读请求格式不正确');
  if(!text||text.length>(engine==='windows'?16000:60000))throw stateError(engine==='windows'?'Windows朗读需要1到16000字，请分段朗读':'系统朗读需要1到60000字',413);
  sweep();if(cancelled.has(id)||signal?.aborted)throw stateError('朗读已取消',499);
  if(active.size)throw stateError('语音正在合成，请停止当前朗读后重试',429);
  const controller=new AbortController(),abort=()=>controller.abort();active.set(id,controller);signal?.addEventListener('abort',abort,{once:true});let dir;
  try{
   dir=mkdtempSync(join(temp,'hermes-panel-speech-'));const input=join(dir,'text.txt'),output=join(dir,'speech.mp3');writeFileSync(input,text,{mode:0o600});
   if(engine==='windows'){
    const current=await windowsCurrent(controller.signal);controller.signal.throwIfAborted();
    await execute(join(data,'venv/bin/python3'),[join(data,'scripts/tts_windows.py'),input,output],{timeout:180000,maxBuffer:2*1024*1024,signal:controller.signal,killSignal:'SIGKILL',env:{...process.env,WINDOWS_TTS_TIMEOUT:'150',WINDOWS_TTS_EMO_AUTO:current?.emo_auto===false?'0':'1'}});
   }else{
    const selected=body.voice||voice().system_voice||'zh-CN-XiaoxiaoNeural';
    if(!/^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/.test(selected))throw stateError('系统音色配置不正确');
    const script='import asyncio,edge_tts,sys\nfrom pathlib import Path\nasyncio.run(edge_tts.Communicate(Path(sys.argv[1]).read_text(),sys.argv[3]).save(sys.argv[2]))';
    await execute(join(data,'venv/bin/python3'),['-c',script,input,output,selected],{timeout:90000,maxBuffer:1024*1024,signal:controller.signal,killSignal:'SIGKILL'});
   }
   controller.signal.throwIfAborted();const stat=statSync(output);if(!stat.isFile()||stat.size<100||stat.size>maxAudio)throw stateError('语音合成结果为空或超过大小限制',502);
   // Both providers promise MP3. Decode it before publishing success; file size
   // alone also accepts HTML errors or truncated audio. Restrict the demuxer so
   // an upstream payload cannot become a playlist with external references.
   try{await execute('ffmpeg',['-nostdin','-v','error','-xerror','-protocol_whitelist','file,pipe','-f','mp3','-i',output,'-map','0:a:0','-f','null','-'],{timeout:30000,maxBuffer:1024*1024,signal:controller.signal});}
   catch(error){if(controller.signal.aborted||error.name==='AbortError')throw error;throw stateError('语音合成结果无法解码，请重试或切换语音服务',502);}
   controller.signal.throwIfAborted();
   const audio=readFileSync(output);return new Response(audio,{headers:{'Content-Type':'audio/mpeg','Cache-Control':'no-store','X-Speech-Engine':engine==='windows'?'windows':'edge','X-Speech-Request':id}});
  }catch(error){
   if(controller.signal.aborted||error.name==='AbortError')throw stateError('朗读已取消',499);
   if(error.status)throw error;
   const status=String(error.stderr||'').match(/TTS 服务 HTTP (\d{3})/);
   throw stateError(status?'Windows合成服务返回 HTTP '+status[1]:error.killed?'语音合成超时，请稍后重试':(engine==='windows'?'Windows':'系统')+'语音合成失败，请检查语音服务',502);
  }finally{signal?.removeEventListener('abort',abort);active.delete(id);if(dir)rmSync(dir,{recursive:true,force:true});}
 }
 return {synthesize,cancel};
}
