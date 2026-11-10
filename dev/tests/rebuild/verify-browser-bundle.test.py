import contextlib
import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path


SOURCE = Path(__file__).with_name('verify-browser-bundle.py')
SPEC = importlib.util.spec_from_file_location('verify_browser_bundle', SOURCE)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class VerifyBrowserBundle(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'app/ui').mkdir(parents=True)
        (self.root / 'dev/tests/rebuild').mkdir(parents=True)
        (self.root / 'cmd').mkdir(parents=True)
        (self.root / 'dev').mkdir(exist_ok=True)
        (self.root / 'app/ui/index.html').write_text('fixture ui')
        (self.root / 'dev/tests/rebuild/example.py').write_text('fixture test')
        (self.root / 'cmd/main').write_text('#!/bin/sh\n')
        (self.root / 'dev/hermes-dev.sh').write_text('#!/bin/sh\n')
        files = []
        for relative in ('app/ui/index.html', 'dev/tests/rebuild/example.py', 'cmd/main', 'dev/hermes-dev.sh'):
            path = self.root / relative
            files.append({
                'path': relative,
                'bytes': path.stat().st_size,
                'sha256': MODULE.digest(path),
            })
        manifest = {
            'kind': 'hermes-browser-acceptance-sources',
            'commit': 'fixture-commit',
            'app_file_count': 1,
            'test_file_count': 1,
            'files': files,
        }
        (self.root / 'app-source-manifest.json').write_text(json.dumps(manifest))
        (self.root / 'candidate-manifest.json').write_text(json.dumps({'commit': 'fixture-commit', 'file_count': 1}))
        source_hash = MODULE.digest(self.root / 'app-source-manifest.json')
        candidate_hash = MODULE.digest(self.root / 'candidate-manifest.json')
        acceptance_id = __import__('hashlib').sha256(
            f"fixture-commit:{source_hash}:{candidate_hash}".encode()
        ).hexdigest()[:16]
        release = self.root / 'release-candidate.tar.gz'
        release_root = self.root / 'release-fixture'
        (release_root / 'appcenter/app/ui').mkdir(parents=True)
        (release_root / 'appcenter/app/ui/index.html').write_text('fixture ui')
        release_manifest = {
            'kind': 'hermes-release-stage', 'commit': 'fixture-commit', 'file_count': 1,
            'files': [{'source': 'app/ui/index.html', 'destination': 'appcenter/ui/index.html',
                       'bytes': 10, 'sha256': MODULE.digest(self.root / 'app/ui/index.html')}],
        }
        (release_root / 'RELEASE-MANIFEST.json').write_text(json.dumps(release_manifest))
        with tarfile.open(release, 'w:gz') as archive:
            archive.add(release_root / 'RELEASE-MANIFEST.json', arcname='release/RELEASE-MANIFEST.json')
            archive.add(release_root / 'appcenter/app/ui/index.html', arcname='release/appcenter/ui/index.html')
        (self.root / 'acceptance-metadata.json').write_text(json.dumps({
            'schema': 1, 'commit': 'fixture-commit', 'acceptance_id': acceptance_id,
            'built_at_utc': '2026-11-08T00:00:00+00:00',
            'app_source_manifest_sha256': source_hash,
            'candidate_manifest_sha256': candidate_hash,
            'release_candidate_sha256': MODULE.digest(release),
        }))
        MODULE.ROOT = self.root
        MODULE.MANIFEST = self.root / 'app-source-manifest.json'
        MODULE.ACCEPTANCE_METADATA = self.root / 'acceptance-metadata.json'

    def test_accepts_matching_sources_and_candidate(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            MODULE.main()
        result = json.loads(output.getvalue())
        self.assertTrue(result['ok'])
        self.assertEqual(result['verified_files'], 4)
        self.assertEqual(result['runtime_files'], 1)
        self.assertEqual(len(result['acceptance_id']), 16)
        self.assertEqual(result['built_at_utc'], '2026-11-08T00:00:00+00:00')
        self.assertIn('verified_at_utc', result)

    def test_rejects_tampered_acceptance_build_metadata(self):
        metadata = json.loads((self.root / 'acceptance-metadata.json').read_text())
        metadata['commit'] = 'different-commit'
        (self.root / 'acceptance-metadata.json').write_text(json.dumps(metadata))
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(SystemExit, '构建凭据'):
            MODULE.main()

    def test_rejects_source_change(self):
        (self.root / 'app/ui/index.html').write_text('tampered')
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(SystemExit, '文件校验失败'):
            MODULE.main()

    def test_rejects_candidate_commit_mismatch(self):
        (self.root / 'candidate-manifest.json').write_text(json.dumps({'commit': 'other-commit'}))
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(SystemExit, '提交号不一致'):
            MODULE.main()

    def test_rejects_missing_test_runtime_support_file(self):
        manifest = json.loads((self.root / 'app-source-manifest.json').read_text())
        for missing in ('cmd/main', 'dev/hermes-dev.sh'):
            with self.subTest(missing=missing):
                manifest['files'] = [item for item in manifest['files'] if item['path'] != missing]
                (self.root / 'app-source-manifest.json').write_text(json.dumps(manifest))
                with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(SystemExit, '运行支持文件未打包'):
                    MODULE.main()
                manifest = json.loads((self.root / 'app-source-manifest.json').read_text())

    def test_rejects_runtime_archive_hash_mismatch(self):
        (self.root / 'release-candidate.tar.gz').write_bytes(b'bad archive')
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(SystemExit, '运行候选校验失败'):
            MODULE.main()

    def rewrite_runtime_archive(self, mutate):
        path = self.root / 'release-candidate.tar.gz'
        replacement = path.with_suffix('.replacement.tar.gz')
        with tarfile.open(path, 'r:gz') as source, tarfile.open(replacement, 'w:gz') as target:
            rows = []
            for member in source.getmembers():
                if not member.isfile():
                    continue
                content = source.extractfile(member).read()
                new_member, new_content = mutate(member, content)
                rows.append((new_member, new_content))
            for new_member, new_content in rows:
                info = tarfile.TarInfo(new_member.name)
                info.size = len(new_content)
                info.mode = new_member.mode
                target.addfile(info, io.BytesIO(new_content))
        replacement.replace(path)

    def test_rejects_runtime_file_tampering_inside_valid_archive(self):
        def tamper(member, content):
            if member.name == 'release/appcenter/ui/index.html':
                return member, b'tampered ui'
            return member, content
        self.rewrite_runtime_archive(tamper)
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(SystemExit, '运行文件哈希或大小不匹配'):
            MODULE.main()

    def test_rejects_unlisted_runtime_archive_member(self):
        def add_extra(member, content):
            return member, content
        self.rewrite_runtime_archive(add_extra)
        path = self.root / 'release-candidate.tar.gz'
        extra = path.with_suffix('.extra.tar.gz')
        with tarfile.open(path, 'r:gz') as source, tarfile.open(extra, 'w:gz') as target:
            for member in source.getmembers():
                if member.isfile():
                    target.addfile(member, source.extractfile(member))
            payload = b'extra'
            info = tarfile.TarInfo('release/appcenter/ui/unlisted.js')
            info.size = len(payload)
            target.addfile(info, io.BytesIO(payload))
        extra.replace(path)
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(SystemExit, '运行候选校验失败'):
            MODULE.main()


if __name__ == '__main__':
    unittest.main(verbosity=2)
