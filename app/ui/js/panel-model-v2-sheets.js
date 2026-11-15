/* 模型页 · 弹层（2026-11-15 第二轮：严格对齐参考稿）
 *
 * 参考稿弹层结构：overlay > sheet > (sheet-h: .tt h3+st / .sheet-x) + sheet-b + sheet-f
 * 多步向导用 .steps；选择项用 .bigopt；确认输入用 .input + .errline。
 *
 * 每个弹层都对应真实写操作，没有只改内存的：
 *   changePrimary  → panel-models action=routes
 *   slot / assignAll → PATCH /api/panel-models/auxiliary
 *   providerAdd    → action=discover 探模型 + action=create
 *   providerModels → action=update（models / default_model）
 *   providerEdit   → action=update
 *   providerDelete → action=delete（先做引用检查）
 *   backendSwap    → action=save_backend（config 类）或转到 voice/auxiliary 编辑器
 *   configWrite    → action=config_write
 */
(function () {
  'use strict';
  var M = window.MV2;
  if (!M) return;
  var el = M.el, btn = M.btn, badge = M.badge, chip = M.chip, sec = M.sec,
      panel = M.panel, steps = M.steps, field = M.field, input = M.input, select = M.select;

  function providerList(S) {
    return ((S.catalog && S.catalog.providers) || []).filter(function (p) { return p.enabled !== false; });
  }

  function nameOf(S, id) {
    var hit = providerList(S).filter(function (p) { return p.id === id; })[0];
    return hit ? hit.name : (id || '');
  }

  /* 只列内核认的模型：enabled:false 的模型选进去会被后端以
     「所选服务或模型未启用」整笔拒绝，列出来就是骗人。 */
  function modelOptions(S) {
    var rows = [];
    providerList(S).forEach(function (p) {
      (p.models || []).forEach(function (m) {
        var id = m && typeof m === 'object' ? m.id : m;
        if (m && typeof m === 'object' && m.enabled === false) return;
        if (!id) return;
        rows.push({ provider: p.id, name: p.name, model: id, api_mode: p.api_mode || 'chat_completions' });
      });
    });
    return rows;
  }

  /* 某个服务下可用的模型名（同样跳过 enabled:false） */
  function usableModels(provider) {
    return ((provider && provider.models) || []).filter(function (m) {
      return !(m && typeof m === 'object' && m.enabled === false);
    }).map(function (m) { return m && typeof m === 'object' ? m.id : m; }).filter(Boolean);
  }

  function groupBy(rows, key) {
    var out = [], index = {};
    rows.forEach(function (row) {
      var k = row[key];
      if (!index[k]) { index[k] = { key: k, name: row.name, rows: [] }; out.push(index[k]); }
      index[k].rows.push(row);
    });
    return out;
  }

  /* ── 1. 换主模型：挑 → 看差异 → 确认 ──────────────── */
  M.sheets.changePrimary = function (S) {
    var rows = modelOptions(S);
    var primary = (S.catalog && S.catalog.primary) || {};
    var picked = { provider: primary.provider, model: primary.model };
    var step = 0;
    var step1Kept = null;

    var sheet = M.sheet({ title: '换主模型', sub: '改的是 model.provider 与 model.default', wide: true });

    function paint() {
      sheet.body.replaceChildren();
      sheet.foot.replaceChildren();
      sheet.body.append(steps(['挑模型', '看差异', '确认'], step));

      if (step === 0) {
        if (!rows.length) {
          sheet.body.append(el('div', 'empty', '没有可用的模型服务，先去「服务商」加一个'));
        }
        groupBy(rows, 'provider').forEach(function (group) {
          var lb = el('div', 'lb', group.name);
          lb.append(el('span', 'mono', group.key));
          sheet.body.append(lb);
          group.rows.forEach(function (row) {
            var on = row.provider === picked.provider && row.model === picked.model;
            var opt = btn('', 'bigopt' + (on ? ' on' : ''), function () {
              picked = { provider: row.provider, model: row.model, api_mode: row.api_mode };
              step = 1;
              paint();
            });
            opt.append(el('span', 'bo'));
            var box = el('span');
            box.append(el('span', 'bt mono', row.model));
            box.append(el('span', 'bd', (row.api_mode || 'chat_completions') + ' · ' + group.name));
            opt.append(box);
            sheet.body.append(opt);
          });
        });
        sheet.foot.append(btn('取消', 'btn', M.closeSheet));
        var next = btn('下一步', 'btn primary', function () { if (!picked.provider) return; step = 1; paint(); });
        sheet.foot.append(next);
        return;
      }

      if (step === 1) {
        /* 新主模型如果正躺在回退链里，后端会以「主模型不能同时出现在回退路线中」拒绝。
           所以这里先算出来，告诉用户它会从回退链摘掉，提交时也真的把它摘掉。 */
        var chain = ((S.catalog && S.catalog.fallbacks) || []);
        var clash = chain.filter(function (f) {
          return f.provider === picked.provider && f.model === picked.model;
        });
        var kept = chain.filter(function (f) { return clash.indexOf(f) < 0; });

        var diff = panel('要改的字段', [
          kvRow('model.provider', nameOf(S, primary.provider) + ' → ' + nameOf(S, picked.provider)),
          kvRow('model.default', (primary.model || '—') + ' → ' + picked.model),
          kvRow('回退链', kept.length + ' 项保持原样' + (clash.length ? '，' + clash.length + ' 项被摘掉（它成了主模型）' : '')),
          kvRow('辅助槽位', '不动（单独指定的那几个继续用各自的服务）')
        ]);
        sheet.body.append(diff);
        if (clash.length) {
          sheet.body.append(el('div', 'errline', '注意：' + picked.model + ' 原本在回退链里，' +
            '切换后它会从回退链移除，否则同一条链里会同时有主模型和它的回退。'));
        }
        sheet.body.append(el('p', 'mini', '切完对新会话生效。当前会话里已经在跑的请求不受影响。'));
        sheet.foot.append(btn('上一步', 'btn', function () { step = 0; paint(); }));
        sheet.foot.append(btn('下一步', 'btn primary', function () { step = 2; paint(); }));
        step1Kept = kept;
        return;
      }

      sheet.body.append(panel('确认', [
        kvRow('新主模型', picked.model),
        kvRow('服务商', nameOf(S, picked.provider)),
        kvRow('写入位置', 'config.yaml 的 model 段')
      ]));
      sheet.foot.append(btn('上一步', 'btn', function () { step = 1; paint(); }));
      sheet.foot.append(btn('确认切换', 'btn primary', async function () {
        M.closeSheet();
        /* entries 用 key 复用现有条目，后端会把 key 命中项原样拷回来。
           只传 provider/model 会被后端判成「回退路线格式不正确」并整笔拒绝。 */
        var chain = step1Kept || ((S.catalog && S.catalog.fallbacks) || []);
        await M.mutate({
          action: 'routes', provider: picked.provider, model: picked.model,
          entries: chain.map(function (f) { return { key: f.key }; }),
          revision: (S.catalog || {}).revision
        }, { done: '主模型已切换到 ' + picked.model, body: '写入 model.provider / model.default，回退链原样保留' });
      }));
    }

    paint();
  };

  /* ── 2. 单个辅助槽位 ──────────────────────────────── */
  M.sheets.slot = function (S, task) {
    var providers = providerList(S);
    var sheet = M.sheet({ title: task.label || task.key, sub: 'auxiliary.' + task.key });

    var providerSel = select([['auto', '跟随主模型（auto）']].concat(
      providers.map(function (p) { return [p.id, p.name]; })
    ), task.provider || 'auto');

    var modelsFor = function (id) {
      var hit = providers.filter(function (p) { return p.id === id; })[0];
      return usableModels(hit);
    };

    var modelSel = select([['', '（用服务默认）']].concat(modelsFor(task.provider).map(function (m) { return [m, m]; })), task.model || '');
    var baseInput = input(task.base_url || '', 'https://…（provider=custom 时必填）');
    var timeoutInput = input(task.timeout || '', '例如 120', 'number');

    providerSel.onchange = function () {
      var list = modelsFor(providerSel.value);
      modelSel.replaceChildren();
      var empty = el('option', null, '（用服务默认）');
      empty.value = '';
      modelSel.append(empty);
      list.forEach(function (m) { var o = el('option', null, m); o.value = m; modelSel.append(o); });
    };

    sheet.body.append(field('来源', providerSel, 'auto 表示这个任务跟主模型走'));
    sheet.body.append(field('模型', modelSel, '来源服务里登记的模型'));
    sheet.body.append(field('独立端点（可选）', baseInput, '只在来源选 custom 时需要'));
    sheet.body.append(field('超时（秒）', timeoutInput, '留空用内核默认'));

    if (task.fallback_chain && task.fallback_chain.length) {
      var chainRows = task.fallback_chain.map(function (entry, index) {
        var row = el('div', 'kv');
        row.append(el('span', null, '#' + (index + 1) + ' ' + nameOf(S, entry.provider)));
        var b = el('b');
        b.append(el('span', 'mono', entry.model || ''));
        row.append(b);
        return row;
      });
      sheet.body.append(panel('现有回退链（' + task.fallback_chain.length + ' 项）', chainRows));
      sheet.body.append(el('p', 'mini', '回退链的顺序调整在「辅助模型」原编辑器里做，这里只改来源与模型，避免两处写同一份链。'));
    }

    sheet.foot.append(btn('取消', 'btn', M.closeSheet));
    sheet.foot.append(btn('保存', 'btn primary', async function () {
      var changes = {
        provider: providerSel.value,
        model: modelSel.value,
        base_url: baseInput.value.trim(),
        timeout: timeoutInput.value.trim() === '' ? '' : Number(timeoutInput.value)
      };
      M.closeSheet();
      await M.auxMutate({ key: task.key, revision: task.revision, changes: changes },
        { done: task.label + ' 已更新' });
    }));
  };

  /* ── 3. 批量分配 ──────────────────────────────────── */
  M.sheets.assignAll = function (S) {
    var providers = providerList(S);
    var tasks = ((S.aux && S.aux.tasks) || []).slice();
    var sheet = M.sheet({ title: '批量分配', sub: '把多个辅助任务一次指到同一个来源', wide: true });

    var providerSel = select([['auto', '跟随主模型（auto）']].concat(
      providers.map(function (p) { return [p.id, p.name]; })
    ), 'auto');
    var modelSel = select([['', '（用服务默认）']], '');

    function fillModels() {
      var hit = providers.filter(function (p) { return p.id === providerSel.value; })[0];
      modelSel.replaceChildren();
      var empty = el('option', null, '（用服务默认）');
      empty.value = '';
      modelSel.append(empty);
      usableModels(hit).forEach(function (id) {
        var o = el('option', null, id);
        o.value = id;
        modelSel.append(o);
      });
    }
    providerSel.onchange = fillModels;

    sheet.body.append(field('目标来源', providerSel));
    sheet.body.append(field('目标模型', modelSel));

    var picked = {};
    tasks.forEach(function (t) { picked[t.key] = t.provider === 'auto' || !t.provider ? false : false; });
    var list = el('div');
    tasks.forEach(function (t) {
      var row = el('label', 'checkline');
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = false;
      box.onchange = function () { picked[t.key] = box.checked; };
      row.append(box);
      row.append(el('span', null, t.label || t.key));
      row.append(el('span', 'mono', 'auxiliary.' + t.key));
      list.append(row);
    });
    sheet.body.append(sec('要改的任务', '勾上才会写'));
    sheet.body.append(list);

    var allBtn = btn('全选', 'btn sm', function () {
      list.querySelectorAll('input[type=checkbox]').forEach(function (box) { box.checked = true; });
      tasks.forEach(function (t) { picked[t.key] = true; });
    });
    var noneBtn = btn('全不选', 'btn sm', function () {
      list.querySelectorAll('input[type=checkbox]').forEach(function (box) { box.checked = false; });
      tasks.forEach(function (t) { picked[t.key] = false; });
    });

    sheet.foot.append(allBtn, noneBtn, btn('取消', 'btn', M.closeSheet));
    sheet.foot.append(btn('批量保存', 'btn primary', async function () {
      var chosen = tasks.filter(function (t) { return picked[t.key]; });
      if (!chosen.length) { M.toast('没有勾任务', '至少勾一个再保存', 'bad'); return; }
      var changes = { provider: providerSel.value, model: modelSel.value };
      if (providerSel.value === 'auto') { changes.model = ''; changes.base_url = ''; }
      M.closeSheet();
      var ok = 0, failed = [];
      for (var i = 0; i < chosen.length; i++) {
        try {
          await M.auxPatch({ key: chosen[i].key, revision: chosen[i].revision, changes: changes });
          ok++;
        } catch (error) {
          failed.push((chosen[i].label || chosen[i].key) + '：' + error.message);
        }
      }
      M.S.aux = await M.auxGet();
      await M.load(['catalog']);
      M.render();
      if (failed.length) M.toast('部分失败', ok + ' 个已改，' + failed.length + ' 个失败：' + failed[0], 'bad');
      else M.toast('批量分配完成', ok + ' 个辅助任务已更新');
    }));
  };

  /* ── 4. 添加服务（四步向导）────────────────────────── */
  M.sheets.providerAdd = function (S) {
    var step = 0;
    var draft = {
      name: '', base_url: '', api_mode: 'chat_completions',
      keyValue: '', models: [], picked: ''
    };
    var sheet = M.sheet({ title: '添加 LLM 服务', sub: '四步：选类型 → 填地址密钥 → 探测模型 → 完成', wide: true });

    function paint() {
      sheet.body.replaceChildren();
      sheet.foot.replaceChildren();
      sheet.body.append(steps(['选类型', '地址与密钥', '探测模型', '完成'], step));

      if (step === 0) {
        [
          ['chat_completions', 'OpenAI 兼容', '大多数中转站和自建网关都走这个'],
          ['anthropic_messages', 'Anthropic Messages', 'Claude 原生协议，部分中转也支持'],
          ['responses', 'Responses', 'OpenAI 新版接口，codex 系模型用']
        ].forEach(function (row) {
          var opt = btn('', 'bigopt' + (draft.api_mode === row[0] ? ' on' : ''), function () {
            draft.api_mode = row[0];
            step = 1;
            paint();
          });
          opt.append(el('span', 'bo'));
          var box = el('span');
          box.append(el('span', 'bt', row[1]));
          box.append(el('span', 'bd', row[2]));
          opt.append(box);
          sheet.body.append(opt);
        });
        sheet.foot.append(btn('取消', 'btn', M.closeSheet));
        sheet.foot.append(btn('下一步', 'btn primary', function () { step = 1; paint(); }));
        return;
      }

      if (step === 1) {
        var nameI = input(draft.name, '例如 ZeroAPI');
        var urlI = input(draft.base_url, 'https://api.example.com/v1');
        var keyI = input(draft.keyValue, 'sk-…（只用于本次探测，不会落盘明文）', 'password');
        nameI.oninput = function () { draft.name = nameI.value; };
        urlI.oninput = function () { draft.base_url = urlI.value; };
        keyI.oninput = function () { draft.keyValue = keyI.value; };
        sheet.body.append(field('服务名称', nameI, '', true));
        sheet.body.append(field('服务地址', urlI, '不含查询参数的 HTTP/HTTPS 地址', true));
        sheet.body.append(field('API 密钥', keyI, '探测要用；最终写进 config 的是 api_key 字段，值不进日志'));
        var err = el('div', 'errline');
        sheet.foot.append(btn('上一步', 'btn', function () { step = 0; paint(); }));
        sheet.foot.append(btn('下一步', 'btn primary', function () {
          if (!draft.name.trim() || !draft.base_url.trim()) {
            err.textContent = '服务名称和地址都要填';
            sheet.body.append(err);
            return;
          }
          step = 2;
          paint();
        }));
        return;
      }

      if (step === 2) {
        sheet.body.append(panel('探测模型清单', [
          el('p', 'mini', '调 /models 端点读这家服务对外宣称的模型名。读不到也可以手填。'),
          el('p', 'mini', '名称 ' + draft.name + ' · 地址 ' + draft.base_url)
        ]));
        var result = el('div');
        var manual = input('', '手填模型名，逗号分隔');
        sheet.body.append(result, field('手填模型', manual, '探测失败时用这个'));
        var runBtn = btn('开始探测', 'btn sm', async function () {
          result.replaceChildren(el('p', 'mini', '探测中…'));
          try {
            var out = await M.api({
              action: 'discover', base_url: draft.base_url, api_mode: draft.api_mode,
              api_key: draft.keyValue
            });
            var names = (out.models || []).map(function (m) { return m.id || m; });
            draft.models = names;
            result.replaceChildren();
            if (!names.length) {
              result.append(el('div', 'errline', '这家服务没返回模型清单，手填吧'));
              return;
            }
            names.forEach(function (name) {
              var opt = btn('', 'bigopt' + (draft.picked === name ? ' on' : ''), function () {
                draft.picked = name;
                paint();
              });
              opt.append(el('span', 'bo'));
              var box = el('span');
              box.append(el('span', 'bt mono', name));
              box.append(el('span', 'bd', '探测到 · ' + draft.api_mode));
              opt.append(box);
              result.append(opt);
            });
          } catch (error) {
            result.replaceChildren(el('div', 'errline', '探测失败：' + error.message));
          }
        });
        sheet.body.append(runBtn);
        sheet.foot.append(btn('上一步', 'btn', function () { step = 1; paint(); }));
        sheet.foot.append(btn('下一步', 'btn primary', function () {
          var extra = manual.value.split(/[,，\s]+/).filter(Boolean);
          if (extra.length) draft.models = extra;
          if (!draft.models.length) { M.toast('还没有模型', '先探测或手填一个模型名', 'bad'); return; }
          if (!draft.picked) draft.picked = draft.models[0];
          step = 3;
          paint();
        }));
        return;
      }

      sheet.body.append(panel('确认写入', [
        kvRow('服务名称', draft.name),
        kvRow('地址', draft.base_url),
        kvRow('协议', draft.api_mode),
        kvRow('模型', draft.models.length + ' 个（默认 ' + draft.picked + '）'),
        kvRow('写入位置', 'providers.<新 id>（由内核生成 id）')
      ]));
      sheet.foot.append(btn('上一步', 'btn', function () { step = 2; paint(); }));
      sheet.foot.append(btn('创建', 'btn primary', async function () {
        M.closeSheet();
        await M.mutate({
          action: 'create',
          changes: {
            name: draft.name.trim(),
            base_url: draft.base_url.trim(),
            api_mode: draft.api_mode,
            default_model: draft.picked,
            models: draft.models,
            credential: draft.keyValue ? { action: 'replace', value: draft.keyValue } : { action: 'keep' }
          },
          revision: (M.S.catalog || {}).revision
        }, { done: '已添加 ' + draft.name, body: '写进 providers 段，密钥以 api_key 字段保存' });
      }));
    }

    paint();
  };

  /* ── 5. 某个服务的模型清单 ────────────────────────── */
  M.sheets.providerModels = function (S, p) {
    var models = (p.models || []).map(function (m) { return m.id || m; });
    var sheet = M.sheet({ title: p.name + ' · 模型', sub: p.id + ' · ' + models.length + ' 个模型', wide: true });
    var host = el('div');
    var manual = input('', '新模型名');

    function paint() {
      host.replaceChildren();
      models.forEach(function (name, index) {
        var row = el('div', 'modelrow');
        var isDefault = name === p.model;
        var entry = (p.models || []).filter(function (m) {
          return (m && typeof m === 'object' ? m.id : m) === name;
        })[0];
        var off = entry && typeof entry === 'object' && entry.enabled === false;
        row.append(el('span', 'mn mono', name));
        if (isDefault) row.append(badge('默认', 'ok'));
        if (off) row.append(badge('未启用', 'warn'));
        var acts = el('span', 'ma');
        acts.append(btn(isDefault ? '已是默认' : '设为默认', 'btn sm', function () {
          if (isDefault) return;
          M.mutate({
            action: 'update', id: p.id,
            changes: { default_model: name },
            revision: (M.S.catalog || {}).revision
          }, { done: '默认模型改为 ' + name });
        }));
        acts.append(btn('移除', 'btn sm danger', function () {
          if (models.length <= 1) { M.toast('不能移除最后一个模型', '先把别的模型加进来', 'bad'); return; }
          models = models.filter(function (m) { return m !== name; });
          paint();
          M.toast('已从清单移除（未写盘）', '点下面的「保存清单」才写入 config.yaml');
        }));
        row.append(acts);
        host.append(row);
      });
      if (!models.length) host.append(el('div', 'empty', '还没有模型'));
    }

    sheet.body.append(host);
    sheet.body.append(field('手动添加', manual, '填一个模型名，点添加'));
    sheet.foot.append(btn('取消', 'btn', M.closeSheet));
    sheet.foot.append(btn('添加', 'btn', function () {
      var name = manual.value.trim();
      if (!name) return;
      if (models.indexOf(name) >= 0) { M.toast('重复模型', name + ' 已经在清单里', 'bad'); return; }
      models.push(name);
      manual.value = '';
      paint();
    }));
    sheet.foot.append(btn('保存清单', 'btn primary', async function () {
      M.closeSheet();
      await M.mutate({
        action: 'update', id: p.id,
        changes: { models: models, default_model: models.indexOf(p.model) >= 0 ? p.model : models[0] },
        revision: (M.S.catalog || {}).revision
      }, { done: p.name + ' 模型清单已保存' });
    }));
    paint();
  };

  /* ── 6. 编辑服务 ──────────────────────────────────── */
  M.sheets.providerEdit = function (S, p) {
    var sheet = M.sheet({ title: '编辑 ' + p.name, sub: p.id, wide: true });
    var nameI = input(p.name || '');
    var urlI = input(p.base_url || '');
    var modeSel = select([['', '由内核识别'], ['chat_completions', 'chat_completions'], ['anthropic_messages', 'anthropic_messages'], ['responses', 'responses']], p.api_mode || '');
    var noteI = input(p.note || '', '备注（可选）');
    var credSel = select([['keep', '保持现有密钥'], ['replace', '换一个新密钥'], ['clear', '清掉密钥']], 'keep');
    var credI = input('', 'sk-…', 'password');
    credI.disabled = true;
    credSel.onchange = function () { credI.disabled = credSel.value !== 'replace'; };

    sheet.body.append(field('服务名称', nameI, '', true));
    sheet.body.append(field('服务地址', urlI, '', true));
    sheet.body.append(field('接口协议', modeSel, '留空由内核按模型名识别'));
    sheet.body.append(field('密钥', credSel, '换地址时旧密钥会被内核自动清掉'));
    sheet.body.append(field('新密钥值', credI));
    sheet.body.append(field('备注', noteI));

    sheet.foot.append(btn('取消', 'btn', M.closeSheet));
    sheet.foot.append(btn('保存', 'btn primary', async function () {
      var changes = {
        name: nameI.value.trim(),
        base_url: urlI.value.trim(),
        api_mode: modeSel.value,
        note: noteI.value
      };
      if (credSel.value === 'replace') changes.credential = { action: 'replace', value: credI.value };
      else if (credSel.value === 'clear') changes.credential = { action: 'clear' };
      M.closeSheet();
      await M.mutate({ action: 'update', id: p.id, changes: changes, revision: (M.S.catalog || {}).revision },
        { done: p.name + ' 已更新' });
    }));
  };

  /* ── 7. 删除服务（先查引用）───────────────────────── */
  M.sheets.providerDelete = function (S, p) {
    var cat = S.catalog || {};
    var primary = cat.primary || {};
    var blockers = [];
    if (primary.provider === p.id) blockers.push('它是当前主模型（' + primary.model + '）');
    ((cat.fallbacks) || []).forEach(function (f) {
      if (f.provider === p.id) blockers.push('回退链里引用了 ' + f.model);
    });
    ((S.aux && S.aux.tasks) || []).forEach(function (t) {
      if (t.provider === p.id) blockers.push('辅助任务「' + (t.label || t.key) + '」在用');
    });

    var sheet = M.sheet({ title: '删除 ' + p.name, sub: '这一步会把它从 providers 段移除' });
    if (blockers.length) {
      sheet.body.append(el('div', 'errline', '还有 ' + blockers.length + ' 处在引用它，先解绑：'));
      var deps = el('div', 'deps');
      blockers.forEach(function (line) { deps.append(el('div', 'dh', '· ' + line)); });
      sheet.body.append(deps);
      sheet.foot.append(btn('知道了', 'btn primary', M.closeSheet));
      return;
    }
    sheet.body.append(el('p', 'mini', '没有主模型、回退链或辅助任务在引用它。删除后密钥字段一起移除。'));
    var confirmI = input('', '输入服务名 ' + p.name + ' 确认');
    sheet.body.append(field('确认', confirmI, '防误删'));
    var err = el('div', 'errline');
    sheet.body.append(err);
    sheet.foot.append(btn('取消', 'btn', M.closeSheet));
    sheet.foot.append(btn('删除', 'btn danger', async function () {
      if (confirmI.value.trim() !== p.name) {
        err.textContent = '服务名不一致，没有删';
        return;
      }
      M.closeSheet();
      await M.mutate({ action: 'delete', id: p.id, revision: (M.S.catalog || {}).revision },
        { done: '已删除 ' + p.name, body: 'providers 段对应条目已移除' });
    }));
  };

  /* ── 8. 换来源 ────────────────────────────────────── */
  M.sheets.backendSwap = function (S, d) {
    /* 有专用编辑器的两个域：直接把人送到那个编辑器，不在这里造第二个写入口 */
    if (d.write_via === 'voice') {
      var vSheet = M.sheet({ title: d.label, sub: '语音配置（stt / tts）· 写入走 /api/panel-models/voice' });
      var voice = S.voice || {};
      var current = d.key === 'stt' ? (voice.stt || {}) : (voice.tts || {});
      vSheet.body.append(panel('当前', [
        kvRow('provider', current.provider || d.provider || '—'),
        kvRow('language', current.language || '—'),
        kvRow('输出格式', current.output_format || '—')
      ]));
      vSheet.body.append(el('p', 'mini', '语音配置有独立的完整编辑器（含 provider 命令、参数、语言），' +
        '这里再放一个下拉框就会有两处写同一份配置。下面是它支持的全部 provider。'));
      var chipRow = el('div', 'chips');
      (d.options || []).forEach(function (name) { chipRow.append(chip(name, true)); });
      vSheet.body.append(chipRow);
      vSheet.foot.append(btn('关闭', 'btn', M.closeSheet));
      vSheet.foot.append(btn('打开语音编辑器', 'btn primary', function () {
        M.closeSheet();
        if (window.openModelVoiceEditor) { window.openModelVoiceEditor(); return; }
        M.toast('语音编辑器入口', '面板「模型」旧页的语音区块已并入这里；先在 config.yaml 改或等这一版接上', 'bad');
      }));
      return;
    }

    if (d.write_via === 'auxiliary') {
      var task = ((S.aux && S.aux.tasks) || []).filter(function (t) { return t.key === 'vision'; })[0];
      if (task) { M.sheets.slot(S, task); return; }
      M.toast('没找到视觉任务', '辅助模型里没有 vision 这一项', 'bad');
      return;
    }

    if (!d.writable) {
      var ro = M.sheet({ title: d.label, sub: d.path });
      ro.body.append(el('p', 'mini', d.note || '没有独立配置项'));
      ro.body.append(el('p', 'mini', 'OCR 走服务商原生能力，生图走 image_gen 工具集开关。' +
        '硬塞一个下拉框只会让人以为改了有用。'));
      ro.foot.append(btn('知道了', 'btn primary', M.closeSheet));
      return;
    }

    /* config 类：真写 config.yaml */
    var sheet = M.sheet({ title: '换来源 · ' + d.label, sub: '写入 ' + d.path });
    var options = (d.options || []).filter(function (o) { return o !== ''; });
    var picked = d.provider;
    var host = el('div');
    options.forEach(function (name) {
      var opt = btn('', 'bigopt' + (name === picked ? ' on' : ''), function () {
        picked = name;
        host.querySelectorAll('.bigopt').forEach(function (node) { node.classList.remove('on'); });
        opt.classList.add('on');
      });
      opt.append(el('span', 'bo'));
      var box = el('span');
      box.append(el('span', 'bt mono', name));
      box.append(el('span', 'bd', '内核接受的取值'));
      opt.append(box);
      host.append(opt);
    });
    var auto = btn('', 'bigopt' + (picked === '' ? ' on' : ''), function () {
      picked = '';
      host.querySelectorAll('.bigopt').forEach(function (node) { node.classList.remove('on'); });
      auto.classList.add('on');
    });
    auto.append(el('span', 'bo'));
    var abox = el('span');
    abox.append(el('span', 'bt', '不指定'));
    abox.append(el('span', 'bd', '从配置里删掉这个键，回到内核默认'));
    auto.append(abox);
    host.prepend(auto);
    sheet.body.append(host);

    sheet.foot.append(btn('取消', 'btn', M.closeSheet));
    sheet.foot.append(btn('保存', 'btn primary', async function () {
      M.closeSheet();
      await M.mutate({
        action: 'save_backend', domain: d.key, provider: picked, revision: (S.backends || {}).revision
      }, { done: d.label + ' 来源已改为 ' + (picked || '默认'), body: '写入 ' + d.path });
    }));
  };

  /* ── 9. 自定义来源 ────────────────────────────────── */
  M.sheets.backendCustom = function (S) {
    var domains = (S.backends && S.backends.domains) || [];
    var sheet = M.sheet({ title: '来源清单', sub: '每个能力域内核接受哪些来源', wide: true });
    sheet.body.append(el('p', 'mini', '自定义来源不是随便填一个名字：内核只认每个域自己那组取值，' +
      '写别的会被当成未知来源。下面是当前所有域可选的来源，点一个直接切过去。'));
    domains.forEach(function (d) {
      if (!d.writable || !d.options || !d.options.length) return;
      var lb = el('div', 'lb', d.label);
      lb.append(el('span', 'mono', d.path));
      sheet.body.append(lb);
      var row = el('div', 'chips');
      d.options.forEach(function (name) {
        var text = name === '' ? '默认' : name;
        var c = btn(text, 'chip' + (d.provider === name ? ' pri' : ''), async function () {
          M.closeSheet();
          await M.mutate({
            action: 'save_backend', domain: d.key, provider: name, revision: (S.backends || {}).revision
          }, { done: d.label + ' 来源已改为 ' + (name || '默认') });
        });
        c.style.cursor = 'pointer';
        row.append(c);
      });
      sheet.body.append(row);
    });
    sheet.foot.append(btn('关闭', 'btn', M.closeSheet));
  };

  /* ── 10. 能力详情 ─────────────────────────────────── */
  M.sheets.backendDetail = function (S, d) {
    var sheet = M.sheet({ title: d.label, sub: d.path + ' · ' + d.status });
    var rows = [
      kvRow('当前来源', d.provider || '未设置'),
      kvRow('状态', d.status),
      kvRow('写入通道', d.write_via === 'config' ? '本页直写 config.yaml'
        : d.write_via === 'voice' ? '语音编辑器（/api/panel-models/voice）'
        : d.write_via === 'auxiliary' ? '辅助模型编辑器（/api/panel-models/auxiliary）'
        : '没有独立配置项'),
      kvRow('可选来源', (d.options || []).join(' / ') || '—')
    ];
    Object.keys(d.detail || {}).forEach(function (key) {
      var value = d.detail[key];
      if (value === '' || value === null || value === undefined) return;
      rows.push(kvRow(key, typeof value === 'object' ? JSON.stringify(value) : String(value)));
    });
    sheet.body.append(panel('', rows));
    if (d.note) sheet.body.append(el('p', 'mini', d.note));
    sheet.foot.append(btn('关闭', 'btn', M.closeSheet));
    if (d.writable) {
      sheet.foot.append(btn('换来源', 'btn primary', function () {
        M.closeSheet();
        M.sheets.backendSwap(S, d);
      }));
    }
  };

  /* ── 11. 写入 config.yaml ─────────────────────────── */
  M.sheets.configWrite = function (S) {
    var preview = S.preview || {};
    var text = preview.text || '';
    var sheet = M.sheet({ title: '写入 config.yaml', sub: '整份替换 · 三道校验不过就不写', wide: true });

    var area = el('textarea', 'textarea');
    area.value = text;
    area.rows = 22;
    area.spellcheck = false;
    area.style.width = '100%';
    area.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, monospace';
    area.style.fontSize = '12px';

    sheet.body.append(el('p', 'mini', '预览里的密钥是 ****（已隐藏）掩码。原样写回会把掩码当真实值写进配置，' +
      '所以这里要先点「载入全文再编辑」拿到可编辑版本，或者整段替换成你自己写的内容。'));
    var hint = el('div', 'errline');
    sheet.body.append(area, hint);

    sheet.foot.append(btn('取消', 'btn', M.closeSheet));
    sheet.foot.append(btn('载入全文', 'btn sm', async function () {
      try {
        var out = await M.api({ action: 'config_preview', raw: true });
        if (out.text && out.text.indexOf('****（已隐藏）') < 0) {
          area.value = out.text;
          M.toast('已载入', '这份是未脱敏原文，写完会原样落盘');
        } else {
          hint.textContent = '服务端仍返回脱敏文本，无法安全编辑；请直接粘贴你自己写的完整 YAML';
        }
      } catch (error) {
        hint.textContent = '载入失败：' + error.message;
      }
    }));
    sheet.foot.append(btn('写入', 'btn primary', async function () {
      var body = area.value;
      if (!body.trim()) { hint.textContent = '内容为空'; return; }
      if (body.indexOf('****（已隐藏）') >= 0) {
        hint.textContent = '还带着掩码，写进去会把密钥变成星号。先删掉掩码行或整段替换。';
        return;
      }
      M.closeSheet();
      await M.mutate({
        action: 'config_write', text: body, revision: (S.preview || {}).revision
      }, { done: 'config.yaml 已写入', body: '已通过解析、映射、model 段三道校验' });
      S.preview = null;
      await M.load(['preview']);
      M.render();
    }));
  };

  function kvRow(k, v) {
    var row = el('div', 'kv');
    row.append(el('span', null, k));
    var b = el('b');
    b.append(el('span', 'mini', String(v)));
    row.append(b);
    return row;
  }
})();
