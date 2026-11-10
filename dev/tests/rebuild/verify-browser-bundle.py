"""Verify the extracted NAS browser bundle sources against their manifest."""
import hashlib
import json
import tarfile
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
MANIFEST = ROOT / 'app-source-manifest.json'
ACCEPTANCE_METADATA = ROOT / 'acceptance-metadata.json'


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def main():
    manifest = json.loads(MANIFEST.read_text(encoding='utf-8'))
    if manifest.get('kind') != 'hermes-browser-acceptance-sources':
        raise SystemExit('不是 Hermes 浏览器验收包')
    if manifest.get('app_file_count') != sum(item['path'].startswith('app/') for item in manifest['files']):
        raise SystemExit('APP 文件数量与清单不符')
    if manifest.get('test_file_count') != sum(item['path'].startswith('dev/tests/rebuild/') for item in manifest['files']):
        raise SystemExit('测试文件数量与清单不符')

    failures = []
    seen = set()
    for item in manifest['files']:
        relative = Path(item['path'])
        if relative.is_absolute() or '..' in relative.parts or item['path'] in seen:
            failures.append(f"非法或重复路径：{item['path']}")
            continue
        seen.add(item['path'])
        path = ROOT / relative
        if not path.is_file():
            failures.append(f"文件缺失：{item['path']}")
        elif path.stat().st_size != item['bytes'] or digest(path) != item['sha256']:
            failures.append(f"文件校验失败：{item['path']}")

    # Native fixtures execute the package wrapper directly; catch missing
    # support files before a NAS run can fail with shell exit 127.
    required_test_support = {'cmd/main', 'dev/hermes-dev.sh'}
    if not required_test_support.issubset(seen):
        failures.append('测试引用的运行支持文件未打包：' + ', '.join(sorted(required_test_support - seen)))

    candidate = json.loads((ROOT / 'candidate-manifest.json').read_text(encoding='utf-8'))
    if candidate.get('commit') != manifest.get('commit'):
        failures.append('浏览器源码与运行候选的提交号不一致')
    try:
        metadata = json.loads(ACCEPTANCE_METADATA.read_text(encoding='utf-8'))
        source_hash = hashlib.sha256(MANIFEST.read_bytes()).hexdigest()
        candidate_hash = hashlib.sha256((ROOT / 'candidate-manifest.json').read_bytes()).hexdigest()
        acceptance_id = hashlib.sha256((manifest['commit'] + ':' + source_hash + ':' + candidate_hash).encode()).hexdigest()[:16]
        if metadata.get('schema') != 1 or metadata.get('commit') != manifest.get('commit'):
            failures.append('验收包内构建凭据的提交号或 schema 无效')
        if metadata.get('acceptance_id') != acceptance_id:
            failures.append('验收包内 acceptance_id 与 manifest 不匹配')
        if metadata.get('app_source_manifest_sha256') != source_hash or metadata.get('candidate_manifest_sha256') != candidate_hash:
            failures.append('验收包内 manifest 指纹与构建凭据不匹配')
        release_sha = metadata.get('release_candidate_sha256')
        if not isinstance(release_sha, str) or len(release_sha) != 64:
            failures.append('验收包内缺少运行候选归档 SHA-256')
        elif (ROOT / 'release-candidate.tar.gz').is_file() and digest(ROOT / 'release-candidate.tar.gz') != release_sha:
            failures.append('运行候选归档 SHA-256 与构建凭据不匹配')
        built_at_utc = metadata.get('built_at_utc')
        if not isinstance(built_at_utc, str) or not built_at_utc.endswith('+00:00'):
            failures.append('验收包缺少 UTC 构建时间')
    except (OSError, ValueError, KeyError, TypeError) as error:
        failures.append('验收包缺少有效构建凭据：' + str(error))
    release_path = ROOT / 'release-candidate.tar.gz'
    if not release_path.is_file():
        failures.append('缺少运行候选归档')
    else:
        try:
            with tarfile.open(release_path, 'r:gz') as archive:
                members = [item for item in archive.getmembers() if item.isfile()]
                manifest_member = next((item for item in members if item.name == 'release/RELEASE-MANIFEST.json'), None)
                if manifest_member is None:
                    raise ValueError('运行归档缺少 RELEASE-MANIFEST.json')
                release_manifest = json.load(archive.extractfile(manifest_member))
                if release_manifest.get('kind') != 'hermes-release-stage':
                    raise ValueError('运行归档类型不正确')
                if release_manifest.get('commit') != manifest.get('commit'):
                    raise ValueError('运行归档与浏览器源码提交号不一致')
                entries = release_manifest.get('files')
                if not isinstance(entries, list) or release_manifest.get('file_count') != len(entries):
                    raise ValueError('运行归档文件清单无效')
                expected = {}
                for entry in entries:
                    source = entry.get('source')
                    destination = entry.get('destination')
                    if not isinstance(source, str) or not isinstance(destination, str):
                        raise ValueError('运行清单路径类型无效')
                    if source.startswith('/') or any(part in ('', '.', '..') for part in source.split('/')):
                        raise ValueError('运行清单源路径非法')
                    if destination.startswith('/') or any(part in ('', '.', '..') for part in destination.split('/')):
                        raise ValueError('运行清单目标路径非法')
                    if not (source.startswith('app/server/') or source.startswith('app/ui/') or source.startswith('app/python/')):
                        raise ValueError('运行清单源路径越界')
                    mapped = 'appcenter/hermes-src/' + source.removeprefix('app/python/') if source.startswith('app/python/') else 'appcenter/' + source.removeprefix('app/')
                    if destination != mapped or destination in expected:
                        raise ValueError('运行清单源/目标映射重复或不匹配')
                    size, sha = entry.get('bytes'), entry.get('sha256')
                    if not isinstance(size, int) or size < 0 or not isinstance(sha, str) or len(sha) != 64:
                        raise ValueError('运行清单大小或 SHA-256 无效')
                    expected['release/' + destination] = (size, sha)
                actual = {item.name: item for item in members if item.name != manifest_member.name}
                if len(actual) != len(members) - 1 or set(actual) != set(expected):
                    raise ValueError('运行归档成员与运行清单不一致')
                for name, (size, sha) in expected.items():
                    item = actual[name]
                    stream = archive.extractfile(item)
                    if item.size != size or stream is None or hashlib.sha256(stream.read()).hexdigest() != sha:
                        raise ValueError('运行文件哈希或大小不匹配：' + name)
        except Exception as error:
            failures.append('运行候选校验失败：' + str(error))
    if failures:
        raise SystemExit('\n'.join(failures))
    print(json.dumps({
        'ok': True,
        'commit': manifest['commit'],
        'acceptance_id': acceptance_id,
        'built_at_utc': built_at_utc,
        'verified_at_utc': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'app_files': manifest['app_file_count'],
        'test_files': manifest['test_file_count'],
        'verified_files': len(seen),
        'runtime_files': candidate['file_count'],
        'runtime_manifest_sha256': hashlib.sha256((ROOT / 'candidate-manifest.json').read_bytes()).hexdigest(),
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
