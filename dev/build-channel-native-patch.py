"""Preserve explicit disabled platform state across native env enablement."""
import difflib,hashlib,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
base=ROOT/'dev/native-baselines/channels/gateway/config.py';original=base.read_text();source=original
old='''    config = GatewayConfig.from_dict(gw_data)

    # Override with environment variables
    _apply_env_overrides(config)'''
new='''    config = GatewayConfig.from_dict(gw_data)
    # Persisted gateway.json and merged YAML share the same explicit-disable
    # contract. Some env bridges previously unconditionally enabled platforms.
    _panel_disabled = {
        name for name, block in (gw_data.get("platforms") or {}).items()
        if isinstance(block, dict) and "enabled" in block
        and not _coerce_bool(block["enabled"], default=True)
    }
    for platform, platform_config in config.platforms.items():
        if platform.value in _panel_disabled:
            platform_config.enabled = False
            platform_config.extra["_enabled_explicit"] = True

    # Override credentials and other env settings; explicit disable survives.
    _apply_env_overrides(config)'''
assert source.count(old)==1;source=source.replace(old,new)
old='''    getenv = _getenv_str
    getenv_int = _getenv_int

    def _enable_from_env'''
new='''    getenv = _getenv_str
    getenv_int = _getenv_int
    _panel_disabled = {
        platform for platform, value in config.platforms.items()
        if not value.enabled and bool(value.extra.get("_enabled_explicit", False))
    }

    def _enable_from_env'''
assert source.count(old)==1;source=source.replace(old,new)
# Restore before plugin discovery so disabled platforms cannot trigger SDK
# checks/installation from credentials merely existing in the environment.
old='''    try:
        from hermes_cli.plugins import discover_plugins
        discover_plugins()  # idempotent
        from gateway.platform_registry import platform_registry'''
new='''    for _panel_platform in _panel_disabled:
        if _panel_platform in config.platforms:
            config.platforms[_panel_platform].enabled = False

''' +old
assert source.count(old)==1;source=source.replace(old,new)
old='''    for platform_config in config.platforms.values():
        platform_config.extra.pop("_enabled_explicit", None)'''
new='''    for _panel_platform in _panel_disabled:
        if _panel_platform in config.platforms:
            config.platforms[_panel_platform].enabled = False
    for platform_config in config.platforms.values():
        platform_config.extra.pop("_enabled_explicit", None)'''
assert source.count(old)==1;source=source.replace(old,new);compile(source,'gateway/config.py','exec')
output=ROOT/'app/python/gateway/config.py';output.parent.mkdir(parents=True,exist_ok=True);output.write_text(source)
(ROOT/'dev/rebuild/channel-native.patch').write_text(''.join(difflib.unified_diff(original.splitlines(True),source.splitlines(True),'a/gateway/config.py','b/gateway/config.py')))
(ROOT/'dev/rebuild/channel-native-manifest.json').write_text(json.dumps({'gateway/config.py':{'baseline_sha256':hashlib.sha256(original.encode()).hexdigest(),'candidate_sha256':hashlib.sha256(source.encode()).hexdigest()}},indent=2))
