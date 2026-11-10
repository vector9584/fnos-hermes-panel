import importlib.util
import json
import os
import hashlib
import ast
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location('browser_suite', Path(__file__).with_name('browser-suite.py'))
SUITE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SUITE)
NATIVE_SPEC = importlib.util.spec_from_file_location(
    'native_environment_suite', Path(__file__).with_name('native-environment-suite.py'))
NATIVE = importlib.util.module_from_spec(NATIVE_SPEC)
NATIVE_SPEC.loader.exec_module(NATIVE)


class BrowserSuite(unittest.TestCase):
    def test_native_environment_suite_is_explicit_and_keeps_identity_test_separate(self):
        expected = {
            'channel-enabled.test.py', 'channels-native.test.py', 'model-pool-native.test.py',
            'model-source-native.test.py', 'native-config-integration.test.py',
            'provider-native.test.py', 'cron-native.test.py', 'echo-native.test.py',
            'drain-lease.test.py', 'drain-stop.test.py', 'drain-store.test.py',
            'lifecycle-real.test.py', 'echo-web.test.py',
        }
        self.assertEqual(set(NATIVE.NATIVE_TESTS), expected)
        self.assertEqual(len(NATIVE.NATIVE_TESTS), len(expected))
        self.assertNotIn('echo-identities.test.py', NATIVE.NATIVE_TESTS)
        source = Path(__file__).with_name('native-environment-suite.py').read_text()
        self.assertIn("'echo-identities.test.py': 'run separately as vector", source)

    def test_native_suite_does_not_forward_live_environment_credentials(self):
        old = {key: os.environ.get(key) for key in ('OPENAI_API_KEY', 'TELEGRAM_BOT_TOKEN')}
        try:
            os.environ.update({'OPENAI_API_KEY': 'must-not-forward', 'TELEGRAM_BOT_TOKEN': 'must-not-forward'})
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                safe = NATIVE.isolated_environment(NATIVE.NATIVE_ROOT, root, 'first.test.py')
                second = NATIVE.isolated_environment(NATIVE.NATIVE_ROOT, root, 'second.test.py')
            self.assertNotIn('OPENAI_API_KEY', safe)
            self.assertNotIn('TELEGRAM_BOT_TOKEN', safe)
            self.assertEqual(safe['HERMES_TEST_NATIVE_ROOT'], str(NATIVE.NATIVE_ROOT))
            self.assertEqual(safe['HOME'], str(root / 'fixture-first.test' / 'home'))
            self.assertEqual(safe['HERMES_HOME'], safe['HOME'])
            self.assertEqual(safe['HERMES_PANEL_CONFIG_ROOT'], safe['HOME'])
            self.assertEqual(safe['HERMES_PANEL_STATE_DIR'], str(root / 'fixture-first.test' / 'state'))
            self.assertEqual(safe['HERMES_MANAGED_DIR'], str(root / 'fixture-first.test' / 'managed'))
            self.assertEqual(safe['TMPDIR'], str(root / 'fixture-first.test' / 'tmp'))
            self.assertNotEqual(safe['HOME'], second['HOME'])
            self.assertNotEqual(safe['HERMES_PANEL_STATE_DIR'], second['HERMES_PANEL_STATE_DIR'])
        finally:
            for key, value in old.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    def test_native_suite_provenance_check_rejects_manifest_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = root / 'app-source-manifest.json'
            candidate = root / 'candidate-manifest.json'
            release = root / 'release-candidate.tar.gz'
            app.write_text(json.dumps({'commit': 'a' * 40}))
            candidate.write_text(json.dumps({'commit': 'a' * 40}))
            release.write_bytes(b'fixture release')
            source_hash = NATIVE.digest(app)
            candidate_hash = NATIVE.digest(candidate)
            acceptance_id = hashlib.sha256(f"{'a' * 40}:{source_hash}:{candidate_hash}".encode()).hexdigest()[:16]
            metadata = root / 'acceptance-metadata.json'
            metadata.write_text(json.dumps({
                'commit': 'a' * 40,
                'acceptance_id': acceptance_id,
                'app_source_manifest_sha256': source_hash,
                'candidate_manifest_sha256': candidate_hash,
                'built_at_utc': '2026-11-08T00:00:00+00:00',
                'release_candidate_sha256': NATIVE.digest(release),
            }))
            old_root = NATIVE.ROOT
            try:
                NATIVE.ROOT = root
                self.assertEqual(NATIVE.metadata()['acceptance_id'], acceptance_id)
                candidate.write_text(json.dumps({'commit': 'b' * 40}))
                with self.assertRaises(SystemExit):
                    NATIVE.metadata()
            finally:
                NATIVE.ROOT = old_root

    def test_every_preview_browser_fixture_requires_dynamic_port_and_group_cleanup(self):
        fixtures = sorted(SUITE.TESTS.glob('*-browser.py'))
        preview_fixtures = [path for path in fixtures if 'preview-server.mjs' in path.read_text(encoding='utf-8')]
        self.assertGreaterEqual(len(preview_fixtures), 40)
        for path in preview_fixtures:
            source = path.read_text(encoding='utf-8')
            tree = ast.parse(source, filename=str(path))
            port_assignments = re.findall(r"['\"]PREVIEW_PORT['\"]\s*:\s*['\"]([^'\"]+)['\"]", source)
            port_assignments += re.findall(r"['\"]PREVIEW_PORT['\"]\s*,\s*['\"]([^'\"]+)['\"]", source)
            self.assertIn('0', port_assignments, f'{path.name} must request an OS-assigned preview port')
            launches = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
                        and isinstance(node.func, ast.Attribute) and node.func.attr == 'Popen']
            self.assertTrue(launches, f'{path.name} must start its preview server explicitly')
            self.assertTrue(any(any(keyword.arg == 'start_new_session'
                                    and isinstance(keyword.value, ast.Constant)
                                    and keyword.value.value is True for keyword in call.keywords)
                                for call in launches),
                            f'{path.name} must isolate the preview process group')
            self.assertTrue('killpg' in source or 'stop_process_group' in source,
                            f'{path.name} must stop its complete preview process group')

    def test_report_provenance_comes_from_matching_bundle_manifests(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app_manifest = root / 'app-source-manifest.json'
            candidate_manifest = root / 'candidate-manifest.json'
            app_manifest.write_text(json.dumps({'commit': 'a' * 40}), encoding='utf-8')
            candidate_manifest.write_text(json.dumps({'commit': 'a' * 40}), encoding='utf-8')
            source_hash = __import__('hashlib').sha256(app_manifest.read_bytes()).hexdigest()
            candidate_hash = __import__('hashlib').sha256(candidate_manifest.read_bytes()).hexdigest()
            acceptance_id = __import__('hashlib').sha256(f"{'a' * 40}:{source_hash}:{candidate_hash}".encode()).hexdigest()[:16]
            metadata = root / 'acceptance-metadata.json'
            metadata.write_text(json.dumps({
                'schema': 1, 'commit': 'a' * 40, 'acceptance_id': acceptance_id,
                'built_at_utc': '2026-11-08T00:00:00+00:00',
                'app_source_manifest_sha256': source_hash,
                'candidate_manifest_sha256': candidate_hash,
                'release_candidate_sha256': '0' * 64,
            }), encoding='utf-8')
            (root / 'release-candidate.tar.gz').write_bytes(b'fixture release')
            metadata_data = json.loads(metadata.read_text())
            metadata_data['release_candidate_sha256'] = __import__('hashlib').sha256((root / 'release-candidate.tar.gz').read_bytes()).hexdigest()
            metadata.write_text(json.dumps(metadata_data), encoding='utf-8')
            old_root, old_app, old_candidate, old_metadata = SUITE.ROOT, SUITE.APP_MANIFEST, SUITE.CANDIDATE_MANIFEST, SUITE.ACCEPTANCE_METADATA
            try:
                SUITE.ROOT, SUITE.APP_MANIFEST, SUITE.CANDIDATE_MANIFEST, SUITE.ACCEPTANCE_METADATA = root, app_manifest, candidate_manifest, metadata
                provenance = SUITE.candidate_provenance()
                self.assertEqual(provenance['candidate_commit'], 'a' * 40)
                expected_id = __import__('hashlib').sha256(
                    f"{'a' * 40}:{provenance['app_source_manifest_sha256']}:{provenance['candidate_manifest_sha256']}".encode()
                ).hexdigest()[:16]
                self.assertEqual(provenance['acceptance_id'], expected_id)
                self.assertEqual(len(provenance['app_source_manifest_sha256']), 64)
                self.assertEqual(len(provenance['candidate_manifest_sha256']), 64)
                self.assertEqual(provenance['bundle_built_at_utc'], '2026-11-08T00:00:00+00:00')
                candidate_manifest.write_text(json.dumps({'commit': 'b' * 40}), encoding='utf-8')
                with self.assertRaises(SystemExit):
                    SUITE.candidate_provenance()
            finally:
                SUITE.ROOT, SUITE.APP_MANIFEST, SUITE.CANDIDATE_MANIFEST, SUITE.ACCEPTANCE_METADATA = old_root, old_app, old_candidate, old_metadata

    def test_core_group_is_explicit_and_every_script_exists(self):
        selected = SUITE.tests_for('core')
        self.assertEqual(len(selected), len(SUITE.CORE))
        self.assertTrue(all(Path(command[-1]).is_file() for _, command in selected))
        self.assertEqual(len({name for name, _ in selected}), len(selected))

    def test_all_group_covers_every_browser_fixture_and_durable_runner_once(self):
        selected = SUITE.tests_for('all')
        expected = {script.stem for script in SUITE.TESTS.glob('*-browser.py')
                    if script.name != 'durable-browser.py'} | {'durable-browser'}
        names = [name for name, _ in selected]
        self.assertEqual(set(names), expected)
        self.assertEqual(len(names), len(set(names)))
        self.assertTrue(all(Path(command[-1]).is_file() for _, command in selected))
        self.assertEqual(names.count('durable-browser'), 1)

    def test_success_and_failure_keep_separate_logs(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            success = SUITE.run_one('ok', [sys.executable, '-c', 'print("fixture passed")'], 2, output, {}, ROOT)
            failure = SUITE.run_one('bad', [sys.executable, '-c', 'raise SystemExit(7)'], 2, output, {}, ROOT)
            self.assertEqual(success['status'], 'passed')
            self.assertEqual(failure['status'], 'failed')
            self.assertEqual(failure['exit_code'], 7)
            self.assertIn('fixture passed', Path(success['stdout']).read_text())
            self.assertTrue(Path(failure['stderr']).is_file())

    def test_timeout_is_reported_and_leader_is_reaped(self):
        with tempfile.TemporaryDirectory() as directory:
            result = SUITE.run_one('slow', [sys.executable, '-c', 'import time; time.sleep(30)'],
                                   0.1, Path(directory), {}, ROOT)
            self.assertEqual(result['status'], 'timeout')
            self.assertIsNotNone(result['exit_code'])

    def test_orphan_cleanup_is_limited_to_new_fixture_command_groups(self):
        with tempfile.TemporaryDirectory(prefix='suite-cleanup-') as directory:
            root = Path(directory)
            fixture_path = root / 'preview-server.mjs'
            fixture_path.write_text('// process identity marker')
            before = set(SUITE.proc_snapshot())
            node = shutil.which('node')
            if not node:
                self.skipTest('Node is required for the process-group cleanup fixture')
            script = root / 'fixture.js'
            script.write_text('setInterval(()=>{},1000);')
            child = subprocess.Popen([node, str(script), str(fixture_path)],
                                     start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                deadline = time.monotonic() + 3
                while child.pid not in SUITE.proc_snapshot() and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertIn(child.pid, SUITE.proc_snapshot())
                killed = SUITE.stop_fixture_processes(before, root)
                child.wait(timeout=3)
                self.assertIn(child.pid, killed)
            finally:
                if child.poll() is None:
                    os.killpg(child.pid, 9)
                    child.wait(timeout=3)


if __name__ == '__main__':
    unittest.main(verbosity=2)
