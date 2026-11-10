#!/usr/bin/env python3
"""Apply a staged Hermes runtime tree to a temporary target.

This command is deliberately fail-closed for production paths. It is a
rehearsal/development publisher: production deployment still requires the
approved operational workflow and a separately reviewed change.
"""
from __future__ import annotations
import argparse, hashlib, json, os, shutil, tempfile
from pathlib import Path

PRODUCTION_PREFIXES=(Path('/vol1'),Path('/vol3'),Path('/vol4'))

def sha(p: Path) -> str:
    h=hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
    return h.hexdigest()

def write_json_atomic(path: Path, value):
    fd,tmp=tempfile.mkstemp(prefix=f'.{path.name}.',dir=str(path.parent))
    try:
        with os.fdopen(fd,'w',encoding='utf-8') as f:
            json.dump(value,f,ensure_ascii=False,indent=2)
            f.write('\n'); f.flush(); os.fsync(f.fileno())
        os.replace(tmp,path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)

def files(root: Path):
    return sorted(p for p in root.rglob('*') if p.is_file() and p.name!='RELEASE-MANIFEST.json')

def safe_relative(raw: str) -> Path:
    rel=Path(raw)
    if not raw or rel.is_absolute() or any(part in ('', '.', '..') for part in raw.split('/')):
        raise ValueError(f'unsafe manifest path: {raw!r}')
    if rel.as_posix()!=raw:
        raise ValueError(f'non-canonical manifest path: {raw!r}')
    return rel

def validate_stage(stage: Path):
    for path in stage.rglob('*'):
        if path.is_symlink(): raise ValueError(f'symlink inside stage refused: {path.relative_to(stage)}')
    manifest_path=stage/'RELEASE-MANIFEST.json'
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise ValueError('missing or symlinked RELEASE-MANIFEST.json')
    manifest=json.loads(manifest_path.read_text(encoding='utf-8'))
    if manifest.get('schema')!=1 or manifest.get('kind')!='hermes-release-stage':
        raise ValueError('unsupported release manifest schema or kind')
    entries=manifest.get('files')
    if not isinstance(entries,list) or manifest.get('file_count')!=len(entries) or not entries:
        raise ValueError('invalid release manifest file list/count')
    expected={}; destinations=set()
    for item in entries:
        if not isinstance(item,dict): raise ValueError('invalid release manifest entry')
        source=safe_relative(item.get('source',''))
        destination=safe_relative(item.get('destination',''))
        if not (source.parts[0]=='app' and len(source.parts)>1 and source.parts[1] in ('server','ui','python')): raise ValueError(f'invalid source path: {source}')
        if not (destination.parts[0]=='appcenter' and len(destination.parts)>1): raise ValueError(f'invalid destination path: {destination}')
        if str(source) in expected: raise ValueError(f'duplicate source path: {source}')
        mapped=Path('appcenter')/(Path('hermes-src')/Path(*source.parts[2:]) if source.parts[1]=='python' else Path(*source.parts[1:]))
        if destination!=mapped: raise ValueError(f'source/destination mapping mismatch: {source} -> {destination}')
        if str(destination) in destinations: raise ValueError(f'duplicate destination path: {destination}')
        destinations.add(str(destination))
        digest=item.get('sha256'); size=item.get('bytes')
        if not isinstance(digest,str) or len(digest)!=64 or any(c not in '0123456789abcdef' for c in digest): raise ValueError(f'invalid SHA-256: {source}')
        if not isinstance(size,int) or size<0: raise ValueError(f'invalid byte count: {source}')
        expected[str(source)]={'destination':str(destination),'sha256':digest,'bytes':size}
        staged=stage/destination
        if staged.is_symlink() or not staged.is_file(): raise ValueError(f'missing or symlinked staged file: {destination}')
        if staged.stat().st_size!=size or sha(staged)!=digest: raise ValueError(f'staged file hash/size mismatch: {destination}')
    actual={p.relative_to(stage).as_posix() for p in files(stage)}
    declared={entry['destination'] for entry in expected.values()}
    if actual!=declared:
        raise ValueError(f'stage contains undeclared or missing files: extra={sorted(actual-declared)[:5]} missing={sorted(declared-actual)[:5]}')
    return manifest,expected

def reject_symlink_components(path: Path):
    current=Path(path.anchor)
    for part in path.parts[1:]:
        current=current/part
        if current.is_symlink(): raise ValueError(f'symlink path component refused: {current}')

def reject_nested_symlinks(root: Path, relative: Path):
    current=root
    for part in relative.parts:
        current=current/part
        if current.is_symlink(): raise ValueError(f'symlink path component refused: {current}')

