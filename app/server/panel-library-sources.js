import * as fs from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {stateError} from './panel-state.js';
function weigh(root,files){
  let total=0;
  (files||[]).forEach(function(name){try{total+=fs.statSync(join(root,name)).size;}catch(_){}});
  return total;
}
export function createLibrarySources(data){
 return ()=>{
  let profile=data,profileName='默认环境';
  const active=join(data,'.active_profile');if(fs.existsSync(active)){const name=fs.readFileSync(active,'utf8').trim();if(name&&name!=='default'){
   if(!/^[a-zA-Z0-9_-]{1,100}$/.test(name))throw stateError('当前环境标识无法识别，请先检查配置',503);profile=join(data,'profiles',name);profileName=name;
   if(!fs.existsSync(profile)||!fs.statSync(profile).isDirectory())throw stateError('当前环境目录不存在，请检查配置',503);
   if(!fs.realpathSync(profile).startsWith(fs.realpathSync(join(data,'profiles'))+sep))throw stateError('当前环境目录超出profiles范围',403);
  }}
  let knowledge=join(data,'knowledge');const env=join(data,'.env');if(fs.existsSync(env)){
   const line=fs.readFileSync(env,'utf8').match(/^\s*(?:export\s+)?OBSIDIAN_VAULT_PATH\s*=\s*(.*)$/m);
   if(line){let value=line[1].trim();if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);else value=value.replace(/\s+#.*$/,'').trim();if(value)knowledge=resolve(data,value);}
  }
  // group: assistant=它是什么 / material=它知道什么 / records=它做过什么(只读) / knowledge=知识库
  // injected: full=每轮全文注入 / index=只注入目录索引 / none=不自动进上下文
  // indexed: 助手有没有可检索的目录（有索引才找得到）
  // applyAt: newSession=新会话生效 / nextSession=下一次会话生效 / never=不生效
  const sources=[
   {id:'soul',name:'人格',root:profile,files:['SOUL.md'],editable:true,group:'assistant',profile:profileName,injected:'full',indexed:true,applyAt:'newSession',description:'持久身份与行为准则，每轮对话全文注入。保存后在新会话中加载，已开始的会话保留原设定。'},
   {id:'memory',name:'长期记忆',root:join(profile,'memories'),files:['MEMORY.md','USER.md'],editable:true,group:'assistant',profile:profileName,injected:'full',indexed:true,applyAt:'nextSession',description:'助手读取和维护的长期事实及用户偏好，每轮全文注入但有字数上限，会话开始时冻结。保存时会检测内核同时修改造成的冲突。'},
   {id:'agents',name:'项目指令',root:profile,files:['AGENTS.md'],editable:true,group:'assistant',profile:profileName,injected:'full',indexed:true,applyAt:'newSession',description:'AGENTS.md：按当前工作目录加载的项目规则，与人格同级每轮全文注入。换工作目录会换一份，没有则不加。'},
   {id:'skills',name:'技能说明书',root:join(profile,'skills'),pattern:/\/SKILL\.md$/i,editable:true,group:'assistant',profile:profileName,injected:'index',indexed:true,applyAt:'newSession',description:'助手按需加载的可复用流程手册。每个技能一份 SKILL.md，改动会直接影响下一次调用，请只改自己清楚后果的部分。'},
   {id:'notes',name:'共享笔记',root:data,files:['notes.md'],editable:true,group:'material',injected:'none',indexed:true,applyAt:'never',description:'跨会话共享的速记。不会自动进入上下文，要靠助手按约定主动翻。'},
   {id:'daily',name:'运行日记',root:join(profile,'memory'),pattern:/^\d{4}-\d{2}-\d{2}\.md$/,editable:false,group:'records',profile:profileName,injected:'none',indexed:false,applyAt:'never',description:'按日期归档的运行记录，只读。不自动进入上下文，需要时按日期去翻。'},
   {id:'organize',name:'整理记录',root:join(profile,'memory'),pattern:/^(?:dreams|evolution).*\.(md|txt|json)$/i,editable:false,group:'records',profile:profileName,injected:'none',indexed:false,applyAt:'never',description:'保留旧记忆整理和反思记录，只读，不代表它们正在自动运行。'},
   {id:'curator',name:'维护报告',root:join(profile,'logs/curator'),editable:false,group:'records',profile:profileName,injected:'none',indexed:false,applyAt:'never',description:'技能维护的原始报告，只读。查看具体操作和结果，不将文件存在等同于已成功执行。'},
   {id:'knowledge',name:'知识库',root:knowledge,editable:true,group:'knowledge',injected:'none',indexed:true,applyAt:'never',description:'你保存的文档与手动整理的对话资料。不会自动复制长期记忆，也不会自动进入上下文。'},
  ];
  return sources.map(function(item){return Object.assign({},item,{volume:weigh(item.root,item.files)});});
 };
}
