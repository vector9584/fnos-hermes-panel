#!/usr/bin/env python3
"""Compare a candidate release manifest with a read-only NAS hash listing."""
from __future__ import annotations
import argparse, json
from pathlib import Path

def main() -> int:
    ap=argparse.ArgumentParser()
    ap.add_argument('candidate',type=Path)
    ap.add_argument('nas_hashes',type=Path)
    ap.add_argument('--output',type=Path,required=True)
    args=ap.parse_args()
    cand=json.loads(args.candidate.read_text(encoding='utf-8'))
    remote={}
    for line in args.nas_hashes.read_text(encoding='utf-8').splitlines():
        bits=line.split(None,1)
        if len(bits)==2:
            remote[bits[1].strip()]=bits[0]
    rows=[]
    for item in cand['files']:
        src=item['path']
        if src.startswith('python/'):
            dst='hermes-src/'+src.removeprefix('python/')
        else:
            dst=src
        old=remote.get(dst)
        action='create' if old is None else ('keep' if old==item['sha256'] else 'replace')
        rows.append({'source':src,'target':dst,'action':action,'candidate_sha256':item['sha256'],'nas_sha256':old})
    rows.sort(key=lambda x:x['target'])
    summary={a:sum(r['action']==a for r in rows) for a in ('create','replace','keep')}
    payload={'schema':1,'kind':'hermes-release-comparison','candidate_commit':cand['commit'],'scope':'read-only; no production write','candidate_file_count':len(rows),'nas_file_count':len(remote),'summary':summary,'files':rows,'nas_extra':sorted(set(remote)-{r['target'] for r in rows})}
    out=args.output if args.output.is_absolute() else Path.cwd()/args.output
    out.parent.mkdir(parents=True,exist_ok=True)
    out.write_text(json.dumps(payload,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'ok':True,'candidate_commit':cand['commit'],'summary':summary,'nas_extra':len(payload['nas_extra'])},ensure_ascii=False))
    return 0
if __name__=='__main__': raise SystemExit(main())
