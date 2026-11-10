"""Generate reviewable APP-only native changes; never edit NAS or import services."""
import difflib
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def once(source, old, new):
    if source.count(old) != 1:
        raise ValueError('Native patch anchor is not unique: ' + old[:90])
    return source.replace(old, new)


def build():
    scheduler = (ROOT / 'dev/native-baselines/cron/scheduler.py').read_text()
    updated = once(scheduler, 'def run_job(\n', 'from cron.panel_echo import guarded as _echo_guarded\n\n\n@_echo_guarded\ndef run_job(\n')
    updated = once(updated, '    scripts_dir = _get_hermes_home() / "scripts"\n',
        '    from cron.panel_echo import script_result\n    _echo_result = script_result(script_path)\n    if _echo_result is not None:\n        return _echo_result\n\n    scripts_dir = _get_hermes_home() / "scripts"\n')
    updated = once(updated, '    logger.info("Running job \'%s\' (ID: %s)", job_name, job_id)\n',
        '    from cron.panel_echo import session_started\n    session_started(_cron_session_id)\n\n    logger.info("Running job \'%s\' (ID: %s)", job_name, job_id)\n')
    updated = once(updated, '        _inactivity_timeout = False\n',
        '        from cron.panel_echo import agent_started\n        agent_started(agent, _cron_future)\n        _inactivity_timeout = False\n')
    updated = once(updated, '                _session_db.close()\n',
        '                from cron.panel_echo import session_finishing\n                try:\n                    session_finishing(_session_db, _final_cron_session_id)\n                finally:\n                    _session_db.close()\n')
    local = (ROOT / 'dev/native-baselines/local.py').read_text()
    changed = once(local, '        return _sanitize_subprocess_env(\n',
        '        from cron.panel_echo import child_env\n        return child_env(_sanitize_subprocess_env(\n')
    changed = once(changed, '            dict(extra) if extra else None,\n        )\n',
        '            dict(extra) if extra else None,\n        ))\n')
    changed = once(changed, '        bash = _find_bash()\n        # For login-shell invocations',
        '        from cron.panel_echo import rewrite_command\n        cmd_string = rewrite_command(cmd_string)\n        bash = _find_bash()\n        # For login-shell invocations')
    # _run_bash uses _make_run_env rather than build_subprocess_env.
    changed = once(changed, '        run_env = _make_run_env(self.env)\n',
        '        from cron.panel_echo import child_env\n        run_env = child_env(_make_run_env(self.env))\n')
    manifest = {}
    diff = []
    for path, old, new in [('cron/scheduler.py', scheduler, updated), ('tools/environments/local.py', local, changed)]:
        compile(new, path, 'exec')
        output = ROOT / 'app/python' / path
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(new)
        manifest[path] = {'baseline_sha256': hashlib.sha256(old.encode()).hexdigest(), 'candidate_sha256': hashlib.sha256(new.encode()).hexdigest()}
        diff.extend(difflib.unified_diff(old.splitlines(True), new.splitlines(True), 'a/' + path, 'b/' + path))
    (ROOT / 'dev/rebuild/echo-native.patch').write_text(''.join(diff))
    (ROOT / 'dev/rebuild/echo-native-manifest.json').write_text(json.dumps(manifest, indent=2))


if __name__ == '__main__':
    build()
