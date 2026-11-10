"""Exact source + shipped-asset edits for the native configuration editors.

No dependency changes or whole-Dashboard rebuild. Both representations are
patched and tested; the deployment manifest guards the shipped asset hashes.
"""
def patch_web(files,once):
 model=files['hermes_cli/web_models.py']
 for cls,field in [('ConfigUpdate','config: dict'),('RawConfigUpdate','yaml_text: str')]:
  model=once(model,f'class {cls}(BaseModel):\n    {field}',f'class {cls}(BaseModel):\n    {field}\n    revision: Optional[str] = None')
 files['hermes_cli/web_models.py']=model
 web=files['hermes_cli/web_server.py']
 web=once(web,'''    with _profile_scope(profile):
        config = _normalize_config_for_web(load_config())
    # Strip internal keys that the frontend shouldn't see or send back
    return {k: v for k, v in config.items() if not k.startswith("_")}''','''    from panel_config_bridge import revision_of
    with _profile_scope(profile):
        loaded = load_config()
        config = _normalize_config_for_web(loaded)
    result = {k: v for k, v in config.items() if not k.startswith("_")}
    result["_panel_revision"] = revision_of(loaded)
    return result''')
 a=web.index('@app.put("/api/config")');b=web.index('\ndef _catalog_provider_env_metadata',a)
 web=web[:a]+'''@app.put("/api/config")
async def update_config(body: ConfigUpdate, profile: Optional[str] = None):
    from panel_config_bridge import expect_revision, ConfigError
    try:
        with _profile_scope(body.profile or profile):
            existing = expect_revision(load_config(), body.revision)
            incoming = dict(body.config)
            incoming.pop("_panel_revision", None)
            incoming = _denormalize_config_from_web(incoming)
            revision = save_config(_deep_merge(existing, incoming))
        return {"ok": True, "revision": revision}
    except ConfigError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception:
        _log.exception("PUT /api/config failed")
        raise HTTPException(status_code=500, detail="配置未收到保存确认，请重新读取核对")

''' +web[b:]
 a=web.index('@app.get("/api/config/raw")');b=web.index('\n# ---------------------------------------------------------------------------\n# Token / cost analytics',a)
 web=web[:a]+'''@app.get("/api/config/raw")
async def get_config_raw(profile: Optional[str] = None):
    from panel_config_bridge import raw_document, ConfigError
    try:
        with _profile_scope(profile):
            return raw_document(get_config_path())
    except ConfigError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc


@app.put("/api/config/raw")
async def update_config_raw(body: RawConfigUpdate, profile: Optional[str] = None):
    from panel_config_bridge import replace_raw, ConfigError
    from hermes_cli.config import is_managed
    from hermes_cli import managed_scope
    try:
        with _profile_scope(body.profile or profile):
            if is_managed():
                raise HTTPException(status_code=403, detail="当前配置由运行环境管理")
            revision = replace_raw(get_config_path(), body.yaml_text, body.revision,
                                   managed_scope.managed_config_keys())
        return {"ok": True, "revision": revision}
    except ConfigError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc

''' +web[b:]
 # An import map changes both static and dynamic imports even when parent
 # chunks remain cached. It must precede every module/preload in the HTML.
 # X-Forwarded-Prefix also covers Monitor's authenticated reverse proxy.
 anchor='''        chat_js = "true" if _DASHBOARD_EMBEDDED_CHAT_ENABLED else "false"'''
 web=once(web,anchor,'''        import json as _panel_json
        _panel_assets = ("api-CUjvYA_E.js", "ConfigPage-DNVi6bFP.js")
        _panel_imports = {
            f"{prefix}/assets/{name}": f"{prefix}/assets/{name}?panel=config18"
            for name in _panel_assets
        }
        _panel_map = '<script type="importmap">' + _panel_json.dumps({"imports": _panel_imports}) + '</script>'
        html = html.replace("<head>", "<head>" + _panel_map, 1)
''' +anchor)
 files['hermes_cli/web_server.py']=web
 api=files['web/src/lib/api.ts']
 api=once(api,'''  saveConfig: (config: Record<string, unknown>, profile = getManagementProfile()) =>
    fetchJSON<{ ok: boolean }>(appendProfileParam("/api/config", profile), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    }),''','''  saveConfig: async (config: Record<string, unknown>, profile = getManagementProfile()) => {
    const { _panel_revision: revision, ...fields } = config;
    let result: { ok: boolean; revision: string };
    try { result = await fetchJSON<{ ok: boolean; revision: string }>(appendProfileParam("/api/config", profile), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: fields, revision }),
    }); } catch (error) {
      try { await reviewConfig(error, {draft: config, latest: () => api.getConfig(profile)}); }
      catch (conflict: any) { if (conflict.panelRevision) config._panel_revision = conflict.panelRevision; throw conflict; }
      throw error;
    }
    config._panel_revision = result.revision;
    return result;
  },''')
 api=once(api,'fetchJSON<{ yaml: string; path?: string }>','fetchJSON<{ yaml: string; path?: string; revision: string }>')
 api=once(api,'saveConfigRaw: (yaml_text: string, profile = getManagementProfile()) =>\n    fetchJSON<{ ok: boolean }>','saveConfigRaw: (yaml_text: string, profile = getManagementProfile(), revision?: string) =>\n    fetchJSON<{ ok: boolean; revision: string }>')
 api=once(api,'body: JSON.stringify({ yaml_text })','body: JSON.stringify({ yaml_text, revision })')
 api=once(api,'body: JSON.stringify({ yaml_text, revision }),\n    }),','body: JSON.stringify({ yaml_text, revision }),\n    }).catch((error) => reviewConfig(error, {draft: yaml_text, raw: true, latest: () => api.getConfigRaw(profile)})),')
 api='import { reviewConfig } from "./panel-config-review.js";\n'+api
 files['web/src/lib/api.ts']=api
 page=files['web/src/pages/ConfigPage.tsx']
 page=once(page,'  const [yamlText, setYamlText] = useState("");','  const [yamlText, setYamlText] = useState("");\n  const yamlRevision = useRef<string | undefined>(undefined);')
 page=once(page,'.then((resp) => setYamlText(resp.yaml))','.then((resp) => { setYamlText(resp.yaml); yamlRevision.current = resp.revision; })')
 page=once(page,'await api.saveConfigRaw(yamlText);','const result = await api.saveConfigRaw(yamlText, undefined, yamlRevision.current);\n      yamlRevision.current = result.revision;')
 page=once(page,'showToast(`${t.config.failedToSaveYaml}: ${e}`, "error");','if (e && typeof e === "object" && "panelRevision" in e) yamlRevision.current = String(e.panelRevision);\n      showToast(`${t.config.failedToSaveYaml}: ${e instanceof Error ? e.message : e}`, "error");')
 page=once(page,'showToast(`${t.config.failedToSave}: ${e}`, "error");','showToast(`${t.config.failedToSave}: ${e instanceof Error ? e.message : e}`, "error");')
 page=once(page,'setConfig(imported);','setConfig({ ...imported, _panel_revision: config?._panel_revision });')
 page=once(page,'JSON.stringify(config, null, 2)','JSON.stringify(Object.fromEntries(Object.entries(config).filter(([key]) => key !== "_panel_revision")), null, 2)')
 files['web/src/pages/ConfigPage.tsx']=page
 api=files['hermes_cli/web_dist/assets/api-CUjvYA_E.js']
 api=once(api,'saveConfig:(e,t=v())=>x(O(`/api/config`,t),{method:`PUT`,headers:{"Content-Type":`application/json`},body:JSON.stringify({config:e})})','saveConfig:async(e,t=v())=>{let{_panel_revision:revision,...config}=e;let result;try{result=await x(O(`/api/config`,t),{method:`PUT`,headers:{"Content-Type":`application/json`},body:JSON.stringify({config,revision})})}catch(error){try{await panelReviewConfig(error,{draft:e,latest:()=>x(O(`/api/config`,t))})}catch(conflict){if(conflict.panelRevision)e._panel_revision=conflict.panelRevision;throw conflict}throw error}e._panel_revision=result.revision;return result}')
 api=once(api,'saveConfigRaw:(e,t=v())=>x(O(`/api/config/raw`,t),{method:`PUT`,headers:{"Content-Type":`application/json`},body:JSON.stringify({yaml_text:e})})','saveConfigRaw:(e,t=v(),revision)=>x(O(`/api/config/raw`,t),{method:`PUT`,headers:{"Content-Type":`application/json`},body:JSON.stringify({yaml_text:e,revision})}).catch(error=>panelReviewConfig(error,{draft:e,raw:true,latest:()=>x(O(`/api/config/raw`,t))}))')
 api='import {reviewConfig as panelReviewConfig} from "./panel-config-review.js?panel=config18";'+api
 files['hermes_cli/web_dist/assets/api-CUjvYA_E.js']=api
 page=files['hermes_cli/web_dist/assets/ConfigPage-DNVi6bFP.js']
 page=once(page,'function $(){let[e,t]','function $(){let panelYamlRevision=(0,U.useRef)(void 0);let[e,t]')
 page=once(page,'.then(e=>v(e.yaml))','.then(e=>{v(e.yaml);panelYamlRevision.current=e.revision})')
 page=once(page,'await V.saveConfigRaw(_),','panelYamlRevision.current=(await V.saveConfigRaw(_,void 0,panelYamlRevision.current)).revision,')
 page=once(page,'k(`${P.config.failedToSaveYaml}: ${e}`,`error`)','e.panelRevision&&(panelYamlRevision.current=e.panelRevision),k(`${P.config.failedToSaveYaml}: ${e.message||e}`,`error`)')
 page=once(page,'k(`${P.config.failedToSave}: ${e}`,`error`)','k(`${P.config.failedToSave}: ${e.message||e}`,`error`)')
 page=once(page,'let e=JSON.parse(r.result);t(e),','let imported=JSON.parse(r.result);t({...imported,_panel_revision:e?._panel_revision}),')
 page=once(page,'JSON.stringify(e,null,2)','JSON.stringify(Object.fromEntries(Object.entries(e).filter(([key])=>key!==`_panel_revision`)),null,2)')
 files['hermes_cli/web_dist/assets/ConfigPage-DNVi6bFP.js']=page