def is_production_path(path: Path):
    return any(path==prefix or prefix in path.parents for prefix in PRODUCTION_PREFIXES)

def ensure_disjoint(target: Path, backup: Path, stage: Path, out: Path):
    paths={'target':target,'backup':backup,'stage':stage,'output':out}
    for name,path in paths.items(): reject_symlink_components(path)
    for left_name,left in paths.items():
        for right_name,right in paths.items():
            if left_name>=right_name: continue
            if left==right or left in right.parents or right in left.parents:
                raise ValueError(f'{left_name} and {right_name} paths overlap')

def verify_backup(backup: Path, expected: dict, stage_manifest_sha256: str):
    for path in backup.rglob('*'):
        if path.is_symlink(): raise ValueError(f'symlink inside backup refused: {path.relative_to(backup)}')
    manifest_path=backup/'BACKUP-MANIFEST.json'
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise ValueError('backup manifest missing or symlinked')
    manifest=json.loads(manifest_path.read_text(encoding='utf-8'))
    if manifest.get('schema')!=1 or manifest.get('kind')!='hermes-release-backup':
        raise ValueError('unsupported backup manifest schema or kind')
    if manifest.get('stage_manifest_sha256')!=stage_manifest_sha256:
        raise ValueError('backup belongs to a different release manifest')
    entries=manifest.get('files')
    if not isinstance(entries,list) or manifest.get('file_count')!=len(entries):
        raise ValueError('invalid backup manifest files/count')
    declared={}
    for entry in entries:
        if not isinstance(entry,dict): raise ValueError('invalid backup manifest entry')
        rel=safe_relative(entry.get('path',''))
        key=rel.as_posix()
        if key in declared: raise ValueError(f'duplicate backup path: {key}')
        digest=entry.get('sha256'); size=entry.get('bytes')
        if not isinstance(digest,str) or len(digest)!=64 or any(c not in '0123456789abcdef' for c in digest):
            raise ValueError(f'invalid backup SHA-256: {key}')
        if not isinstance(size,int) or size<0: raise ValueError(f'invalid backup byte count: {key}')
        declared[key]={'sha256':digest,'bytes':size}
    if declared!=expected: raise ValueError('backup file manifest does not match captured target files')
    actual={p.relative_to(backup).as_posix() for p in backup.rglob('*') if p.is_file() and p!=manifest_path}
    if actual!=set(declared):
        raise ValueError(f'backup contains undeclared or missing files: extra={sorted(actual-set(declared))[:5]} missing={sorted(set(declared)-actual)[:5]}')
    for rel,item in declared.items():
        path=backup/rel
        reject_nested_symlinks(backup,Path(rel))
        if not path.is_file() or path.stat().st_size!=item['bytes'] or sha(path)!=item['sha256']:
            raise ValueError(f'backup hash/size mismatch: {rel}')

def read_backup(backup: Path, stage_manifest_sha256: str):
    manifest_path=backup/'BACKUP-MANIFEST.json'
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise ValueError('backup manifest missing or symlinked')
    manifest=json.loads(manifest_path.read_text(encoding='utf-8'))
    entries=manifest.get('files')
    if not isinstance(entries,list): raise ValueError('invalid backup manifest files/count')
    expected={}
    for entry in entries:
        if not isinstance(entry,dict): raise ValueError('invalid backup manifest entry')
        rel=safe_relative(entry.get('path',''))
        key=rel.as_posix()
        if key in expected: raise ValueError(f'duplicate backup path: {key}')
        expected[key]={'sha256':entry.get('sha256'),'bytes':entry.get('bytes')}
    verify_backup(backup,expected,stage_manifest_sha256)
    return expected

