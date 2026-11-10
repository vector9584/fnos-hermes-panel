import os
import json
import subprocess
import tarfile
import tempfile
import unittest
import io
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
BASELINE = '74059c0ca00934602d29e497382dde70793ac755'


class ReleasePreflight(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='release-preflight-test-', dir='/private/tmp')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'repo'
        subprocess.run(['git', 'clone', '-q', '--shared', str(ROOT), str(self.root)], check=True)
        subprocess.run(['git', '-C', str(self.root), 'checkout', '-q', 'HEAD'], check=True)
        current_script = self.root / 'dev/release-preflight.sh'
        if current_script.read_bytes() != (ROOT / 'dev/release-preflight.sh').read_bytes():
            shutil.copy2(ROOT / 'dev/release-preflight.sh', current_script)
            subprocess.run(['git', '-C', str(self.root), 'add', 'dev/release-preflight.sh'], check=True)
            subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=Fixture', '-c',
                            'user.email=fixture@example.invalid', 'commit', '-qm', 'test candidate preflight'],
                           check=True)
        self.archive = Path(self.temp.name) / 'candidate.tar.gz'
        self.baseline_archive = Path(self.temp.name) / 'baseline.tar.gz'
        self.baseline_archive.write_bytes(b'fixture baseline')
        self.write_candidate_archive()

    def write_candidate_archive(self, commit=None, manifest=True):
        commit = commit or subprocess.check_output(['git', '-C', str(self.root), 'rev-parse', 'HEAD'], text=True).strip()
        files = []
        payloads = {}
        tracked = subprocess.check_output(
            ['git', '-C', str(self.root), 'ls-files', 'app/server', 'app/ui', 'app/python'], text=True
        ).splitlines()
        for raw in tracked:
            source = 'app/' + raw.removeprefix('app/')
            if '.bak-' in source or source.endswith('.bak') or not (self.root / source).is_file():
                continue
            content = (self.root / source).read_bytes()
            destination = ('appcenter/hermes-src/' + source.removeprefix('app/python/')) \
                if source.startswith('app/python/') else ('appcenter/' + source.removeprefix('app/'))
            files.append({'source': source, 'destination': destination,
                          'sha256': __import__('hashlib').sha256(content).hexdigest(), 'bytes': len(content)})
            payloads[destination] = content
        with tarfile.open(self.archive, 'w:gz') as bundle:
            if manifest:
                payload = json.dumps({'kind': 'hermes-release-stage', 'commit': commit,
                                      'file_count': len(files), 'files': files}).encode()
                info = tarfile.TarInfo('release/RELEASE-MANIFEST.json')
                info.size = len(payload)
                bundle.addfile(info, io.BytesIO(payload))
                for name, content in payloads.items():
                    entry = tarfile.TarInfo('release/' + name)
                    entry.size = len(content)
                    bundle.addfile(entry, io.BytesIO(content))

    def run_preflight(self):
        env = {**os.environ, 'RELEASE_BASE_COMMIT': BASELINE,
               'CANDIDATE_ARCHIVE': str(self.archive), 'BASELINE_ARCHIVE': str(self.baseline_archive)}
        return subprocess.run(['bash', 'dev/release-preflight.sh', '--json'], cwd=self.root,
                              env=env, text=True, capture_output=True)

    def run_default_preflight(self):
        env = {**os.environ, 'RELEASE_BASE_COMMIT': BASELINE,
               'CANDIDATE_ARCHIVE': '', 'BASELINE_ARCHIVE': str(self.baseline_archive)}
        return subprocess.run(['bash', 'dev/release-preflight.sh', '--json'], cwd=self.root,
                              env=env, text=True, capture_output=True)

    def test_local_evidence_does_not_block_when_complete_publisher_is_present(self):
        evidence = self.root / 'outputs/hermes-rebuild/hermes-env-evidence/local-proof.tap'
        evidence.parent.mkdir(parents=True, exist_ok=True)
        evidence.write_text('local test evidence\n')
        result = self.run_preflight()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('working tree is not clean', result.stderr)
        self.assertNotIn('deploy script omits candidate runtime files', result.stderr)
        self.assertNotIn('complete workspace deploy helper is missing', result.stderr)
        self.assertNotIn('workspace deploy helper lacks the Python hermes-src mapping', result.stderr)

    def test_untracked_runtime_source_is_rejected_before_mapping_audit(self):
        (self.root / 'app/ui/new-module.js').write_text('new runtime asset\n')
        result = self.run_preflight()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('untracked runtime files are not in the committed candidate', result.stderr)
        self.assertNotIn('deploy script omits candidate runtime files', result.stderr)

    def test_tracked_runtime_modification_is_rejected(self):
        with (self.root / 'app/ui/index.html').open('a') as stream:
            stream.write('\n<!-- fixture -->\n')
        result = self.run_preflight()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('release inputs differ from HEAD', result.stderr)

    def test_deploy_mapping_shape_change_fails_closed(self):
        helper = self.root / 'dev/hermes-dev.sh'
        text = helper.read_text()
        self.assertIn('local rel="$what/$f"', text)
        helper.write_text(text.replace('local rel="$what/$f"', 'local rel="new-layout/$f"'))
        self.assertIn('local rel="new-layout/$f"', helper.read_text())
        subprocess.run(['git', '-C', str(self.root), 'add', 'dev/hermes-dev.sh'], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=Fixture', '-c',
                        'user.email=fixture@example.invalid', 'commit', '-qm', 'change deploy mapping'],
                       check=True)
        result = self.run_preflight()
        self.assertIn('ui/server deploy path mapping changed', result.stderr)
        self.assertNotIn('complete workspace deploy helper is missing', result.stderr)

    def test_complete_publisher_shape_change_fails_closed(self):
        helper = self.root / 'dev/deploy-workspace.sh'
        text = helper.read_text()
        self.assertIn('python/*) printf', text)
        helper.write_text(text.replace("python/*) printf 'hermes-src/%s\\n'", "python/*) printf 'wrong-root/%s\\n'"))
        subprocess.run(['git', '-C', str(self.root), 'add', 'dev/deploy-workspace.sh'], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=Fixture', '-c',
                        'user.email=fixture@example.invalid', 'commit', '-qm', 'change complete deploy mapping'],
                       check=True)
        result = self.run_preflight()
        self.assertIn('workspace deploy helper lacks the Python hermes-src mapping', result.stderr)

    def test_stale_or_manifestless_candidate_archive_fails_closed(self):
        self.write_candidate_archive(commit='0' * 40)
        result = self.run_preflight()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('candidate archive is invalid or stale', result.stderr)
        self.write_candidate_archive(manifest=False)
        result = self.run_preflight()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('candidate archive is invalid or stale', result.stderr)

    def test_runtime_archive_from_ancestor_commit_is_accepted_when_tree_matches(self):
        result = self.run_preflight()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_default_archive_stages_and_checks_current_head(self):
        result = self.run_default_preflight()
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(data['commit'], subprocess.check_output(
            ['git', '-C', str(self.root), 'rev-parse', 'HEAD'], text=True).strip())
        self.assertTrue(data['candidate_archive'].endswith('/candidate.tar.gz'))
        self.assertFalse(Path(data['candidate_archive']).exists(), 'temporary candidate archive must be cleaned')

    def test_explicit_stale_archive_still_fails_closed(self):
        self.write_candidate_archive(commit='0' * 40)
        result = self.run_preflight()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('candidate archive is invalid or stale', result.stderr)

    def test_archive_missing_runtime_source_is_rejected(self):
        self.write_candidate_archive()
        with tarfile.open(self.archive, 'r:gz') as original:
            members = [item for item in original.getmembers() if item.name != 'release/appcenter/ui/index.html']
            contents = {item.name: original.extractfile(item).read() for item in members if item.isfile()}
        with tarfile.open(self.archive, 'w:gz') as bundle:
            for item in members:
                if item.name not in contents:
                    bundle.addfile(item)
                    continue
                body = contents[item.name]
                info = tarfile.TarInfo(item.name)
                info.size = len(body)
                bundle.addfile(info, io.BytesIO(body))
        result = self.run_preflight()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('archive members do not match manifest', result.stderr)

    def test_ancestor_archive_is_rejected_after_committed_runtime_change(self):
        with (self.root / 'app/ui/index.html').open('a') as stream:
            stream.write('\n<!-- newer runtime -->\n')
        subprocess.run(['git', '-C', str(self.root), 'add', 'app/ui/index.html'], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=Fixture', '-c',
                        'user.email=fixture@example.invalid', 'commit', '-qm', 'change runtime after archive'],
                       check=True)
        result = self.run_preflight()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('runtime source changed since staging: app/ui/index.html', result.stderr)

    def test_current_commit_archive_with_tampered_payload_fails_closed(self):
        with tarfile.open(self.archive, 'w:gz') as bundle:
            commit = subprocess.check_output(['git', '-C', str(self.root), 'rev-parse', 'HEAD'], text=True).strip()
            original = b'candidate bytes'; tampered = b'tampered bytes'
            files = [{'source': 'app/ui/index.html', 'destination': 'appcenter/ui/index.html',
                      'sha256': __import__('hashlib').sha256(original).hexdigest(), 'bytes': len(original)}]
            payload = json.dumps({'kind': 'hermes-release-stage', 'commit': commit,
                                  'file_count': 1, 'files': files}).encode()
            manifest = tarfile.TarInfo('release/RELEASE-MANIFEST.json'); manifest.size = len(payload)
            bundle.addfile(manifest, io.BytesIO(payload))
            item = tarfile.TarInfo('release/appcenter/ui/index.html'); item.size = len(tampered)
            bundle.addfile(item, io.BytesIO(tampered))
        result = self.run_preflight()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('candidate archive is invalid or stale', result.stderr)

    def test_duplicate_archive_member_fails_closed(self):
        commit = subprocess.check_output(['git', '-C', str(self.root), 'rev-parse', 'HEAD'], text=True).strip()
        content = b'candidate bytes'
        files = [{'source': 'app/ui/index.html', 'destination': 'appcenter/ui/index.html',
                  'sha256': __import__('hashlib').sha256(content).hexdigest(), 'bytes': len(content)}]
        payload = json.dumps({'kind': 'hermes-release-stage', 'commit': commit,
                              'file_count': 1, 'files': files}).encode()
        with tarfile.open(self.archive, 'w:gz') as bundle:
            manifest = tarfile.TarInfo('release/RELEASE-MANIFEST.json'); manifest.size = len(payload)
            bundle.addfile(manifest, io.BytesIO(payload))
            for _ in range(2):
                item = tarfile.TarInfo('release/appcenter/ui/index.html'); item.size = len(content)
                bundle.addfile(item, io.BytesIO(content))
        result = self.run_preflight()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('candidate archive is invalid or stale', result.stderr)

    def test_manifest_cannot_redirect_source_to_unrelated_target(self):
        commit = subprocess.check_output(['git', '-C', str(self.root), 'rev-parse', 'HEAD'], text=True).strip()
        content = b'candidate bytes'
        files = [{'source': 'app/ui/index.html', 'destination': 'appcenter/server/monitor.js',
                  'sha256': __import__('hashlib').sha256(content).hexdigest(), 'bytes': len(content)}]
        payload = json.dumps({'kind': 'hermes-release-stage', 'commit': commit,
                              'file_count': 1, 'files': files}).encode()
        with tarfile.open(self.archive, 'w:gz') as bundle:
            manifest = tarfile.TarInfo('release/RELEASE-MANIFEST.json'); manifest.size = len(payload)
            bundle.addfile(manifest, io.BytesIO(payload))
            item = tarfile.TarInfo('release/appcenter/server/monitor.js'); item.size = len(content)
            bundle.addfile(item, io.BytesIO(content))
        result = self.run_preflight()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('candidate archive is invalid or stale', result.stderr)


if __name__ == '__main__':
    unittest.main(verbosity=2)
