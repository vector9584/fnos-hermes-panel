#!/usr/bin/env python3
"""Exercise candidate runtime publish/rollback in temporary directories only."""
from __future__ import annotations
import argparse, hashlib, json, shutil, subprocess, sys, tempfile
from pathlib import Path

def digest(p: Path) -> str:
    h=hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
    return h.hexdigest()

def tree(root: Path):
    return {str(p.relative_to(root)):digest(p) for p in root.rglob('*') if p.is_file()}

def copy_tree(src: Path, dst: Path):
    for p in src.rglob('*'):
        rel=p.relative_to(src); q=dst/rel
        if p.is_dir(): q.mkdir(parents=True,exist_ok=True)
        elif p.is_file(): q.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(p,q)

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--stage',type=Path,required=True,help='release-stage output directory containing RELEASE-MANIFEST.json')
    ap.add_argument('--output',type=Path,required=True)
    args=ap.parse_args()
    stage=args.stage if args.stage.is_absolute() else Path.cwd()/args.stage
    out=args.output if args.output.is_absolute() else Path.cwd()/args.output
    if not stage.is_dir() or not (stage/'RELEASE-MANIFEST.json').is_file(): raise SystemExit(f'missing release stage or manifest: {stage}')
    out.parent.mkdir(parents=True,exist_ok=True)
    if out.exists() and out.is_dir():
        raise SystemExit(f'output must be a file, not directory: {out}')
    with tempfile.TemporaryDirectory(prefix='hermes-release-rehearsal-',dir='/private/tmp') as td:
        base=Path(td); target=base/'target'; backup=base/'backup'; target.mkdir()
        # Seed a production-like old tree: one extra retained file, and every
        # candidate file represented by old bytes so replace and rollback are real.
        copy_tree(stage/'appcenter',target/'appcenter')
        extra=target/'appcenter/server/retained-runtime.js'; extra.parent.mkdir(parents=True,exist_ok=True); extra.write_text('retained-old-runtime\n')
        candidate_files=sorted(p for p in (stage/'appcenter').rglob('*') if p.is_file())
        if not candidate_files: raise SystemExit('release stage contains no runtime files')
        (target/'appcenter'/candidate_files[-1].relative_to(stage/'appcenter')).unlink()
        for p in target.rglob('*'):
            if p.is_file() and p!=extra: p.write_bytes(b'old-runtime-byte\n')
        before=tree(target)
        apply_report=base/'apply.json'
        apply_cmd=[sys.executable,str(Path(__file__).with_name('release-apply.py')),
                   '--stage',str(stage),'--target',str(target),'--backup',str(backup),
                   '--apply','--output',str(apply_report)]
        subprocess.run(apply_cmd,check=True,capture_output=True,text=True)
        after=tree(target)
        candidate={'appcenter/'+path:digest for path,digest in tree(stage/'appcenter').items()}
        missing=sorted(set(candidate)-set(after)); mismatched=sorted(k for k in candidate if after.get(k)!=candidate[k])
        if missing or mismatched: raise SystemExit(f'publish verification failed missing={missing[:3]} mismatched={mismatched[:3]}')
        apply_data=json.loads(apply_report.read_text(encoding='utf-8'))
        candidate_extras=sorted(set(after)-set(candidate)-{'appcenter/server/retained-runtime.js'})
        if candidate_extras: raise SystemExit(f'publish unexpectedly added paths: {candidate_extras[:3]}')
        rollback_report=base/'rollback.json'
        rollback_cmd=[sys.executable,str(Path(__file__).with_name('release-apply.py')),
                      '--stage',str(stage),'--target',str(target),'--backup',str(backup),
                      '--rollback','--output',str(rollback_report)]
        subprocess.run(rollback_cmd,check=True,capture_output=True,text=True)
        restored=tree(target)
        rollback_ok=restored==before
        if not rollback_ok: raise SystemExit('rollback verification failed')
        rollback_data=json.loads(rollback_report.read_text(encoding='utf-8'))
        result={'ok':True,'scope':'release-apply.py in temporary directories only; production paths are refused','candidate_files':len(candidate),'before_files':len(before),'after_files':len(after),'apply_actions':len(apply_data['actions']),'rollback_restored':len(rollback_data['restored']),'rollback_removed':len(rollback_data['removed']),'retained_extra_preserved':'appcenter/server/retained-runtime.js' in after and 'appcenter/server/retained-runtime.js' in restored,'publish_exact_match':not missing and not mismatched,'rollback_exact_match':rollback_ok}
    out.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False))

if __name__=='__main__': main()
