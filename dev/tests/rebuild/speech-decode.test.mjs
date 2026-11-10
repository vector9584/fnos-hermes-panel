import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createSpeechService} from '../../../app/server/panel-speech.js';
import {runSpeechProcess} from '../../../app/server/panel-speech-process.js';
const available=spawnSync('ffmpeg',['-version'],{stdio:'ignore'}).status===0;
test('actual decoder accepts MP3 and rejects HTML or broken audio from either provider',{skip:!available},async t=>{
 const root=fs.mkdtempSync(join(tmpdir(),'speech-decode-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const good=join(root,'valid.mp3');await runSpeechProcess('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','sine=frequency=440:duration=0.2','-c:a','libmp3lame',good]);const mp3=fs.readFileSync(good);fs.unlinkSync(good);
 let payload=mp3;const service=createSpeechService({data:'/fixture',temp:root,voice:()=>({system_voice:'zh-CN-XiaoxiaoNeural'}),windowsCurrent:async()=>({emo_auto:false}),execute:async(command,args,options)=>{if(command==='ffmpeg')return runSpeechProcess(command,args,options);fs.writeFileSync(args[0]==='-c'?args[3]:args[2],payload);}});
 for(const engine of ['windows','system']){
  payload=mp3;const response=await service.synthesize({text:'fixture'},engine);assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),mp3);assert.deepEqual(fs.readdirSync(root),[]);
  for(const bad of [Buffer.from('<html>upstream error</html>'.repeat(10)),Buffer.alloc(500,1)]){payload=bad;await assert.rejects(service.synthesize({text:'fixture'},engine),e=>e.status===502&&e.message.includes('无法解码'));assert.deepEqual(fs.readdirSync(root),[]);}
 }
});
