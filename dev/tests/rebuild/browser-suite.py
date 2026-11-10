#!/usr/bin/env python3
"""Run isolated NAS browser fixtures serially and retain per-test evidence."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
TESTS = ROOT / "dev/tests/rebuild"
APP_MANIFEST = ROOT / "app-source-manifest.json"
CANDIDATE_MANIFEST = ROOT / "candidate-manifest.json"
ACCEPTANCE_METADATA = ROOT / "acceptance-metadata.json"
CORE = [
    "models-browser.py",
    "error-state-browser.py",
    "experts-browser.py",
    "plans-browser.py",
    "navigation-browser.py",
    "keyboard-controls-browser.py",
    "visible-state-browser.py",
    "log-clear-browser.py",
    "session-archive-browser.py",
    "channels-browser.py",
    "channel-pairing-browser.py",
    "channel-runtime-browser.py",
    "chat-entry-browser.py",
    "chat-scroll-browser.py",
    "chat-search-browser.py",
    "chat-slash-browser.py",
    "chat-storage-browser.py",
    "chat-tools-browser.py",
    "chat-load-error-browser.py",
    "library-browser.py",
    "library-read-browser.py",
    "library-recovery-browser.py",
    "library-storage-browser.py",
    "echo-browser.py",
    "expert-room-browser.py",
    "usage-browser.py",
    "auth-browser.py",
]


def proc_snapshot() -> dict[int, str]:
    """Read command lines without shell parsing; only used for timeout cleanup."""
    result = {}
    proc = Path("/proc")
    if proc.is_dir():
        for entry in proc.iterdir():
            if not entry.name.isdigit():
                continue
            try:
                command = (entry / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace").strip()
            except OSError:
                continue
            if command:
                result[int(entry.name)] = command
        return result
    listing = subprocess.run(["ps", "-axo", "pid=,command="], text=True,
                             capture_output=True, check=False)
    if listing.returncode:
        return result
    for line in listing.stdout.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) == 2 and parts[0].isdigit():
            result[int(parts[0])] = parts[1]
    return result


def belongs_to_fixture(command: str, root: Path) -> bool:
    root_text = str(root)
    return ("preview-server.mjs" in command and root_text in command) or (
        "php -S " in command and "hermes-echo-web-" in command
    )


def stop_fixture_processes(before: set[int], root: Path, timeout: float = 5.0) -> list[int]:
    targets = {pid: command for pid, command in proc_snapshot().items()
               if pid not in before and belongs_to_fixture(command, root)}
    groups = set()
    for pid in targets:
        try:
            groups.add(os.getpgid(pid))
        except (ProcessLookupError, PermissionError):
            pass
    for group in groups:
        try:
            os.killpg(group, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
    deadline = time.monotonic() + timeout
    while targets and time.monotonic() < deadline:
        live = set(proc_snapshot())
        targets = {pid: command for pid, command in targets.items() if pid in live}
        if targets:
            time.sleep(0.05)
    remaining_groups = set()
    for pid in targets:
        try:
            remaining_groups.add(os.getpgid(pid))
        except (ProcessLookupError, PermissionError):
            pass
    for group in remaining_groups:
        try:
            os.killpg(group, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    return sorted(targets)


def run_one(name: str, command: list[str], timeout: float, output: Path,
            env: dict[str, str], root: Path) -> dict:
    stdout_path = output / f"{name}.stdout.log"
    stderr_path = output / f"{name}.stderr.log"
    before = set(proc_snapshot())
    started = time.monotonic()
    timed_out = False
    cleanup = []
    with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
        try:
            process = subprocess.Popen(command, cwd=root, env=env, stdout=stdout, stderr=stderr,
                                       start_new_session=True)
        except OSError as error:
            stderr.write(f"Unable to start fixture: {error}\n".encode())
            return {
                "name": name,
                "status": "failed",
                "exit_code": None,
                "duration_seconds": round(time.monotonic() - started, 3),
                "timeout_seconds": timeout,
                "stdout": str(stdout_path),
                "stderr": str(stderr_path),
                "orphan_fixture_pids_signalled": [],
            }
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
            cleanup = stop_fixture_processes(before, root)
            code = process.returncode
    return {
        "name": name,
        "status": "timeout" if timed_out else ("passed" if code == 0 else "failed"),
        "exit_code": code,
        "duration_seconds": round(time.monotonic() - started, 3),
        "timeout_seconds": timeout,
        "stdout": str(stdout_path),
        "stderr": str(stderr_path),
        "orphan_fixture_pids_signalled": cleanup,
    }


def tests_for(group: str) -> list[tuple[str, list[str]]]:
    scripts = sorted(TESTS.glob("*-browser.py"))
    scripts = [script for script in scripts if script.name not in {"durable-browser.py"}]
    if group == "core":
        scripts = [TESTS / name for name in CORE]
    selected = [(script.stem, [sys.executable, str(script)]) for script in scripts]
    if group != "core":
        selected.insert(0, ("durable-browser", [sys.executable, str(TESTS / "run-browser-isolated.py")]))
    return selected


def candidate_provenance() -> dict[str, str]:
    """Bind suite results to the extracted, hash-verified browser bundle."""
    if not APP_MANIFEST.is_file() or not CANDIDATE_MANIFEST.is_file():
        raise SystemExit("missing browser bundle manifests; run only from a verified acceptance bundle")
    source_bytes = APP_MANIFEST.read_bytes()
    candidate_bytes = CANDIDATE_MANIFEST.read_bytes()
    source = json.loads(source_bytes)
    candidate = json.loads(candidate_bytes)
    commit = source.get("commit")
    if not isinstance(commit, str) or len(commit) != 40 or candidate.get("commit") != commit:
        raise SystemExit("browser source and runtime candidate commit do not match")
    source_hash = hashlib.sha256(source_bytes).hexdigest()
    candidate_hash = hashlib.sha256(candidate_bytes).hexdigest()
    acceptance_id = hashlib.sha256(f"{commit}:{source_hash}:{candidate_hash}".encode()).hexdigest()[:16]
    try:
        metadata = json.loads(ACCEPTANCE_METADATA.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise SystemExit(f"missing or invalid acceptance metadata: {error}")
    if (metadata.get("schema") != 1 or metadata.get("commit") != commit
            or metadata.get("acceptance_id") != acceptance_id
            or metadata.get("app_source_manifest_sha256") != source_hash
            or metadata.get("candidate_manifest_sha256") != candidate_hash):
        raise SystemExit("acceptance metadata does not match browser bundle manifests")
    release_archive = ROOT / "release-candidate.tar.gz"
    if not release_archive.is_file() or hashlib.sha256(release_archive.read_bytes()).hexdigest() != metadata.get("release_candidate_sha256"):
        raise SystemExit("release candidate archive does not match acceptance metadata")
    built_at_utc = metadata.get("built_at_utc")
    if not isinstance(built_at_utc, str) or not built_at_utc.endswith("+00:00"):
        raise SystemExit("acceptance metadata has no UTC build timestamp")
    return {
        "acceptance_id": acceptance_id,
        "candidate_commit": commit,
        "bundle_built_at_utc": built_at_utc,
        "release_candidate_sha256": metadata.get("release_candidate_sha256"),
        "app_source_manifest_sha256": source_hash,
        "candidate_manifest_sha256": candidate_hash,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--group", choices=("core", "all"), default="core")
    parser.add_argument("--timeout", type=float, default=300,
                        help="per-script timeout in seconds (default: 300)")
    parser.add_argument("--output-dir", type=Path,
                        help="new directory for per-test logs and report.json")
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    provenance = candidate_provenance()
    lock_path = Path("/tmp/hermes-browser-suite.lock")
    with lock_path.open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("another browser suite is already running")

        label = datetime.now().strftime("%Y%m%d-%H%M%S")
        started_at_utc = datetime.now(timezone.utc).isoformat(timespec="seconds")
        output = args.output_dir or Path("/tmp") / f"hermes-browser-suite-{label}"
        output = output.resolve()
        output.mkdir(parents=True, exist_ok=False)
        env = os.environ.copy()
        env.setdefault("HERMES_PREVIEW_NODE", "/vol1/@apphome/hermes-agent/data/node/bin/node")
        env.setdefault("HERMES_TEST_PYTHON", "/vol1/@apphome/hermes-agent/data/venv/bin/python3")
        env.setdefault("HERMES_PLAYWRIGHT_BROWSERS_PATH", "/vol1/@apphome/hermes-agent/data/.cache/ms-playwright")
        selected = tests_for(args.group)
        results = []
        print(json.dumps({"group": args.group, "count": len(selected), "output_dir": str(output), **provenance}, ensure_ascii=False), flush=True)
        for index, (name, command) in enumerate(selected, start=1):
            print(f"[{index}/{len(selected)}] {name}", flush=True)
            result = run_one(name, command, args.timeout, output, env, ROOT)
            results.append(result)
            print(json.dumps(result, ensure_ascii=False), flush=True)
        report = {
            "schema": 1,
            "candidate_root": str(ROOT),
            **provenance,
            "group": args.group,
            "started_at_local": label,
            "started_at_utc": started_at_utc,
            "completed_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "count": len(results),
            "passed": sum(item["status"] == "passed" for item in results),
            "failed": sum(item["status"] == "failed" for item in results),
            "timed_out": sum(item["status"] == "timeout" for item in results),
            "results": results,
        }
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps({"report": str(output / 'report.json'), "passed": report['passed'],
                          "failed": report['failed'], "timed_out": report['timed_out']}, ensure_ascii=False), flush=True)
        return 0 if report["failed"] == 0 and report["timed_out"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
