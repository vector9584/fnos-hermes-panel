#!/usr/bin/env python3
"""Build a reviewable, non-executing production deployment plan."""
from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]

def safe_path(raw):
    if not isinstance(raw,str) or not raw:
        raise ValueError(f'unsafe or non-canonical release path: {raw!r}')
    path=Path(raw)
    if path.is_absolute() or any(part in ('','.','..') for part in raw.split('/')) or path.as_posix()!=raw:
        raise ValueError(f'unsafe or non-canonical release path: {raw!r}')
    return path

def validate_inputs(manifest,comparison):
    if manifest.get('schema')!=1 or manifest.get('kind')!='hermes-candidate-runtime':
        raise ValueError('unsupported candidate manifest')
    if comparison.get('schema')!=1 or comparison.get('kind')!='hermes-release-comparison':
        raise ValueError('unsupported NAS comparison')
    commit=manifest.get('commit')
    if not isinstance(commit,str) or len(commit)!=40 or comparison.get('candidate_commit')!=commit:
        raise ValueError('candidate commit mismatch between manifest and comparison')
    source_rows={}
    for item in manifest.get('files',[]):
        if not isinstance(item,dict): raise ValueError('invalid candidate manifest entry')
        source=safe_path(item.get('path','')).as_posix()
        if source in source_rows: raise ValueError(f'duplicate candidate source: {source}')
        if not (source.startswith('server/') or source.startswith('ui/') or source.startswith('python/')):
            raise ValueError(f'candidate source outside runtime roots: {source}')
        digest=item.get('sha256')
        if not isinstance(digest,str) or len(digest)!=64 or any(c not in '0123456789abcdef' for c in digest):
            raise ValueError(f'invalid candidate SHA-256: {source}')
        if not isinstance(item.get('bytes'),int) or item['bytes']<0: raise ValueError(f'invalid candidate size: {source}')
        source_rows[source]=item
    if manifest.get('file_count')!=len(source_rows) or not source_rows: raise ValueError('candidate file count mismatch')
    comparison_rows={}
    for item in comparison.get('files',[]):
        if not isinstance(item,dict): raise ValueError('invalid comparison entry')
        source=safe_path(item.get('source','')).as_posix()
        target=safe_path(item.get('target','')).as_posix()
        expected_target='hermes-src/'+source.removeprefix('python/') if source.startswith('python/') else source
        if target!=expected_target: raise ValueError(f'candidate target mapping mismatch: {source} -> {target}')
        if source in comparison_rows or target in {row['target'] for row in comparison_rows.values()}:
            raise ValueError(f'duplicate comparison source or target: {source}')
        candidate=source_rows.get(source)
        if not candidate or candidate['sha256']!=item.get('candidate_sha256'):
            raise ValueError(f'comparison candidate hash mismatch or unknown source: {source}')
        old=item.get('nas_sha256')
        if old is not None and (not isinstance(old,str) or len(old)!=64 or any(c not in '0123456789abcdef' for c in old)):
            raise ValueError(f'invalid NAS SHA-256: {target}')
        action='create' if old is None else ('keep' if old==candidate['sha256'] else 'replace')
        if item.get('action')!=action: raise ValueError(f'comparison action mismatch for {target}: expected {action}')
        comparison_rows[source]=item
    if set(comparison_rows)!=set(source_rows): raise ValueError('comparison does not cover every candidate file exactly once')
    summary={action:sum(row['action']==action for row in comparison_rows.values()) for action in ('create','replace','keep')}
    if comparison.get('candidate_file_count')!=len(source_rows) or comparison.get('summary')!=summary:
        raise ValueError('comparison file count or action summary mismatch')
    extras=comparison.get('nas_extra')
    if not isinstance(extras,list) or len(extras)!=len(set(extras)):
        raise ValueError('invalid or duplicate NAS extra paths')
    extra_paths={safe_path(extra).as_posix() for extra in extras}
    candidate_targets={row['target'] for row in comparison_rows.values()}
    if extra_paths & candidate_targets: raise ValueError('NAS extra path overlaps a candidate target')
    existing_candidate_count=sum(row['action']!='create' for row in comparison_rows.values())
    if comparison.get('nas_file_count')!=existing_candidate_count+len(extra_paths):
        raise ValueError('NAS file count does not match candidate rows and extras')
    return summary,comparison_rows,extras

def build_plan(manifest,comparison,manifest_sha256=None):
    summary,rows,extras=validate_inputs(manifest,comparison)
    actions=[row for row in rows.values() if row['action'] in ('create','replace')]
    plan={
      'schema':1,
      'kind':'hermes-production-deployment-plan',
      'executable':False,
      'candidate_commit':manifest['commit'],
      'candidate_manifest_sha256':manifest_sha256,
      'scope':'APP server/ui and hermes-src overlay only; no DATA writes',
      'summary':summary,
      'actions':sorted(actions,key=lambda row:row['target']),
      'preserve':[
        '/vol1/@apphome/hermes-agent/data',
        '/vol1/@apphome/hermes-agent/data/workspace/hermes-src.git',
        'all NAS files not listed in actions',
      ],
      'nas_extra_preserve':sorted(extras),
      'preflight':[
        'capture production DATA/VAR and APP runtime asset inventory',
        'verify no active long-running conversation before restart',
        'verify candidate and rollback archive SHA-256',
        'verify target parent ownership and mode without recursive chown',
        'abort on any source revision or target file drift',
      ],
      'write_order':[
        'create immutable backup of every target replaced and record SHA-256',
        'write APP server/ui and hermes-src files with hermes-agent ownership',
        'read back every written file and compare candidate SHA-256',
        'run only: cd /vol1/@apphome/hermes-agent/data/workspace/fnos-hermes-agent-src && dev/hermes-dev.sh restart',
        'poll monitor/gateway/dashboard health and re-read target SHA-256',
        'capture post-deploy DATA/VAR/APP inventory and compare SQLite row hashes',
      ],
      'abort_conditions':[
        'candidate manifest mismatch',
        'target file changed since comparison',
        'backup or readback hash mismatch',
        'restart command failure or ambiguous process identity',
        'health or socket timeout',
        'post-deploy asset or SQLite comparison shows unexplained loss',
      ],
      'separate_artifacts':[
        'app/echo-web/** -> /vol1/1000/飞牛文件/html/task/ (separate ACL-aware release)',
        'app/bin/** and app/package.json (package/build artifacts, not APP runtime copy)',
      ],
    }
    return plan

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('manifest',type=Path)
    ap.add_argument('comparison',type=Path)
    ap.add_argument('--output',type=Path,required=True)
    args=ap.parse_args()
    manifest=json.loads(args.manifest.read_text(encoding='utf-8'))
    comparison=json.loads(args.comparison.read_text(encoding='utf-8'))
    plan=build_plan(manifest,comparison,hashlib.sha256(args.manifest.read_bytes()).hexdigest())
    out=args.output if args.output.is_absolute() else ROOT/args.output
    out.parent.mkdir(parents=True,exist_ok=True)
    out.write_text(json.dumps(plan,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'ok':True,'executable':False,'candidate_commit':plan['candidate_commit'],'actions':len(plan['actions']),'summary':plan['summary']},ensure_ascii=False))

if __name__=='__main__': main()
