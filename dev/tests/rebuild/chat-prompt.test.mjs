import test from 'node:test';
import assert from 'node:assert/strict';
import {UI_CAPABILITIES_PROMPT, buildChatHistory} from '../../../app/server/panel-chat-prompt.js';

test('web chat system guidance describes rendering without claiming tools or host permissions',()=>{
  assert.match(UI_CAPABILITIES_PROMPT,/完整 GFM Markdown/);
  assert.match(UI_CAPABILITIES_PROMPT,/\[qr\]/);
  assert.match(UI_CAPABILITIES_PROMPT,/MEDIA:/);
  assert.doesNotMatch(UI_CAPABILITIES_PROMPT,/预授权|yolo|需要批准|hermes-dev\.sh restart|用 stat|定期.*总结/);
});

test('provider history receives exactly one system message and retains the opening user request',()=>{
  const messages=[{role:'user',content:'初始目标'},...Array.from({length:205},(_,index)=>({role:index%2?'assistant':'user',content:String(index)}))];
  const history=buildChatHistory({messages},'SOUL\n\n专家\n\n表达风格');
  assert.equal(history[0].role,'system');
  assert.equal(history[0].content,'SOUL\n\n专家\n\n表达风格');
  assert.equal(history.filter(message=>message.role==='system').length,1);
  assert.equal(history[1].content,'初始目标');
  assert.equal(history.length,202);
});
