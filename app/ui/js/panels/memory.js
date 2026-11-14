/* 记忆页面
 * 来源：index.html 内联 app.js 第 7656-7688 行（共 33 行）
 * 2026-11-13 按原分区纯搬运外移，逻辑零改动。全局作用域与执行顺序与原内联块一致。 */
/* ============================ 记忆页面 ============================ */
var _memData = { soul:'', memory:'', notes:'' };
function renderMemoryPage(){
  apiGet('/api/memory?profile='+encodeURIComponent(_activeProfileId())).then(function(res){
    if(!res || !res.ok){ toast('加载记忆失败','error'); return; }
    _memData = { soul: res.soul||'', memory: res.memory||'', notes: res.notes||'' };
    var el;
    el=document.getElementById('memSoul'); if(el) el.value=_memData.soul;
    el=document.getElementById('memMemory'); if(el) el.value=_memData.memory;
    el=document.getElementById('memNotes'); if(el) el.value=_memData.notes;
  }).catch(function(e){ toast('网络错误','error'); });
}
function saveMemoryField(field){
  var elId = field==='soul'?'memSoul':field==='memory'?'memMemory':'memNotes';
  var el = document.getElementById(elId); if(!el) return;
  var payload = {}; payload[field] = el.value; payload.profile = _activeProfileId();
  fetch(apiUrl('/api/memory'), { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) })
    .then(function(r){ return r.json(); })
    .then(function(res){ if(res.ok) toast('✅ '+field+' 已保存'); else toast(res.error||'保存失败','error'); })
    .catch(function(e){ toast('网络错误','error'); });
}
function saveAllMemory(){
  var payload = {
    soul: (document.getElementById('memSoul')||{}).value||'',
    memory: (document.getElementById('memMemory')||{}).value||'',
    notes: (document.getElementById('memNotes')||{}).value||'',
    profile: _activeProfileId()
  };
  fetch(apiUrl('/api/memory'), { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) })
    .then(function(r){ return r.json(); })
    .then(function(res){ if(res.ok) toast('✅ 全部记忆已保存'); else toast(res.error||'保存失败','error'); })
    .catch(function(e){ toast('网络错误','error'); });
}