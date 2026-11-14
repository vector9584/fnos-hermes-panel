/* 模型 / Provider 切换
 * 来源：index.html 内联 app.js 第 6153-6215 行（共 63 行）
 * 2026-11-13 按原分区纯搬运外移，逻辑零改动。全局作用域与执行顺序与原内联块一致。 */

/* ============================ 模型 / Provider ============================ */
function loadConfig(){
  return apiGet('/api/config').then(function(cfg){
    if(cfg && !cfg.error){
      _cfg = cfg;
      // hermes 是否已配置模型（服务端判定：config.yaml 含 model/providers 段）
      window.__hermesConfigured = (cfg.hermes_configured !== false);
      if(!_cfg.extensions) _cfg.extensions = { toolsets:{}, mcp_servers:[], skills_dirs:[], persona:'default', memory:{enabled:true,char_limit:2200}, team:[], team_name:'' };
      if(!_cfg.extensions.toolsets) _cfg.extensions.toolsets = {};
      if(!_cfg.extensions.memory) _cfg.extensions.memory = {enabled:true,char_limit:2200};
      if(!_cfg.extensions.memory.policy) _cfg.extensions.memory.policy = {};
      if(!_cfg.extensions.tools_config) _cfg.extensions.tools_config = {};
      if(!_cfg.extensions.expert_favorites) _cfg.extensions.expert_favorites = [];
      if(!_cfg.extensions.external_resources) _cfg.extensions.external_resources = {};
      if(!_cfg.extensions.workflow) _cfg.extensions.workflow = { enabled:false, active:false };
      else if(_cfg.extensions.workflow.active == null) _cfg.extensions.workflow.active = false;
      if(!_cfg.extensions.tools_config) _cfg.extensions.tools_config = {};
      if(!_cfg.extensions.expert_favorites) _cfg.extensions.expert_favorites = [];
      if(_cfg.extensions.persona===undefined) _cfg.extensions.persona = 'default';
      if(!_cfg.extensions.persona) _cfg.extensions.persona = 'default';
      if(!_cfg.extensions.external_resources) _cfg.extensions.external_resources = { superpowers_zh:{enabled:false,path:'skills/superpowers-zh'}, ai_coding_guide:{enabled:false,url:'https://github.com/jnMetaCode/ai-coding-guide'}, shellward:{enabled:false,mode:'audit',mcp:{command:'shellward',args:['shellward-mcp']}} };
      if(!_cfg.extensions.memory.policy) _cfg.extensions.memory.policy = {};
      if(!_cfg.extensions.workflow || typeof _cfg.extensions.workflow!=='object') _cfg.extensions.workflow = { enabled:false, active:false, key:'', name:'', concurrency:2, category:'', inputs:[], steps:[] };
      if(_cfg.extensions.workflow.active===undefined) _cfg.extensions.workflow.active = false;
      // profilefix v3（模型 A）：_persona 不再从 config 恢复（config 是旧 UI 持久层，
      // 可能落后于后端 .active_profile）——由 fetchProfiles 完成后按 is_active 同步。
      // Issue #7：清缓存/换浏览器后，从服务端恢复会话角色分组与会话→分组映射
      // Issue #7：始终以服务端持久化的角色分组与会话→分组映射为准（清缓存/换浏览器后恢复，
      // 且不被本地可能已失效的旧值遮蔽，否则会出现「所有会话挤在默认分组」的观感）。
      if(Array.isArray(_cfg.extensions.agents) && _cfg.extensions.agents.length){
        _agents = _cfg.extensions.agents.slice();
        if(!_agents.some(function(a){ return a.id==='default'; })) _agents.unshift({ id:'default', name:'默认主力助手', icon:'🤖', expertId:null });
      }
      // 未配置模型时强制只保留默认分组：残留的专家/团队分组无意义，
      // 且 saveAgents 回写 localStorage 后会顺便清掉浏览器端的旧残留
      if(_cfg.hermes_configured === false){
        _agents = [{ id:'default', name:'默认主力助手', icon:'🤖', expertId:null }];
      }
      renderConfigBanner();
      _settingsLoaded = true;
    } else {
      toast('读取配置失败：'+(cfg&&cfg.error||'服务器没有返回配置读取原因'));
    }
    return _cfg;
  }).catch(function(e){ toast('读取配置失败：'+e.message); return _cfg; });
}
/* 未配置模型的提示：2026-11-14 起不再往聊天页 DOM 里插一条 #modelConfigBanner，
   改走统一通知组件（key='model-config'）。语义不变：提醒 + 一键去「模型」页。 */
function renderConfigBanner(){
  if(window.__hermesConfigured !== false){
    if(window.__hzToast && window.__hzToast.dismiss) window.__hzToast.dismiss('model-config');
    return;
  }
  if(!window.__hzToast) return;
  window.__hzToast({
    key:'model-config', type:'warning', duration:0,
    title:'尚未配置模型服务，聊天暂时不可用',
    message:'先添加一个模型供应商并填写 API Key，配好就能直接对话。',
    actions:[
      {label:'稍后', onClick:'close'},
      {label:'去配置模型', primary:true, onClick:function(){ switchPage('models'); }}
    ]
  });
}
/* 模型管理由 panel-models-ui.js 提供。 */