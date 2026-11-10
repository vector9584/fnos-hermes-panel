import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location('release_plan', ROOT / 'dev/release-plan.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ReleasePlan(unittest.TestCase):
    def setUp(self):
        self.commit = '1' * 40
        self.files = [
            {'path': 'server/monitor.js', 'sha256': 'a' * 64, 'bytes': 4},
            {'path': 'python/gateway/config.py', 'sha256': 'b' * 64, 'bytes': 5},
            {'path': 'ui/index.html', 'sha256': 'c' * 64, 'bytes': 6},
        ]
        self.manifest = {'schema': 1, 'kind': 'hermes-candidate-runtime',
                         'commit': self.commit, 'file_count': len(self.files), 'files': self.files}
        self.rows = [
            {'source': 'server/monitor.js', 'target': 'server/monitor.js', 'action': 'replace',
             'candidate_sha256': 'a' * 64, 'nas_sha256': 'd' * 64},
            {'source': 'python/gateway/config.py', 'target': 'hermes-src/gateway/config.py', 'action': 'create',
             'candidate_sha256': 'b' * 64, 'nas_sha256': None},
            {'source': 'ui/index.html', 'target': 'ui/index.html', 'action': 'keep',
             'candidate_sha256': 'c' * 64, 'nas_sha256': 'c' * 64},
        ]
        self.comparison = {'schema': 1, 'kind': 'hermes-release-comparison',
                           'candidate_commit': self.commit, 'candidate_file_count': 3,
                           'nas_file_count': 3,
                           'summary': {'create': 1, 'replace': 1, 'keep': 1},
                           'files': self.rows, 'nas_extra': ['legacy.txt']}

    def test_plan_maps_python_overlay_and_preserves_unlisted_files(self):
        plan = MODULE.build_plan(self.manifest, self.comparison, 'f' * 64)
        self.assertFalse(plan['executable'])
        self.assertEqual(plan['candidate_manifest_sha256'], 'f' * 64)
        self.assertEqual(plan['nas_extra_preserve'], ['legacy.txt'])
        self.assertEqual([row['target'] for row in plan['actions']],
                         ['hermes-src/gateway/config.py', 'server/monitor.js'])
        self.assertEqual(plan['summary'], {'create': 1, 'replace': 1, 'keep': 1})

    def test_commit_mismatch_is_rejected(self):
        self.comparison['candidate_commit'] = '2' * 40
        with self.assertRaisesRegex(ValueError, 'commit mismatch'):
            MODULE.build_plan(self.manifest, self.comparison)

    def test_missing_candidate_row_is_rejected(self):
        self.comparison['files'].pop()
        self.comparison['summary']['keep'] = 0
        self.comparison['candidate_file_count'] = 2
        with self.assertRaisesRegex(ValueError, 'does not cover every candidate'):
            MODULE.build_plan(self.manifest, self.comparison)

    def test_python_overlay_redirect_is_rejected(self):
        self.comparison['files'][1]['target'] = 'server/config.py'
        with self.assertRaisesRegex(ValueError, 'target mapping mismatch'):
            MODULE.build_plan(self.manifest, self.comparison)

    def test_comparison_hash_or_action_tamper_is_rejected(self):
        self.comparison['files'][0]['candidate_sha256'] = 'e' * 64
        with self.assertRaisesRegex(ValueError, 'hash mismatch'):
            MODULE.build_plan(self.manifest, self.comparison)

    def test_traversal_path_is_rejected(self):
        self.comparison['nas_extra'] = ['../private']
        with self.assertRaisesRegex(ValueError, 'unsafe or non-canonical'):
            MODULE.build_plan(self.manifest, self.comparison)

    def test_remote_inventory_count_and_extra_overlap_are_rejected(self):
        self.comparison['nas_file_count'] = 2
        with self.assertRaisesRegex(ValueError, 'NAS file count'):
            MODULE.build_plan(self.manifest, self.comparison)
        self.comparison['nas_file_count'] = 3
        self.comparison['nas_extra'] = ['server/monitor.js']
        with self.assertRaisesRegex(ValueError, 'overlaps a candidate target'):
            MODULE.build_plan(self.manifest, self.comparison)

    def test_missing_candidate_targets_are_not_counted_as_existing_remote_files(self):
        self.comparison['nas_file_count'] = 2
        self.comparison['summary'] = {'create': 1, 'replace': 0, 'keep': 2}
        self.comparison['files'][0].update(action='keep', nas_sha256='a' * 64)
        self.comparison['files'][1].update(action='create', nas_sha256=None)
        self.comparison['nas_extra'] = []
        plan = MODULE.build_plan(self.manifest, self.comparison)
        self.assertEqual(plan['summary'], {'create': 1, 'replace': 0, 'keep': 2})
        self.assertEqual([row['source'] for row in plan['actions']], ['python/gateway/config.py'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
