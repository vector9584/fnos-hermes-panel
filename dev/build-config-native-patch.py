"""Generate narrow native config hooks from verified NAS baselines; no imports."""
import difflib,hashlib,json
from build_config_web_patch import patch_web
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
BASE=ROOT/'dev/native-baselines/config'
def once(source,old,new):
 if source.count(old)!=1:raise ValueError('Patch anchor not unique: '+old[:100])
 return source.replace(old,new)

def build():
 original={str(p.relative_to(BASE)):p.read_text() for p in BASE.rglob('*') if p.is_file()};updated=dict(original)
 u=updated['utils.py']
 u=once(u,'    path = Path(path)\n    path.parent.mkdir(parents=True, exist_ok=True)\n\n    original_mode = _preserve_file_mode(path)\n', '''    from panel_config_bridge import write as _panel_config_write
    if _panel_config_write(path, data):
        return
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    original_mode = _preserve_file_mode(path)
''')
 start=u.index('def atomic_roundtrip_yaml_update(');point=u.index('    from ruamel.yaml import YAML',start)
 u=u[:point]+'''    from panel_config_bridge import dotted_update as _panel_dotted_update
    if _panel_dotted_update(path, key_path, value):
        return
'''+u[point:]
 u=once(u,'    return yaml.load(stream, Loader=_get_fast_yaml_loader())','''    from panel_config_bridge import raw_stream as _panel_raw_stream
    return _panel_raw_stream(stream, lambda source: yaml.load(source, Loader=_get_fast_yaml_loader()))''')
 updated['utils.py']=u
 c=updated['hermes_cli/config.py']
 c=once(c,'from utils import atomic_replace, fast_safe_load','from utils import atomic_replace, fast_safe_load\nfrom panel_config_bridge import empty_mapping as _panel_empty_mapping')
 c=c.replace('fast_safe_load(f) or {}','_panel_empty_mapping(fast_safe_load(f))')
 c=once(c,'def _load_config_impl(*, want_deepcopy: bool) -> Dict[str, Any]:\n    with _CONFIG_LOCK:','''def _load_config_impl(*, want_deepcopy: bool) -> Dict[str, Any]:
    from panel_config_bridge import ensure_recovered as _panel_ensure_recovered
    _panel_ensure_recovered(get_config_path())
    with _CONFIG_LOCK:''')
 c=once(c,'    return _load_config_impl(want_deepcopy=True)','''    from panel_config_bridge import capture as _panel_capture
    return _panel_capture(get_config_path(), lambda: _load_config_impl(want_deepcopy=True))''')
 # Raw cache returns need their own snapshot even on a fast cache hit.
 for name,next_name,args,call in [('read_raw_config','read_user_config_raw','',''),('read_user_config_raw','read_raw_config_readonly','config_path: Optional[Path] = None','config_path')]:
  c=once(c,'def '+name+'(', 'def _panel_original_'+name+'(')
  point=c.index('\ndef '+next_name+'(')
  resolved='config_path or get_config_path()' if call else 'get_config_path()'
  wrapper=f'''\ndef {name}({args}) -> Dict[str, Any]:
    from panel_config_bridge import capture as _panel_capture
    return _panel_capture({resolved}, lambda: _panel_original_{name}({call}))

'''
  c=c[:point]+wrapper+c[point:]
 # Preserve provenance through normalizers that copy to a plain dictionary.
 for name,next_name in [('_normalize_root_model_keys','_normalize_max_turns_config'),('_normalize_max_turns_config','is_provider_enabled')]:
  a=c.index('def '+name+'(');b=c.index('\ndef '+next_name+'(',a);block=c[a:b]
  block=block.replace('    config = dict(config)','    from panel_config_bridge import inherit as _panel_inherit\n    config = _panel_inherit(dict(config), config)',1)
  c=c[:a]+block+c[b:]
 # Extract the original normalization pipeline and run it for both the read
 # baseline and desired value. Managed policy and native defaults remain native.
 a=c.index('    with _CONFIG_LOCK:',c.index('def save_config('));b=c.index('\ndef _parse_env_value(',a)
 old=c[a:b]
 raw_start=old.index('        # Compute explicit user paths');raw_end=old.index('        # Build optional commented-out sections')
 normalize=old[raw_start:raw_end]
 normalize=normalize.replace('        _raw_for_paths = read_raw_config()','        _raw_for_paths = copy.deepcopy(_panel_snapshot["raw"])')
 normalize=normalize.replace('_LAST_EXPANDED_CONFIG_BY_PATH.get(str(config_path))','_panel_snapshot["value"]')
 # This inner function intentionally retains original normalization statements.
 normalize=''.join('    '+line if line.strip() else line for line in normalize.splitlines(True))
 prefix='''    with _CONFIG_LOCK:
        if is_managed():
            managed_error("save configuration")
            return
        from hermes_cli import managed_scope
        from panel_config_bridge import snapshot_of as _panel_snapshot_of, missing_snapshot as _panel_missing_snapshot, write as _panel_write
        ensure_hermes_home()
        config_path = get_config_path()
        require_readable_config_before_write(config_path)
        _panel_snapshot = _panel_snapshot_of(config) or _panel_missing_snapshot(config_path)
        managed_keys = managed_scope.managed_config_keys()

        def _panel_normalize(config):
            if managed_keys:
                config, _stripped = _strip_dotted_keys(copy.deepcopy(config), managed_keys)
'''
 suffix='''            return normalized, current_normalized

        _panel_before, _ = _panel_normalize(copy.deepcopy(_panel_snapshot["value"]))
        normalized, current_normalized = _panel_normalize(config)
        _panel_write(config_path, normalized, snapshot=_panel_snapshot, baseline=_panel_before, managed_keys=managed_keys, effective_after=config)
        _secure_file(config_path)
        _RAW_CONFIG_CACHE.pop(str(config_path), None)
        _LOAD_CONFIG_CACHE.pop(str(config_path), None)
        _LAST_EXPANDED_CONFIG_BY_PATH[str(config_path)] = copy.deepcopy(current_normalized)
        return _panel_snapshot["raw_hash"] or "missing"

'''
 c=c[:a]+prefix+normalize+suffix+c[b:]
 # Keep native validation/managed guards and process-env refresh; replace only
 # the file read-modify-write with a shared cross-process transaction.
 a=c.index('def load_env(');b=c.index('\n# Module-level memo',a);block=c[a:b]
 block=once(block,'    env_path = get_env_path()\n','''    env_path = get_env_path()
    from panel_config_bridge import read_env as _panel_read_env
    _panel_values = _panel_read_env(env_path)
    if _panel_values is not None:
        return _panel_values
''');c=c[:a]+block+c[b:]
 a=c.index('def save_env_value(');b=c.index('\ndef custom_endpoint_key_env',a);block=c[a:b]
 block=once(block,'    env_path = get_env_path()\n','''    env_path = get_env_path()
    from panel_config_bridge import update_env as _panel_update_env
    _panel_result = _panel_update_env(env_path, key, value)
    if _panel_result is not None:
        os.environ[key] = value
        invalidate_env_cache()
        return
''');c=c[:a]+block+c[b:]
 a=c.index('def remove_env_value(');b=c.index('\ndef save_anthropic_oauth_token',a);block=c[a:b]
 block=once(block,'    env_path = get_env_path()\n','''    env_path = get_env_path()
    from panel_config_bridge import update_env as _panel_update_env
    _panel_result = _panel_update_env(env_path, key, remove=True)
    if _panel_result is not None:
        os.environ.pop(key, None)
        invalidate_env_cache()
        return _panel_result["found"]
''');c=c[:a]+block+c[b:]
 a=c.index('def sanitize_env_file(');b=c.index('\ndef _check_non_ascii_credential',a);block=c[a:b]
 block=once(block,'    env_path = get_env_path()\n','''    env_path = get_env_path()
    from panel_config_bridge import config_path as _panel_config_path
    if _panel_config_path(env_path.with_name("config.yaml")):
        # Reading already normalizes safely. Formatting-only migration must
        # not rewrite credential files or race real edits in this deployment.
        return 0
''');c=c[:a]+block+c[b:]
 updated['hermes_cli/config.py']=c
 # Every native auth-store transaction takes config first, native auth second.
 # This closes the recovery-vs-OAuth-writer race without changing OAuth data.
 auth=updated['hermes_cli/auth.py']
 a=auth.index('def _auth_store_lock(');b=auth.index('\ndef _load_auth_store(',a)
 block=once(auth[a:b],'    with _file_lock(\n        lock_path,','    from panel_config_bridge import auth_guard\n    with auth_guard(auth_path), _file_lock(\n        lock_path,');auth=auth[:a]+block+auth[b:]
 for function,args,path in [('_load_auth_store','auth_file: Optional[Path] = None','auth_file or _auth_file_path()'),('_save_auth_store','auth_store: Dict[str, Any], target_path: Optional[Path] = None','target_path or _auth_file_path()')]:
  auth=once(auth,'def '+function+'(', 'def _panel_original'+function+'(')
  call='auth_file' if function=='_load_auth_store' else 'auth_store, target_path'
  auth+='\n\ndef '+function+'('+args+'):\n    from panel_config_bridge import auth_guard\n    with auth_guard('+path+'):\n        return _panel_original'+function+'('+call+')\n'
 auth=once(auth,'        pool[provider_id] = merged\n        return _save_auth_store(auth_store)','        from panel_config_bridge import filter_auth_entries\n        pool[provider_id] = filter_auth_entries(auth_store, merged)\n        return _save_auth_store(auth_store)')
 updated['hermes_cli/auth.py']=auth
 credential=updated['hermes_cli/credential_lifecycle.py']
 for function,args,call in [('save_provider_env_credential','env_var: str, value: str','env_var, value'),('remove_provider_env_credential','env_var: str','env_var, remove=True')]:
  credential=once(credential,'def '+function+'(', 'def _panel_original_'+function+'(')
  original_call='env_var, value' if function.startswith('save') else 'env_var'
  credential+='\n\ndef '+function+'('+args+'):\n    from panel_config_bridge import provider_credential\n    result = provider_credential('+call+')\n    return result if result is not None else _panel_original_'+function+'('+original_call+')\n'
 updated['hermes_cli/credential_lifecycle.py']=credential
 runtime=updated['hermes_cli/runtime_provider.py']
 runtime=once(runtime,'    pool_result = _try_resolve_from_custom_pool(base_url, "custom", custom_provider.get("api_mode"), provider_name=custom_provider.get("name"))','''    from panel_custom_pool import resolve as _panel_custom_pool
    _panel_key = (str(custom_provider.get("api_key") or "").strip()
                  or _getenv(str(custom_provider.get("key_env") or "").strip(), "").strip())
    pool_result = _panel_custom_pool(base_url, custom_provider, requested_provider, _panel_key)
    if pool_result and not custom_provider.get("api_mode"):
        pool_result["api_mode"] = _detect_api_mode_for_url(base_url) or "chat_completions"''')
 updated['hermes_cli/runtime_provider.py']=runtime

 # Importer parses text directly; attach exactly the bytes it parsed.
 imp=updated['hermes_cli/agent_import.py'];a=imp.index('def load_yaml_file(');b=imp.index('\ndef dump_yaml_file',a);block=imp[a:b];block=once(block,'    return data','    from panel_config_bridge import attach_raw as _panel_attach_raw\n    return _panel_attach_raw(path, data, raw)');block=once(block,'    if data is None:\n        return {}','    if data is None:\n        data = {}');imp=imp[:a]+block+imp[b:];updated['hermes_cli/agent_import.py']=imp
 patch_web(updated,once)
 web=updated['hermes_cli/web_server.py']
 for fname,next_anchor in [('set_env_var','\n# Live credential probes'),('remove_env_var','\n@app.post("/api/env/reveal")')]:
  a=web.index('async def '+fname+'(');b=web.index(next_anchor,a);block=web[a:b]
  point=block.index('    try:');block=block[:point]+'    from panel_config_bridge import ConfigError\n'+block[point:]
  block=once(block,'    except ValueError as exc:','    except ConfigError as exc:\n        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc\n    except ValueError as exc:')
  web=web[:a]+block+web[b:]
 updated['hermes_cli/web_server.py']=web
 helper=ROOT/'app/python/hermes_cli/web_dist/assets/panel-config-review.js'
 (ROOT/'app/python/web/src/lib/panel-config-review.js').write_text(helper.read_text())
 manifest={};diff=[]
 for path,new in updated.items():
  old=original[path]
  if new==old:continue
  if path.endswith('.py'):compile(new,path,'exec')
  output=ROOT/'app/python'/path;output.parent.mkdir(parents=True,exist_ok=True);output.write_text(new)
  manifest[path]={'baseline_sha256':hashlib.sha256(old.encode()).hexdigest(),'candidate_sha256':hashlib.sha256(new.encode()).hexdigest()}
  diff.extend(difflib.unified_diff(old.splitlines(True),new.splitlines(True),'a/'+path,'b/'+path))
 (ROOT/'dev/rebuild/config-native.patch').write_text(''.join(diff));(ROOT/'dev/rebuild/config-native-manifest.json').write_text(json.dumps(manifest,indent=2))
if __name__=='__main__':build()
