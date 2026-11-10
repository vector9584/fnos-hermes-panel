"""Import candidate cron/env modules in an isolated HOME; no Gateway or model."""
import importlib
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
NATIVE = Path(os.environ['HERMES_TEST_NATIVE_ROOT'])
ISOLATED = tempfile.TemporaryDirectory(prefix='hermes-echo-native-')
os.environ.update(HERMES_HOME=ISOLATED.name, HOME=ISOLATED.name, PYTHONDONTWRITEBYTECODE='1')
sys.path.insert(0, str(NATIVE))
import cron
cron.__path__.insert(0, str(ROOT / 'app/python/cron'))
from cron import panel_echo
from _hermes_panel_echo import runtime, taskq


def candidate(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class NativeEchoTests(unittest.TestCase):
    def test_native_import_and_preflight_never_runs_old_wrapper(self):
        scheduler = candidate('cron.scheduler', 'app/python/cron/scheduler.py')
        ok, output = scheduler._run_job_script('taskq_tick.sh')
        self.assertTrue(ok)
        self.assertFalse(scheduler._parse_wake_gate(output))
        self.assertFalse((Path(ISOLATED.name) / 'scripts').exists())
        self.assertTrue(hasattr(scheduler.run_job, '__wrapped__'))

    def test_terminal_factory_bridges_only_current_run(self):
        local = candidate('echo_candidate_local', 'app/python/tools/environments/local.py')
        self.assertNotIn('ECHO_RUN_ID', local.build_subprocess_env({'ECHO_RUN_ID': 'foreign'}))
        run = type('Run', (), {'id': 'bound-run', 'task': {'id': 42}})()
        token = runtime.CURRENT.set(run)
        try:
            result = local.build_subprocess_env({'ECHO_RUN_ID': 'foreign'})
            self.assertEqual(result['ECHO_RUN_ID'], 'bound-run')
            self.assertEqual(result['ECHO_TASK_ID'], '42')
        finally:
            runtime.CURRENT.reset(token)


if __name__ == '__main__':
    try:
        unittest.main()
    finally:
        ISOLATED.cleanup()
