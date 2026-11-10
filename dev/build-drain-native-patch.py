"""Append bounded VAR lease to native external drain without replacing it."""
import difflib,hashlib,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];base=ROOT/'dev/native-baselines/drain/gateway/drain_control.py';original=base.read_text()
needle='    body = read_drain_request(home=home)\n'
# Only drain_requested; notification suppression keeps original marker semantics.
start=original.index('def drain_requested(');at=original.index(needle,start)
insert='''    # A panel restart lease is specific to this Gateway PID incarnation and
    # expires automatically. It does not alter the legacy DATA marker.
    try:
        from panel_drain_bridge import panel_drain_requested
        if panel_drain_requested():
            return True
    except ImportError:
        pass
'''
source=original[:at]+insert+original[at:];compile(source,'gateway/drain_control.py','exec');(ROOT/'app/python/gateway/drain_control.py').write_text(source)
(ROOT/'dev/rebuild/drain-native.patch').write_text(''.join(difflib.unified_diff(original.splitlines(True),source.splitlines(True),'a/gateway/drain_control.py','b/gateway/drain_control.py')))
(ROOT/'dev/rebuild/drain-native-manifest.json').write_text(json.dumps({'gateway/drain_control.py':{'baseline_sha256':hashlib.sha256(original.encode()).hexdigest(),'candidate_sha256':hashlib.sha256(source.encode()).hexdigest()}},indent=2))
