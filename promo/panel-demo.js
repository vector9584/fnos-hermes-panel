(() => {
'use strict';
/* 首页七章 · 真实面板仿真（注入式，不替换 index.html 的深色仪器主体）
   视觉语言 1:1 取自 app/ui/css/base.css 的浅色面板：
   --bg0:#eef0f4  --card:#fff  --border:#d0d4da  --text:#1f2937
   --accent:#5e64f3  --accent-bg:#e8eafe  --success:#16a34a  --warning:#f59e0b */
const NAV = [
  { id: 'chat', title: '对话', icon: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7A8.38 8.38 0 0 1 4 11.5a8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>' },
  { id: 'collaboration', title: '协作', icon: '<circle cx="9" cy="7" r="3"/><circle cx="17" cy="7" r="3"/><path d="M5 21v-2a4 4 0 0 1 4-4h2"/><path d="M13 21v-2a4 4 0 0 1 4-4h2"/>' },
  { id: 'tasks', title: '任务', icon: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>' },
  { id: 'materials', title: '档案', icon: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>' },
  { id: 'capabilities', title: '能力', icon: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>' },
  { id: 'models', title: '模型', icon: '<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>' },
  { id: 'maintenance', title: '维护', icon: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>' },
  { id: 'settings', title: '设置', icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>' },
];
const css = document.createElement('style');
css.textContent = `
.pd-shell{--pbg:#eef0f4;--pcard:#fff;--pbd:#d0d4da;--pt:#1f2937;--pt3:#6b7280;--pac:#5e64f3;--pacbg:#e8eafe;--pok:#16a34a;--pwarn:#f59e0b;--pred:#ef4444;
  background:var(--pbg);color:var(--pt);border:1px solid var(--pbd);border-radius:12px;overflow:hidden;
  font:13px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,'PingFang SC','Microsoft YaHei',sans-serif;
  text-align:left;box-shadow:0 18px 40px -22px rgba(0,0,0,.6)}
.pd-shell *{box-sizing:border-box;margin:0}
.pd-shell button{font:inherit;cursor:pointer;border:0;background:none;color:inherit}
.pd-tagbar{display:flex;align-items:center;gap:10px;padding:8px 12px;background:#fff;border-bottom:1px solid var(--pbd);font-size:11px;color:var(--pt3)}
.pd-tagbar b{color:var(--pt);font-weight:600}
.pd-lay{display:flex;min-height:0}
.pd-side{flex:0 0 64px;background:#fff;border-right:1px solid var(--pbd);padding:6px 0;display:flex;flex-direction:column;gap:2px}
.pd-navbtn{display:flex;flex-direction:column;align-items:center;gap:3px;padding:7px 2px;border-radius:8px;font-size:10px;color:var(--pt3);margin:0 4px;transition:.15s}
.pd-navbtn svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.pd-navbtn.on{background:var(--pacbg);color:var(--pac)}
.pd-navbtn:hover{background:#f4f5f7}
.pd-col{flex:0 0 168px;background:#fff;border-right:1px solid var(--pbd);display:flex;flex-direction:column}
.pd-colhead{padding:10px 12px;font-size:11px;color:var(--pt3);border-bottom:1px solid #e5e7eb;display:flex;justify-content:space-between;align-items:center}
.pd-sess{padding:9px 12px;border-bottom:1px solid #f0f1f3;cursor:pointer;transition:.15s}
.pd-sess:hover{background:#f7f8fa}
.pd-sess.on{background:var(--pacbg)}
.pd-sess b{display:block;font-size:12px;font-weight:500;color:var(--pt);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pd-sess em{display:block;font-size:10px;color:var(--pt3);font-style:normal;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pd-main{flex:1;min-width:0;display:flex;flex-direction:column;background:var(--pbg)}
.pd-chathead{padding:10px 14px;background:#fff;border-bottom:1px solid var(--pbd);display:flex;justify-content:space-between;align-items:center;gap:10px}
.pd-chathead b{font-size:13px;font-weight:600}
.pd-chathead span{font-size:11px;color:var(--pt3)}
.pd-body{flex:1;min-height:0;padding:14px;display:flex;flex-direction:column;gap:10px;overflow:auto}
.pd-msg{max-width:78%;display:flex;flex-direction:column;gap:3px}
.pd-msg.you{align-self:flex-end;align-items:flex-end}
.pd-msg .sender{font-size:10px;color:var(--pt3)}
.pd-bubble{padding:9px 12px;border-radius:12px;font-size:13px;line-height:1.55;background:#fff;border:1px solid #e5e7eb;color:var(--pt)}
.pd-msg.you .pd-bubble{background:var(--pac);border-color:var(--pac);color:#fff}
.pd-composer{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#fff;border-top:1px solid var(--pbd)}
.pd-composer input{flex:1;border:1px solid var(--pbd);border-radius:8px;padding:9px 12px;font:inherit;font-size:13px;color:var(--pt);outline:none;background:var(--pbg)}
.pd-composer .mic{border-radius:8px;padding:8px 11px;background:var(--pbg);color:var(--pt3);font-size:13px}
.pd-composer .mic svg{width:15px;height:15px;display:block}
.pd-composer .send{border-radius:8px;padding:8px 13px;background:var(--pac);color:#fff;font-size:13px}
.pd-step{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;background:#fff;border:1px solid #e5e7eb;border-radius:10px}
.pd-step s{font-style:normal;width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;flex:none;margin-top:1px}
.pd-step.ok s{background:var(--pok);color:#fff}
.pd-step.warn s{background:var(--pwarn);color:#fff}
.pd-step.wait s{background:#fff;color:var(--pwarn);border:1px solid var(--pwarn)}
.pd-step b{display:block;font-size:12.5px;font-weight:500}
.pd-step em{display:block;font-size:11px;color:var(--pt3);font-style:normal;margin-top:2px}
.pd-step.you{align-self:flex-end;background:var(--pac);border-color:var(--pac)}
.pd-step.you b,.pd-step.you em{color:#fff}
.pd-switch{display:flex;align-items:center;gap:12px;padding:11px 12px;background:#fff;border:1px solid #e5e7eb;border-radius:10px}
.pd-switch .nm{font-size:12.5px;font-weight:500}
.pd-switch .ds{font-size:11px;color:var(--pt3);margin-top:2px}
.pd-switch .tg{margin-left:auto;flex:none;width:34px;height:20px;border-radius:10px;background:#cbd0d8;position:relative;transition:.18s}
.pd-switch .tg::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:.18s;box-shadow:0 1px 2px rgba(0,0,0,.25)}
.pd-switch.on .tg{background:var(--pac)}
.pd-switch.on .tg::after{left:16px}
.pd-model{display:flex;flex-direction:column;gap:4px;padding:11px 12px;background:#fff;border:1px solid #e5e7eb;border-radius:10px;cursor:pointer;transition:.15s}
.pd-model:hover{border-color:var(--pac)}
.pd-model.on{border-color:var(--pac);background:var(--pacbg)}
.pd-model b{font-size:12.5px;font-weight:500}
.pd-model em{font-size:11px;color:var(--pt3);font-style:normal}
.pd-model .bar{height:4px;border-radius:2px;background:#e5e7eb;margin-top:7px;overflow:hidden}
.pd-model .bar i{display:block;height:100%;background:var(--pac)}
.pd-grid{display:grid;gap:10px}
.pd-note{font-size:11px;color:var(--pt3);line-height:1.6}
.pd-badge{display:inline-block;padding:2px 8px;border-radius:6px;font-size:10.5px;font-weight:500}
.pd-badge.ok{background:#dcfce7;color:#166534}
.pd-badge.wait{background:#fef3c7;color:#92400e}
.pd-badge.run{background:var(--pacbg);color:var(--pac)}
@media(max-width:560px){.pd-col{display:none}.pd-side{flex:0 0 50px}.pd-navbtn{font-size:9px}.pd-msg{max-width:92%}}
`;
document.head.append(css);

const esc = t => String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const svg = p => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
const side = active => '<div class="pd-side">' + NAV.map(n =>
  `<button type="button" class="pd-navbtn${n.id===active?' on':''}" data-nav="${n.id}" aria-pressed="${n.id===active}" title="${n.title}">${svg(n.icon)}<span>${n.title}</span></button>`).join('') + '</div>';
const tagbar = (t, sub) => `<div class="pd-tagbar"><b>${t}</b><span>${sub}</span><span style="margin-left:auto">界面演示 · 非实时数据</span></div>`;
const micSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>';
const composer = `<div class="pd-composer"><button class="mic" type="button" title="语音">${micSvg}</button><input placeholder="输入消息…" readonly><button class="send" type="button">发送</button></div>`;

function chapter(n) { return document.getElementById('ch' + n); }

/* ── 1 对话 ── */
function renderChat(root, title, sub, sessions, active, msgs) {
  root.innerHTML = `<div class="pd-shell">${tagbar('对话', '会话')}<div class="pd-lay">${side('chat')}
    <div class="pd-col"><div class="pd-colhead"><span>会话</span><span>${sessions.length} 个</span></div>${sessions.map((s,i)=>`<div class="pd-sess${i===active?' on':''}" data-sess="${i}"><b>${esc(s.t)}</b><em>${esc(s.d)}</em></div>`).join('')}</div>
    <div class="pd-main"><div class="pd-chathead"><div><b>${esc(title)}</b><div style="font-size:10px;color:var(--pt3)">${esc(sub)}</div></div></div>
    <div class="pd-body" data-msgs></div>${composer}</div></div></div>`;
  const body = root.querySelector('[data-msgs]');
  const draw = () => { body.innerHTML = msgs.map(m =>
    m.you ? `<div class="pd-msg you"><div class="sender">你</div><div class="pd-bubble">${m.t}</div></div>`
          : `<div class="pd-msg"><div class="sender">助手</div><div class="pd-bubble">${m.t}</div></div>`).join(''); };
  draw();
  root.addEventListener('click', e => {
    const s = e.target.closest('[data-sess]');
    if (s) { root.querySelectorAll('.pd-sess').forEach((x,i)=>x.classList.toggle('on', +s.dataset.sess===i)); }
    const n = e.target.closest('[data-nav]');
    if (n) { root.querySelectorAll('.pd-navbtn').forEach(x=>x.classList.toggle('on', x===n)); }
  });
}

/* ── 2 看着它干活 ── */
function renderTask(root) {
  const steps = [
    { k:'you', b:'把相册按日期分好，重复的挑出来' },
    { k:'ok', b:'看了一遍相册', d:'1,284 张照片，11 个年份' },
    { k:'ok', b:'按月份分成 11 组', d:'放在「相册整理」里，原图没动' },
    { k:'warn', b:'撞上两个同名文件', d:'换了个比法，接着往下走' },
    { k:'ok', b:'按内容比对，找出 3 组重复', d:'每组 2–4 张' },
    { k:'wait', b:'下一步要删文件，停下来问你', d:'等你说「确认删除」或「保留原图」' },
  ];
  root.innerHTML = `<div class="pd-shell">${tagbar('对话', '整理相册')}<div class="pd-lay">${side('chat')}
    <div class="pd-col"><div class="pd-colhead"><span>进行中</span><span>1 个任务</span></div><div class="pd-sess on"><b>整理相册</b><em>第 4 步 / 共 6 步</em></div><div class="pd-sess"><b>写周报</b><em>排队中</em></div></div>
    <div class="pd-main"><div class="pd-chathead"><div><b>整理相册</b><div style="font-size:10px;color:var(--pt3)">执行过程 · 危险动作先确认</div></div></div>
    <div class="pd-body">${steps.map(s => {
      if (s.k==='you') return `<div class="pd-step you"><div><b>${s.b}</b></div></div>`;
      const mk = s.k==='ok'?'✓':s.k==='warn'?'!':'?';
      return `<div class="pd-step ${s.k}"><s>${mk}</s><div><b>${s.b}</b>${s.d?`<em>${s.d}</em>`:''}</div></div>`;
    }).join('')}</div>${composer}</div></div></div>`;
  root.querySelectorAll('.pd-navbtn').forEach(b => b.addEventListener('click', () => {
    root.querySelectorAll('.pd-navbtn').forEach(x=>x.classList.toggle('on', x===b));
  }));
}

/* ── 3 手机上也能管 ── */
function renderMobile(root) {
  root.innerHTML = `<div class="pd-shell">${tagbar('对话', '手机浏览器')}<div class="pd-lay">
    <div class="pd-main"><div class="pd-chathead"><div><b>整理相册</b><div style="font-size:10px;color:var(--pt3)">同一套面板 · 触屏布局</div></div></div>
    <div class="pd-body" style="gap:8px">
      <div class="pd-msg"><div class="sender">助手</div><div class="pd-bubble">分完了，11 组；重复的 3 组只做了标记。</div></div>
      <div class="pd-msg you"><div class="sender">你</div><div class="pd-bubble">先别删，我再看看</div></div>
      <div class="pd-switch on"><div><div class="nm">在手机上继续刚才的会话</div><div class="ds">不换设备、不重开，接着同一句话往下聊</div></div><div class="tg"></div></div>
      <div class="pd-note">侧栏收成「更多」，会话树收进抽屉——不是另一套缩水产品。</div>
    </div>${composer}</div></div></div>`;
}

/* ── 4 关掉浏览器还在 ── */
function renderPersist(root) {
  const groups = [
    ['今天', [['整理相册','11 组 · 3 组重复'],['写周报','三段 · 4 条待办']]],
    ['昨天', [['算报价','三份对照表'],['查论文','7 篇']]],
    ['上周', [['改英文','公式编号保留']]],
  ];
  root.innerHTML = `<div class="pd-shell">${tagbar('档案', '留痕录')}<div class="pd-lay">${side('materials')}
    <div class="pd-col"><div class="pd-colhead"><span>会话历史</span><span>按时间排</span></div>${groups.map(g=>`<div style="padding:8px 12px 4px;font-size:10px;color:var(--pt3)">${g[0]}</div>`+g[1].map(s=>`<div class="pd-sess"><b>${s[0]}</b><em>${s[1]}</em></div>`).join('')).join('')}</div>
    <div class="pd-main"><div class="pd-chathead"><div><b>整理相册</b><div style="font-size:10px;color:var(--pt3)">关掉浏览器再打开，还在这里</div></div></div>
    <div class="pd-body">
      <div class="pd-msg"><div class="sender">助手</div><div class="pd-bubble">上次停在这：3 组重复，等你确认要不要删。</div></div>
      <div class="pd-step wait"><s>?</s><div><b>接着往下问</b><em>历史、语气、工具调用记录都在，不从头开始</em></div></div>
    </div>${composer}</div></div></div>`;
  root.querySelectorAll('.pd-navbtn').forEach(b => b.addEventListener('click', () => {
    root.querySelectorAll('.pd-navbtn').forEach(x=>x.classList.toggle('on', x===b));
  }));
}

/* ── 5 直接说话 ── */
function renderVoice(root) {
  root.innerHTML = `<div class="pd-shell">${tagbar('对话', '语音输入')}<div class="pd-lay">${side('chat')}
    <div class="pd-main"><div class="pd-chathead"><div><b>整理相册</b><div style="font-size:10px;color:var(--pt3)">语音入口在输入框里，不是另一台仪器</div></div></div>
    <div class="pd-body">
      <div class="pd-msg you"><div class="sender">你（语音转写）</div><div class="pd-bubble">「把重复的那几组都删了吧」</div></div>
      <div class="pd-msg"><div class="sender">助手</div><div class="pd-bubble">收到。删除前再确认一次：这 3 组共 7 张，都是重复的，删了不会动原图。</div></div>
    </div>
    <div class="pd-composer"><button class="mic" type="button" style="background:var(--pac);color:#fff">${micSvg}</button><input placeholder="正在听…" readonly><button class="send" type="button">发送</button></div></div></div></div>`;
}

/* ── 6 换模型 ── */
function renderModels(root) {
  const models = [
    { n:'DeepSeek Flash', d:'日常对话 · 快', p:42 },
    { n:'DeepSeek V4 Pro', d:'难一点的活 · 慢但稳', p:88 },
    { n:'Grok 4.7', d:'另一种思路', p:15 },
  ];
  root.innerHTML = `<div class="pd-shell">${tagbar('模型', '模型服务')}<div class="pd-lay">${side('models')}
    <div class="pd-col"><div class="pd-colhead"><span>模型</span><span>${models.length} 个</span></div>${models.map((m,i)=>`<div class="pd-sess${i===1?' on':''}" data-m="${i}"><b>${m.n}</b><em>${m.d}</em></div>`).join('')}</div>
    <div class="pd-main"><div class="pd-chathead"><div><b>DeepSeek V4 Pro</b><div style="font-size:10px;color:var(--pt3)">正在使用</div></div></div>
    <div class="pd-body" style="display:grid;grid-auto-rows:min-content;gap:10px">
      ${models.map((m,i)=>`<div class="pd-model${i===1?' on':''}" data-m="${i}"><b>${m.n}</b><em>${m.d}</em><div class="bar"><i style="width:${m.p}%"></i></div></div>`).join('')}
      <div class="pd-note">选一个模型，下一页就换它来答；切换只改本机配置，不把你送到别处。</div>
    </div></div></div></div>`;
  root.addEventListener('click', e => {
    const m = e.target.closest('[data-m]');
    if (m) { const i = +m.dataset.m;
      root.querySelectorAll('[data-m]').forEach(x=>x.classList.toggle('on', +x.dataset.m===i));
      root.querySelector('.pd-chathead b').textContent = models[i].n;
    }
  });
}

/* ── 7 开关是真的 ── */
function renderTools(root) {
  const tools = [
    ['联网搜索','查外面的资料', true],
    ['浏览器自动化','自己点网页', true],
    ['读写文件','翻你的文件', true],
    ['执行代码','现算现出结果', false],
    ['看图与视觉','看截图和照片', true],
    ['语音合成','开口说话', true],
    ['定时任务','到点自己跑', false],
  ];
  root.innerHTML = `<div class="pd-shell">${tagbar('能力', '技能与工具')}<div class="pd-lay">${side('capabilities')}
    <div class="pd-main"><div class="pd-chathead"><div><b>技能与工具</b><div style="font-size:10px;color:var(--pt3)">关了就是关了，不假装还在</div></div></div>
    <div class="pd-body" style="display:grid;grid-auto-rows:min-content;gap:8px">
      ${tools.map((t,i)=>`<div class="pd-switch${t[2]?' on':''}" data-tool="${i}"><div><div class="nm">${t[0]}</div><div class="ds">${t[1]}</div></div><button class="tg" type="button" role="switch" aria-checked="${t[2]}" aria-label="${t[0]}"></button></div>`).join('')}
    </div></div></div></div>`;
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-tool]');
    if (b) { b.classList.toggle('on'); const tg=b.querySelector('.tg'); tg.setAttribute('aria-checked', b.classList.contains('on')); }
  });
}

const RENDER = { 1: renderChat, 2: renderTask, 3: renderMobile, 4: renderPersist, 5: renderVoice, 6: renderModels, 7: renderTools };

function mount() {
  const chatSessions = [
    { t:'项目规划讨论', d:'12 条消息 · 刚刚' },
    { t:'整理相册', d:'24 条 · 昨天' },
    { t:'写周报', d:'8 条 · 昨天' },
    { t:'查论文', d:'15 条 · 上周' },
  ];
  const chatMsgs = [
    { you:true, t:'把相册按日期分好，重复的挑出来' },
    { you:false, t:'看完了，1,284 张，按月份分成 11 组；重复的 3 组只做了标记，原图没动。' },
    { you:true, t:'重复的能删吗？' },
    { you:false, t:'能，但删之前我会停下来问你一句，不动你的原图。' },
  ];
  const targets = [
    c => renderChat(c, '项目规划讨论', '默认主力助手 · 12 条消息', chatSessions, 0, chatMsgs),
    renderTask, renderMobile, renderPersist, renderVoice, renderModels, renderTools,
  ];
  targets.forEach((fn, i) => {
    const sec = chapter(i + 1);
    const con = sec && sec.querySelector('.console');
    if (!con) return;
    const viewer = con.querySelector('.viewer');
    const labh = con.querySelector('.lab-h');
    const labb = con.querySelector('.lab-b');
    const host = document.createElement('div');
    host.style.marginTop = '14px';
    if (viewer) viewer.after(host);
    if (labh) labh.remove();
    if (labb) labb.remove();
    fn(host);
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
else mount();
})();
