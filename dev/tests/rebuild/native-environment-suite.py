"""Run NAS/Linux native acceptance fixtures against isolated /tmp state."""
import argparse
import hashlib
import json
import os
import pwd
import signal
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
TESTS = ROOT / 'dev/tests/rebuild'
NATIVE_TESTS = (
    'channel-enabled.test.py',
    'channels-native.test.py',
    'model-pool-native.test.py',
    'model-source-native.test.py',
    'native-config-integration.test.py',
    'provider-native.test.py',
    'cron-native.test.py',
    'echo-native.test.py',
    'drain-lease.test.py',
    'drain-stop.test.py',
    'drain-store.test.py',
    'lifecycle-real.test.py',
    'echo-web.test.py',
)
NATIVE_ROOT = Path('/vol1/@appcenter/hermes-agent/hermes-src')


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def stop_group(process):
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        process.wait()
        return
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.05)
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)


def metadata():
    manifest_path = ROOT / 'app-source-manifest.json'
    candidate_path = ROOT / 'candidate-manifest.json'
    metadata_path = ROOT / 'acceptance-metadata.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    candidate = json.loads(candidate_path.read_text(encoding='utf-8'))
    receipt = json.loads(metadata_path.read_text(encoding='utf-8'))
    source_hash = digest(manifest_path)
    candidate_hash = digest(candidate_path)
    acceptance_id = hashlib.sha256(
        f"{manifest['commit']}:{source_hash}:{candidate_hash}".encode()
    ).hexdigest()[:16]
    if (candidate.get('commit') != manifest.get('commit')
            or receipt.get('commit') != manifest.get('commit')
            or receipt.get('acceptance_id') != acceptance_id
            or receipt.get('app_source_manifest_sha256') != source_hash
            or receipt.get('candidate_manifest_sha256') != candidate_hash):
        raise SystemExit('验收包 provenance 不匹配；拒绝运行原生集成组')
    release = ROOT / 'release-candidate.tar.gz'
    if not release.is_file() or receipt.get('release_candidate_sha256') != digest(release):
        raise SystemExit('运行候选归档 SHA 不匹配；拒绝运行原生集成组')
    return {
        'acceptance_id': acceptance_id,
        'candidate_commit': manifest['commit'],
        'bundle_built_at_utc': receipt['built_at_utc'],
        'app_source_manifest_sha256': source_hash,
        'candidate_manifest_sha256': candidate_hash,
        'release_candidate_sha256': receipt['release_candidate_sha256'],
    }


