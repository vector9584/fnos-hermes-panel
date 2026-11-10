#!/usr/bin/env python3
"""Build a hash-audited, non-production NAS browser acceptance bundle."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def tracked(paths: list[str]) -> list[str]:
    result = subprocess.check_output(["git", "ls-files", "--", *paths], cwd=ROOT, text=True)
    return [line for line in result.splitlines() if line]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    bundle_paths = ["app", "cmd/main", "dev/tests/rebuild", "dev/release-stage.py", "dev/release-manifest.py",
                    "dev/browser-bundle.py", "dev/hermes-dev.sh", "dev/rebuild/NAS-browser-handoff.md"]
    dirty = subprocess.run(["git", "diff", "--quiet", "HEAD", "--", *bundle_paths], cwd=ROOT).returncode
    if dirty:
        raise SystemExit("refusing to bundle: browser/release inputs differ from HEAD")
    untracked = subprocess.check_output(
        ["git", "ls-files", "--others", "--exclude-standard", "--", "app", "dev/tests/rebuild"],
        cwd=ROOT,
        text=True,
    ).splitlines()
    unexpected = [path for path in untracked if "/__pycache__/" not in f"/{path}/" and not path.endswith(".pyc")]
    if unexpected:
        raise SystemExit("refusing to bundle untracked APP/test inputs: " + ", ".join(unexpected[:10]))
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    output = args.output if args.output.is_absolute() else ROOT / args.output
    if output.exists():
        raise SystemExit(f"refusing to overwrite existing output: {output}")

    app_files = tracked(["app"])
    test_files = tracked(["dev/tests/rebuild"])
    handoff = "dev/rebuild/NAS-browser-handoff.md"
    if handoff not in tracked([handoff]):
        raise SystemExit(f"missing handoff: {handoff}")

    with tempfile.TemporaryDirectory(prefix="hermes-browser-bundle-", dir="/private/tmp") as temp:
        work = Path(temp)
        stage = work / "release-stage"
        release_archive = work / "release-candidate.tar.gz"
        subprocess.run(
            [sys.executable, str(ROOT / "dev/release-stage.py"), "--output", str(stage), "--archive", str(release_archive)],
            cwd=ROOT,
            check=True,
            stdout=subprocess.DEVNULL,
        )
        release_manifest = json.loads((stage / "RELEASE-MANIFEST.json").read_text(encoding="utf-8"))
        if release_manifest["commit"] != commit:
            raise SystemExit("release stage commit does not match browser bundle commit")

        bundle = work / "bundle"
        bundle_root = bundle / "hermes-browser-acceptance"
        files = []
        for rel in app_files + test_files + ["cmd/main", "dev/hermes-dev.sh", handoff]:
            source = ROOT / rel
            if not source.is_file():
                raise SystemExit(f"tracked bundle input is missing: {rel}")
            target = bundle_root / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            files.append({"path": rel, "sha256": digest(target), "bytes": target.stat().st_size})

        # NAS runs fixtures as hermes-agent after vector extracts the archive.
        # Do not preserve local private directory modes that make the bundle
        # unreadable across that identity boundary.
        for directory in sorted((path for path in bundle_root.rglob('*') if path.is_dir()),
                                key=lambda path: len(path.parts), reverse=True):
            directory.chmod(0o755)
        bundle_root.chmod(0o755)
        for path in bundle_root.rglob('*'):
            if path.is_file():
                path.chmod(path.stat().st_mode | 0o444)

        shutil.copy2(release_archive, bundle_root / "release-candidate.tar.gz")
        shutil.copy2(stage / "RELEASE-MANIFEST.json", bundle_root / "candidate-manifest.json")
        browser_manifest = {
            "schema": 1,
            "kind": "hermes-browser-acceptance-sources",
            "commit": commit,
            "app_file_count": len(app_files),
            "test_file_count": len(test_files),
            "files": files,
        }
        (bundle_root / "app-source-manifest.json").write_text(
            json.dumps(browser_manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        built_at_utc = datetime.now(timezone.utc).isoformat(timespec="seconds")
        source_hash = digest(bundle_root / "app-source-manifest.json")
        candidate_hash = digest(bundle_root / "candidate-manifest.json")
        acceptance_id = hashlib.sha256(
            f"{commit}:{source_hash}:{candidate_hash}".encode()
        ).hexdigest()[:16]
        (bundle_root / "acceptance-metadata.json").write_text(
            json.dumps({
                "schema": 1,
                "acceptance_id": acceptance_id,
                "commit": commit,
                "built_at_utc": built_at_utc,
                "app_source_manifest_sha256": source_hash,
                "candidate_manifest_sha256": candidate_hash,
                "release_candidate_sha256": digest(release_archive),
            }, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        archive = output
        archive.parent.mkdir(parents=True, exist_ok=True)
        with tarfile.open(archive, "w:gz") as tar:
            tar.add(bundle_root, arcname="hermes-browser-acceptance")
        with tarfile.open(archive, "r:gz") as tar:
            members = {member.name: member for member in tar.getmembers() if member.isfile()}
            expected = {f"hermes-browser-acceptance/{rel}": row["sha256"] for rel, row in (
                (item["path"], item) for item in files
            )}
            expected.update({
                "hermes-browser-acceptance/release-candidate.tar.gz": digest(release_archive),
                "hermes-browser-acceptance/candidate-manifest.json": digest(bundle_root / "candidate-manifest.json"),
                "hermes-browser-acceptance/app-source-manifest.json": digest(bundle_root / "app-source-manifest.json"),
                "hermes-browser-acceptance/acceptance-metadata.json": digest(bundle_root / "acceptance-metadata.json"),
            })
            if set(members) != set(expected):
                raise SystemExit("browser bundle member set does not match its manifests")
            for name, expected_hash in expected.items():
                stream = tar.extractfile(members[name])
                if stream is None or hashlib.sha256(stream.read()).hexdigest() != expected_hash:
                    raise SystemExit(f"browser bundle hash verification failed: {name}")
            release_stream = tar.extractfile(members["hermes-browser-acceptance/release-candidate.tar.gz"])
            if release_stream is None:
                raise SystemExit("browser bundle release candidate is unreadable")
            with tarfile.open(fileobj=io.BytesIO(release_stream.read()), mode="r:gz") as release_tar:
                release_members = {member.name: member for member in release_tar.getmembers() if member.isfile()}
                stage_manifest = json.loads(release_tar.extractfile("release/RELEASE-MANIFEST.json").read())
                for item in stage_manifest["files"]:
                    member_name = "release/" + item["destination"]
                    stream = release_tar.extractfile(release_members[member_name])
                    if stream is None or hashlib.sha256(stream.read()).hexdigest() != item["sha256"]:
                        raise SystemExit(f"release candidate hash verification failed: {item['destination']}")
        sidecar = {"path": str(archive), "sha256": digest(archive), "bytes": archive.stat().st_size,
                   "commit": commit, "acceptance_id": acceptance_id, "built_at_utc": built_at_utc,
                   "app_source_manifest_sha256": source_hash,
                   "candidate_manifest_sha256": candidate_hash}
        archive.with_suffix(archive.suffix + ".sha256.json").write_text(
            json.dumps(sidecar, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(json.dumps({"ok": True, **sidecar, "app_files": len(app_files), "test_files": len(test_files)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
