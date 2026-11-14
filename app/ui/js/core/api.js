/* API 基础：BASE、请求封装、401 统一兜底与设备授权硬锁
 * 来源：index.html 内联 app.js 第 118-225 行（共 108 行）
 * 2026-11-13 按原分区纯搬运外移，逻辑零改动。全局作用域与执行顺序与原内联块一致。 */

/* ============================ API 基础 ============================ */
function _resolveBase(){
  try {
    var b = document.querySelector('base');
    var href = (b && b.getAttribute('href')) || document.baseURI || window.location.pathname;
    var path = String(href).split('?')[0].split('#')[0];
    if (/\/[^\/]+\.[a-zA-Z0-9]+$/.test(path)) path = path.replace(/\/[^\/]+\.[a-zA-Z0-9]+$/, '');
    path = path.replace(/\/$/, '');
    return path;
  } catch(e){ return (window.location.pathname||'').replace(/\/$/,''); }
}
/* 2026-11-12：BASE 原先只在 DOMContentLoaded 里赋值。经 fnOS 5666 门户（/app/hermes-agent/ 前缀）
   打开时，页面脚本在 DOMContentLoaded 之前发起的第一个请求（panel-auth/bootstrap、workspace-ui）
   拿到 BASE='' → 请求打到门户根 /api/... → 404，且仅在这个前缀下复现（root 直连看不出来）。
   改成调用即取，绝不再返回只有路径没有前缀的 URL。 */
function apiUrl(p){
  if(!BASE) BASE = _resolveBase();
  if(BASE) return BASE + p;
  var m = String(window.location.pathname||'').match(/^(\/app\/[^\/]+)/);
  return (m ? m[1] : '') + p;
}

var _tokenLoading=null;
function fetchToken(){
  if(_tokenLoading)return _tokenLoading;
  _tokenLoading=fetch(apiUrl('/api/panel-auth/bootstrap'),{cache:'no-store'}).then(function(r){
    if(!r.ok){if(r.status===401){monitorToken='';if(typeof panelAuthExpired==='function')panelAuthExpired();}return null;}
    return r.json();
  }).then(function(d){if(d&&d.token){monitorToken=d.token;try{localStorage.setItem('panel-device-token',d.token);}catch(e){}}return d;}).catch(function(){return null;}).finally(function(){_tokenLoading=null;});
  return _tokenLoading;
}

/* 抛 HTTP 错误（网络 / 状态码） */
function api(path, method, body){
  method = method || 'GET';
  var headers = { 'Content-Type':'application/json' };
  if(monitorToken) headers['X-Monitor-Token'] = monitorToken;
  var opts = { method:method, headers:headers, cache:'no-store' };
  if(body) opts.body = JSON.stringify(body);
  return fetch(apiUrl(path), opts).then(function(r){
    if(!r.ok){
      return r.json().catch(function(){ return null; }).then(function(j){
        var error=new Error((j && j.error) ? (j.error+' (HTTP '+r.status+')') : ('HTTP '+r.status));error.status=r.status;error.data=j;error.undo_id=j&&j.undo_id||null;throw error;
      });
    }
    return r.json();
  });
}
/* 不抛逻辑错误，返回原始 JSON（便于读取 {ok:false,error}） */
function apiGet(path){ return api(path,'GET').catch(function(e){ return { ok:false, error:e.message }; }); }
function apiPost(path, body){ return api(path,'POST',body).catch(function(e){ return { ok:false, error:e.message }; }); }

// ── 设备授权失效：整页硬锁 ────────────────────────────────────────────
// 面板壳子是静态资源，不带设备也能下发；接口才要设备。所以授权失效后骨架、
// 侧栏、已渲染的通道会话全都还在，看着能点，其实每个请求都是 401。
// 这里一旦确认 401 pairing_required，就把整个应用盖死，只留重新授权入口。
var _authWallShown = false;
function panelAuthWall(message){
  if(_authWallShown) return;
  _authWallShown = true;
  monitorToken = '';
  try { localStorage.removeItem('panel-device-token'); } catch(e) {}
  try { document.documentElement.style.overflow = 'hidden'; } catch(e) {}
  var wall = document.createElement('div');
  wall.id = 'panel-auth-wall';
  wall.setAttribute('role','alertdialog');
  wall.style.cssText = 'position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;background:#0f161d;padding:24px;box-sizing:border-box';
  var card = document.createElement('div');
  card.style.cssText = 'width:min(440px,100%);box-sizing:border-box;background:#16202a;border:1px solid #2b3c4b;border-radius:14px;padding:26px;color:#e9eef3;font:15px/1.65 system-ui,-apple-system,sans-serif';
  var h = document.createElement('h2');
  h.textContent = '设备授权已失效';
  h.style.cssText = 'margin:0 0 10px;font-size:19px';
  var p = document.createElement('p');
  p.textContent = message || '此浏览器对面板的设备授权已过期或被撤销，页面数据已锁定。';
  p.style.cssText = 'margin:0 0 8px;color:#bac8d5';
  var hint = document.createElement('p');
  hint.textContent = '重新打开面板即可重新授权；飞牛 App 内直接重试即可。';
  hint.style.cssText = 'margin:0 0 18px;color:#8fa1b0;font-size:13px';
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '重新授权';
  btn.style.cssText = 'width:100%;padding:12px;border:0;border-radius:10px;background:#6cd9bf;color:#122c27;font:inherit;cursor:pointer';
  btn.onclick = function(){ try { localStorage.removeItem('panel-device-token'); } catch(e) {} location.reload(); };
  card.appendChild(h); card.appendChild(p); card.appendChild(hint); card.appendChild(btn);
  wall.appendChild(card);
  document.body.appendChild(wall);
}
window.panelAuthWall = panelAuthWall;

// 统一 401 兜底：旧逻辑只有「保存草稿」遇到 401 才提示，其它接口静默失败，
// 于是授权失效后还能翻子页面、还能看到已渲染的通道会话。这里在请求层统一拦。
(function(){
  if(typeof window.fetch !== 'function') return;
  var raw = window.fetch.bind(window);
  window.fetch = function(input, init){
    return raw(input, init).then(function(r){
      if(r && r.status === 401){
        var url = '';
        try { url = typeof input === 'string' ? input : ((input && input.url) || ''); } catch(e) {}
        if(!/\/api\/panel-auth\/pair\b/.test(url)){
          try { r.clone().json().then(function(d){ if(d && d.pairing_required) panelAuthWall(d.error); }).catch(function(){}); } catch(e) {}
        }
      }
      return r;
    });
  };
})();