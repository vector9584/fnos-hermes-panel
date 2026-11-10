#!/usr/bin/env bash
# Read-only release audit. It never contacts or writes a NAS runtime directory.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
BASELINE_COMMIT="${RELEASE_BASE_COMMIT:-74059c0ca00934602d29e497382dde70793ac755}"
DEPLOY_SCRIPT="$ROOT/dev/hermes-dev.sh"
WORKSPACE_DEPLOY_SCRIPT="$ROOT/dev/deploy-workspace.sh"
json=0
if [[ $# -gt 0 ]]; then
  [[ $# -eq 1 && ${1:-} == --json ]] || { echo "usage: $0 [--json]" >&2; exit 2; }
  json=1
fi

git rev-parse --verify "$BASELINE_COMMIT^{commit}" >/dev/null
git rev-parse --verify HEAD^{commit} >/dev/null
git merge-base --is-ancestor "$BASELINE_COMMIT" HEAD
git diff --check
# Audit only files that determine or enter the candidate release. Local TAP,
# screenshots, rollback reports and unrelated notes are evidence, not runtime
# inputs, and must not make a clean candidate impossible to inspect.
release_paths=(app/server app/ui app/python dev/hermes-dev.sh dev/deploy-workspace.sh dev/release-*.py dev/release-*.sh)
if ! git diff --quiet HEAD -- "${release_paths[@]}"; then
  echo "release preflight: release inputs differ from HEAD" >&2
  git status --short -- "${release_paths[@]}" >&2
  exit 1
fi
untracked_runtime=$(git ls-files --others -- app/server app/ui app/python)
unexpected_runtime=()
while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  [[ "$path" == */__pycache__/*.pyc ]] && continue
  unexpected_runtime+=("$path")
done <<< "$untracked_runtime"
if ((${#unexpected_runtime[@]})); then
  echo "release preflight: untracked runtime files are not in the committed candidate:" >&2
  printf '  %s\n' "${unexpected_runtime[@]}" >&2
  exit 1
fi

# Use the complete candidate APP tree. A file need not have changed in Git to
# be absent from an older NAS runtime, and deploying only changed paths would
# leave imports and static assets missing. Retained historical .bak files are
# excluded; all other tracked app files are release inputs.
required=()
while IFS= read -r rel; do required+=("$rel"); done < <(
  { git ls-files 'app/server/*' 'app/ui/*' | sed 's#^app/##'; git ls-files 'app/python/*' | sed 's#^app/python/##' | while IFS= read -r rel; do printf 'hermes-src/%s\n' "$rel"; done; } | grep -vE '(^|/)\.bak(-|\.)|\.bak-|^server/monitor\.js\.bak' | sort
)
missing=()
for rel in "${required[@]}"; do
  src_rel="$rel"; [[ "$rel" == hermes-src/* ]] && src_rel="python/${rel#hermes-src/}"; [[ -f "app/$src_rel" ]] || missing+=("$rel")
done
if ((${#missing[@]})); then
  printf 'release preflight: candidate files missing:\n' >&2
  printf '  %s\n' "${missing[@]}" >&2
  exit 1
fi

# Verify the reviewed narrow helper and the complete candidate publisher before
# allowing the candidate to proceed. The narrow ui/server cases remain useful
# for their original scope; a complete candidate must use the workspace helper.
deploy_block=$(sed -n '/^cmd_deploy()/,/^cmd_sync_back()/p' "$DEPLOY_SCRIPT")
[[ -n "$deploy_block" ]] || { echo "release preflight: cannot inspect cmd_deploy in $DEPLOY_SCRIPT" >&2; exit 1; }
grep -Eq '^[[:space:]]*ui\|server\)' <<< "$deploy_block" || {
  echo "release preflight: deploy helper no longer has the reviewed ui|server case" >&2; exit 1;
}
grep -Fq 'local f="index.html"' <<< "$deploy_block" &&
grep -Fq '[ "$what" = server ] && f="monitor.js"' <<< "$deploy_block" &&
grep -Fq 'local rel="$what/$f"' <<< "$deploy_block" || {
  echo "release preflight: ui/server deploy path mapping changed; review it before updating coverage" >&2; exit 1;
}
grep -Eq '^[[:space:]]*py\)' <<< "$deploy_block" || {
  echo "release preflight: Python deploy case is missing or changed" >&2; exit 1;
}
[[ -x "$WORKSPACE_DEPLOY_SCRIPT" ]] || {
  echo "release preflight: complete workspace deploy helper is missing or not executable" >&2
  exit 1
}
workspace_deploy=$(sed -n '1,260p' "$WORKSPACE_DEPLOY_SCRIPT")
grep -Fq 'git -C "$SRC_REPO" ls-files app/server app/ui app/python' <<< "$workspace_deploy" || {
  echo "release preflight: workspace deploy helper does not enumerate the candidate runtime tree" >&2
  exit 1
}
grep -Fq "python/*) printf 'hermes-src/%s" <<< "$workspace_deploy" || {
  echo "release preflight: workspace deploy helper lacks the Python hermes-src mapping" >&2
  exit 1
}
grep -Fq 'dev/hermes-dev.sh restart' <<< "$workspace_deploy" || {
  echo "release preflight: workspace deploy helper does not use the reviewed restart command" >&2
  exit 1
}

candidate_tar=${CANDIDATE_ARCHIVE:-}
baseline_tar=${BASELINE_ARCHIVE:-outputs/hermes-rebuild/rollback-20261106-baseline.tar.gz}
[[ -f "$baseline_tar" ]] || { echo "release preflight: missing baseline archive $baseline_tar" >&2; exit 1; }
stage_tmp=""
cleanup() { [[ -z "$stage_tmp" ]] || rm -rf "$stage_tmp"; }
trap cleanup EXIT
if [[ -z "$candidate_tar" ]]; then
  stage_tmp=$(mktemp -d "${TMPDIR:-/private/tmp}/hermes-preflight-stage.XXXXXX") || {
    echo "release preflight: cannot create temporary candidate stage" >&2; exit 1;
  }
  candidate_tar="$stage_tmp/candidate.tar.gz"
  if ! python3 "$ROOT/dev/release-stage.py" --output "$stage_tmp/stage" --archive "$candidate_tar" >&2; then
    echo "release preflight: failed to stage current HEAD" >&2; exit 1;
  fi
fi
[[ -f "$candidate_tar" ]] || { echo "release preflight: missing candidate archive $candidate_tar" >&2; exit 1; }
commit=$(git rev-parse HEAD)
if ! python3 - "$candidate_tar" "$commit" <<'PY'
import hashlib,json,subprocess,sys,tarfile
from pathlib import Path
archive,expected=sys.argv[1:]
try:
    with tarfile.open(archive,'r:*') as bundle:
        member=next((item for item in bundle.getmembers() if item.isfile() and item.name.rstrip('/').endswith('RELEASE-MANIFEST.json')),None)
        if member is None:raise ValueError('missing RELEASE-MANIFEST.json')
        manifest=json.load(bundle.extractfile(member))
    staged_commit=manifest.get('commit')
    if manifest.get('kind')!='hermes-release-stage' or not isinstance(staged_commit,str):
        raise ValueError('invalid release manifest identity')
    if subprocess.run(['git','merge-base','--is-ancestor',staged_commit,expected],check=False).returncode:
        raise ValueError('release manifest commit is not an ancestor of current HEAD')
    entries=manifest.get('files')
    if not isinstance(entries,list) or manifest.get('file_count')!=len(entries) or not entries:
        raise ValueError('invalid manifest file list/count')
    declared={}
    sources=set()
    for entry in entries:
        if not isinstance(entry,dict):raise ValueError('invalid manifest file entry')
        name=entry.get('destination')
        source=entry.get('source')
        if not isinstance(source,str) or source.startswith('/') or any(part in ('','.','..') for part in source.split('/')):
            raise ValueError('unsafe manifest source')
        if not (source.startswith('app/server/') or source.startswith('app/ui/') or source.startswith('app/python/')):
            raise ValueError('manifest source outside runtime roots')
        expected_name='appcenter/hermes-src/'+source.removeprefix('app/python/') if source.startswith('app/python/') else 'appcenter/'+source.removeprefix('app/')
        if name!=expected_name or source in sources:
            raise ValueError('manifest source/destination mapping mismatch')
        sources.add(source)
        if not isinstance(name,str) or name.startswith('/') or any(part in ('','.','..') for part in name.split('/')):
            raise ValueError('unsafe manifest path')
        digest=entry.get('sha256');size=entry.get('bytes')
        if name in declared or not isinstance(digest,str) or len(digest)!=64 or not isinstance(size,int) or size<0:
            raise ValueError('duplicate or invalid manifest file entry')
        declared[name]=(digest,size)
    tracked=subprocess.check_output(['git','ls-files','app/server','app/ui','app/python'],text=True).splitlines()
    expected_sources=set()
    for raw in tracked:
        source='app/'+raw.removeprefix('app/')
        if '.bak-' in source or source.endswith('.bak') or not Path(source).is_file():
            continue
        expected_sources.add(source)
    if sources!=expected_sources:
        raise ValueError('manifest does not cover the complete current runtime source tree')
    for entry in entries:
        source=entry['source']
        path=__import__('pathlib').Path(source)
        if path.stat().st_size!=entry['bytes'] or hashlib.sha256(path.read_bytes()).hexdigest()!=entry['sha256']:
            raise ValueError('runtime source changed since staging: '+source)
    with tarfile.open(archive,'r:*') as bundle:
        prefix=member.name[:-len('RELEASE-MANIFEST.json')]
        members=bundle.getmembers()
        payload_members=[item for item in members if item.isfile() and item.name.startswith(prefix) and item.name!=member.name]
        if len({item.name for item in payload_members})!=len(payload_members):raise ValueError('duplicate archive member')
        actual={item.name[len(prefix):]:item for item in payload_members}
        if set(actual)!=set(declared):raise ValueError('archive members do not match manifest')
        for name,(digest,size) in declared.items():
            item=actual[name];stream=bundle.extractfile(item)
            if item.size!=size or stream is None or hashlib.sha256(stream.read()).hexdigest()!=digest:
                raise ValueError('archive file hash/size mismatch: '+name)
except Exception as error:
    print('release preflight: candidate archive is invalid or stale: '+str(error),file=sys.stderr)
    raise SystemExit(1)
PY
then
  exit 1
fi
if ((json)); then
  printf '{"ok":true,"commit":"%s","baseline":"%s","runtime_files":%d,"candidate_archive":"%s","baseline_archive":"%s"}\n' "$commit" "$BASELINE_COMMIT" "${#required[@]}" "$candidate_tar" "$baseline_tar"
else
  printf 'release preflight: OK\ncommit=%s\nbaseline=%s\nruntime_files=%d\ncandidate_archive=%s\nbaseline_archive=%s\n' "$commit" "$BASELINE_COMMIT" "${#required[@]}" "$candidate_tar" "$baseline_tar"
fi
