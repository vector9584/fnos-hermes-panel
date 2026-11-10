import {stateError} from './panel-state.js';
// dotenv grammar used by native python-dotenv. Does not expand ${...}: native
// runtime expansion still owns that step. Never include input in diagnostics.
export function parseEnv(text){
 text=String(text).replace(/^\uFEFF/,'');const bindings=[],values=Object.create(null);let position=0;
 const fail=()=>{throw stateError('凭证文件第 '+(text.slice(0,position).split('\n').length)+' 行无法解析，原文件已保留',503);};
 while(position<text.length){
  const start=position;
  const take=expression=>{const match=text.slice(position).match(expression);if(match){position+=match[0].length;return match[0];}return '';};
  take(/^[ \t]*/);let key=null,value=null;
  if(text[position]==='#')take(/^[^\r\n]*/);
  else if(position<text.length&&!/[\r\n]/.test(text[position])){
   take(/^export[ \t]+/);key=take(/^[A-Za-z_][A-Za-z0-9_]*/);if(!key)fail();take(/^[ \t]*/);
   if(text[position]==='='){
    position++;take(/^[ \t]*/);const quote=text[position];
    if(quote==='"'||quote==="'"){
     position++;let content='',closed=false;
     while(position<text.length){const char=text[position++];if(char===quote){closed=true;break;}if(char==='\\'&&position<text.length){content+=char+text[position++];}else content+=char;}
     if(!closed)fail();
     const escapes={'\\':'\\',"'":"'",'"':'"',a:'\x07',b:'\b',f:'\f',n:'\n',r:'\r',t:'\t',v:'\v'};
     value=content.replace(quote==='"'?/\\([\\'"abfnrtv])/g:/\\([\\'])/g,(_,char)=>escapes[char]);take(/^[ \t]*/);if(text[position]==='#')take(/^[^\r\n]*/);
    }else value=take(/^[^\r\n]*/).replace(/[ \t]+#.*/,'').trimEnd();
   }else if(text[position]==='#')take(/^[^\r\n]*/);
   if(position<text.length&&!/[\r\n]/.test(text[position]))fail();values[key]=value;
  }
  take(/^(?:\r\n|\n|\r)/);if(start===position)fail();bindings.push({key,value,original:text.slice(start,position)});
 }
 return {bindings,values};
}
export function envValue(text,key){return parseEnv(text).values[key]??'';}
export function setEnvValue(text,key,value){
 if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)||typeof value!=='string'||/[\r\n\0]/.test(value))throw stateError('凭证变量名或单行值不正确');
 const line=key+'="'+value.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"\n';const {bindings}=parseEnv(text);let seen=false,out='';
 for(const binding of bindings){if(binding.key===key){if(!seen)out+=line;seen=true;}else out+=binding.original;}
 if(!seen)out+=(out&&!/[\r\n]$/.test(out)?'\n':'')+line;return out;
}
