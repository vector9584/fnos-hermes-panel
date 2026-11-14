/* 主题切换
 * 来源：index.html 内联 app.js 第 5670-5693 行（共 24 行）
 * 2026-11-13 按原分区纯搬运外移，逻辑零改动。全局作用域与执行顺序与原内联块一致。 */

/* ============================ Theme ============================ */
function setTheme(mode){
  currentTheme=mode;
  document.body.classList.remove('theme-light','theme-dark');
  if(mode==='light'){ document.body.classList.add('theme-light'); }
  else if(mode==='dark'){ document.body.classList.add('theme-dark'); }
  else {
    if(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) document.body.classList.add('theme-dark');
    else document.body.classList.add('theme-light');
  }
  document.querySelectorAll('.glob-btn').forEach(function(b){ b.classList.remove('active'); });
  var map={'auto':'btnThemeAuto','light':'btnThemeLight','dark':'btnThemeDark'};
  var id=map[mode]; if(id){ var b=document.getElementById(id); if(b) b.classList.add('active'); }
  try { localStorage.setItem('fnos-theme-mode', mode); } catch(e){}
  syncWordmark();
}

/* 顶栏词标：src 由 apiUrl() 拼（自带 /app/<app> 前缀，经门户打开也取得到），
   按主题选深/浅两张，全挂就退成文字。2026-11-12 取代原来的 CSS mask。 */
function syncWordmark(){
  /* 词标已不再走网络图：css/panel-wordmark.css 用 base64 遮罩 + currentColor，
     主题/连接态全靠 CSS 变量自动跟随。空壳保留，避免历史调用点 ReferenceError。 */
}