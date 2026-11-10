(function(){
 'use strict';
 // The live copy is the upload source. Browser storage is a recovery copy,
 // never a prerequisite for sending the current text to the server.
 var live=new Map(),pending=new Map(),database;
 function db(){
  if(!database)database=new Promise((resolve,reject)=>{
   var request=indexedDB.open('hermes-library-drafts',1);
   request.onupgradeneeded=()=>request.result.createObjectStore('drafts');
   request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
   request.onblocked=()=>reject(Error('草稿存储被其他页面占用'));
  }).catch(error=>{database=null;throw error;});
  return database;
 }
 async function stored(key,record){
  var database=await db();
  return new Promise((resolve,reject)=>{
   var write=arguments.length>1,tx=database.transaction('drafts',write?'readwrite':'readonly'),store=tx.objectStore('drafts');
   var request=write?store.put(record,key):store.get(key);
   tx.oncomplete=()=>resolve(request.result);tx.onerror=tx.onabort=()=>reject(tx.error||Error('草稿存储失败'));
  });
 }
 function local(key){try{return JSON.parse(localStorage.getItem(key)||'null');}catch(_){return null;}}
 function stamp(record){return record?.saved_at||0;}
 async function read(key){
  if(live.has(key))return live.get(key).value;
  var value=local(key),disk=null;
  try{disk=await stored(key);}catch(_){}
  if(live.has(key))return live.get(key).value;
  if(disk&&stamp(disk)>=stamp(value))value=disk;
  if(value?.deleted)value=null;
  live.set(key,{value,durable:true});return value;
 }
 function write(key,value){
  var previous=live.get(key)?.value;
  var record={...(value||{deleted:true}),saved_at:Math.max(Date.now(),stamp(previous)+1)},entry={value:value?record:null,durable:false};
  live.set(key,entry);
  try{localStorage.setItem(key,JSON.stringify(record));entry.durable=true;}catch(_){}
  var task=(pending.get(key)||Promise.resolve()).then(()=>stored(key,record)).then(()=>{entry.durable=true;return true;},()=>entry.durable);
  pending.set(key,task);task.finally(()=>{if(pending.get(key)===task)pending.delete(key);});
  return task;
 }
 window.PanelLibraryDrafts={read,write,ack:(key,text)=>{var entry=live.get(key);if(entry?.value?.text===text)entry.durable=true;},peek:key=>live.has(key)?live.get(key).value:local(key),durable:key=>live.get(key)?.durable===true};
 window.addEventListener('beforeunload',event=>{
  if([...live.values()].some(entry=>entry.value?.dirty&&!entry.durable)){event.preventDefault();event.returnValue='';}
 });
}());
