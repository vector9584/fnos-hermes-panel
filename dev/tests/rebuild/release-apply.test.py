import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location('release_apply', ROOT / 'dev/release-apply.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ReleaseApply(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='release-apply-test-', dir='/private/tmp')
        self.root = Path(self.tmp.name)
        self.stage = self.root / 'stage'
        self.target = self.root / 'target'
        self.backup = self.root / 'backup'
        self.output = self.root / 'result.json'
        (self.stage / 'appcenter/server').mkdir(parents=True)
        (self.stage / 'appcenter/hermes-src').mkdir(parents=True)
        self.entries = [
            ('app/server/monitor.js', 'appcenter/server/monitor.js', b'new-monitor\n'),
            ('app/python/panel_config.py', 'appcenter/hermes-src/panel_config.py', b'new-python\n'),
        ]
        self.write_manifest()
        self.addCleanup(self.tmp.cleanup)

    def write_manifest(self):
        import hashlib
        rows = []
        for source, destination, content in self.entries:
            path = self.stage / destination
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
            rows.append({'source': source, 'destination': destination,
                         'sha256': hashlib.sha256(content).hexdigest(), 'bytes': len(content)})
        (self.stage / 'RELEASE-MANIFEST.json').write_text(json.dumps({
            'schema': 1, 'kind': 'hermes-release-stage', 'file_count': len(rows), 'files': rows,
        }))

    def apply(self):
        return MODULE.main_args_for_test(self.stage, self.target, self.backup, self.output)

    def test_all_release_paths_detect_production_prefixes(self):
        for path in (Path('/vol1/runtime'), Path('/vol3/data'), Path('/vol4/archive')):
            self.assertTrue(MODULE.is_production_path(path))
        for path in (Path('/private/tmp/release'), Path('/tmp/release')):
            self.assertFalse(MODULE.is_production_path(path))

    def test_valid_stage_applies_and_preserves_unlisted_target_files(self):
        (self.target / 'appcenter/server').mkdir(parents=True)
        (self.target / 'appcenter/server/monitor.js').write_bytes(b'old-monitor\n')
        (self.target / 'appcenter/keep.txt').write_text('keep\n')
        actions = MODULE.apply_stage(self.stage, self.target, self.backup)
        self.assertEqual(len(actions), 2)
        self.assertEqual((self.target / 'appcenter/server/monitor.js').read_bytes(), b'new-monitor\n')
        self.assertEqual((self.target / 'appcenter/hermes-src/panel_config.py').read_bytes(), b'new-python\n')
        self.assertEqual((self.target / 'appcenter/keep.txt').read_text(), 'keep\n')
        self.assertEqual((self.backup / 'appcenter/server/monitor.js').read_bytes(), b'old-monitor\n')
        manifest = json.loads((self.backup / 'BACKUP-MANIFEST.json').read_text())
        self.assertEqual(manifest['file_count'], 1)
        self.assertEqual(manifest['files'][0]['path'], 'appcenter/server/monitor.js')

    def test_explicit_rollback_restores_replaced_removes_created_and_keeps_unlisted(self):
        (self.target / 'appcenter/server').mkdir(parents=True)
        old = self.target / 'appcenter/server/monitor.js'
        old.write_bytes(b'old-monitor\n')
        keep = self.target / 'operator-data.json'
        keep.write_text('retain\n')
        MODULE.apply_stage(self.stage, self.target, self.backup)
        result = MODULE.rollback_stage(self.stage, self.target, self.backup)
        self.assertEqual(old.read_bytes(), b'old-monitor\n')
        self.assertFalse((self.target / 'appcenter/hermes-src/panel_config.py').exists())
        self.assertEqual(keep.read_text(), 'retain\n')
        self.assertEqual(result['removed'], ['appcenter/hermes-src/panel_config.py'])
        self.assertEqual(result['restored'], ['appcenter/server/monitor.js'])

    def test_explicit_rollback_refuses_target_drift_and_keeps_backup(self):
        (self.target / 'appcenter/server').mkdir(parents=True)
        old = self.target / 'appcenter/server/monitor.js'
        old.write_bytes(b'old-monitor\n')
        MODULE.apply_stage(self.stage, self.target, self.backup)
        old.write_bytes(b'external-edit\n')
        with self.assertRaisesRegex(ValueError, 'target drift since publish'):
            MODULE.rollback_stage(self.stage, self.target, self.backup)
        self.assertEqual(old.read_bytes(), b'external-edit\n')
        self.assertEqual((self.backup / 'appcenter/server/monitor.js').read_bytes(), b'old-monitor\n')

    def test_explicit_rollback_failure_recovers_candidate_and_keeps_backup(self):
        (self.target / 'appcenter/server').mkdir(parents=True)
        old = self.target / 'appcenter/server/monitor.js'
        old.write_bytes(b'old-monitor\n')
        MODULE.apply_stage(self.stage, self.target, self.backup)
        real_replace = MODULE.os.replace
        writes = {'target': 0}

        def fail_rollback_readback(source, destination):
            destination = Path(destination)
            if str(destination).startswith(str(self.target)):
                writes['target'] += 1
                if writes['target'] == 1:
                    real_replace(source, destination)
                    destination.write_bytes(b'corrupt rollback readback')
                    return None
            return real_replace(source, destination)

        with patch.object(MODULE.os, 'replace', side_effect=fail_rollback_readback):
            with self.assertRaisesRegex(RuntimeError, 'candidate files restored and backup retained'):
                MODULE.rollback_stage(self.stage, self.target, self.backup)
        self.assertEqual(old.read_bytes(), b'new-monitor\n')
        self.assertEqual((self.target / 'appcenter/hermes-src/panel_config.py').read_bytes(), b'new-python\n')
        self.assertEqual((self.backup / 'appcenter/server/monitor.js').read_bytes(), b'old-monitor\n')

    def test_failed_apply_refuses_tampered_backup_without_overwriting_target(self):
        (self.target / 'appcenter/server').mkdir(parents=True)
        old = self.target / 'appcenter/server/monitor.js'
        old.write_bytes(b'old-monitor\n')
        real_replace = MODULE.os.replace
        writes = {'count': 0}

        def fail_publish_and_tamper_backup(source, destination):
            if str(destination).startswith(str(self.target)):
                writes['count'] += 1
                if writes['count'] == 1:
                    (self.backup / 'appcenter/server/monitor.js').write_bytes(b'tampered-backup\n')
                    raise OSError('fixture publish failure')
            return real_replace(source, destination)

        with patch.object(MODULE.os, 'replace', side_effect=fail_publish_and_tamper_backup):
            with self.assertRaisesRegex(RuntimeError, 'rollback refused.*backup verification failed'):
                MODULE.apply_stage(self.stage, self.target, self.backup)
        self.assertEqual(old.read_bytes(), b'old-monitor\n')
        self.assertEqual((self.target / 'appcenter/hermes-src/panel_config.py').exists(), False)

    def test_backup_manifest_rejects_missing_file_and_records_empty_backup(self):
        actions = MODULE.apply_stage(self.stage, self.target, self.backup)
        self.assertEqual(len(actions), 2)
        manifest = json.loads((self.backup / 'BACKUP-MANIFEST.json').read_text())
        self.assertEqual(manifest['file_count'], 0)
        with self.assertRaisesRegex(ValueError, 'backup file manifest'):
            MODULE.verify_backup(self.backup, {'appcenter/server/monitor.js': {
                'sha256': '0' * 64, 'bytes': 1,
            }}, MODULE.sha(self.stage / 'RELEASE-MANIFEST.json'))

    def test_backup_manifest_name_inside_nested_target_path_is_not_ignored(self):
        (self.target / 'appcenter/server').mkdir(parents=True)
        old = self.target / 'appcenter/server/monitor.js'
        old.write_bytes(b'old-monitor\n')
        self.entries.append(('app/server/nested/BACKUP-MANIFEST.json',
                             'appcenter/server/nested/BACKUP-MANIFEST.json', b'new-manifest-name\n'))
        self.write_manifest()
        actions = MODULE.apply_stage(self.stage, self.target, self.backup)
        self.assertEqual(len(actions), 3)
        backup_manifest = json.loads((self.backup / 'BACKUP-MANIFEST.json').read_text())
        self.assertEqual(backup_manifest['file_count'], 1)
        self.assertEqual((self.target / 'appcenter/server/nested/BACKUP-MANIFEST.json').read_bytes(), b'new-manifest-name\n')

    def test_modified_staged_file_fails_before_target_or_backup_creation(self):
        (self.stage / 'appcenter/server/monitor.js').write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError, 'mismatch'):
            MODULE.validate_stage(self.stage)
        self.assertFalse(self.target.exists())
        self.assertFalse(self.backup.exists())

    def test_path_traversal_manifest_is_rejected(self):
        data = json.loads((self.stage / 'RELEASE-MANIFEST.json').read_text())
        data['files'][0]['destination'] = 'appcenter/../../outside'
        (self.stage / 'RELEASE-MANIFEST.json').write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, 'unsafe manifest path'):
            MODULE.validate_stage(self.stage)

    def test_manifest_cannot_redirect_python_overlay(self):
        data = json.loads((self.stage / 'RELEASE-MANIFEST.json').read_text())
        data['files'][1]['destination'] = 'appcenter/server/monitor.js'
        (self.stage / 'RELEASE-MANIFEST.json').write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, 'mapping mismatch|duplicate destination'):
            MODULE.validate_stage(self.stage)

    def test_nonempty_backup_is_never_overwritten(self):
        self.backup.mkdir()
        (self.backup / 'operator.txt').write_text('untouched')
        with self.assertRaisesRegex(ValueError, 'non-empty backup'):
            MODULE.apply_stage(self.stage, self.target, self.backup)
        self.assertEqual((self.backup / 'operator.txt').read_text(), 'untouched')
        self.assertFalse(self.target.exists())

    def test_replace_error_restores_old_bytes_and_removes_new_files(self):
        (self.target / 'appcenter/server').mkdir(parents=True)
        old = self.target / 'appcenter/server/monitor.js'
        old.write_bytes(b'old-monitor\n')
        real_replace = MODULE.os.replace
        writes = {'count': 0}

        def fail_second_publish(source, destination):
            if str(destination).startswith(str(self.target)):
                writes['count'] += 1
                if writes['count'] == 2:
                    raise OSError('fixture publish failure')
            return real_replace(source, destination)

        with patch.object(MODULE.os, 'replace', side_effect=fail_second_publish):
            with self.assertRaisesRegex(OSError, 'fixture publish failure'):
                MODULE.apply_stage(self.stage, self.target, self.backup)
        self.assertEqual(old.read_bytes(), b'old-monitor\n')
        self.assertFalse((self.target / 'appcenter/hermes-src/panel_config.py').exists())

    def test_rollback_readback_failure_is_reported(self):
        (self.target / 'appcenter/server').mkdir(parents=True)
        old = self.target / 'appcenter/server/monitor.js'
        old.write_bytes(b'old-monitor\n')
        real_replace = MODULE.os.replace
        writes = {'count': 0}

        def corrupt_rollback_readback(source, destination):
            destination = Path(destination)
            if str(destination).startswith(str(self.target)):
                writes['count'] += 1
                if writes['count'] == 2:
                    raise OSError('fixture publish failure')
                if writes['count'] == 3:
                    real_replace(source, destination)
                    destination.write_bytes(b'corrupt restore')
                    return None
            return real_replace(source, destination)

        with patch.object(MODULE.os, 'replace', side_effect=corrupt_rollback_readback):
            with self.assertRaisesRegex(RuntimeError, 'rollback readback verification failed'):
                MODULE.apply_stage(self.stage, self.target, self.backup)

    def test_target_drift_after_plan_aborts_before_any_publish(self):
        (self.target / 'appcenter/server').mkdir(parents=True)
        old = self.target / 'appcenter/server/monitor.js'
        old.write_bytes(b'old-monitor\n')
        # Reproduce a race between action planning and backup capture by changing
        # the file during backup copy.
        original_copy2 = MODULE.shutil.copy2
        def drift_during_backup(source, destination):
            result = original_copy2(source, destination)
            if Path(destination).is_relative_to(self.backup):
                old.write_bytes(b'external-change\n')
            return result
        with patch.object(MODULE.shutil, 'copy2', side_effect=drift_during_backup):
            with self.assertRaisesRegex(ValueError, 'target drift'):
                MODULE.apply_stage(self.stage, self.target, self.backup)
        self.assertEqual(old.read_bytes(), b'external-change\n')
        self.assertFalse((self.target / 'appcenter/hermes-src/panel_config.py').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
