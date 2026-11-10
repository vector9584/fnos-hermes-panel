#!/usr/bin/env python3
"""Exercise the staged runtime publisher and rollback against a temporary tree."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLISHER = ROOT / "dev/release-apply.py"


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tree(root: Path) -> dict[str, str]:
    return {path.relative_to(root).as_posix(): sha(path)
            for path in sorted(root.rglob("*")) if path.is_file()}


def under_tmp(path: Path) -> bool:
    resolved = path.resolve()
    return any(root == resolved or root in resolved.parents
               for root in (Path("/tmp"), Path("/private/tmp")))


def command(*args: str) -> dict:
    result = subprocess.run([sys.executable, str(PUBLISHER), *args], cwd=ROOT,
                            text=True, capture_output=True, check=False)
    if result.returncode:
        raise RuntimeError(f"release publisher failed ({result.returncode}): {result.stderr.strip()}")
    return json.loads(result.stdout)


def rehearse(stage: Path, work: Path) -> dict:
    stage, work = stage.resolve(), work.resolve()
    if not under_tmp(stage) or not under_tmp(work):
        raise ValueError("stage and rehearsal work directory must be under /tmp")
    if not stage.is_dir() or work.exists() and any(work.iterdir()):
        raise ValueError("stage must exist and work directory must be empty")
    manifest = json.loads((stage / "RELEASE-MANIFEST.json").read_text(encoding="utf-8"))
    entries = manifest["files"]
    if len(entries) < 3:
        raise ValueError("at least three runtime files are required to cover create/replace/keep")
    target, backup = work / "target", work / "backup"
    target.mkdir(parents=True)
    extras = {"local/unlisted.txt": b"preserve this file\n"}
    for relative, content in extras.items():
        path = target / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    seed_actions = {"create": [], "replace": [], "keep": []}
    for index, entry in enumerate(entries):
        destination = target / entry["destination"]
        if index == 0:
            seed_actions["create"].append(entry["destination"])
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        source = stage / entry["destination"]
        if index == 1:
            destination.write_bytes(b"previous release bytes\n")
            seed_actions["replace"].append(entry["destination"])
        elif index == 2:
            destination.write_bytes(source.read_bytes())
            seed_actions["keep"].append(entry["destination"])
    before = tree(target)
    apply = command("--stage", str(stage), "--target", str(target), "--backup", str(backup),
                    "--output", str(work / "apply.json"), "--apply")
    after_apply = tree(target)
    expected_candidate = {entry["destination"]: entry["sha256"] for entry in entries}
    if any(after_apply.get(path) != digest for path, digest in expected_candidate.items()):
        raise RuntimeError("published runtime tree differs from candidate manifest")
    if any(after_apply.get(path) != hashlib.sha256(content).hexdigest()
           for path, content in extras.items()):
        raise RuntimeError("publisher changed an unlisted target file")
    rollback = command("--stage", str(stage), "--target", str(target), "--backup", str(backup),
                       "--output", str(work / "rollback.json"), "--rollback")
    after_rollback = tree(target)
    if after_rollback != before:
        raise RuntimeError("rollback did not restore the exact original target tree")
    report = {
        "candidate_commit": manifest["commit"],
        "candidate_manifest_sha256": sha(stage / "RELEASE-MANIFEST.json"),
        "candidate_files": len(entries),
        "candidate_tree_sha256": hashlib.sha256(json.dumps(expected_candidate, sort_keys=True).encode()).hexdigest(),
        "target_before_files": len(before),
        "target_before_tree_sha256": hashlib.sha256(json.dumps(before, sort_keys=True).encode()).hexdigest(),
        "actions_seeded": {key: len(value) for key, value in seed_actions.items()},
        "unlisted_files_preserved": sorted(extras),
        "apply": {"created": apply["creates"], "replaced": apply["replaces"], "kept": apply["keeps"]},
        "rollback": {"removed_created": rollback["removed"], "restored": rollback["restored"]},
        "publish_exact_match": True,
        "rollback_exact_match": True,
        "restored_target_files": len(after_rollback),
        "restored_target_tree_sha256": hashlib.sha256(json.dumps(after_rollback, sort_keys=True).encode()).hexdigest(),
        "scope": "isolated /tmp runtime-tree rehearsal; no NAS or production paths",
    }
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", type=Path, required=True)
    parser.add_argument("--work", type=Path, required=True,
                        help="new or empty directory under /tmp")
    parser.add_argument("--report", type=Path, required=True,
                        help="report path under /tmp")
    args = parser.parse_args()
    report_path = args.report.resolve()
    if not under_tmp(report_path):
        parser.error("report must be under /tmp")
    try:
        report = rehearse(args.stage, args.work)
    except (OSError, ValueError, KeyError, json.JSONDecodeError, RuntimeError) as error:
        parser.error(str(error))
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "candidate_commit": report["candidate_commit"],
                      "candidate_files": report["candidate_files"],
                      "publish_exact_match": report["publish_exact_match"],
                      "rollback_exact_match": report["rollback_exact_match"],
                      "report": str(report_path)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
