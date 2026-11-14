/* 扩展页（技能/MCP/插件）
 * 来源：index.html 内联 app.js 第 6216-7547 行（共 1332 行）
 * 2026-11-13 按原分区纯搬运外移，逻辑零改动。全局作用域与执行顺序与原内联块一致。 */

/* ============================ 扩展 ============================ */
function extSwitchTab(el, key){
  document.querySelectorAll('#extTabs .ui-tab').forEach(function(t){ t.classList.remove('active'); });
  el.classList.add('active');
  document.querySelectorAll('.ext-pane').forEach(function(p){ p.classList.remove('active'); });
  var pane=document.getElementById('ext-'+key); if(pane) pane.classList.add('active');
  if(key==='skills') renderSkills('local');
  if(key==='mcp') renderMcpServers();
}
function extSkillSubtab(el, key){
  document.querySelectorAll('#ext-skills .skill-subtabs .ui-tab').forEach(function(t){ t.classList.remove('active'); });
  el.classList.add('active');
  var bar=document.getElementById('skillMarketBar');
  if(bar) bar.style.display = (key==='market') ? 'block' : 'none';
  if(key==='market'){ renderSkillMarket(); } else { renderSkills(key); }
}
function renderExtensions(){ renderToolsets(); renderSkills('local'); renderExperts(); renderMemory(); }
function renderToolsets(priorFeedback){
  var el=document.getElementById('toolsetList'); if(!el) return;
  var generation=++_toolNativeLoadGeneration;
  var feedback=document.getElementById('toolsetFeedback');if(feedback)feedback.textContent=priorFeedback||'';
  // GET /proxy/dashboard/* 不带 X-Monitor-Token：proxy 会自动注入 X-Hermes-Session-Token，
  // 自带 X-Monitor-Token 会触发 CORS 预检，app-center/trim_app_center 对 OPTIONS 返 401，
  // 导致浏览器控制台出现 401 噪音。这里保持「无自定义头」=简单请求=不预检。
  fetch(apiUrl('/proxy/dashboard/api/tools/toolsets'), { cache:'no-store' })
    .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
    .then(function(list){
      if(generation!==_toolNativeLoadGeneration)return;
      _toolNativeFallback = false;
      _toolNative = {};
      (list||[]).forEach(function(t){ if(t && t.name) _toolNative[t.name]=t; });
      el.innerHTML = Object.keys(_toolNative).map(function(k){
        var t=_toolNative[k]; var on=!!t.enabled;
        var icon = toolIconFor(k, t);
        var configurable=!!(t.config_fields&&t.config_fields.length) || !!(window.PV&&PV.toolConfigFields&&PV.toolConfigFields[k]&&PV.toolConfigFields[k].length);
        var saved=(_cfg.extensions&&_cfg.extensions.toolsets)||{};
        var stateText=on?'已启用':'未启用';
        if(Object.prototype.hasOwnProperty.call(saved,k)&&!!saved[k]!==on)stateText=(on?'运行中':'当前未运行')+' · 重启后将'+(saved[k]?'启用':'关闭');
        var syncAction=Object.prototype.hasOwnProperty.call(saved,k)&&!!saved[k]!==on?'syncToolsetConfig(\''+k+'\','+on+')':'';
        return extCardHTML(k, t.label||t.name||k, t.description||'', on, 'toggleToolset(\''+k+'\',\'runtime\','+on+')', icon, configurable, stateText, 'runtime', syncAction, k);
      }).join('');
    })
    .catch(function(error){
      if(generation!==_toolNativeLoadGeneration)return;
      // Dashboard is authoritative for runtime state; the config fallback is only the saved value.
      _toolNativeFallback = true;
      _toolNative = null;
      var ts = _cfg.extensions.toolsets || {};
      var keys = Object.keys(ts);
      if(!keys.length) keys = PV.toolsets.map(function(t){ return t.id; });
      if(feedback)feedback.textContent=(priorFeedback?priorFeedback+' ':'')+'仪表盘工具状态暂不可用，以下显示的是已保存配置；更改后需重启应用生效。原因：'+(error.message||'连接失败');
      el.innerHTML = keys.map(function(k){
        var def = PV.toolsets.find(function(t){ return t.id===k; }) || { name:k, icon:'🔧' };
        var on = !!ts[k];
        var icon = def.icon || toolIconFor(k, def);
        var configurable=!!(window.PV&&PV.toolConfigFields&&PV.toolConfigFields[k]&&PV.toolConfigFields[k].length);
        return extCardHTML(k, def.name||k, def.desc||'', on, 'toggleToolset(\''+k+'\',\'saved\')', icon, configurable, on?'配置已启用（待应用）':'配置未启用（待应用）', 'saved', '', k);
      }).join('');
    });
}
function extCardHTML(id, name, desc, on, onclick, icon, configurable, stateText, mode, syncAction, key){
  if(icon==null) icon='🔧';
  var disabled=_toolActionBusy[id]?' disabled':'';
  return '<div class="ext-card" data-toolset-id="'+DOM.escAttr(key||id)+'" data-toggle-mode="'+(mode||'')+'" data-runtime-enabled="'+(mode==='runtime'&&on?'true':mode==='runtime'?'false':'')+'">'+
    '<div class="top"><div class="icon">'+icon+'</div><div><div class="name">'+esc(name)+'</div><div class="status '+(on?'on':'off')+'">'+esc(stateText||(on?'已启用':'未启用'))+'</div></div></div>'+
    '<div class="actions">'+
      '<button class="btn"'+disabled+' onclick="'+onclick+'">'+(on?'关闭':'启用')+'</button>'+
      (syncAction?'<button class="btn secondary"'+disabled+' onclick="'+syncAction+'">同步重启配置</button>':'')+
      (configurable?'<button class="btn secondary"'+disabled+' onclick="renderToolConfigModal(\''+esc(id)+'\')">配置</button>':'')+
    '</div></div>';
}
function toggleToolset(id, mode, expectedOn){
  var newOn;
  if(_toolActionBusy[id])return;
  if(mode==='runtime'&&(!_toolNative||!_toolNative[id])){
    renderToolsets('仪表盘工具状态已变化；当前操作未写入重启配置，请按最新状态重试。');
    return;
  }
  if(mode==='runtime'&&typeof expectedOn==='boolean'&&_toolNative[id].enabled!==expectedOn){
    renderToolsets('仪表盘中的工具状态已更新；页面已刷新，请核对新状态后重试。');
    return;
  }
  if(mode==='saved'||(!mode&&_toolNativeFallback)){
    var savedToolsets=_cfg.extensions.toolsets||(_cfg.extensions.toolsets={}),savedPrevious=!!savedToolsets[id];
    _toolActionBusy[id]=true;setToolActionDisabled(id,true);
    savedToolsets[id]=!savedPrevious;_toolNativeLoadGeneration++;
    var savedFeedback=document.getElementById('toolsetFeedback');if(savedFeedback)savedFeedback.textContent='正在保存工具配置…';
    saveConfig().then(function(result){
      if(!result||result.ok!==true)throw Error(result&&result.error||'保存未收到确认');
      _toolActionBusy[id]=false;
      setToolActionDisabled(id,false);
      var list=document.getElementById('toolsetList'),card=list&&list.querySelector('[data-toolset-id="'+CSS.escape(id)+'"]');
      if(card){var state=card.querySelector('.status'),action=card.querySelector('.actions .btn');if(state){state.textContent=savedToolsets[id]?'配置已启用（待应用）':'配置未启用（待应用）';state.classList.toggle('on',!!savedToolsets[id]);state.classList.toggle('off',!savedToolsets[id]);}if(action)action.textContent=savedToolsets[id]?'关闭':'启用';}
      var current=document.getElementById('toolsetFeedback');if(current)current.textContent='工具配置已保存'+(result.restart_required?'，重启应用后生效':'');
    }).catch(function(error){
      _toolActionBusy[id]=false;
      savedToolsets[id]=savedPrevious;renderToolsets('保存失败，已恢复原配置：'+(error.message||'请求失败'));
    });
    return;
  }
  if((mode==='runtime'||!mode)&&_toolNative && _toolNative[id]){
    newOn = !_toolNative[id].enabled;
    var configBefore=!!((_cfg.extensions.toolsets||{})[id]);
    _toolActionBusy[id]=true;setToolActionDisabled(id,true);
    fetch(apiUrl('/proxy/dashboard/api/tools/toolsets/'+encodeURIComponent(id)), {
      method:'PUT', headers:{ 'Content-Type':'application/json', 'X-Monitor-Token':monitorToken||'' }, body: JSON.stringify({ enabled:newOn })
    }).then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json().catch(function(){ return {}; }); })
      .then(function(result){
        if(result&&result.ok===false) throw new Error(result.error||'工具状态未保存');
        if(_toolNative&&_toolNative[id])_toolNative[id].enabled=newOn;
        if(_cfg.extensions) _cfg.extensions.toolsets[id]=newOn;
        return saveConfig().then(function(saved){
          if(!saved||saved.ok!==true)throw Object.assign(new Error(saved&&saved.error||'重启配置未收到确认'),{runtimeUpdated:true});
          _toolActionBusy[id]=false;
          renderToolsets('运行状态与重启配置已同步'+(saved.restart_required?'，重启应用后生效':''));
        });
      })
      .catch(function(error){
        if(error&&error.runtimeUpdated){_toolActionBusy[id]=false;_cfg.extensions.toolsets[id]=configBefore;renderToolsets('运行状态已更新，但重启配置保存失败；可在此卡片重试同步。');return;}
        var ts=_cfg.extensions.toolsets||(_cfg.extensions.toolsets={});
        _toolNativeFallback=true;_toolNative=null;
        ts[id]=configBefore;
        _toolActionBusy[id]=false;
        renderToolsets('仪表盘状态更新失败（'+(error.message||'连接失败')+'）；已保留重启配置。以下显示的是已保存配置。');
      });
    return;
  }
  if(mode==='runtime')return;
  var ts = _cfg.extensions.toolsets;
  var previous=!!ts[id];ts[id]=!previous;newOn=ts[id];renderToolsets();
  _toolActionBusy[id]=true;setToolActionDisabled(id,true);
  var feedback=document.getElementById('toolsetFeedback');if(feedback)feedback.textContent='正在保存工具配置…';
  saveConfig().then(function(result){
    if(!result||result.ok!==true)throw Error(result&&result.error||'保存未收到确认');
    _toolActionBusy[id]=false;
    renderToolsets();
    var current=document.getElementById('toolsetFeedback');if(current)current.textContent='工具配置已保存'+(result.restart_required?'，重启应用后生效':'');
  }).catch(function(error){
    _toolActionBusy[id]=false;
    ts[id]=previous;renderToolsets('保存失败，已恢复原配置：'+(error.message||'请求失败'));
  });
}
function setToolActionDisabled(id, disabled){
  var list=document.getElementById('toolsetList');if(!list)return;
  var card=list.querySelector('[data-toolset-id="'+CSS.escape(id)+'"]');
  if(card)card.querySelectorAll('.actions button').forEach(function(button){button.disabled=!!disabled;});
}
function syncToolsetConfig(id, enabled){
  if(_toolActionBusy[id])return;
  if(!_toolNative||!_toolNative[id]||!!_toolNative[id].enabled!==!!enabled){renderToolsets('仪表盘中的工具状态已更新；未覆盖重启配置，请核对最新状态后重试。');return;}
  var ts=_cfg.extensions.toolsets||(_cfg.extensions.toolsets={}),previous=!!ts[id];
  _toolActionBusy[id]=true;setToolActionDisabled(id,true);
  ts[id]=!!enabled;
  var feedback=document.getElementById('toolsetFeedback');if(feedback)feedback.textContent='正在同步重启配置…';
  saveConfig().then(function(result){
    if(!result||result.ok!==true)throw Error(result&&result.error||'保存未收到确认');
    _toolActionBusy[id]=false;
    renderToolsets('运行状态与重启配置已同步'+(result.restart_required?'，重启应用后生效':''));
  }).catch(function(error){
    _toolActionBusy[id]=false;
    ts[id]=previous;renderToolsets('重启配置同步失败，原配置已保留：'+(error.message||'请求失败'));
  });
}
function renderToolConfigModal(id){
  var modal=document.getElementById('toolConfigModal'); if(!modal) return;
  if (modal.parentElement !== document.body) document.body.appendChild(modal);
  modal.style.display='flex';
  _toolCfgCurrent = id;
  var native = _toolNative && _toolNative[id];
  var titleName = native ? (native.label||native.name) : id;
  var on = !!(native && native.enabled) || !!(_cfg.extensions.toolsets && _cfg.extensions.toolsets[id]);
  var icon = toolIconFor(id, native);
  var title=document.getElementById('toolCfgTitle'); if(title) title.textContent='工具配置：'+titleName;
  // 优先后端 config_fields（非空），否则用 PV.toolConfigFields 兜底
  var fields = (native && native.config_fields && native.config_fields.length) ? native.config_fields : ((window.PV && PV.toolConfigFields && PV.toolConfigFields[id]) || []);
  var body=document.getElementById('toolCfgBody');
  var cfg = (_cfg.extensions.tools_config && _cfg.extensions.tools_config[id]) || {};
  var header = '<div class="tool-cfg-header">'+
    '<div class="icon cfg-icon-lg">'+icon+'</div>'+
    '<div class="tch-meta"><div class="tch-name">'+esc(titleName)+'</div><div class="status '+(on?'on':'off')+'">'+(on?'已启用':'未启用')+'</div></div>'+
    '</div>';
  if(fields && fields.length){
    body.innerHTML = header + fields.map(function(f,i){
      var key=f.key||f.name||('tf_'+i);
      var val=esc(cfg[key]!=null?cfg[key]:(f.default||''));
      return '<div class="skill-config-field"><label>'+esc(f.label||key)+(f.required?' *':'')+'</label><input type="'+(f.type==='password'?'password':'text')+'" data-key="'+DOM.escAttr(key)+'" value="'+val+'" placeholder="'+DOM.escAttr(f.placeholder||'')+'"></div>';
    }).join('');
  } else {
    body.innerHTML = header + '<div class="conn-hint">该工具暂无可配置参数，或参数需通过 Hermes 仪表盘配置。</div>';
  }
}
function closeToolConfigModal(){ var m=document.getElementById('toolConfigModal'); if(m) m.style.display='none'; }
function saveToolConfig(){
  var id=_toolCfgCurrent; if(!id) return;
  var values={}; var inputs=document.querySelectorAll('#toolCfgBody input[data-key]');
  for(var i=0;i<inputs.length;i++){ values[inputs[i].getAttribute('data-key')]=inputs[i].value; }
  var button=document.querySelector('#toolConfigModal .modal-foot .btn.primary'); if(button)button.disabled=true;
  fetch(apiUrl('/proxy/dashboard/api/tools/toolsets/'+encodeURIComponent(id)+'/config'), { method:'PUT', headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''}, body:JSON.stringify({ config:values }) })
    .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json().catch(function(){ return {}; }); })
    .then(function(result){ if(result&&result.ok===false) throw new Error(result.error||'工具配置未保存'); closeToolConfigModal(); toast('工具配置已保存：'+id); })
    .catch(function(error){ toast('工具配置未保存：'+(error.message||'请求失败')); })
    .finally(function(){ if(button)button.disabled=false; });
}
function skillIcon(s){
  if(!s) return '📦';
  if(s.icon) return s.icon;
  if(s.emoji) return s.emoji;
  var nm = s.name || '';
  if(window.PV && PV.skillIcons && PV.skillIcons[nm]) return PV.skillIcons[nm];
  return '📦';
}
// 工具集图标：后端 icon/emoji → PV.TOOL_ICON_MAP → PV.skillIcons(按 id/name) → 🔧
function toolIconFor(id, t){
  if(t && (t.icon||t.emoji)) return t.icon||t.emoji;
  if(window.PV){
    if(PV.TOOL_ICON_MAP && PV.TOOL_ICON_MAP[id]) return PV.TOOL_ICON_MAP[id];
    if(PV.skillIcons){
      if(PV.skillIcons[id]) return PV.skillIcons[id];
      if(t && t.name && PV.skillIcons[t.name]) return PV.skillIcons[t.name];
    }
  }
  return '🔧';
}
function renderSkills(kind){
  var el=document.getElementById('skillGrid'); if(!el) return;
  var feedback=document.getElementById('skillFeedback');if(feedback)feedback.textContent='';
  if(kind==='native'){
    fetch(apiUrl('/proxy/dashboard/api/skills'), { cache:'no-store', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
      .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
      .then(function(list){
        _skillNative = list||[];
        if(!_skillNative.length){ el.innerHTML='<div class="empty-state">未获取到原生技能（请先启动仪表盘）。</div>'; return; }
        el.innerHTML = _skillNative.map(function(s){
          var on=!!s.enabled; var nm=(s.name||'').replace(/'/g,"\\'");
          var desc = esc((s.description||s.desc||'').slice(0,80));
          var tools = Array.isArray(s.tools) ? s.tools.slice(0,4).map(function(t){ return '<code>'+esc(typeof t==='string'?t:(t.name||''))+'</code>'; }).join(' ') : '';
          return '<div class="ext-card" data-skill="'+nm+'">'+
            '<div class="top"><div class="icon">'+skillIcon(s)+'</div><div><div class="name">'+esc(s.name||'')+'</div><div class="status '+(on?'on':'off')+'">'+(on?'已启用':'未启用')+'</div></div></div>'+
            (desc?'<div class="desc">'+desc+'</div>':'')+
            (tools?'<div class="tools">'+tools+'</div>':'')+
            '<div class="actions">'+
              '<button class="btn" onclick="event.stopPropagation();toggleNativeSkill(\''+nm+'\')">'+(on?'关闭':'启用')+'</button>'+
              '<button class="btn secondary" onclick="event.stopPropagation();openSkillConfig(\''+nm+'\')">配置</button>'+
            '</div></div>';
        }).join('');
      })
      .catch(function(){ el.innerHTML='<div class="empty-state">加载原生技能失败（请先启动仪表盘）。</div>'; });
  } else {
    apiGet('/api/extensions/skills/local').then(function(res){
      if(res && res.ok && res.skills){
        _skillLocal = res.skills;
        if(!_skillLocal.length){ el.innerHTML='<div class="empty-state">尚未发现已安装技能。</div>'; return; }
        el.innerHTML = _skillLocal.map(function(s){
          var nm=(s.name||'').replace(/'/g,"\\'");
          var desc = esc((s.description||s.desc||'').slice(0,80));
          return '<div class="ext-card" data-skill="'+nm+'">'+
            '<div class="top"><div class="icon">'+skillIcon(s)+'</div><div><div class="name">'+esc(s.name||'未命名')+'</div><div class="status">'+(s.origin==='dir'?'目录加载':'Hermes 技能')+'</div></div></div>'+
            (desc?'<div class="desc">'+desc+'</div>':'')+
            '</div>';
        }).join('');
      } else {
        var message=res&&res.error?res.error:'服务没有返回本地技能列表';
        el.innerHTML='<div class="empty-state">本地技能列表暂时不可用，请重试。</div>';
        if(feedback)feedback.textContent='本地技能读取失败：'+message;
      }
    }).catch(function(error){el.innerHTML='<div class="empty-state">本地技能列表暂时不可用，请重试。</div>';if(feedback)feedback.textContent='本地技能读取失败：'+(error.message||'请求失败');});
  }
}
function toggleNativeSkill(name){
  var list=_skillNative||[]; var s=null;
  for(var i=0;i<list.length;i++){ if(list[i].name===name){ s=list[i]; break; } }
  if(!s) return;
  var newOn=!s.enabled;
  fetch(apiUrl('/proxy/dashboard/api/skills/toggle'), { method:'PUT', headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''}, body: JSON.stringify({ name:name, enabled:newOn }) })
    .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json().catch(function(){ return {}; }); })
    .then(function(result){ if(result && result.ok===false) throw new Error(result.error||'技能状态未保存'); s.enabled=newOn; renderSkills('native'); })
    .catch(function(error){ toast('技能状态未保存：'+(error.message||'请求失败')); renderSkills('native'); });
}
// ── 技能市场（扩展→技能→技能市场：精选目录 + SkillHub 搜索，安装/卸载/配置/获取指引）──
var _skillMarketItems = [];    // 当前市场技能列表（精选目录或搜索结果）
var _skillMarketFilter = 'all';
var _installedSkillNames = []; // 全部已安装技能目录名（供搜索结果对照安装状态）
var _marketCfgCurrent = null;  // 正在配置的市场技能
function renderSkillMarket(){
  var el=document.getElementById('skillGrid'); if(!el) return;
  apiGet('/api/extensions/skills/market-catalog').then(function(res){
    if(res && res.ok && res.items){
      _skillMarketItems = res.items;
      _installedSkillNames = res.installed_names || [];
      renderSkillMarketGrid();
    } else {
      el.innerHTML='<div class="empty-state">加载技能市场失败，请部署后重试。</div>';
    }
  });
}
function renderSkillMarketCatalog(){
  var el=document.getElementById('skillMarketSearch'); if(el) el.value='';
  renderSkillMarket();
}
function setSkillMarketFilter(btn, f){
  _skillMarketFilter = f;
  ['smFilterAll','smFilterInstalled','smFilterOfficial'].forEach(function(id){ var b=document.getElementById(id); if(b) b.classList.remove('active'); });
  if(btn) btn.classList.add('active');
  renderSkillMarketGrid();
}
function renderSkillMarketGrid(){
  var el=document.getElementById('skillGrid'); if(!el) return;
  var rows=[];
  (_skillMarketItems||[]).forEach(function(it, i){
    if(_skillMarketFilter==='installed' && !it.installed) return;
    if(_skillMarketFilter==='official' && !it.official) return;
    rows.push({ it:it, i:i });
  });
  if(!rows.length){ el.innerHTML='<div class="empty-state">没有匹配的技能。</div>'; return; }
  el.innerHTML = rows.map(function(r){ return renderSkillMarketCard(r.it, r.i); }).join('');
}
function renderSkillMarketCard(it, i){
  var installed=!!it.installed;
  var icon=it.icon||'🧩';
  var official=it.official?'<span class="conn-badge" style="background:rgba(139,92,246,.15);color:#a78bfa;border-color:rgba(139,92,246,.4)">官方</span>':'';
  var desc=esc((it.desc||it.description||'').slice(0,80));
  var meta='';
  if(it._search){
    var bits=[];
    if(it.downloads) bits.push(it.downloads+' 次安装');
    if(it.stars) bits.push(it.stars+' 星');
    if(bits.length) meta='<div class="conn-hint" style="margin:0 0 10px">'+esc(bits.join(' · '))+'</div>';
  }
  var actions='';
  if(installed){
    actions+='<button class="btn danger" onclick="event.stopPropagation();uninstallMarketSkill('+i+')">卸载</button>';
    actions+='<button class="btn secondary" onclick="event.stopPropagation();configMarketSkill('+i+')">配置</button>';
  } else {
    actions+='<button class="btn primary" onclick="event.stopPropagation();installMarketSkill('+i+')">安装</button>';
  }
  actions+='<button class="btn secondary" onclick="event.stopPropagation();openMarketGuide('+i+')">获取指引</button>';
  return '<div class="ext-card">'+
    '<div class="top"><div class="icon">'+icon+'</div><div><div class="name">'+esc(it.name||'未命名')+official+'</div><div class="status '+(installed?'on':'off')+'">'+(installed?'已安装':'未安装')+'</div></div></div>'+
    (desc?'<div class="desc">'+desc+'</div>':'')+
    meta+
    '<div class="actions">'+actions+'</div></div>';
}
function installMarketSkill(i){
  var it=_skillMarketItems[i]; if(!it) return;
  var payload={ slug: it.slug, namespace: it.namespace, name: it.id || it.slug };
  if(it.mcp && it.mcp.url){ payload.mcp={ name: it.mcp.name, url: it.mcp.url, headers:{} }; }
  toast('正在安装 '+it.name+'…');
  apiPost('/api/extensions/skills/install-package', payload).then(function(res){
    if(res && res.ok){
      toast('✅ '+it.name+' 安装成功'+((it.mcp&&it.mcp.fields)?'，请点击「配置」输入凭证':''));
      renderSkillMarket();
    } else {
      toast('❌ 安装失败：'+((res&&res.error)||'服务器没有返回安装原因'));
    }
  });
}
async function uninstallMarketSkill(i){
  var it=_skillMarketItems[i]; if(!it) return;
  var name=it.id || it.slug;
  if(!(await ui.confirm('确定卸载技能「'+(it.name||name)+'」？\n将删除其本地文件与注册信息（含 MCP 服务器）。', {danger:true}))) return;
  toast('正在卸载 '+it.name+'…');
  var payload={ name: name };
  if(it.mcp && it.mcp.name) payload.mcp_name=it.mcp.name;
  apiPost('/api/extensions/skills/uninstall', payload).then(function(res){
    if(res && res.ok){ toast('🗑️ '+it.name+' 已卸载'); renderSkillMarket(); }
    else { toast('❌ 卸载失败：'+((res&&res.error)||'服务器没有返回卸载原因')); }
  });
}
function configMarketSkill(i){
  var it=_skillMarketItems[i]; if(!it) return;
  _marketCfgCurrent=it;
  var title=document.getElementById('marketCfgTitle');
  var body=document.getElementById('marketCfgBody');
  if(title) title.textContent=(it.name||'技能')+' 配置';
  if(!body) return;
  var html='';
  if(it.mcp && it.mcp.fields && it.mcp.fields.length){
    if(it.desc||it.description) html+='<div class="conn-desc">'+esc(it.desc||it.description)+'</div>';
    if(it.cred_hint) html+='<div class="conn-hint">💡 '+esc(it.cred_hint)+'</div>';
    html+='<div class="conn-section-title">凭证</div><div class="conn-fields">';
    it.mcp.fields.forEach(function(f){
      html+='<div class="field"><label>'+esc(f.label||f.key)+'</label><input type="password" id="mktCfg_'+esc(f.key)+'" value="" placeholder="留空则保留原值"></div>';
    });
    html+='</div>';
    html+='<div class="conn-hint">保存后将注册为 MCP 服务器，由对话中的智能体调用（重启应用后生效）。</div>';
  } else {
    if(it.desc||it.description) html+='<div class="conn-desc">'+esc(it.desc||it.description)+'</div>';
    html+='<div class="conn-hint">💡 凭证提示：'+esc(it.cred_hint||'该技能无需额外凭证')+'</div>';
    html+='<div class="conn-hint">该技能的凭证由其内置脚本管理，请按「获取指引」完成授权。</div>';
    var gurl=it.guide_url||it.webUrl||'';
    if(gurl) html+='<a class="conn-doc" href="'+DOM.escAttr(gurl)+'" target="_blank">📄 查看获取指引 →</a>';
  }
  body.innerHTML=html;
  var m=document.getElementById('marketCfgModal');
  if(m && m.parentElement!==document.body) document.body.appendChild(m);
  if(m) m.style.display='flex';
}
function closeMarketConfig(){ var m=document.getElementById('marketCfgModal'); if(m) m.style.display='none'; _marketCfgCurrent=null; }
function saveMarketConfig(){
  var it=_marketCfgCurrent; if(!it){ closeMarketConfig(); return; }
  if(!(it.mcp && it.mcp.fields && it.mcp.fields.length)){
    toast('该技能通过内置脚本配置，请参考获取指引');
    closeMarketConfig(); return;
  }
  var headers={};
  it.mcp.fields.forEach(function(f){
    var el=document.getElementById('mktCfg_'+f.key);
    var v=el?el.value.trim():'';
    if(v) headers[f.header]=(f.prefix||'')+v;
  });
  apiPost('/api/extensions/skills/config-mcp', { name: it.mcp.name, url: it.mcp.url, headers: headers }).then(function(res){
    if(res && res.ok){ toast('✅ 凭证已保存，网关重启后生效'); closeMarketConfig(); }
    else { toast('❌ 保存失败：'+((res&&res.error)||'服务器没有返回保存原因')); }
  });
}
function openMarketGuide(i){
  var it=_skillMarketItems[i]; if(!it) return;
  var url=it.guide_url||it.webUrl||('https://www.skillhub.cn/skills/'+(it.slug||''));
  window.open(url, '_blank');
}
function searchSkillMarket(){
  var el=document.getElementById('skillMarketSearch');
  var kw=el?el.value.trim():'';
  if(!kw){ renderSkillMarket(); return; }
  var grid=document.getElementById('skillGrid');
  if(grid) grid.innerHTML='<div class="empty-state">正在搜索 SkillHub…</div>';
  apiGet('/api/extensions/skills/search?keyword='+encodeURIComponent(kw)).then(function(res){
    if(res && res.ok && res.items){
      _skillMarketItems=res.items.map(function(it){
        return {
          id: it.slug, name: it.name, icon: '', desc: it.description,
          slug: it.slug, namespace: it.namespace, guide_url: it.webUrl,
          cred_hint: '', official: false,
          installed: _installedSkillNames.indexOf(it.slug)>=0,
          _search: true, downloads: it.downloads, stars: it.stars
        };
      });
      renderSkillMarketGrid();
    } else {
      if(grid) grid.innerHTML='<div class="empty-state">搜索失败：'+esc((res&&res.error)||'服务器没有返回搜索原因')+'</div>';
    }
  });
}
var _skillCfgCurrent = null; // { kind:'native'|'local', index, name }
var _toolCfgCurrent = null;  // 当前正在配置的工具 id（替代放在 body 内会被 innerHTML 覆盖的 hidden input）
function openSkillConfig(name){
  var list=_skillNative||[]; var s=null;
  for(var i=0;i<list.length;i++){ if(list[i].name===name){ s=list[i]; _skillCfgCurrent={kind:'native',index:i,name:name}; break; } }
  if(!s){ toast('未找到该技能'); return; }
  renderSkillConfigModal(s);
}
function closeSkillConfigModal(){ document.getElementById('skillConfigModal').style.display='none'; _skillCfgCurrent=null; }
function renderSkillConfigModal(s){
  var title = document.getElementById('skillCfgTitle');
  var body = document.getElementById('skillCfgBody');
  var setupBtn = document.getElementById('skillCfgSetupBtn');
  if(title) title.textContent = (s.name||'未命名') + ' 配置';
  if(!body) return;
  if(!_skillCfgCurrent) _skillCfgCurrent = { kind:'native', name:s.name };
  _skillCfgCurrent.name = s.name;
  var saved = {};
  var icon = skillIcon(s);
  var on = !!(s.enabled || s.status==='enabled');
  _skillCfgCurrent.enabled = on;
  var html = '<div class="setting-row" style="margin-bottom:14px"><div style="display:flex;align-items:center;gap:12px"><div class="cfg-icon-lg">'+icon+'</div><div><div style="font-weight:600">'+esc(s.name||'')+'</div><div class="status '+(on?'on':'off')+'">'+(on?'已启用':'未启用')+'</div></div></div><div class="toggle '+(on?'on':'')+'" onclick="toggleSkillCfgEnabled()"></div></div>';
  if(s.description||s.desc) html += '<p class="conn-desc">'+esc(s.description||s.desc)+'</p>';
  // 工具列表
  if(Array.isArray(s.tools) && s.tools.length){
    html += '<div class="conn-section-title">工具</div><div class="conn-tools">'+s.tools.map(function(t){ var n=typeof t==='string'?t:(t.name||''); return '<code>'+esc(n)+'</code>'; }).join(' ')+'</div>';
  }
  // 配置字段（优先用后端给出的 config/schema）
  var cfgFields = s.config_fields || s.configFields || (s.config && s.config.fields) || (s.schema && s.schema.fields);
  var providers = s.providers || s.config_options || (s.config && s.config.providers);
  var savedConfig = saved.config || {};
  if(providers && providers.length){
    html += '<div class="conn-section-title">选择提供商</div>';
    providers.forEach(function(p, idx){
      var sel = (_skillCfgCurrent.providerIdx===idx);
      var pid = 'skillProv_'+idx;
      html += '<div class="skill-config-provider'+(sel?' selected':'')+'">'+
        '<div class="prov-head"><div><span class="prov-name">'+esc(p.name||p.label||('方案 '+(idx+1)))+'</span> '+(p.badge?'<span class="prov-badge">'+esc(p.badge)+'</span>':'')+'</div><button class="btn" style="width:auto;padding:5px 12px" onclick="selectSkillProvider('+idx+')">'+(sel?'已选':'Select')+'</button></div>'+
        (p.description||p.desc?'<div class="prov-desc">'+esc(p.description||p.desc)+'</div>':'')+
        '<div id="'+pid+'"></div></div>';
    });
  } else if(cfgFields && cfgFields.length){
    html += '<div class="conn-section-title">配置参数</div>'+renderSkillConfigFields(cfgFields, savedConfig);
  } else {
    html += '<div class="conn-hint">该技能未暴露可配置参数，或参数需通过 Hermes 仪表盘/CLI 配置。</div>';
  }
  body.innerHTML = html;
  if(setupBtn) setupBtn.style.display = (s.needs_setup || s.setup_command) ? 'inline-block' : 'none';
  var scm = document.getElementById('skillConfigModal');
  if (scm && scm.parentElement !== document.body) document.body.appendChild(scm);
  document.getElementById('skillConfigModal').style.display='flex';
}
function renderSkillConfigFields(fields, values){
  return fields.map(function(f, i){
    var key = f.key || f.name || ('field_'+i);
    var val = esc(values[key] || f.default || '');
    var ph = esc(f.placeholder || f.label || '');
    return '<div class="skill-config-field"><label>'+esc(f.label||key)+(f.required?' *':'')+'</label><input type="'+(f.type==='password'?'password':'text')+'" data-key="'+DOM.escAttr(key)+'" value="'+val+'" placeholder="'+ph+'"></div>';
  }).join('');
}
function toggleSkillCfgEnabled(){
  if(!_skillCfgCurrent) return;
  if(_skillCfgCurrent.kind==='native'){ toggleNativeSkill(_skillCfgCurrent.name); renderSkillConfigModal(_skillNative[_skillCfgCurrent.index]); }
}
function selectSkillProvider(idx){ if(!_skillCfgCurrent) return; _skillCfgCurrent.providerIdx = idx; renderSkillConfigModal(_skillCfgCurrent.kind==='native'?_skillNative[_skillCfgCurrent.index]:_skillLocal[_skillCfgCurrent.index]); }
function saveSkillConfig(){
  if(!_skillCfgCurrent){ closeSkillConfigModal(); return; }
  var configKind=_skillCfgCurrent.kind;
  var values={}; var inputs=document.querySelectorAll('#skillCfgBody input[data-key]');
  for(var i=0;i<inputs.length;i++){ values[inputs[i].getAttribute('data-key')] = inputs[i].value; }
  var payload = { name:_skillCfgCurrent.name, config:values };
  if(configKind==='native')payload.enabled=!!(_skillNative&&_skillNative[_skillCfgCurrent.index]&&_skillNative[_skillCfgCurrent.index].enabled);
  if(_skillCfgCurrent.providerIdx!=null) payload.provider_idx=_skillCfgCurrent.providerIdx;
  fetch(apiUrl('/proxy/dashboard/api/skills/config'), { method:'PUT', headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''}, body:JSON.stringify(payload) })
    .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
    .then(function(result){ if(result && result.ok===false) throw new Error(result.error||'技能配置未保存'); toast('技能配置已保存（仪表盘）'); closeSkillConfigModal(); renderSkills(configKind==='native'?'native':'local'); })
    .catch(function(error){
      toast('技能配置未保存：'+(error.message||'仪表盘不可用'));
    });
}
function runSkillSetup(){
  if(!_skillCfgCurrent) return;
  var s = _skillCfgCurrent.kind==='native' ? _skillNative[_skillCfgCurrent.index] : _skillLocal[_skillCfgCurrent.index];
  if(!s || !s.setup_command){ toast('该技能无需安装'); return; }
  toast('正在执行安装：'+s.setup_command);
  fetch(apiUrl('/proxy/dashboard/api/skills/setup'), { method:'POST', headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''}, body:JSON.stringify({name:s.name, command:s.setup_command}) })
    .then(function(r){ return r.json(); }).then(function(d){ toast(d.message||'安装完成'); }).catch(function(){ toast('安装请求失败（请检查 dashboard 是否启动）'); });
}
function renderMemory(){
  setToggle('memToggle', !!(_cfg.extensions.memory && _cfg.extensions.memory.enabled));
  var r=document.getElementById('memLimit'); if(r && _cfg.extensions.memory) r.value=_cfg.extensions.memory.char_limit;
  var v=document.getElementById('memLimitVal'); if(v && _cfg.extensions.memory) v.textContent=_cfg.extensions.memory.char_limit;
}
function toggleMemory(){
  if(!_cfg.extensions.memory) _cfg.extensions.memory={enabled:true,char_limit:2200};
  _cfg.extensions.memory.enabled = !_cfg.extensions.memory.enabled;
  renderMemory(); saveConfig();
}
function updateMemLimit(val){
  if(!_cfg.extensions.memory) _cfg.extensions.memory={enabled:true,char_limit:2200};
  _cfg.extensions.memory.char_limit = parseInt(val)||2200;
  var v=document.getElementById('memLimitVal'); if(v) v.textContent=val;
  saveConfig();
}
/* Legacy workflow editing is retired; task plans own this behavior. */
/* persona / profiles 系统（与 Hermes 官方 profiles 完全对齐） */
/* 参考: hermesagent.org.cn/docs/user-guide/profiles */
/* 每个 profile = 完全隔离的 Hermes 环境（独立 config.yaml、.env、SOUL.md、记忆、会话、技能、网关） */
var _profiles = [];  // 从后端 /api/profiles 拉取
var _profilesLoaded = false;
function allPersonas(){
  // 兼容层：将 profiles 转换为旧版 persona 格式（供 chat 系统使用）
  var out={};
  _profiles.forEach(function(p){ out[p.id] = { emoji:p.emoji, label:p.name, prompt:p.prompt }; });
  if(!_profiles.length){
    out['default']={emoji:'🤖',label:'默认助手',prompt:'你是用户的默认主力助手。'};
  }
  return out;
}
function fetchProfiles(cb){
  apiGet('/api/profiles').then(function(res){
    if(res && res.ok && res.profiles){
      _profiles = res.profiles; _profilesLoaded = true;
      // profilefix v3（模型 A）：_persona 跟随后端 active profile（.active_profile），
      // 不从 config/localStorage 恢复（那两处可能落后于后端真实激活状态）
      var _ap = null;
      for(var i=0;i<_profiles.length;i++){ if(_profiles[i].is_active){ _ap = _profiles[i]; break; } }
      if(_ap && _ap.id){
        var _newP = String(_ap.id||'default');
        if(_newP.indexOf('exp-')===0 || _newP==='team') _newP = 'default';
        if(_persona !== _newP){
          _persona = _newP;
          _personaPrompt = (_ap.prompt) ? _ap.prompt : '';
          if(_cfg && _cfg.extensions) _cfg.extensions.persona = _newP;
          if(window.chatState) chatState.persona = _newP;
          try { localStorage.setItem('hermes_persona', _newP); } catch(e){}
        }
        if(typeof renderPersonas==='function') renderPersonas();
        if(typeof renderPresetAgents==='function') renderPresetAgents();
        if(typeof renderRail==='function') renderRail();
        if(typeof updateHeader==='function') updateHeader();
      }
    }
    if(cb) cb();
  }).catch(function(){ if(cb) cb(); });
}
// ── 预设智能体模板（内置，一键套用激活）────────────────────────────────────
var PRESET_AGENT_TEMPLATES = [
  { id:'fnos_operator', emoji:'🖥️', name:'飞牛操作员', desc:'NAS 运维专家：TRIM CLI、应用中心、存储/网络、容器、日志与备份恢复', prompt:'你是一位资深的飞牛 fnOS NAS 运维专家。精通 TRIM CLI（应用管理/日志/存储/网络/系统）、应用中心全流程（安装、升级、卸载、热补丁、回调脚本）、存储卷与共享文件夹、Docker 容器、系统日志排查、备份与恢复。回答时优先给出可直接执行的命令与步骤，注重数据安全并主动提示操作风险，遇到不确定的配置先说明风险再给方案。' },
  { id:'coder', emoji:'💻', name:'程序员', desc:'全栈工程师：可运行代码优先，注重安全与可维护性', prompt:'你是一位资深全栈工程师。优先给出可直接运行的代码与命令，注重安全性、可维护性与生产实践；遇到模糊需求先给出最小可行方案再迭代。' },
  { id:'researcher', emoji:'🔬', name:'研究员', desc:'严谨调研：基于证据、引用来源，区分事实与推测', prompt:'你是一位严谨的研究员。回答须基于证据、引用来源，并明确区分事实、推测与不确定信息；避免臆断。' },
  { id:'writer', emoji:'✍️', name:'写作助手', desc:'专业写作：结构化中文表达，按场景调整语气篇幅', prompt:'你是一位专业的写作助手。擅长结构化、清晰、有感染力的中文表达，依据场景调整语气与篇幅。' },
  { id:'analyst', emoji:'📊', name:'数据分析师', desc:'数据洞察：量化结论优先，给出可执行建议', prompt:'你是一位数据分析师。善于从数据 / 文件中提取洞察，优先给出量化结论与可执行建议。' }
];
function renderPresetAgents(){
  var el=document.getElementById('presetAgentGrid'); if(!el) return;
  el.innerHTML = PRESET_AGENT_TEMPLATES.map(function(t){
    var exists = _profiles.some(function(p){ return p.id===t.id; });
    var active = _profiles.some(function(p){ return p.id===t.id && (p.is_active || _persona===p.id); });
    // 卡片用纵向 flex：描述区 flex:1 撑开、按钮区 margin-top:auto 贴底，保证各卡片按钮垂直位置一致
    return '<div class="ext-card" style="border:1px solid var(--border);display:flex;flex-direction:column">'+
      '<div class="top"><div class="icon" style="font-size:22px">'+t.emoji+'</div><div><div class="name">'+esc(t.name)+'</div><div class="status '+(exists?'on':'off')+'">'+(exists?'已创建':'未创建')+'</div></div></div>'+
      '<div class="conn-desc" style="font-size:11px;opacity:.8;flex:1">'+esc(t.desc)+'</div>'+
      '<div style="margin-top:10px"><button class="btn sm primary" onclick="applyPresetAgent(\''+t.id+'\')">'+(exists?'打开会话':'创建并打开会话')+'</button></div>'+
      '</div>';
  }).join('');
}
function applyPresetAgent(id){
  var t = PRESET_AGENT_TEMPLATES.find(function(x){ return x.id===id; });
  if(!t) return;
  var existing = _profiles.find(function(p){ return p.id===t.id; });
  if(existing){
    pwStartRoleChat(existing);
    return;
  }
  pwStartRoleChat({id:t.id,name:t.name,emoji:t.emoji,prompt:t.prompt,quick_prompts:[]});
}
/* ── 专家页（独立页，两页签：我的 / 内置，专家市场已并入内置）────────── */
var EXPERT_SCENE={ mine:'all', builtin:'all' };
var EXPERT_SRC={ builtin:'all' }; // 内置页签来源筛选：all | builtin(精选) | workflow(工作流专家)
var BUILTIN_EXPERTS=null;
function _jsStr(s){ return String(s==null?'':s).replace(/'/g,"\\'"); }
function _expertScene(e){ return e.scene||'通用'; }
// 工作流专家（扩展页 js/personas_library.js 的 AGENCY_PERSONAS，268 位）映射为内置专家模板格式
// 工作流专家库个别条目的 emoji 字段存的是纯文本（如「公众号」），非法时兜底为 🧠
function _wfEmoji(e){
  e=String(e||'').trim();
  if(!e) return '🧠';
  if(/[\uD800-\uDBFF]/.test(e)) return e;
  if(/^[\u00A9\u00AE\u203C\u2049\u2122\u2139\u2190-\u21FF\u2300-\u23FF\u2460-\u24FF\u25A0-\u27BF\u2900-\u297F\u2B00-\u2BFF\u3030\u303D\u3297\u3299\uFE0F]/.test(e)) return e;
  return '🧠';
}
function _workflowExperts(){
  return (window.AGENCY_PERSONAS||[]).map(function(p){
    return { slug:p.id, id:p.id, name:p.label||p.name||p.id, emoji:_wfEmoji(p.emoji),
      desc:p.desc||'', scene:p.dept_label||'通用', prompt:p.prompt||'',
      skills:[], quick_prompts:[], workflow:true };
  });
}
// 内置精选（API 30 个）+ 工作流专家（268 个）合并清单，按 slug 去重（内置优先）；套用专家设定覆盖（编辑层）
var _expertOverrides = {};
function _applyExpertOverride(e){
  var ov=_expertOverrides[(e.slug||e.id)];
  if(!ov) return e;
  var n={};
  Object.keys(e).forEach(function(k){ n[k]=e[k]; });
  ['name','emoji','desc','prompt','scene','skills','quick_prompts','skill_count'].forEach(function(k){
    if(ov[k]!==undefined) n[k]=ov[k];
  });
  return n;
}
function _allBuiltinExperts(){
  var base=window.BUILTIN_EXPERTS_ARR||_builtinExperts()||[];
  var wf=_workflowExperts();
  var seen={}; base.forEach(function(e){ seen[e.slug||e.id]=1; });
  var out=base.map(_applyExpertOverride);
  wf.forEach(function(e){ if(!seen[e.slug||e.id]) out.push(_applyExpertOverride(e)); });
  return out;
}
/* 内置专家编辑弹窗：编辑设定保存到覆盖层（PUT /api/experts/:slug），渲染时套用 */
function openBuiltinExpertEditor(slug){
  var list=_allBuiltinExperts();
  var e=list.filter(function(x){ return (x.slug||x.id)===slug; })[0];
  if(!e) return;
  var html='<div class="modal-overlay" id="expEditOverlay" onclick="if(event.target===this)closeExpEdit()">'+
    '<div class="modal" style="max-width:520px">'+
    '<div class="modal-head"><h3>编辑专家设定 · '+esc(e.name)+'</h3><button class="modal-close" aria-label="关闭" title="关闭" onclick="closeExpEdit()">\u00d7</button></div>'+
    '<div class="modal-body" style="padding:14px 16px;max-height:70vh;overflow-y:auto">'+
    '<div class="field"><label>名称</label><input id="ee_name" class="input" value="'+DOM.escAttr(e.name||'')+'"></div>'+
    '<div class="field"><label>图标（Emoji）</label><input id="ee_emoji" class="input" value="'+DOM.escAttr(e.emoji||'')+'" placeholder="如 🧠"></div>'+
    '<div class="field"><label>简介</label><input id="ee_desc" class="input" value="'+DOM.escAttr(e.desc||'')+'"></div>'+
    '<div class="field"><label>系统提示词</label><textarea id="ee_prompt" style="width:100%;min-height:160px;background:var(--bg0);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px;font-size:13px;line-height:1.6;font-family:monospace">'+esc(e.prompt||'')+'</textarea></div>'+
    '<div class="field"><label>技能（逗号分隔）</label><input id="ee_skills" class="input" value="'+DOM.escAttr((e.skills||[]).join(', '))+'" placeholder="如 web_search, file_manager"></div>'+
    '<div class="field"><label>快捷提问（逗号分隔）</label><input id="ee_quick" class="input" value="'+DOM.escAttr((e.quick_prompts||[]).join(', '))+'" placeholder="如 你擅长什么？, 帮我完成一项任务"></div>'+
    '<div class="hint" style="font-size:11px;color:var(--text3);margin-top:6px">修改保存后立即生效（覆盖内置模板，不创建副本）。重置请删除覆盖。</div>'+
    '</div>'+
    '<div class="modal-foot" style="padding:12px 16px;display:flex;justify-content:flex-end;gap:8px">'+
    '<button class="btn" onclick="closeExpEdit()">取消</button>'+
    '<button class="btn primary" onclick="saveBuiltinExpertEditor(\''+esc(slug).replace(/'/g,"\\'")+'\')">保存设定</button>'+
    '</div></div></div>';
  var d=document.createElement('div'); d.innerHTML=html; window.ui.adoptOverlay(document.body.appendChild(d.firstChild));
}
function saveBuiltinExpertEditor(slug){
  var name=document.getElementById('ee_name').value.trim()||'未命名';
  var data={
    name:name,
    emoji:document.getElementById('ee_emoji').value.trim(),
    desc:document.getElementById('ee_desc').value.trim(),
    prompt:document.getElementById('ee_prompt').value,
    skills:(document.getElementById('ee_skills').value||'').split(/[,，]/).map(function(s){return s.trim();}).filter(Boolean),
    quick_prompts:(document.getElementById('ee_quick').value||'').split(/[,，]/).map(function(s){return s.trim();}).filter(Boolean)
  };
  fetch(apiUrl('/api/experts/'+encodeURIComponent(slug)), { method:'PUT', headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''}, body: JSON.stringify(data) })
    .then(function(r){ return r.json(); })
    .then(function(j){
      if(j.ok){ toast('✅ 专家设定已保存：'+name); closeExpEdit(); window.__builtinLoaded=false; renderBuiltinExperts(); }
      else toast('保存失败：'+(j.error||'服务器没有返回保存原因'),'error');
    })
    .catch(function(){ toast('网络错误','error'); });
}
function closeExpEdit(){ var o=document.getElementById('expEditOverlay'); if(o) o.remove(); }
function _builtinExperts(){
  if(BUILTIN_EXPERTS) return BUILTIN_EXPERTS;
  // 内置专家：预设智能体模板（后续追加 Octop 转换的飞牛专家）
  BUILTIN_EXPERTS = PRESET_AGENT_TEMPLATES.map(function(t){
    return { id:t.id, emoji:t.emoji, name:t.name, desc:t.desc, prompt:t.prompt, scene:'通用', skills:[], quick_prompts:['你擅长什么？','帮我完成一项任务'] };
  });
  return BUILTIN_EXPERTS;
}
function expSwitchTab(el, key){
  document.querySelectorAll('#expTabs .ui-tab').forEach(function(t){ t.classList.remove('active'); });
  el.classList.add('active');
  document.querySelectorAll('.exp-pane').forEach(function(p){ p.classList.remove('active'); });
  var pane=document.getElementById('exp-'+key); if(pane) pane.classList.add('active');
  if(key==='mine') renderMineExperts();
  if(key==='builtin') renderBuiltinExperts();
}
function renderExpertsPage(){
  fetchProfiles(function(){ renderMineExperts(); renderBuiltinExperts(); });
}
function refreshExperts(){
  window.__builtinLoaded=false;
  fetchProfiles(function(){ renderMineExperts(); renderBuiltinExperts(); });
  toast('专家列表已刷新');
}
function _renderExpertList(key, fullList, opts){
  opts=opts||{};
  var gridId={mine:'expMineGrid',builtin:'expBuiltinGrid'}[key];
  var scenesEl=document.getElementById({mine:'expMineScenes',builtin:'expBuiltinScenes'}[key]);
  var srcsEl=document.getElementById({mine:null,builtin:'expBuiltinSrcs'}[key]);
  var searchEl=opts.searchId?document.getElementById(opts.searchId):null;
  var grid=document.getElementById(gridId); if(!grid) return;
  // 来源筛选 chips（仅内置页签：全部 / 内置精选 / 工作流专家）
  if(srcsEl){
    var baseCnt=fullList.filter(function(e){ return !e.workflow; }).length;
    var wfCnt=fullList.length-baseCnt;
    var srcCur=EXPERT_SRC[key]||'all';
    var srcHtml='<button class="exp-src-chip'+(srcCur==='all'?' active':'')+'" onclick="setExpSrc(\''+key+'\',\'all\')">全部 '+fullList.length+'</button>'+
      '<button class="exp-src-chip'+(srcCur==='builtin'?' active':'')+'" onclick="setExpSrc(\''+key+'\',\'builtin\')">内置精选 '+baseCnt+'</button>'+
      (wfCnt?'<button class="exp-src-chip'+(srcCur==='workflow'?' active':'')+'" onclick="setExpSrc(\''+key+'\',\'workflow\')">工作流专家 '+wfCnt+'</button>':'');
    srcsEl.innerHTML=srcHtml;
  }
  // 先按来源过滤，再按场景过滤
  var srcList=fullList.filter(function(e){
    var src=EXPERT_SRC[key]||'all';
    if(src==='all') return true;
    var wf=!!e.workflow;
    return src==='workflow' ? wf : !wf;
  });
  // 场景筛选 chips（基于来源过滤后的列表动态生成，保证场景与当前来源联动）
  if(scenesEl){
    var scenes={}; srcList.forEach(function(e){ var s=_expertScene(e); scenes[s]=(scenes[s]||0)+1; });
    var chipsHtml='<button class="exp-scene-chip'+(EXPERT_SCENE[key]==='all'?' active':'')+'" onclick="setExpScene(\''+key+'\',\'all\')">全部</button>';
    Object.keys(scenes).forEach(function(s){
      chipsHtml+='<button class="exp-scene-chip'+(EXPERT_SCENE[key]===s?' active':'')+'" onclick="setExpScene(\''+key+'\',\''+_jsStr(s)+'\')">'+esc(s)+'</button>';
    });
    scenesEl.innerHTML=chipsHtml;
  }
  // 搜索 + 场景过滤
  var q=(searchEl?searchEl.value:'').trim().toLowerCase();
  var list=srcList.filter(function(e){
    if(EXPERT_SCENE[key]!=='all' && _expertScene(e)!==EXPERT_SCENE[key]) return false;
    if(!q) return true;
    // 工作流专家 3.5MB 数据不参与 prompt 搜索（性能），仅搜名称/描述/分类
    var hay=(e.name||'')+' '+(e.desc||e.description||'')+(e.workflow?'':' '+(e.prompt||''))+' '+(e.id||'');
    return hay.toLowerCase().indexOf(q)>=0;
  });
  if(!list.length){ grid.innerHTML='<div class="empty-state">'+(srcList.length?'没有匹配的专家':'暂无数据')+'</div>'; return; }
  var kind=opts.kind||key;
  grid.innerHTML=list.map(function(e){ return _expertCardHtml(e,kind); }).join('');
}
function setExpSrc(key, v){ EXPERT_SRC[key]=v; renderBuiltinExperts(); }
function setExpScene(key, v){ EXPERT_SCENE[key]=v; if(key==='builtin') renderBuiltinExperts(); else renderMineExperts(); }
function _expertCardHtml(e, kind){
  if(kind==='mine'){
    var p=e, active=p.is_active||(_persona===p.id);
    var modelTag=p.model?'<span class="exp-badge">'+esc(p.model)+'</span>':'';
    var skillTag=(p.skills&&p.skills.length)?'<span class="exp-badge">🛠 '+p.skills.length+' 技能</span>':'';
    return '<div class="exp-card'+(active?' active':'')+'">'+
      '<div class="exp-card-head"><div class="exp-card-avatar">'+(p.emoji||'🤖')+'</div>'+
      '<div><div class="exp-card-title">'+esc(p.name||p.id)+'</div>'+
      '<div class="exp-card-scene">'+esc(_expertScene(p))+' · <span class="exp-status '+(active?'on':'off')+'">'+(active?'● 使用中':'未使用')+'</span></div></div></div>'+
      '<div class="exp-card-desc">'+esc((p.prompt||'').slice(0,120))+'</div>'+
      '<div class="exp-card-foot"><div style="display:flex;gap:6px;flex-wrap:wrap">'+modelTag+skillTag+'</div>'+
      '<div class="exp-card-actions">'+
        '<button class="btn sm danger" onclick="deleteMyExpert(\''+_jsStr(p.id)+'\',event)" title="删除该专家">删除</button>'+
        '<button class="btn sm" onclick="openPersonaModal(\''+_jsStr(p.id)+'\')">编辑</button>'+
        '<button class="btn sm primary" onclick="pwProfileChatById(\''+_jsStr(p.id)+'\')">对话</button>'+
      '</div></div></div>';
  }
  var exists=_profiles.some(function(p){ return p.id===e.id; });
  var active=exists && _profiles.some(function(p){ return p.id===e.id && (p.is_active||_persona===p.id); });
  if(kind==='builtin'){
    var sc=e.skill_count!=null?e.skill_count:(e.skills?e.skills.length:0);
    return '<div class="exp-card'+(active?' active':'')+'">'+
      '<div class="exp-card-head"><div class="exp-card-avatar">'+(e.emoji||'🧠')+'</div>'+
      '<div><div class="exp-card-title">'+esc(e.name)+'</div>'+
      '<div class="exp-card-scene">'+esc(_expertScene(e))+' · <span class="exp-status '+(active?'on':'off')+'">'+(active?'● 使用中':(exists?'已创建':'未创建'))+'</span></div></div></div>'+
      '<div class="exp-card-desc">'+esc(e.desc||'')+'</div>'+
      '<div class="exp-card-foot">'+
        ((e.skills&&e.skills.length)?'<span class="exp-badge">🛠 '+sc+' 技能</span>':'<span></span>')+
        '<div class="exp-card-actions">'+
          '<button class="btn sm" onclick="openBuiltinExpertEditor(\''+_jsStr(e.slug||e.id)+'\')">编辑设定</button>'+
          (exists
            ? '<button class="btn sm primary" onclick="pwProfileChatById(\''+_jsStr(e.id)+'\')">对话</button>'
            : '<button class="btn sm primary" onclick="pwExpertTemplateChat(\''+_jsStr(e.slug||e.id)+'\')">开始对话</button>')+
        '</div></div></div>';
  }
  return '<div class="empty-state">专家资料暂时无法显示，请刷新目录重试。</div>';
}
function renderMineExperts(){
  var grid=document.getElementById('expMineGrid'); if(!grid) return;
  if(!_profilesLoaded){ grid.innerHTML='<div class="empty-state">加载中…</div>'; return; }
  _renderExpertList('mine', _profiles, { kind:'mine', searchId:'expMineSearch' });
}
async function deleteMyExpert(pid, e){
  if(e) e.stopPropagation();
  var p=_profiles.find(function(x){ return x.id===pid; });
  if(!p) return;
  if(!(await ui.confirm('确定删除专家「'+(p.name||pid)+'」？该专家的配置与会话将一并删除。', {danger:true}))) return;
  fetch(apiUrl('/api/profiles/'+encodeURIComponent(pid)), { method:'DELETE', headers:{'X-Monitor-Token':monitorToken||''} })
    .then(function(r){ return r.json().catch(function(){ return {}; }); })
    .then(function(j){
      if(j.ok===false && j.error){ toast('删除失败：'+j.error,'error'); return; }
      toast('🗑 已删除专家：'+(p.name||pid));
      fetchProfiles(function(){ renderMineExperts(); renderRail(); });
    })
    .catch(function(){ toast('删除失败：网络错误','error'); });
}
function renderBuiltinExperts(){
  var grid=document.getElementById('expBuiltinGrid'); if(!grid) return;
  if(!_profilesLoaded){ fetchProfiles(function(){ renderBuiltinExperts(); }); grid.innerHTML='<div class="empty-state">加载中…</div>'; return; }
  // 确保工作流专家库（AGENCY_PERSONAS）就绪，就绪后再渲染合并清单
  ensurePersonasLibrary(function(){
    if(!window.__builtinLoaded){
      grid.innerHTML='<div class="empty-state">加载中…</div>';
      apiGet('/api/experts?scope=builtin').then(function(r){
        window.__builtinLoaded=true;
        window.BUILTIN_EXPERTS_ARR=(r&&Array.isArray(r.experts))?r.experts:_builtinExperts();
        _expertOverrides=(r&&r.overrides)||{};
        _renderExpertList('builtin', _allBuiltinExperts(), { kind:'builtin', searchId:'expBuiltinSearch' });
      }).catch(function(){
        window.__builtinLoaded=true;
        window.BUILTIN_EXPERTS_ARR=_builtinExperts();
        _renderExpertList('builtin', _allBuiltinExperts(), { kind:'builtin', searchId:'expBuiltinSearch' });
      });
      return;
    }
    _renderExpertList('builtin', _allBuiltinExperts(), { kind:'builtin', searchId:'expBuiltinSearch' });
  });
}
function openExpertCreateForm(slug){
  pwExpertTemplateChat(slug);
}
function renderPersonas(){
  var el=document.getElementById('personaGrid'); if(!el) return;
  if(!_profilesLoaded){ fetchProfiles(function(){ renderPersonas(); }); el.innerHTML='<div class="empty-state">加载中…</div>'; return; }
  renderPresetAgents();
  el.innerHTML = _profiles.map(function(p){
    var active = p.is_active || (_persona===p.id);
    var canDelete = !p.is_default;
    var modelTag = p.model ? '<span class="badge" style="font-size:10px;background:var(--accent);color:#fff;margin-left:6px;padding:1px 5px;border-radius:3px">'+esc(p.model)+'</span>' : '';
    var skillsCount = (p.skills && p.skills.length) ? p.skills.length : 0;
    var infoTags = '<div style="display:flex;gap:6px;margin-top:4px;flex-wrap:wrap">';
    if(p.is_default) infoTags += '<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:var(--border);color:var(--muted)">主目录</span>';
    infoTags += '<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:var(--border);color:var(--muted);cursor:pointer" title="点击配置该 Agent 的专属 API 密钥" onclick="event.stopPropagation();openPersonaEnvEditor(\''+esc(p.id)+'\',\''+esc(p.name||p.id)+'\')">'+(p.has_api_key?'✅ API已配置':'⚠️ 未配置API')+'</span>';
    if(skillsCount) infoTags += '<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:var(--border);color:var(--muted)">🛠 '+skillsCount+' 技能</span>';
    infoTags += '</div>';
    return '<div class="ext-card" style="border:'+(active?'1px solid var(--accent)':'1px solid var(--border)')+'">'+
      '<div class="top"><div class="icon" style="font-size:24px">'+(p.emoji||'🤖')+'</div><div><div class="name">'+esc(p.name||p.id)+modelTag+'</div><div class="status '+(active?'on':'off')+'">'+(active?'当前环境':'可作为独立环境配置')+'</div></div></div>'+
      '<div class="conn-desc" style="font-size:11px;opacity:.8">'+esc((p.prompt||'').slice(0,80))+'</div>'+
      infoTags+
      '<div class="persona-actions" style="margin-top:8px">'+
        '<button class="btn sm" data-persona-action="edit" data-id="'+DOM.escAttr(p.id)+'">编辑</button>'+
        (canDelete?'<button class="btn sm danger" data-persona-action="delete" data-id="'+DOM.escAttr(p.id)+'">删除</button>':'')+
        '<button class="btn sm primary" data-persona-action="select" data-id="'+DOM.escAttr(p.id)+'">打开会话</button>'+
      '</div></div>';
  }).join('') + '<div class="ext-card add-card" onclick="openPersonaModal(\'\')" style="cursor:pointer;display:flex;align-items:center;justify-content:center;min-height:120px;border:1px dashed var(--border)"><span style="font-size:28px;opacity:.6">+</span><span style="margin-left:8px;opacity:.7">添加环境 Profile</span></div>';
  if (!el._personaDelegated) {
    el._personaDelegated = true;
    el.addEventListener('click', function(ev){
      var btn = ev.target.closest('button[data-persona-action]');
      if (!btn || !el.contains(btn)) return;
      var id = btn.getAttribute('data-id');
      var action = btn.getAttribute('data-persona-action');
      if (action === 'edit') openPersonaModal(id);
      else if (action === 'delete') deletePersona(id);
      else if (action === 'select') pwProfileChatById(id);
    });
  }
}
function openPersonaModal(id, prefill){
  try {
    prefill = prefill||{};
    var m=document.getElementById('personaModal'); if(!m){ toast('模态未就绪'); return; }
    if (m.parentElement !== document.body) document.body.appendChild(m);
    m.style.display='flex';
    document.getElementById('personaEditId').value = id||'';
    document.getElementById('personaModalTitle').textContent = id? '编辑环境 Profile' : '添加环境 Profile';
    var p = id ? _profiles.find(function(x){ return x.id===id; }) : null;
    document.getElementById('personaEmoji').value = p?(p.emoji||''):(prefill.emoji||'🤖');
    document.getElementById('personaLabel').value = p?(p.name||''):(prefill.name||'');
    document.getElementById('personaPrompt').value = p?(p.prompt||''):(prefill.prompt||'');
    document.getElementById('personaDeleteBtn').style.display = (id && p && !p.is_default) ? 'inline-block' : 'none';
    // 动态插入模型字段和克隆选项（如果尚未插入）
    var promptEl = document.getElementById('personaPrompt');
    var extraWrap = document.getElementById('personaExtraFields');
    if(!extraWrap){
      extraWrap = document.createElement('div');
      extraWrap.id = 'personaExtraFields';
      promptEl.parentElement.after(extraWrap);
    }
    var extraHtml = '<div class="field" style="margin-top:10px"><label>模型（留空=跟随默认配置）</label>'+
      '<select id="personaModel" style="width:100%;padding:8px;border-radius:6px;background:var(--bg1);color:var(--text);border:1px solid var(--border)">'+buildModelOptionsHtml(p?(p.model||''):'', '跟随默认配置')+'</select></div>';
    if(!id){
      // 新建时提供克隆选项
      extraHtml += '<div class="field" style="margin-top:10px"><label>创建方式</label>'+
        '<select id="personaCloneMode" style="width:100%;padding:8px;border-radius:6px;background:var(--card);color:var(--text);border:1px solid var(--border)">'+
          '<option value="blank">空白创建（预置技能）</option>'+
          '<option value="clone">克隆配置（继承 API 密钥 + 模型 + SOUL.md）</option>'+
          '<option value="clone_all">完整克隆（配置 + 记忆 + 会话 + 技能）</option>'+
        '</select><div style="font-size:11px;color:var(--muted);margin-top:4px">克隆从当前默认 profile 复制配置，新 Agent 的会话和记忆独立</div></div>';
    }
    // 技能目录多选（编辑或新建时可用；default 主目录除外）
    if(!p || !p.is_default){
      var curScene=(p&&p.scene)||prefill.scene||'通用';
      var curQp=(p&&Array.isArray(p.quick_prompts)&&p.quick_prompts.length)?p.quick_prompts.slice():(Array.isArray(prefill.quick_prompts)?prefill.quick_prompts.slice():[]);
      extraHtml += '<div class="field" style="margin-top:10px"><label>场景（用于分类筛选）</label>'+
        '<input id="personaScene" value="'+DOM.escAttr(curScene)+'" placeholder="通用" style="width:100%;padding:8px;border-radius:6px;background:var(--bg1);color:var(--text);border:1px solid var(--border)">'+
        '<div style="font-size:11px;color:var(--muted);margin-top:4px">可选：通用/开发/写作/运营/效率/金融/生活/学习/安全/运维</div></div>'+
        '<div class="field" style="margin-top:10px"><label>快捷提问（每行一条，展示在对话欢迎页，最多 12 条）</label>'+
        '<textarea id="personaQuickPrompts" rows="3" placeholder="例如：&#10;帮我总结这篇文档&#10;写一封工作邮件" style="width:100%;padding:8px;border-radius:6px;background:var(--bg1);color:var(--text);border:1px solid var(--border);resize:vertical">'+esc(curQp.join('\n'))+'</textarea></div>';
      _personaSkillsSel = (p && p.skills && p.skills.length) ? p.skills.slice() : ((prefill.skills||[]).slice());
      extraHtml += '<div class="field" style="margin-top:10px"><label>技能目录（点击选择该 Agent 使用的技能）</label>'+
        '<div id="personaSkillsChips" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;max-height:130px;overflow:auto"></div>'+
        '<div id="personaSkillsHint" style="font-size:11px;color:var(--muted);margin-top:4px"></div></div>';
    }
    if(id && p && !p.is_default){
      // 编辑时显示环境信息
      extraHtml += '<div class="field" style="margin-top:8px"><label>环境状态</label><div style="font-size:11px;color:var(--muted);margin-top:4px">'+
        'API 密钥：'+(p.has_api_key?'<span style="color:#4caf50">已配置</span>':'<span style="color:#ff9800">未配置</span>')+
        (p.env_keys && p.env_keys.length ? ' · 环境变量：'+p.env_keys.length+' 个' : '')+
        ' <button class="btn sm" onclick="openPersonaEnvEditor(\''+esc(id)+'\',\''+esc(p.name||'')+'\')" style="margin-left:6px">'+(p.has_api_key?'修改':'配置')+' API 密钥</button>'+
        '<div style="margin-top:4px;line-height:1.5">每个 Agent 是独立环境，可配置专属密钥；留空则回落到全局默认 .env 的密钥。</div>'+
        '</div></div>';
    }
    extraWrap.innerHTML = extraHtml;
    if(!p || !p.is_default) loadPersonaSkills(false);
  } catch(e){ toast('打开角色编辑失败：'+e.message); }
}
// ── 技能目录多选：从已安装技能中选择（数据源 /proxy/dashboard/api/skills）─
var _personaSkillsSel=[];
var _personaAllSkills=null; // [{name,description,enabled}] 已安装技能缓存
function loadPersonaSkills(force){
  if(_personaAllSkills && !force){ _renderPersonaSkillsChips(); return; }
  var box=document.getElementById('personaSkillsChips');
  if(!box) return;
  box.innerHTML='<span style="font-size:11px;color:var(--muted)">加载已安装技能…</span>';
  fetch(apiUrl('/proxy/dashboard/api/skills'), { cache:'no-store', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
    .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
    .then(function(list){
      _personaAllSkills=Array.isArray(list)?list:[];
      _renderPersonaSkillsChips();
    })
    .catch(function(){ _personaAllSkills=[]; _renderPersonaSkillsChips(); });
}
function _personaSkillName(s){ return (typeof s==='string')?s:(s&&s.name?String(s.name):''); }
function _renderPersonaSkillsChips(){
  var box=document.getElementById('personaSkillsChips'); if(!box) return;
  var hint=document.getElementById('personaSkillsHint');
  var avail={};
  (_personaAllSkills||[]).forEach(function(s){ var n=_personaSkillName(s); if(n) avail[n]=s; });
  var names=Object.keys(avail);
  if(!names.length && !_personaSkillsSel.length){
    if(hint) hint.textContent='未能获取已安装技能（请先启动仪表盘），可手动添加。';
    box.innerHTML='<button class="btn sm" onclick="addPersonaSkillPrompt()">+ 手动添加技能</button>';
    return;
  }
  if(hint) hint.textContent='已选 '+_personaSkillsSel.length+' 个技能；不选则继承预置。';
  var html='';
  _personaSkillsSel.forEach(function(n){
    if(avail[n]) return;
    html+='<span class="ps-chip sel" title="已选（未在安装列表）" onclick="togglePersonaSkill(\''+_jsStr(n)+'\')">'+esc(n)+' ✕</span>';
  });
  names.forEach(function(n){
    var on=_personaSkillsSel.indexOf(n)>=0;
    var desc=String(avail[n].description||'').replace(/"/g,'&quot;').slice(0,60);
    html+='<span class="ps-chip'+(on?' sel':'')+'" title="'+desc+'" onclick="togglePersonaSkill(\''+_jsStr(n)+'\')">'+esc(n)+(on?' ✓':'')+'</span>';
  });
  html+='<span style="align-self:center"><button class="btn sm" onclick="addPersonaSkillPrompt()">+ 手动添加</button></span>';
  box.innerHTML=html;
}
function togglePersonaSkill(n){
  var i=_personaSkillsSel.indexOf(n);
  if(i>=0) _personaSkillsSel.splice(i,1); else _personaSkillsSel.push(n);
  _renderPersonaSkillsChips();
}
function addPersonaSkillPrompt(){
  var n=prompt('输入技能名（与技能目录/市场中的名称一致，如 web_search）：');
  if(!n) return;
  n=n.trim();
  if(!n) return;
  if(_personaSkillsSel.indexOf(n)<0) _personaSkillsSel.push(n);
  _renderPersonaSkillsChips();
}
function closePersonaModal(){ var m=document.getElementById('personaModal'); if(m) m.style.display='none'; }
function savePersona(){
  var id=document.getElementById('personaEditId').value;
  var emoji=document.getElementById('personaEmoji').value.trim()||'🤖';
  var label=document.getElementById('personaLabel').value.trim();
  var prompt=document.getElementById('personaPrompt').value;
  var modelEl=document.getElementById('personaModel');
  var model=modelEl?modelEl.value.trim():'';
  var sceneEl=document.getElementById('personaScene');
  var scene=sceneEl?sceneEl.value.trim():'';
  var qpEl=document.getElementById('personaQuickPrompts');
  var qp=(qpEl?qpEl.value:'').split('\n').map(function(s){ return s.trim(); }).filter(Boolean).slice(0,12);
  if(!label){ toast('请填写 Agent 名称'); return; }
  if(id){
    // 更新已有 profile（SOUL.md + config + metadata）
    var payload = { name:label, emoji:emoji, prompt:prompt, scene: scene||'通用' };
    if(model) payload.model = model;
    if(qp.length) payload.quick_prompts = qp; else payload.quick_prompts = [];
    if(_personaSkillsSel && _personaSkillsSel.length) payload.skills = _personaSkillsSel.slice();
    api('/api/profiles/'+encodeURIComponent(id), 'PUT', payload).then(function(r){
      if(r&&r.ok){ toast('已保存环境 Profile：'+label); closePersonaModal(); fetchProfiles(function(){ renderPersonas(); renderMineExperts(); }); }
      else toast('保存失败：'+(r&&r.error||'服务器没有返回保存原因'));
    }).catch(function(){ toast('保存失败'); });
  } else {
    // 创建新 profile（调用 hermes profile create）
    var newId = label.toLowerCase().replace(/[^a-z0-9_-]/g,'_').slice(0,24) || ('agent_'+Date.now());
    var cloneEl=document.getElementById('personaCloneMode');
    var cloneMode=cloneEl?cloneEl.value:'blank';
    var payload = { id:newId, name:label, emoji:emoji, prompt:prompt };
    if(model) payload.model = model;
    if(scene) payload.scene = scene;
    if(qp.length) payload.quick_prompts = qp;
    if(_personaSkillsSel && _personaSkillsSel.length) payload.skills = _personaSkillsSel.slice();
    if(cloneMode==='clone') payload.clone = true;
    if(cloneMode==='clone_all') payload.clone_all = true;
    toast('正在添加环境 Profile…（hermes profile create）');
    apiPost('/api/profiles', payload).then(function(r){
      if(r&&r.ok){ toast('已创建环境 Profile；当前会话不会切换'); closePersonaModal(); fetchProfiles(function(){ renderPersonas(); renderMineExperts(); }); }
      else toast('创建失败：'+(r&&r.error||'服务器没有返回创建原因'));
    });
  }
}
async function deletePersona(id){
  if(!id) id = document.getElementById('personaEditId').value;
  if(!id) return;
  if(!(await ui.confirm('确定删除该 Agent？\n\n这将停止其网关、移除服务、删除命令别名和所有配置数据。\n此操作不可恢复！', {danger:true}))) return;
  fetch(apiUrl('/api/profiles/'+encodeURIComponent(id)), { method:'DELETE', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
    .then(function(r){ return r.json(); })
    .then(function(r){
      if(r&&r.ok){ toast('已删除环境 Profile（hermes profile delete）'); closePersonaModal(); if(_persona===id){ _persona='default'; _personaPrompt=''; } fetchProfiles(function(){ renderPersonas(); }); }
      else toast('删除失败：'+(r&&r.error||'服务器没有返回删除原因'));
    }).catch(function(){ toast('删除失败'); });
}
// ── 每个 Agent 的专属 API 密钥配置（独立 .env）──────────────────────────
var _envProfileId = null;
var _envProfileName = '';
// 模型名 → 推荐 API 密钥（按前缀匹配，供 API 密钥面板联动提示）
var MODEL_KEY_RULES = [
  { re: /deepseek/i, key: 'DEEPSEEK_API_KEY', label: 'DeepSeek' },
  { re: /glm|zhipu|chatglm/i, key: 'GLM_API_KEY', label: '智谱 GLM' },
  { re: /moonshot|kimi/i, key: 'MOONSHOT_API_KEY', label: 'Moonshot Kimi' },
  { re: /minimax/i, key: 'MINIMAX_API_KEY', label: 'MiniMax' },
  { re: /qwen/i, key: 'QWEN_API_KEY', label: '通义千问 Qwen' },
  { re: /gpt|openai|o[0-9]/i, key: 'OPENAI_API_KEY', label: 'OpenAI' },
  { re: /claude|anthropic/i, key: 'ANTHROPIC_API_KEY', label: 'Anthropic Claude' },
  { re: /gemini/i, key: 'GEMINI_API_KEY', label: 'Google Gemini' },
  { re: /grok|xai/i, key: 'XAI_API_KEY', label: 'xAI Grok' },
  { re: /sensenova|sensen|sense/i, key: 'SENSENOVA_API_KEY', label: '商汤 SenseNova' },
  { re: /ollama/i, key: 'OLLAMA_BASE_URL', label: 'Ollama' },
];
function modelKeyRule(modelId){
  var m = String(modelId||'');
  for(var i=0;i<MODEL_KEY_RULES.length;i++){
    if(MODEL_KEY_RULES[i].re.test(m)) return MODEL_KEY_RULES[i];
  }
  return null;
}
function openPersonaEnvEditor(id, name){
  _envProfileId = id; _envProfileName = name || id;
  var prof = null;
  try { prof = _profiles.find(function(x){ return x.id===id; }); } catch(e){}
  var curModel = (prof && prof.model) ? String(prof.model).trim() : '';
  var rule = modelKeyRule(curModel);
  var m = document.getElementById('personaEnvModal');
  if(!m){
    m = document.createElement('div');
    m.id = 'personaEnvModal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:none;align-items:center;justify-content:center;z-index:9999';
    m.innerHTML = '<div style="background:var(--card);border:1px solid var(--border);border-radius:12px;width:min(560px,92vw);max-height:84vh;display:flex;flex-direction:column">'+
      '<div id="envModalTitle" style="padding:14px 16px;font-weight:600;border-bottom:1px solid var(--border)">🔑 配置 API 密钥</div>'+
      '<div id="envModalBody" style="padding:14px 16px;overflow:auto;flex:1"></div>'+
      '<div id="envModalFoot" style="padding:12px 16px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end">'+
        '<button class="btn" onclick="closePersonaEnvEditor()">取消</button>'+
        '<button class="btn primary" onclick="savePersonaEnv()">保存并重启网关</button>'+
      '</div></div>';
    document.body.appendChild(m);
  }
  document.getElementById('envModalTitle').textContent = '🔑 '+name+' 的 API 密钥';
  var body = document.getElementById('envModalBody');
  body.innerHTML = '<div class="conn-hint" style="font-size:12px;margin-bottom:10px;line-height:1.6">每个 Agent 是独立环境，可配置专属密钥（写入该 Agent 的 .env，保存后网关自动重启生效）。<br>已有密钥仅显示前 4 位；输入新值覆盖，清空输入框并保存 = 删除该密钥（留空密钥时回落到全局默认 .env）。</div>';
  // 当前模型联动提示：直接定位该模型所需的 API 密钥
  if(curModel){
    body.innerHTML += '<div style="font-size:11px;margin-bottom:10px;padding:7px 9px;border-radius:6px;background:'+(rule?'var(--accent-bg)':'var(--bg1)')+';border:1px solid '+(rule?'var(--accent)':'var(--border)')+';line-height:1.6">'+
      '当前模型：<b>'+esc(curModel)+'</b>'+(rule ? ' → 对应密钥 <b style="color:var(--accent)">'+esc(rule.key)+'</b>（下方 ★ 高亮行，填入该服务商密钥即可）' : '，未匹配到常用密钥，请在下方「自定义变量」添加对应服务商密钥')+'</div>';
  }
  body.innerHTML += '<div style="font-size:12px;font-weight:600;margin-bottom:6px">常用密钥</div>';
  var commonKeys = ['OPENAI_API_KEY','ANTHROPIC_API_KEY','KIMI_API_KEY','MOONSHOT_API_KEY','MINIMAX_API_KEY','QWEN_API_KEY','DEEPSEEK_API_KEY','GLM_API_KEY','ZHIPU_API_KEY','XAI_API_KEY','SENSENOVA_API_KEY','GEMINI_API_KEY','OLLAMA_BASE_URL'];
  var known = {}; commonKeys.forEach(function(k){ known[k]=1; });
  body.innerHTML += '<div id="envCommonWrap" style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px">'+commonKeys.map(function(k){ return envKeyRowHtml(k, '', rule && rule.key===k); }).join('')+'</div>';
  body.innerHTML += '<div style="font-size:12px;font-weight:600;margin-bottom:6px">自定义变量 <button class="btn sm" onclick="addEnvCustomRow()">+ 添加</button></div>';
  body.innerHTML += '<div id="envCustomWrap" style="display:flex;flex-direction:column;gap:8px"></div>';
  // 读取当前值（脱敏）填入 placeholder
  apiGet('/api/profiles/'+encodeURIComponent(id)+'/env').then(function(res){
    if(!res || res.error) return;
    Object.keys(res.env||{}).forEach(function(k){
      if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return; // 过滤非法键名（如误入的 "model: xxx"），避免假键混入
      var inp = document.getElementById('env_inp_'+k);
      if(inp){ inp.placeholder = res.env[k]; }
      else {
        // 自定义键已有值：追加一行
        addEnvCustomRow(k, res.env[k]);
      }
    });
  }).catch(function(){});
  m.style.display = 'flex';
}
function envKeyRowHtml(key, placeholder, hl){
  var border = hl ? 'border:1.5px solid var(--accent);background:var(--accent-bg)' : 'border:1px solid var(--border);background:var(--bg1)';
  return '<div style="display:flex;gap:8px;align-items:center'+(hl?';background:var(--accent-bg);border-radius:6px;padding:4px 6px;margin:-4px -6px':'')+'">'+
    '<label style="width:180px;font-size:11px;color:'+(hl?'var(--accent)':'var(--muted)')+';flex-shrink:0;font-weight:'+(hl?'600':'400')+'">'+esc(key)+(hl?' ★':'')+'</label>'+
    '<input type="password" id="env_inp_'+esc(key)+'" class="env-inp" placeholder="'+(placeholder||'未配置')+'" style="flex:1;padding:7px 10px;border-radius:6px;color:var(--text);'+border+'"></div>';
}
function addEnvCustomRow(key, placeholder){
  var wrap = document.getElementById('envCustomWrap'); if(!wrap) return;
  var k = key || ''; var ph = placeholder || '';
  var row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;align-items:center';
  row.innerHTML = '<input type="text" class="env-custom-key" placeholder="变量名（如 MY_API_KEY）" value="'+DOM.escAttr(k)+'" style="width:180px;padding:7px 10px;border-radius:6px;background:var(--bg1);color:var(--text);border:1px solid var(--border);flex-shrink:0;font-size:12px">'+
    '<input type="password" class="env-inp" placeholder="'+(ph||'值')+'" style="flex:1;padding:7px 10px;border-radius:6px;background:var(--bg1);color:var(--text);border:1px solid var(--border);font-size:12px">'+
    '<button class="btn sm danger" aria-label="移除此环境变量" title="移除此环境变量" onclick="this.parentElement.remove()" style="flex-shrink:0">✕</button>';
  wrap.appendChild(row);
}
function closePersonaEnvEditor(){ var m=document.getElementById('personaEnvModal'); if(m) m.style.display='none'; }
function savePersonaEnv(){
  var env = {};
  var skipped = 0;
  // 常用键区
  document.querySelectorAll('#envCommonWrap .env-inp').forEach(function(inp){
    var key = inp.id.replace('env_inp_','');
    var val = inp.value.trim();
    if(!val){ if(inp.placeholder && inp.placeholder !== '未配置' && inp.placeholder !== '值') env[key] = ''; else skipped++; return; }
    if(val === inp.placeholder) { skipped++; return; } // 未修改
    env[key] = val;
  });
  // 自定义键区：仅提交键名非空的行；值空且 placeholder 有原值 → 删除
  document.querySelectorAll('#envCustomWrap .env-custom-key').forEach(function(kInp, i){
    var key = kInp.value.trim();
    if(!key) return;
    var vInp = kInp.parentElement.querySelector('.env-inp');
    var val = vInp ? vInp.value.trim() : '';
    if(val){ env[key] = val; }
    else if(vInp && vInp.placeholder && vInp.placeholder !== '值'){ env[key] = ''; }
  });
  var keys = Object.keys(env);
  if(!keys.length){ toast('没有需要保存的变更'); return; }
  toast('正在保存 '+keys.length+' 个密钥…');
  api('/api/profiles/'+encodeURIComponent(_envProfileId)+'/env', 'PUT', { env: env }).then(function(r){
    if(r && r.ok){
      toast('已保存，网关正在重启生效');
      closePersonaEnvEditor();
      fetchProfiles(function(){ renderPersonas(); });
    } else toast('保存失败：'+(r&&r.error||'服务器没有返回保存原因'));
  }).catch(function(){ toast('保存失败：网络错误'); });
}
function selectPersona(id){
  _persona = id;
  var p = _profiles.find(function(x){ return x.id===id; });
  _personaPrompt = (p && p.prompt) ? p.prompt : '';
  _cfg.extensions.persona = id;
  if(window.chatState) chatState.persona = id;
  try { localStorage.setItem('hermes_persona', id); } catch(e){}
  // 切换 Agent 后若对话区为空，立即重渲染个性化欢迎页（快捷提问随专家变化）
  var chatBody=document.getElementById('chatBody');
  if(chatBody && !chatBody.querySelector('.msg')){ try{ chatBody.innerHTML = welcomeHTML(); }catch(e){} }
  _selectedExpert = null;
  try { localStorage.removeItem('hermes_selected_expert'); } catch(e){}
  renderSelectedExpertBar();
  // 调用后端激活 profile（hermes profile use + 触发网关重载配置）
  toast('正在切换 Agent…（hermes profile use '+id+'）');
  // profilefix v3（模型 A）：fetchProfiles 放在 activate 成功后再拉取，
  // 避免竞态（activate 未完成时 is_active 还是旧值，会把刚选的 _persona 覆盖回去）
  apiPost('/api/profiles/'+encodeURIComponent(id)+'/activate', {}).then(function(r){
    if(r&&r.ok) toast('已切换到 Agent：'+(p?p.name:id)+'（网关将重载配置）');
    fetchProfiles(function(){ renderPersonas(); });
  }).catch(function(){ fetchProfiles(function(){ renderPersonas(); }); });
  saveConfig();
}
/* 与某个 Agent 直接对话：激活该 Agent + 打开其专属会话（独立分组，复用既有会话）并跳转对话页 */
function chatWithPersona(id){
  var p=_profiles.find(function(x){ return x.id===id; });
  if(!p){ toast('未找到该 Agent'); return; }
  if(p.is_default){
    // 默认助手：常规新会话（归入 default 分组），仅激活 + 新建 + 跳转对话页
    selectPersona(id);
    newTab();
    switchPage('chat');
    var ta=document.getElementById('chatInput'); if(ta){ try{ ta.focus(); }catch(e){} }
    return;
  }
  selectPersona(id); // 激活 profile（hermes profile use + 网关重载）
  // 互斥：停用工作流 & 专家团（与扩展页专家独立会话一致），确保会话归入该 Agent 分组
  var agentId='p-'+id;
  ensureAgent(agentId, { name:p.name||id, icon:(p.emoji||'🤖'), profileId:id });
  function openChat(){
    switchPage('chat');
    var ta=document.getElementById('chatInput'); if(ta){ try{ ta.focus(); }catch(e){} }
    var t=document.getElementById('chatTitle'); if(t) t.textContent=p.name||id;
  }
  // profilefix v4（模型 A）：会话不分归属，直接新建对话
  var existing=null;
  if(existing){
    switchSession(agentId, existing.id);
    openChat();
    toast('已打开与「'+(p.name||id)+'」的对话');
    return;
  }
  fetch(apiUrl('/api/sessions'), { method:'POST', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
    .then(function(r){ return r.json(); })
    .then(function(s){
      _sessions.unshift(s);
      currentSession=s.id; currentAgent=agentId;
      _openTabs.push(s.id); persistTabs();
      renderSessionTabs(); renderRail(); updateHeader();
      if(window.innerWidth<=768) closeRailDrawer();
      var body=document.getElementById('chatBody');
      if(body && !body.querySelector('.msg')){ try{ body.innerHTML=welcomeHTML(); }catch(e){} }
      openChat();
      toast('已创建与「'+(p.name||id)+'」的新会话');
    })
    .catch(function(){ toast('创建会话失败'); });
}
var _expFilter=''; var _expDept='';
function renderExperts(){
  var el=document.getElementById('expertGrid'); if(!el) return;
  // 兜底（Issue #1）：若专家库尚未加载，轮询强制重新拉取（带缓存破坏），最多 5 次；避免一直停留 8 个样例
  if(!(window.AGENCY_PERSONAS && window.AGENCY_PERSONAS.length)){
    if(!window.__personasRetry){
      window.__personasRetry = true;
      var tries = 0;
      (function poll(){
        ensurePersonasLibrary(function(){
          tries++;
          if(window.AGENCY_PERSONAS && window.AGENCY_PERSONAS.length){
            renderExperts();
          } else if(tries < 5){
            setTimeout(poll, 600);
          } else {
            renderExperts(); // 最终以 PV.experts(8 个) 兜底，并保留重试标记以便下次进入时再试
          }
        });
      })();
    }
  }
  window.__expRendered = true;
  var list = expertsList();
  var cnt=document.getElementById('expCount');
  if(cnt){ cnt.textContent = (window.AGENCY_PERSONAS && window.AGENCY_PERSONAS.length) ? ('共 '+list.length+' 位专家') : '专家库加载中…'; }
  var deptWrap=document.getElementById('expDepts');
  var depts = (window.AGENCY_DEPTS && window.AGENCY_DEPTS.length) ? window.AGENCY_DEPTS : [];
  if(deptWrap){
    var dhtml='<div class="exp-dept'+(!_expDept?' active':'')+'" onclick="filterDept(this,\'\')">全部 <span class="cnt">'+list.length+'</span></div>';
    depts.forEach(function(d){ dhtml+='<div class="exp-dept'+(d.id===_expDept?' active':'')+'" onclick="filterDept(this,\''+esc(d.id)+'\')">'+esc(d.label||d.id)+' <span class="cnt">'+esc(d.count||'')+'</span></div>'; });
    deptWrap.innerHTML=dhtml;
  }
  var term=(document.getElementById('expSearch')?document.getElementById('expSearch').value:'').toLowerCase();
  var favs=_cfg.extensions.expert_favorites||[];
  el.innerHTML = list.filter(function(e){
    return (!_expDept || (e.deptId||'')===_expDept) && (!term || (e.name||'').toLowerCase().indexOf(term)>=0);
  }).map(function(e){
    var isFav = favs.indexOf(e.id)>=0;
    return '<div class="ext-card">'+
      '<div class="top"><div class="icon">'+(e.icon||'🎯')+'</div><div><div class="name">'+esc(e.name)+'</div><div class="status">'+esc(e.dept||'')+'</div></div></div>'+
      '<div class="actions">'+
        '<button class="btn" onclick="useExpert(\''+esc(e.id)+'\')">使用</button>'+
        '<button class="btn secondary" onclick="favExpert(\''+esc(e.id)+'\')">'+(isFav?'已收藏':'收藏')+'</button>'+
      '</div></div>';
  }).join('') || '<div class="empty-state">没有匹配的专家。</div>';
  renderSelectedExpertBar();
}
function filterDept(el, dept){
  _expDept=dept;
  document.querySelectorAll('.exp-dept').forEach(function(d){ d.classList.remove('active'); });
  el.classList.add('active');
  renderExperts();
}
function useExpert(id){
  var list=expertsList(); var e=list.find(function(x){ return x.id===id; });
  if(!e) return;
  // 复用工具栏专家选择器逻辑：为专家创建独立会话分组（Issue #6）
  pickItemExpert(id, null);
}
function favExpert(id){
  if(!_cfg.extensions.expert_favorites) _cfg.extensions.expert_favorites=[];
  var arr=_cfg.extensions.expert_favorites;
  var idx=arr.indexOf(id);
  if(idx>=0) arr.splice(idx,1); else arr.push(id);
  saveConfig(); renderExperts();
  toast(idx>=0?'已取消收藏':'已收藏该专家');
}
function clearSelectedExpert(){
  _selectedExpert=null; renderSelectedExpertBar(); toast('已清除选用的专家');
}
function renderSelectedExpertBar(){
  var bar=document.getElementById('selectedExpertBar'); if(!bar) return;
  if(_selectedExpert){
    bar.style.display='flex';
    bar.innerHTML='<span class="seb-label">当前已选用：</span><strong>'+esc(_selectedExpert.name||'')+'</strong><button class="btn sm" onclick="clearSelectedExpert()">清除</button>';
  } else {
    bar.style.display='none'; bar.innerHTML='';
  }
}

/* 工具服务管理由 panel-mcp-ui.js 提供。 */