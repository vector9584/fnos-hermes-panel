// Small, dependency-free compatibility UI for the shipped native config editor.
export function configError(error){
 const raw=String(error?.message||error);const match=raw.match(/^\d{3}:\s*([\s\S]*)$/);
 if(match){try{return new Error(JSON.parse(match[1]).detail||'配置保存失败，请重试');}catch{}}
 return error instanceof Error?error:new Error(raw);
}
export async function reviewConfig(error,{draft,latest,raw=false}){
 if(!/^409:/.test(String(error?.message||error)))throw configError(error);
 const failure=configError(error);let current;
 try{current=await latest();}catch{throw new Error('最新配置读取失败，当前输入已保留，请稍后重试');}
 return new Promise((resolve,reject)=>{
  const prior=document.activeElement;const dialog=document.createElement('dialog');dialog.className='panel-config-review';dialog.setAttribute('aria-labelledby','panel-config-review-title');
  const style=document.createElement('style');style.textContent=`.panel-config-review{box-sizing:border-box;margin:auto;width:min(960px,calc(100vw - 24px));max-height:calc(100dvh - 24px);padding:22px;border:1px solid #465163;border-radius:12px;background:#151b25;color:#edf2fa;font:14px/1.6 system-ui;overflow:auto}.panel-config-review::backdrop{background:#000a}.panel-config-review h2{margin:0 0 8px;font-size:19px}.panel-config-review p{margin:8px 0;color:#bcc8d8}.panel-config-review .compare{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:16px 0}.panel-config-review textarea{box-sizing:border-box;width:100%;min-height:230px;max-height:40dvh;resize:vertical;background:#0e141d;color:#edf2fa;border:1px solid #465163;border-radius:6px;padding:10px;font:12px/1.5 ui-monospace,monospace;white-space:pre;overflow:auto}.panel-config-review footer{display:flex;flex-wrap:wrap;gap:10px;justify-content:flex-end}.panel-config-review button{min-height:44px;padding:8px 14px;border:1px solid #52637a;border-radius:7px;background:#223047;color:#edf2fa;cursor:pointer}.panel-config-review button:focus-visible,.panel-config-review textarea:focus-visible{outline:2px solid #9ebfff;outline-offset:2px}@media(max-width:600px){.panel-config-review{padding:16px}.panel-config-review .compare{grid-template-columns:1fr}.panel-config-review textarea{min-height:130px;max-height:23dvh}.panel-config-review footer button{width:100%}}`;
  function node(tag,text,parent=dialog){const el=document.createElement(tag);if(text)el.textContent=text;parent.appendChild(el);return el;}
  dialog.appendChild(style);node('h2','配置已在别处修改').id='panel-config-review-title';node('p','当前输入尚未保存。对照最新配置后，可以返回继续编辑，或明确采用最新版本再保存。');
  const compare=node('div');compare.className='compare';
  const clean=value=>JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key])=>key!=='_panel_revision')),null,2);
  for(const [title,text] of [['当前输入',raw?draft:clean(draft)],['最新已保存配置',raw?current.yaml:clean(current)]]){const column=node('label',title,compare);const area=node('textarea',null,column);area.readOnly=true;area.value=text;area.setAttribute('aria-label',title);}
  node('p',raw?'采用最新版本后再次保存，将以当前输入替换整份 YAML。请先把需要保留的新字段合入当前输入。':'采用最新版本后再次保存，当前表单里的字段将按你的输入写入。请先核对两侧的差异。');
  const footer=node('footer');const back=node('button','返回继续编辑',footer);const adopt=node('button','已核对，采用最新版本',footer);
  function finish(revision){dialog.close();dialog.remove();prior?.focus?.();if(revision){failure.message='已保留输入并采用最新版本，请再次点击保存';failure.panelRevision=revision;}reject(failure);}
  back.onclick=()=>finish();adopt.onclick=()=>finish(raw?current.revision:current._panel_revision);dialog.addEventListener('cancel',e=>{e.preventDefault();finish();});document.body.appendChild(dialog);dialog.showModal();back.focus();
 });
}
