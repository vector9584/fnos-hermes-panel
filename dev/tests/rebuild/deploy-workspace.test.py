import hashlib
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


class DeployWorkspace(unittest.TestCase):
    def test_complete_tree_is_published_and_extra_runtime_is_preserved(self):
        with tempfile.TemporaryDirectory(prefix='deploy-workspace-', dir='/private/tmp') as directory:
            root = Path(directory)
            source = root / 'source'
            shutil.copytree(ROOT, source, symlinks=True)
            app = root / 'app'
            data = root / 'data'
            backup = root / 'backup'
            fakebin = root / 'bin'
            app.mkdir()
            data.mkdir()
            fakebin.mkdir()
            (fakebin / 'id').write_text('#!/bin/sh\nprintf "%s\\n" hermes-agent\n')
            (fakebin / 'fake-node').write_text('#!/bin/sh\nexit 0\n')
            (fakebin / 'fake-python').write_text('#!/bin/sh\nexit 0\n')
            for path in fakebin.iterdir():
                path.chmod(0o755)

            retained = app / 'server/retained-runtime.js'
            retained.parent.mkdir(parents=True)
            retained.write_text('keep me\n')

            env = {
                **os.environ,
                'PATH': str(fakebin) + ':' + os.environ.get('PATH', ''),
                'SRC_REPO': str(source),
                'APP_DIR': str(app),
                'DATA_DIR': str(data),
                'NODE_BIN': str(fakebin / 'fake-node'),
                'PY_BIN': str(fakebin / 'fake-python'),
                'BACKUP': str(backup),
            }
            result = subprocess.run(
                ['bash', str(source / 'dev/deploy-workspace.sh'), '--no-restart'],
                env=env, text=True, capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            expected_count = sum(1 for entry in subprocess.check_output(
                ['git', '-C', str(source), 'ls-files', 'app/server', 'app/ui', 'app/python'],
                text=True).splitlines() if '.bak-' not in entry and '.bak-' not in entry and not entry.endswith('.bak'))
            self.assertIn(f'Candidate files: {expected_count}', result.stdout)
            self.assertTrue(retained.is_file())
            self.assertEqual(retained.read_text(), 'keep me\n')

            rows = (backup / 'MANIFEST.tsv').read_text().splitlines()
            self.assertEqual(len(rows), expected_count + 1)
            self.assertTrue(rows[0].startswith('source\tdestination\taction'))
            destinations = set()
            for line in rows[1:]:
                source_rel, destination_rel, action, candidate, old = line.split('\t')
                destinations.add(destination_rel)
                source_file = source / 'app' / source_rel
                target_file = app / destination_rel
                self.assertTrue(source_file.is_file(), source_rel)
                self.assertTrue(target_file.is_file(), destination_rel)
                self.assertEqual(digest(source_file), candidate)
                self.assertEqual(digest(target_file), candidate)
                if action == 'replace':
                    self.assertTrue(old)
                    self.assertEqual(digest(backup / destination_rel), old)
                else:
                    self.assertIn(action, {'create', 'keep'})
            self.assertEqual(len(destinations), expected_count)
            self.assertNotIn('server/retained-runtime.js', destinations)

    def test_symlink_target_is_refused_before_overwrite(self):
        with tempfile.TemporaryDirectory(prefix='deploy-workspace-link-', dir='/private/tmp') as directory:
            root = Path(directory)
            source = root / 'source'
            shutil.copytree(ROOT, source, symlinks=True)
            app = root / 'app'
            data = root / 'data'
            fakebin = root / 'bin'
            app.mkdir(); data.mkdir(); fakebin.mkdir()
            for name in ('id', 'fake-node', 'fake-python'):
                script = fakebin / name
                script.write_text('#!/bin/sh\n' + ('printf "hermes-agent\\n"' if name == 'id' else 'exit 0') + '\n')
                script.chmod(0o755)
            outside = root / 'outside'; outside.write_text('outside\n')
            target = app / 'server/panel-queue.js'; target.parent.mkdir(parents=True)
            target.symlink_to(outside)
            env = {**os.environ, 'PATH': str(fakebin) + ':' + os.environ.get('PATH', ''),
                   'SRC_REPO': str(source), 'APP_DIR': str(app), 'DATA_DIR': str(data),
                   'NODE_BIN': str(fakebin / 'fake-node'), 'PY_BIN': str(fakebin / 'fake-python'),
                   'BACKUP': str(root / 'backup')}
            result = subprocess.run(['bash', str(source / 'dev/deploy-workspace.sh'), '--no-restart'],
                                    env=env, text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('符号链接', result.stderr)
            self.assertEqual(outside.read_text(), 'outside\n')

    def test_existing_backup_directory_is_refused_without_touching_runtime(self):
        with tempfile.TemporaryDirectory(prefix='deploy-workspace-backup-', dir='/private/tmp') as directory:
            root = Path(directory)
            source = root / 'source'
            shutil.copytree(ROOT, source, symlinks=True)
            app = root / 'app'; data = root / 'data'; fakebin = root / 'bin'
            app.mkdir(); data.mkdir(); fakebin.mkdir()
            for name, body in {
                'id': '#!/bin/sh\nprintf "hermes-agent\\n"\n',
                'fake-node': '#!/bin/sh\nexit 0\n',
                'fake-python': '#!/bin/sh\nexit 0\n',
            }.items():
                script = fakebin / name; script.write_text(body); script.chmod(0o755)
            backup = root / 'backup'; backup.mkdir(); (backup / 'sentinel').write_text('keep\n')
            env = {**os.environ, 'PATH': str(fakebin) + ':' + os.environ.get('PATH', ''),
                   'SRC_REPO': str(source), 'APP_DIR': str(app), 'DATA_DIR': str(data),
                   'NODE_BIN': str(fakebin / 'fake-node'), 'PY_BIN': str(fakebin / 'fake-python'),
                   'BACKUP': str(backup)}
            result = subprocess.run(['bash', str(source / 'dev/deploy-workspace.sh'), '--no-restart'],
                                    env=env, text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('备份目录已存在', result.stderr)
            self.assertEqual((backup / 'sentinel').read_text(), 'keep\n')
            self.assertEqual(list(app.rglob('*')), [])

    def test_hardlink_target_is_refused_before_replacement(self):
        with tempfile.TemporaryDirectory(prefix='deploy-workspace-hardlink-', dir='/private/tmp') as directory:
            root = Path(directory)
            source = root / 'source'
            shutil.copytree(ROOT, source, symlinks=True)
            app = root / 'app'; data = root / 'data'; fakebin = root / 'bin'
            app.mkdir(); data.mkdir(); fakebin.mkdir()
            for name, body in {
                'id': '#!/bin/sh\nprintf "hermes-agent\\n"\n',
                'fake-node': '#!/bin/sh\nexit 0\n',
                'fake-python': '#!/bin/sh\nexit 0\n',
            }.items():
                script = fakebin / name; script.write_text(body); script.chmod(0o755)
            target = app / 'server/panel-queue.js'; target.parent.mkdir(parents=True)
            target.write_text('shared-old\n'); sibling = root / 'sibling.js'; os.link(target, sibling)
            env = {**os.environ, 'PATH': str(fakebin) + ':' + os.environ.get('PATH', ''),
                   'SRC_REPO': str(source), 'APP_DIR': str(app), 'DATA_DIR': str(data),
                   'NODE_BIN': str(fakebin / 'fake-node'), 'PY_BIN': str(fakebin / 'fake-python'),
                   'BACKUP': str(root / 'backup')}
            result = subprocess.run(['bash', str(source / 'dev/deploy-workspace.sh'), '--no-restart'],
                                    env=env, text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('硬链接', result.stderr)
            self.assertEqual(target.read_text(), 'shared-old\n')
            self.assertEqual(sibling.read_text(), 'shared-old\n')


if __name__ == '__main__':
    unittest.main(verbosity=2)
