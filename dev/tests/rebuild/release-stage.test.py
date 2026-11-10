import importlib.util
import tempfile
import subprocess
import unittest
from unittest.mock import patch
from pathlib import Path

ROOT = __import__('pathlib').Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location('release_stage', ROOT / 'dev/release-stage.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ReleaseStage(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='release-stage-test-', dir='/private/tmp')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for path in ('app/server', 'app/ui', 'app/python'):
            (self.root / path).mkdir(parents=True, exist_ok=True)
        (self.root / 'app/server/monitor.js').write_text('baseline\n')
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        subprocess.run(['git', '-C', str(self.root), 'add', '.'], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=Fixture', '-c',
                        'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline'], check=True)

    def test_runtime_diff_from_head_refuses_stage(self):
        (self.root / 'app/server/monitor.js').write_text('uncommitted candidate\n')
        with patch.object(MODULE, 'ROOT', self.root):
            with self.assertRaisesRegex(SystemExit, 'tracked runtime files differ from HEAD'):
                MODULE.assert_clean_runtime_tree()

    def test_clean_runtime_tree_is_allowed(self):
        with patch.object(MODULE, 'ROOT', self.root):
            MODULE.assert_clean_runtime_tree()

    def test_untracked_runtime_source_refuses_stage(self):
        (self.root / 'app/server/panel-new-feature.js').write_text('new runtime module\n')
        with patch.object(MODULE, 'ROOT', self.root):
            with self.assertRaisesRegex(SystemExit, 'untracked runtime files: app/server/panel-new-feature.js'):
                MODULE.assert_clean_runtime_tree()

    def test_python_bytecode_cache_does_not_block_stage(self):
        cache = self.root / 'app/server/__pycache__'
        cache.mkdir()
        (cache / 'fixture.cpython-313.pyc').write_bytes(b'cache')
        with patch.object(MODULE, 'ROOT', self.root):
            MODULE.assert_clean_runtime_tree()


if __name__ == '__main__':
    unittest.main(verbosity=2)
