#!/usr/bin/env python3
"""Stage a Hermes candidate release without touching a production directory.

The candidate `app/python` tree is an overlay for the installed hermes-src
root; all other app paths retain their APP_DIR-relative destination. The output
is suitable for a separately reviewed deployment step, never a live deploy.
"""
from __future__ import annotations
import argparse, hashlib, json, shutil, subprocess, tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNTIME_PATHS = ("app/server", "app/ui", "app/python")

def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()

def assert_clean_runtime_tree():
    try:
        git("diff", "--quiet", "HEAD", "--", *RUNTIME_PATHS)
    except subprocess.CalledProcessError as error:
        raise SystemExit("refusing release stage: tracked runtime files differ from HEAD") from error
    untracked=git("ls-files", "--others", "--", *RUNTIME_PATHS).splitlines()
    unexpected=[path for path in untracked if not ("/__pycache__/" in f"/{path}/" and path.endswith('.pyc'))]
    if unexpected:
        raise SystemExit("refusing release stage: untracked runtime files: " + ", ".join(unexpected[:10]))

def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def files() -> list[str]:
    out=[]
    for raw in git("ls-files", "app/server", "app/ui", "app/python").splitlines():
        rel=raw.removeprefix("app/")
        if ".bak-" in rel or rel.endswith(".bak"):
            continue
        if (ROOT / "app" / rel).is_file():
            out.append(rel)
    return out

def destination(rel: str) -> Path:
    if rel == "python" or rel.startswith("python/"):
        return Path("hermes-src") / rel.removeprefix("python/")
    return Path(rel)

def main() -> int:
    ap=argparse.ArgumentParser()
    ap.add_argument("--output", type=Path, required=True, help="empty temporary staging directory")
    ap.add_argument("--archive", type=Path)
    ap.add_argument("--baseline", default="74059c0ca00934602d29e497382dde70793ac755")
    args=ap.parse_args()
    commit=git("rev-parse", "HEAD")
    git("merge-base", "--is-ancestor", args.baseline, commit)
    assert_clean_runtime_tree()
    out=args.output if args.output.is_absolute() else ROOT / args.output
    if out.exists() and any(out.iterdir()):
        raise SystemExit(f"refusing non-empty staging directory: {out}")
    out.mkdir(parents=True, exist_ok=True)
    entries=[]
    for rel in files():
        src=ROOT / "app" / rel
        dst_rel=destination(rel)
        dst=out / "appcenter" / dst_rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        src_hash=digest(src)
        if digest(dst)!=src_hash:
            raise SystemExit(f"hash mismatch after staging: {rel}")
        entries.append({"source":"app/"+rel,"destination":"appcenter/"+dst_rel.as_posix(),"sha256":src_hash,"bytes":src.stat().st_size})
    assert_clean_runtime_tree()
    if git("rev-parse", "HEAD") != commit:
        raise SystemExit("refusing release stage: HEAD changed during staging")
    manifest={"schema":1,"kind":"hermes-release-stage","commit":commit,"baseline":args.baseline,"scope":"temporary staging only; no production deployment","file_count":len(entries),"files":entries}
    (out/"RELEASE-MANIFEST.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    archive_info=None
    if args.archive:
        archive=args.archive if args.archive.is_absolute() else ROOT / args.archive
        archive.parent.mkdir(parents=True,exist_ok=True)
        # The manifest inside the archive describes the archive contents. Keep
        # the archive digest in the command output/sidecar to avoid a circular
        # self-hash that could never describe its own final bytes.
        with tarfile.open(archive,"w:gz") as tf:
            tf.add(out,"release")
        archive_info={"path":str(archive),"sha256":digest(archive),"bytes":archive.stat().st_size}
        (archive.with_suffix(archive.suffix+'.sha256.json')).write_text(json.dumps(archive_info,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"ok":True,"commit":commit,"file_count":len(entries),"staging":str(out),"archive":archive_info},ensure_ascii=False))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