def isolated_environment(native_root, output_root, test_name):
    # Carry only runtime lookup/locale settings; do not expose live model or
    # channel credentials to native integration subprocesses.
    fixture_root = output_root / ('fixture-' + Path(test_name).stem)
    home = fixture_root / 'home'
    state = fixture_root / 'state'
    managed = fixture_root / 'managed'
    temp = fixture_root / 'tmp'
    fixture_root.mkdir()
    home.mkdir()
    state.mkdir()
    managed.mkdir()
    temp.mkdir()
    env = {key: os.environ[key] for key in ('PATH', 'LANG', 'LC_ALL') if key in os.environ}
    env.update({
        'HOME': str(home),
        'HERMES_HOME': str(home),
        'HERMES_PANEL_CONFIG_ROOT': str(home),
        'HERMES_PANEL_STATE_DIR': str(state),
        'HERMES_MANAGED_DIR': str(managed),
        'TMPDIR': str(temp),
        'HERMES_TEST_NATIVE_ROOT': str(native_root),
        'HERMES_PREVIEW_NODE': '/vol1/@apphome/hermes-agent/data/node/bin/node',
        'TEST_PHP': shutil.which('php') or '/usr/bin/php',
        'PYTHONDONTWRITEBYTECODE': '1',
    })
    return env


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--native-root', required=True,
                        help='read-only installed Hermes source root: /vol1/@appcenter/hermes-agent/hermes-src')
    parser.add_argument('--timeout', type=int, default=240,
                        help='per-test process-group timeout in seconds (default: 240)')
    args = parser.parse_args()
    if args.timeout < 1 or args.timeout > 900:
        raise SystemExit('--timeout must be between 1 and 900 seconds')
    try:
        expected_uid = pwd.getpwnam('hermes-agent').pw_uid
    except KeyError:
        raise SystemExit('hermes-agent account is unavailable')
    if os.geteuid() != expected_uid:
        raise SystemExit('run this suite as hermes-agent; it does not invoke sudo')
    native_root = Path(args.native_root)
    if native_root != NATIVE_ROOT:
        raise SystemExit('native root must be the read-only installed Hermes source path')
    try:
        resolved = native_root.resolve(strict=True)
    except OSError as error:
        raise SystemExit('native root is unavailable: ' + type(error).__name__)
    if resolved != native_root or not resolved.is_dir() or not (resolved / 'hermes_cli/route_identity.py').is_file():
        raise SystemExit('native root identity or hermes_cli/route_identity.py is invalid')
    if not Path('/proc/self/stat').is_file():
        raise SystemExit('Linux /proc identity contract is unavailable')
    if not shutil.which('php'):
        raise SystemExit('PHP CLI is required for echo-web.test.py')
    bundle = metadata()
    verifier = subprocess.run(
        [sys.executable, '-B', str(TESTS / 'verify-browser-bundle.py')],
        cwd=ROOT, capture_output=True, text=True, timeout=60,
        env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'},
    )
    if verifier.returncode:
        sys.stderr.write(verifier.stdout)
        sys.stderr.write(verifier.stderr)
        raise SystemExit('bundle verifier failed; no native tests were started')
    verifier_result = json.loads(verifier.stdout)
    output_root = Path(tempfile.mkdtemp(prefix='hermes-native-suite-', dir='/tmp'))
    results = []
    started_at = datetime.now(timezone.utc).isoformat(timespec='seconds')
    for name in NATIVE_TESTS:
        started = time.monotonic()
        stdout_path = output_root / (name + '.stdout.log')
        stderr_path = output_root / (name + '.stderr.log')
        command = [sys.executable, '-B', str(TESTS / name)]
        status = 'failed'
        exit_code = None
        try:
            process = subprocess.Popen(command, cwd=ROOT,
                                       env=isolated_environment(native_root, output_root, name),
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       start_new_session=True)
            try:
                stdout, stderr = process.communicate(timeout=args.timeout)
                exit_code = process.returncode
                status = 'passed' if exit_code == 0 else 'failed'
            except subprocess.TimeoutExpired:
                stop_group(process)
                stdout, stderr = process.communicate()
                stderr += f'\nTIMEOUT after {args.timeout}s; test process group stopped.\n'.encode()
                status = 'timed_out'
        except OSError as error:
            stdout = b''
            stderr = (type(error).__name__ + ': ' + str(error)).encode()
        stdout_path.write_bytes(stdout)
        stderr_path.write_bytes(stderr)
        results.append({
            'name': name,
            'status': status,
            'exit_code': exit_code,
            'duration_seconds': round(time.monotonic() - started, 3),
            'stdout_bytes': len(stdout),
            'stderr_bytes': len(stderr),
            'stdout_sha256': digest(stdout_path),
            'stderr_sha256': digest(stderr_path),
        })
    report = {
        'schema': 1,
        'suite': 'nas-native-isolated',
        **bundle,
        'started_at_utc': started_at,
        'native_root': str(native_root),
        'python': sys.executable,
        'python_version': sys.version,
        'timeout_seconds': args.timeout,
        'verifier': verifier_result,
        'count': len(results),
        'passed': sum(row['status'] == 'passed' for row in results),
        'failed': sum(row['status'] == 'failed' for row in results),
        'timed_out': sum(row['status'] == 'timed_out' for row in results),
        'excluded': {
            'echo-identities.test.py': 'run separately as vector; requires sudo to www-data/hermes-agent and real ACL',
        },
        'results': results,
        'logs_dir': str(output_root),
    }
    report['completed_at_utc'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    report_path = output_root / 'report.json'
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print('report_sha256=' + digest(report_path))
    return 0 if report['failed'] == 0 and report['timed_out'] == 0 else 1


if __name__ == '__main__':
    raise SystemExit(main())