def rollback_stage(stage: Path, target: Path, backup: Path):
    stage=Path(stage).absolute(); target=Path(target).absolute(); backup=Path(backup).absolute()
    ensure_disjoint(target,backup,stage,backup.parent/'release-rollback-result.json')
    manifest,declared=validate_stage(stage)
    stage_manifest_sha256=sha(stage/'RELEASE-MANIFEST.json')
    original=read_backup(backup,stage_manifest_sha256)
    actions=[]
    for item in manifest['files']:
        rel=safe_relative(item['destination']); dst=target/rel
        reject_nested_symlinks(target,rel)
        current=sha(dst) if dst.is_file() else None
        candidate=declared[item['source']]['sha256']
        if current!=candidate:
            raise ValueError(f'target drift since publish; refusing rollback: {rel}')
        actions.append((rel,current))
    stage_paths={rel.as_posix() for rel,_ in actions}
    if set(original)-stage_paths:
        raise ValueError('backup contains paths outside the staged candidate')
    removed=[]; restored=[]; touched=set()
    try:
        for rel,_ in reversed(actions):
            key=rel.as_posix(); dst=target/rel
            if key not in original:
                touched.add(key)
                dst.unlink(); removed.append(key)
        for key,item in original.items():
            rel=Path(key); dst=target/rel; dst.parent.mkdir(parents=True,exist_ok=True)
            touched.add(key)
            fd,tmp=tempfile.mkstemp(prefix=f'.{dst.name}.rollback.',dir=str(dst.parent)); os.close(fd)
            try:
                shutil.copy2(backup/rel,tmp)
                if Path(tmp).stat().st_size!=item['bytes'] or sha(Path(tmp))!=item['sha256']:
                    raise ValueError(f'backup copy hash mismatch: {key}')
                os.replace(tmp,dst)
            finally:
                if os.path.exists(tmp): os.unlink(tmp)
            if dst.stat().st_size!=item['bytes'] or sha(dst)!=item['sha256']:
                raise ValueError(f'rollback readback verification failed: {key}')
            restored.append(key)
    except BaseException as rollback_error:
        try:
            for key in sorted(touched):
                rel=Path(key); dst=target/rel; dst.parent.mkdir(parents=True,exist_ok=True)
                staged=stage/next(item['destination'] for item in manifest['files'] if item['destination']==key)
                fd,tmp=tempfile.mkstemp(prefix=f'.{dst.name}.rollback-recovery.',dir=str(dst.parent)); os.close(fd)
                try:
                    shutil.copy2(staged,tmp); os.replace(tmp,dst)
                finally:
                    if os.path.exists(tmp): os.unlink(tmp)
                expected=next(item['sha256'] for item in manifest['files'] if item['destination']==key)
                if sha(dst)!=expected: raise RuntimeError(f'candidate recovery readback failed: {key}')
        except BaseException as recovery_error:
            raise RuntimeError(f'rollback failed ({rollback_error}); restoring the candidate also failed ({recovery_error})') from rollback_error
        raise RuntimeError(f'rollback failed; candidate files restored and backup retained ({rollback_error})') from rollback_error
    return {'removed':removed,'restored':restored}

