import hashlib
import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def git(*arguments):
    return subprocess.check_output(['git', '-C', str(ROOT), *arguments])


def manifest(root):
    return {str(file.relative_to(root)): hashlib.sha256(file.read_bytes()).hexdigest()
            for file in sorted(root.rglob('*')) if file.is_file()}


def run(destination):
    destination.mkdir(parents=True, exist_ok=True)
    commit = git('rev-parse', 'HEAD').decode().strip()
    baseline_archive = destination / ('baseline-' + commit[:8] + '.tar.gz')
    with baseline_archive.open('wb') as output:
        subprocess.run(['git', '-C', str(ROOT), 'archive', '--format=tar.gz', 'HEAD'], stdout=output, check=True)
    # The rehearsal models the publishable repository candidate.  Do not fold
    # untracked logs, screenshots or local reports into a release rollback
    # manifest; those are evidence artifacts, not deployable files.
    files = [name for name in git('ls-files', '-z', '--cached').decode().split('\0')
             if name and '__pycache__' not in Path(name).parts and not name.endswith('.pyc')]
    candidate_archive = destination / 'candidate.tar.gz'
    with tarfile.open(candidate_archive, 'w:gz') as archive:
        for name in sorted(set(files)):
            if name and (ROOT / name).is_file():
                archive.add(ROOT / name, arcname=name, recursive=False)
    with tempfile.TemporaryDirectory(prefix='hermes-rollback-', dir='/tmp') as temporary:
        temporary = Path(temporary)
        baseline = temporary / 'baseline'
        candidate = temporary / 'candidate'
        runtime = temporary / 'runtime'
        baseline.mkdir()
        candidate.mkdir()
        with tarfile.open(baseline_archive) as archive:
            archive.extractall(baseline)
        with tarfile.open(candidate_archive) as archive:
            archive.extractall(candidate)
        before, after = manifest(baseline), manifest(candidate)
        shutil.copytree(baseline, runtime)
        added = sorted(set(after) - set(before))
        removed = sorted(set(before) - set(after))
        changed = sorted(name for name in before.keys() & after.keys() if before[name] != after[name])
        for name in removed:
            (runtime / name).unlink()
        for name in added + changed:
            (runtime / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(candidate / name, runtime / name)
        if manifest(runtime) != after:
            raise RuntimeError('隔离部署后的校验值不匹配')
        for name in added:
            (runtime / name).unlink()
        for name in removed + changed:
            (runtime / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(baseline / name, runtime / name)
        restored = manifest(runtime)
        if restored != before:
            raise RuntimeError('隔离回滚后的校验值不匹配')
        report = {'baseline_commit': commit, 'scope': '本地完整源码文件，隔离目录部署及回滚；不代表生产数据回滚',
                  'baseline_files': len(before), 'candidate_files': len(after), 'added': added, 'removed': removed,
                  'changed': changed, 'deployed_exact_match': True, 'restored_exact_match': True,
                  'archives': {file.name: hashlib.sha256(file.read_bytes()).hexdigest()
                               for file in (baseline_archive, candidate_archive)}}
        (destination / 'baseline-manifest.json').write_text(json.dumps(before, indent=2, ensure_ascii=False))
        (destination / 'candidate-manifest.json').write_text(json.dumps(after, indent=2, ensure_ascii=False))
        (destination / 'rehearsal.json').write_text(json.dumps(report, indent=2, ensure_ascii=False))
        print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    run(Path(sys.argv[1]).resolve())
