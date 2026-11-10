#!/usr/bin/env python3
"""Emit a deterministic candidate runtime manifest for deployment review."""
from __future__ import annotations
import argparse, hashlib, json, subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()

def sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--baseline", default="74059c0ca00934602d29e497382dde70793ac755")
    ap.add_argument("--output", type=Path)
    args = ap.parse_args()
    commit = git("rev-parse", "HEAD")
    git("merge-base", "--is-ancestor", args.baseline, commit)
    files = []
    # Runtime release layers only: server, ui, and the Python overlay. The
    # echo-web/bin/package files are separate artifacts and are not copied to
    # APP_DIR by the canonical Hermes deploy helper.
    for raw in git("ls-files", "app/server", "app/ui", "app/python").splitlines():
        rel = raw.removeprefix("app/")
        if ".bak-" in rel or rel.endswith(".bak"):
            continue
        path = ROOT / "app" / rel
        if path.is_file():
            files.append({"path": rel, "sha256": sha(path), "bytes": path.stat().st_size})
    payload = {
        "schema": 1,
        "kind": "hermes-candidate-runtime",
        "commit": commit,
        "baseline": args.baseline,
        "scope": "candidate app tree; does not prove production deployment",
        "file_count": len(files),
        "files": files,
    }
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        out = args.output if args.output.is_absolute() else ROOT / args.output
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8")
    else:
        print(text, end="")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