def apply_stage(stage: Path, target: Path, backup: Path):
    stage=Path(stage).absolute(); target=Path(target).absolute(); backup=Path(backup).absolute()
    ensure_disjoint(target,backup,stage,backup.parent/'release-apply-result.json')
    manifest,declared=validate_stage(stage)
    if target.exists() and target.is_file(): raise ValueError('target must be a directory')
    if backup.exists() and any(backup.iterdir()): raise ValueError('non-empty backup directory')
    actions=[]
    for item in manifest['files']:
        rel=safe_relative(item['destination']); dst=target/rel; digest=declared[item['source']]['sha256']
        reject_nested_symlinks(target,rel)
        old=sha(dst) if dst.is_file() else None
        actions.append({'path':str(rel),'candidate_sha256':digest,'existing_sha256':old,'action':'create' if old is None else ('keep' if old==digest else 'replace')})
    target.mkdir(parents=True,exist_ok=True); backup.mkdir(parents=True,exist_ok=True)
    backup_files={}
    for item in actions:
        dst=target/item['path']
        if dst.is_file():
            b=backup/item['path']; b.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(dst,b); expected=item['existing_sha256']
            if sha(dst)!=expected or sha(b)!=expected: raise ValueError(f'backup hash mismatch or target drift: {item["path"]}')
            backup_files[item['path']]={'sha256':expected,'bytes':b.stat().st_size}
    stage_manifest_sha256=sha(stage/'RELEASE-MANIFEST.json')
    write_json_atomic(backup/'BACKUP-MANIFEST.json',{
        'schema':1,'kind':'hermes-release-backup','stage_manifest_sha256':stage_manifest_sha256,
        'file_count':len(backup_files),
        'files':[{'path':path,**backup_files[path]} for path in sorted(backup_files)],
    })
    verify_backup(backup,backup_files,stage_manifest_sha256)
    created=[]; replaced=[]
    try:
        for item in actions:
            src=stage/item['path']; dst=target/item['path']; dst.parent.mkdir(parents=True,exist_ok=True)
            if item['action']=='keep': continue
            fd,tmp=tempfile.mkstemp(prefix=f'.{dst.name}.',dir=str(dst.parent)); os.close(fd)
            try:
                shutil.copy2(src,tmp)
                if sha(Path(tmp))!=item['candidate_sha256']: raise ValueError(f'staged copy hash mismatch: {item["path"]}')
                os.replace(tmp,dst)
            finally:
                if os.path.exists(tmp): os.unlink(tmp)
            (replaced if item['action']=='replace' else created).append(item['path'])
            if sha(dst)!=item['candidate_sha256']: raise ValueError(f'readback hash mismatch: {item["path"]}')
        for item in actions:
            if sha(target/item['path'])!=item['candidate_sha256']: raise ValueError(f'final hash mismatch: {item["path"]}')
    except BaseException as publish_error:
        for rel in reversed(created):
            try:(target/rel).unlink()
            except FileNotFoundError:pass
        try:
            verify_backup(backup,backup_files,stage_manifest_sha256)
        except BaseException as backup_error:
            raise RuntimeError(f'publish failed ({publish_error}); rollback refused because backup verification failed ({backup_error})') from publish_error
        for rel in reversed(replaced):
            original=backup/rel; dst=target/rel
            fd,tmp=tempfile.mkstemp(prefix=f'.{dst.name}.rollback.',dir=str(dst.parent)); os.close(fd)
            try:shutil.copy2(original,tmp); os.replace(tmp,dst)
            finally:
                if os.path.exists(tmp):os.unlink(tmp)
            expected=backup_files[rel]
            if dst.stat().st_size!=expected['bytes'] or sha(dst)!=expected['sha256']:
                raise RuntimeError(f'rollback readback verification failed: {rel}') from publish_error
        raise
    return actions

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--stage',type=Path,required=True)
    ap.add_argument('--target',type=Path,required=True)
    ap.add_argument('--backup',type=Path,required=True)
    ap.add_argument('--apply',action='store_true',help='write the target; default is a read-only plan')
    ap.add_argument('--rollback',action='store_true',help='restore the verified pre-apply target from backup')
    ap.add_argument('--output',type=Path,required=True)
    args=ap.parse_args()
    stage=args.stage.absolute(); target=args.target.absolute(); backup=args.backup.absolute(); out=args.output.absolute()
    if not stage.is_dir(): raise SystemExit(f'missing stage: {stage}')
    if is_production_path(target):
        raise SystemExit('refusing production path; this tool only applies to temporary targets')
    if is_production_path(backup) or is_production_path(out) or is_production_path(stage):
        raise SystemExit('refusing production stage, backup, or output path; this tool only applies to temporary paths')
    try:
        ensure_disjoint(target,backup,stage,out)
        manifest,declared=validate_stage(stage)
    except (OSError,ValueError,json.JSONDecodeError) as exc:
        raise SystemExit(f'invalid release stage or overlapping path: {exc}') from exc
    actions=[]
    for item in manifest['files']:
        rel=safe_relative(item['destination']); dst=target/rel
        try: reject_nested_symlinks(target,rel)
        except ValueError as exc: raise SystemExit(str(exc)) from exc
        old=sha(dst) if dst.is_file() else None
        actions.append({'path':str(rel),'candidate_sha256':declared[item['source']]['sha256'],'existing_sha256':old,'action':'create' if old is None else ('keep' if old==declared[item['source']]['sha256'] else 'replace')})
    if args.apply and args.rollback:
        raise SystemExit('--apply and --rollback are mutually exclusive')
    if args.rollback:
        try:
            result=rollback_stage(stage,target,backup)
        except (OSError,ValueError,json.JSONDecodeError) as exc:
            raise SystemExit(f'rollback refused or failed: {exc}') from exc
        payload={'ok':True,'rolled_back':True,'scope':'temporary target only; production paths refused','target':str(target),**result}
    elif not args.apply:
        result={'ok':True,'applied':False,'scope':'read-only plan; production paths refused','target':str(target),'actions':actions}
        payload=result
    else:
        actions=apply_stage(stage,target,backup)
        result={'ok':True,'applied':True,'scope':'temporary target only; production paths refused','target':str(target),'backup':str(backup),'actions':actions}
        payload=result
    out.parent.mkdir(parents=True,exist_ok=True); out.write_text(json.dumps(payload,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    if args.rollback:
        summary={'ok':True,'rolled_back':True,'removed':len(result['removed']),'restored':len(result['restored'])}
    else:
        summary={'ok':True,'applied':result['applied'],'actions':len(actions),'creates':sum(x['action']=='create' for x in actions),'replaces':sum(x['action']=='replace' for x in actions),'keeps':sum(x['action']=='keep' for x in actions)}
    print(json.dumps(summary,ensure_ascii=False))

if __name__=='__main__': main()
