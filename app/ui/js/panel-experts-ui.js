(function(){
 'use strict';
 var page=document.querySelector('#page-experts .page-body'),sequence=0,timer,offset=0,total=0,rows=[],favorites=[],editor=null,editing=null,busy=false;
 function el(tag,text,cls){var n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
 async function request(path,method,body){await fetchToken();var r=await fetch(apiUrl('/api/workspace-ui'+path),{method:method||'GET',headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''},body:body?JSON.stringify(body):undefined});var d=await r.json();if(!r.ok||d.error||d.ok===false)throw Error(d.error||'专家操作失败');return d;}
 function avatar(value){var n=el('span',undefined,'pw-avatar');if(/^\/api\/workspace-ui\/avatars\/[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(value||'')){var img=el('img');img.src=apiUrl(value);img.alt='';n.append(img);}else n.textContent=value||'🧠';return n;}
 page.replaceChildren();
 var header=document.querySelector('#page-experts .page-header');header.replaceChildren(el('h1','专家库'));
 var intro=el('p','专家设定用于会话中的职责与方法，技能和工具由当前环境共享。','page-subtitle');
 var filters=el('div',undefined,'expert-library-filters'),search=el('input'),scene=el('select'),scope=el('select');search.type='search';search.placeholder='搜索名称、专长或分类';search.setAttribute('aria-label','搜索专家');scene.setAttribute('aria-label','专家分类');scope.setAttribute('aria-label','收藏范围');
 [['all','全部专家'],['favorites','收藏的专家']].forEach(function(item){var o=el('option',item[1]);o.value=item[0];scope.append(o);});
 var reset=el('button','刷新','action'),discussion=el('button','组建专家讨论','action primary');discussion.onclick=function(){pwRoom();};filters.append(search,scene,scope,reset);header.append(discussion);
 var feedback=el('div','','maintenance-feedback');feedback.setAttribute('role','status');var grid=el('div',undefined,'expert-library-grid'),more=el('button','加载更多专家','action');more.hidden=true;page.append(intro,filters,feedback,grid,more);
 function keepFilters(){try{localStorage.setItem('panel-expert-filters',JSON.stringify({q:search.value,scene:scene.value,scope:scope.value}));}catch(_){}}
 var saved={};try{saved=JSON.parse(localStorage.getItem('panel-expert-filters')||'{}');}catch(_){}search.value=saved.q||'';scope.value=saved.scope||'all';
 async function load(append){
  var seq=++sequence;feedback.textContent='正在读取专家…';keepFilters();
  try{
   var data=await request('/experts?q='+encodeURIComponent(search.value.trim())+'&scene='+encodeURIComponent(scene.value||saved.scene||'')+'&favorites='+(scope.value==='favorites'?'1':'0')+'&offset='+(append?offset:0)+'&limit=36');
   if(seq!==sequence)return;
   var workspace=await request('');if(seq!==sequence)return;favorites=workspace.favorites||[];
   var chosen=scene.value||saved.scene||'';scene.replaceChildren();var all=el('option','所有分类');all.value='';scene.append(all);data.scenes.forEach(function(s){var o=el('option',s);o.value=s;scene.append(o);});scene.value=chosen;saved={};
   rows=append?rows.concat(data.experts):data.experts;offset=rows.length;total=data.total;draw();feedback.textContent='共 '+total+' 位专家 · 已显示 '+offset+' 位';more.hidden=offset>=total;
  }catch(error){if(seq===sequence){feedback.textContent=error.message;var retry=el('button','重试','action');retry.onclick=function(){load(false);};feedback.append(retry);}}
 }
 function draw(){
  grid.replaceChildren();
  if(!rows.length){grid.append(el('p',scope.value==='favorites'?'还没有匹配的收藏，切换到全部专家选择常用专家。':'没有匹配的专家，试试其他名称或分类。','page-subtitle'));return;}
  rows.forEach(function(e){
   var card=el('article',undefined,'expert-library-card'),head=el('div',undefined,'expert-library-head');head.append(avatar(e.emoji),el('h3',e.name));var favorite=el('button',favorites.includes(e.id)?'★':'☆','expert-favorite');favorite.type='button';favorite.setAttribute('aria-label',favorites.includes(e.id)?'取消收藏':'收藏');favorite.setAttribute('aria-pressed',String(favorites.includes(e.id)));favorite.title=favorites.includes(e.id)?'取消收藏':'收藏';favorite.onclick=async function(){favorite.disabled=true;try{var current=(await request('')).favorites||[];var next=current.includes(e.id)?current.filter(id=>id!==e.id):current.concat(e.id);await request('/preferences','PUT',{favorites:next});await pwWorkspaceRefresh();await load(false);}catch(error){feedback.textContent=error.message;favorite.disabled=false;}};head.append(favorite);card.append(head,el('small',e.scene||'通用'),el('p',e.desc||'查看职责与方法后开始对话。'));
   var actions=el('div',undefined,'expert-library-actions');[['开始对话',function(){pwExpertChat(e.id);}],['查看设定',function(){openEditor(e.id);}],['加入讨论',function(){pwRoom(e.id);}]].forEach(function(item){var button=el('button',item[0],item[0]==='开始对话'?'action primary':'action');button.onclick=item[1];actions.append(button);});card.append(actions);grid.append(card);
  });
 }
 search.oninput=function(){clearTimeout(timer);timer=setTimeout(()=>load(false),200);};scene.onchange=scope.onchange=function(){saved={};load(false);};reset.onclick=function(){load(false);};more.onclick=function(){load(true);};
 window.renderExpertsPage=window.refreshExperts=window.renderBuiltinExperts=window.renderMineExperts=function(){return load(false);};
 function field(label,name,value,multiline){var l=el('label',undefined,'expert-editor-field');l.append(el('span',label));var input=el(multiline?'textarea':'input');input.name=name;if(multiline)input.rows=name==='prompt'?10:4;input.value=value||'';l.append(input);return l;}
 function values(){var result={};['name','desc','scene','prompt'].forEach(function(key){result[key]=editor.querySelector('[name='+key+']').value;});result.emoji=editor.querySelector('[name=emoji]').value;result.quick_prompts=editor.querySelector('[name=quick_prompts]').value.split('\n').map(x=>x.trim()).filter(Boolean);return result;}
 function draftKey(){return 'panel-expert-draft:'+editing.id;}
 function saveDraft(){if(editor&&editing)try{localStorage.setItem(draftKey(),JSON.stringify({revision:editing.revision,values:values()}));}catch(_){editor.querySelector('.expert-editor-feedback').textContent='浏览器无法保存草稿，请保持窗口打开。';}}
 function close(){if(!editor||busy)return;saveDraft();editor.close();editor.remove();editor=null;editing=null;}
 function lock(value){busy=value;editor.querySelectorAll('button,input,textarea').forEach(n=>n.disabled=value);}
 async function openEditor(id,discard){
  if(busy)return;if(editor)close();
  try{
   var e=(await request('/experts/'+encodeURIComponent(id))).expert;editing=e;var draft=null;
   if(discard)localStorage.removeItem(draftKey());else try{draft=JSON.parse(localStorage.getItem(draftKey())||'null');}catch(_){}
   if(draft)editing={...e,revision:draft.revision};var initial=draft?.values||e;
   editor=el('dialog',undefined,'panel-connector-dialog expert-editor');editor.setAttribute('aria-label','专家设定');var head=el('div',undefined,'modal-head'),x=el('button','×','modal-close');x.setAttribute('aria-label','关闭');x.onclick=close;head.append(el('h3','专家设定'),x);
   var form=el('form'),body=el('div',undefined,'modal-body');body.append(field('名称','name',initial.name),field('简介','desc',initial.desc),field('分类','scene',initial.scene));
   var avatarBox=el('div',undefined,'expert-avatar-field'),image=avatar(initial.emoji),file=el('input'),hidden=el('input');file.type='file';file.accept='image/png,image/jpeg,image/gif,image/webp';file.setAttribute('aria-label','上传专家头像');hidden.type='hidden';hidden.name='emoji';hidden.value=initial.emoji;avatarBox.append(image,file,hidden);body.append(avatarBox);
   body.append(field('职责与方法','prompt',initial.prompt,true),field('快速提问（每行一个）','quick_prompts',(initial.quick_prompts||[]).join('\n'),true),el('p','保存后用于新选择的专家；已有会话、排队消息和讨论成员保留各自快照。'));
   var status=el('div',draft?'已恢复未保存的设定':'','expert-editor-feedback');status.setAttribute('role','status');body.append(status);
   var foot=el('div',undefined,'modal-foot'),reset=el('button','丢弃草稿并读取最新','action'),undo=el('button','撤销上次修改','action'),save=el('button','保存设定','action primary');reset.type=undo.type='button';undo.hidden=!e.can_undo;save.type='submit';foot.append(reset,undo,save);form.append(body,foot);editor.append(head,form);document.body.append(editor);
   editor.addEventListener('cancel',function(event){event.preventDefault();close();});form.oninput=saveDraft;
   file.onchange=async function(){var chosen=this.files[0];if(!chosen)return;lock(true);status.textContent='正在处理头像…';try{
    if(chosen.size>2*1024*1024)throw Error('头像不得超过 2 MB');var data=new FormData();if(chosen.type==='image/gif')data.append('file',chosen,chosen.name||'avatar.gif');else{if(!['image/png','image/jpeg','image/webp'].includes(chosen.type))throw Error('请选择 PNG、JPEG、GIF 或 WebP 图片');var bitmap=await createImageBitmap(chosen),canvas=document.createElement('canvas');canvas.width=canvas.height=256;var side=Math.min(bitmap.width,bitmap.height);canvas.getContext('2d').drawImage(bitmap,(bitmap.width-side)/2,(bitmap.height-side)/2,side,side,0,0,256,256);bitmap.close();var blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));data.append('file',blob,'avatar.png');}var response=await fetch(apiUrl('/api/workspace-ui/avatars'),{method:'POST',headers:{'X-Monitor-Token':monitorToken||''},body:data}),result=await response.json();if(!response.ok||!result.ok)throw Error(result.error||'头像上传失败');hidden.value=result.url;image.replaceWith(image=avatar(result.url));saveDraft();status.textContent='头像已加入草稿';
   }catch(error){status.textContent=error.message;}finally{lock(false);}};
   reset.onclick=async function(){if(!confirm('丢弃本次未保存设定并读取最新版本？'))return;close();await openEditor(id,true);};
   undo.onclick=async function(){if(!confirm('撤销此专家上次保存的修改？当前输入会被替换，已有会话快照不变。'))return;lock(true);try{await request('/experts/'+encodeURIComponent(id)+'/undo','POST',{revision:editing.revision});lock(false);close();await openEditor(id,true);load(false);}catch(error){status.textContent=error.message;lock(false);}};
   form.onsubmit=async function(event){event.preventDefault();if(busy)return;saveDraft();var changes=values();lock(true);status.textContent='正在保存…';try{await request('/experts/'+encodeURIComponent(id),'PUT',{...changes,revision:editing.revision});localStorage.removeItem(draftKey());editor.close();editor.remove();editor=null;editing=null;feedback.textContent='专家设定已保存';load(false);}catch(error){status.textContent=error.message+'；输入已保留。';}finally{if(editor)lock(false);else busy=false;}};
   editor.showModal();
  }catch(error){feedback.textContent=error.message;}
 }
 window.openBuiltinExpertEditor=openEditor;
 // The duplicate capability tab routes into the single expert library.
 var originalExt=window.extSwitchTab;window.extSwitchTab=function(button,key){if(key==='experts'){switchPage('experts');return;}return originalExt(button,key);};
 document.querySelector('#extTabs [onclick*="\'experts\'"]')?.remove();document.getElementById('ext-experts')?.remove();
}());
