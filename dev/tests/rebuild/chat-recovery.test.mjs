import test from 'node:test';
import assert from 'node:assert/strict';
import {interruptAssistantMessage,recoverInterruptedAssistantMessage} from '../../../app/server/panel-chat-recovery.js';

test('interrupted assistant turns retain completed tools and mark only live tools',()=>{
  const message={role:'assistant',content:'已经检查了一部分',_streaming:true,_streamId:'s1',ts:1,tools:[
    {tool:'read_file',status:'completed',result:'保留'},
    {tool:'terminal',status:'running',running:true},
    {tool:'search',status:'failed',result:'失败原因'},
  ]};
  assert.equal(interruptAssistantMessage(message,{now:()=>42}),true);
  assert.equal(message._streaming,undefined);assert.equal(message._streamId,undefined);
  assert.equal(message.queue_status,'interrupted');assert.equal(message.ts,42);
  assert.equal(message.tools[0].status,'completed');assert.equal(message.tools[1].status,'interrupted');
  assert.equal(message.tools[1].running,false);assert.equal(message.tools[2].status,'failed');
  assert.match(message.content,/被打断/);
});

test('blank interrupted turns get visible recovery text and do not mutate non-assistant messages',()=>{
  const message={role:'assistant',content:'开始处理…',_streaming:true,tools:[]};
  assert.equal(interruptAssistantMessage(message,{now:()=>9,phrase:'中断说明'}),true);
  assert.equal(message.content,'中断说明');
  const user={role:'user',content:'原文'};
  assert.equal(interruptAssistantMessage(user),false);assert.deepEqual(user,{role:'user',content:'原文'});
});

test('interruption merges the durable queue tool checkpoint before marking live tools',()=>{
  const message={role:'assistant',content:'已开始',_streaming:true,tools:[
    {tool:'read_file',toolCallId:'read-1',status:'completed',result:'旧检查点'},
  ]};
  assert.equal(interruptAssistantMessage(message,{now:()=>10,tools:[
    {tool:'read_file',toolCallId:'read-1',status:'completed',result:'最终结果'},
    {tool:'terminal',toolCallId:'run-1',status:'running',running:true},
  ]}),true);
  assert.equal(message.tools.length,2);
  assert.equal(message.tools[0].result,'最终结果');
  assert.equal(message.tools[1].status,'interrupted');
  assert.equal(message.tools[1].running,false);
});

test('recovery creates a visible assistant turn when only the request user message was saved',()=>{
  const session={messages:[{role:'user',request_id:'req-1',content:'检查服务'}]};
  const message=recoverInterruptedAssistantMessage(session,{id:'req-1',result:{reply:'已检查一部分',tools:[{tool:'terminal',status:'running'}]}},{now:()=>21});
  assert.equal(message.request_id,'req-1');
  assert.equal(message.queue_status,'interrupted');
  assert.match(message.content,/已检查一部分/);
  assert.equal(message.tools[0].status,'interrupted');
  assert.equal(session.messages.length,2);
});

test('recovery replaces an assistant placeholder with the latest durable partial reply',()=>{
  const session={messages:[
    {role:'user',request_id:'req-2',content:'检查'},
    {role:'assistant',request_id:'req-2',content:'开始处理…',_streaming:true,tools:[]},
  ]};
  const message=recoverInterruptedAssistantMessage(session,{id:'req-2',result:{reply:'队列中保存的部分回复',tools:[]}},{now:()=>22});
  assert.match(message.content,/队列中保存的部分回复/);
  assert.match(message.content,/被打断/);
  assert.equal(session.messages.length,2);
});

test('recovery never downgrades a completed transcript tool from an older queue checkpoint',()=>{
  const message={role:'assistant',content:'已完成',tools:[
    {tool:'terminal',toolCallId:'run-3',status:'completed',result:'保留的最终结果'},
  ]};
  assert.equal(interruptAssistantMessage(message,{tools:[
    {tool:'terminal',toolCallId:'run-3',status:'running'},
  ]}),true);
  assert.equal(message.tools[0].status,'completed');
  assert.equal(message.tools[0].result,'保留的最终结果');
});
