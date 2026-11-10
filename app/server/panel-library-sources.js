import * as fs from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {stateError} from './panel-state.js';
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
  return [
   {id:'knowledge',name:'知识库',root:knowledge,editable:true,group:'knowledge',description:'你保存的文档与手动整理的对话资料。不会自动复制长期记忆。'},
   {id:'soul',name:'身份与行为',root:profile,files:['SOUL.md'],editable:true,group:'memory',profile:profileName,description:'持久身份与行为准则。保存后在新会话中加载，已开始的会话保留原设定。'},
   {id:'memory',name:'长期记忆',root:join(profile,'memories'),files:['MEMORY.md','USER.md'],editable:true,group:'memory',profile:profileName,description:'助手读取和维护的长期事实及用户偏好。保存时会检测内核同时修改造成的冲突。'},
   {id:'notes',name:'共享笔记',root:data,files:['notes.md'],editable:true,group:'memory',description:'全局笔记，供不同会话共同参考。'},
   {id:'daily',name:'运行日记',root:join(profile,'memory'),pattern:/^\d{4}-\d{2}-\d{2}\.md$/,editable:false,group:'records',profile:profileName,description:'读取已有日期记录。旧讨论曾自动追加片段；现有讨论以完整会话记录为准，不把片段称为自动总结。'},
   {id:'organize',name:'历史整理记录',root:join(profile,'memory'),pattern:/^(?:dreams|evolution).*\.(md|txt|json)$/i,editable:false,group:'records',profile:profileName,description:'保留旧记忆整理和反思记录，不代表它们正在自动运行。'},
   {id:'curator',name:'技能维护报告',root:join(profile,'logs/curator'),editable:false,group:'records',profile:profileName,description:'内核Curator的原始报告。查看具体操作和结果，不将文件存在等同于已成功执行。'},
  ];
 };
}
