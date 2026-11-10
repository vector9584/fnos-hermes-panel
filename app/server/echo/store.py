"""ECHO storage shared by the panel, scheduler and CLI. No service startup."""
import copy
import hashlib
import importlib.util
import json
import os
from contextlib import contextmanager
from pathlib import Path

_spec = importlib.util.spec_from_file_location('echo_panel_storage', Path(__file__).parents[1] / 'panel-echo.py')
panel = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(panel)


def read(path):
    raw = Path(path).read_bytes()
    data = json.loads(raw)
    panel.validate(data)
    return raw, data


@contextmanager
def transaction(path, backups):
    path, backups = Path(path), Path(backups)
    with panel.locked(path, True):
        raw, data = read(path)
        before = copy.deepcopy(data)
        yield data
        panel.validate(data)
        if data == before:
            return
        backups.mkdir(parents=True, exist_ok=True)
        target = backups / (hashlib.sha256(raw).hexdigest() + '.json')
        try:
            with target.open('xb') as handle:
                os.fchmod(handle.fileno(), 0o600)
                handle.write(raw)
                handle.flush()
                os.fsync(handle.fileno())
        except FileExistsError:
            if target.read_bytes() != raw:
                raise ValueError('队列备份校验不一致，未修改原文件')
        panel.save(path, data)


def process_identity(pid=None):
    pid = pid or os.getpid()
    # Linux boot ID + /proc starttime disambiguate PID reuse and reboots.
    try:
        boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        stat = Path('/proc/{}/stat'.format(pid)).read_text().rsplit(')', 1)[1].split()
        return {'pid': pid, 'boot': boot, 'start': stat[19]}
    except (OSError, IndexError):
        return None


def owner_alive(owner):
    if not isinstance(owner, dict) or not owner.get('pid'):
        return None
    actual = process_identity(owner['pid'])
    if actual:
        return actual == owner
    try:
        os.kill(owner['pid'], 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return None
    return None
