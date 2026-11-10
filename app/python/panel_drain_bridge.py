"""Read a short-lived panel drain lease from VAR, never write Hermes DATA."""
import json,os,time
from pathlib import Path

def _live_stop_owner(owner):
 if not isinstance(owner,dict) or type(owner.get('pid')) is not int or owner['pid']<=0:return False
 expected=Path(__file__).resolve().parents[1]/'server/panel_lifecycle.py'
 if owner.get('script')!=str(expected):return False
 base=Path('/proc')/str(owner['pid'])
 try:
  fields=(base/'stat').read_text().rsplit(')',1)[1].split()
  args=(base/'cmdline').read_bytes().decode().rstrip('\0').split('\0')
  return fields[0] not in ('Z','X') and fields[19]==str(owner.get('start')) and len(args)>=4 and args[1:4]==['-B',str(expected),'stop']
 except (OSError,ValueError,IndexError,UnicodeError):return False

def panel_drain_requested():
 path=os.environ.get('HERMES_PANEL_DRAIN_LEASE')
 if not path:return False
 try:
  file=Path(path)
  if file.is_symlink():return False
  with file.open('rb') as stream:raw=stream.read(8193)
  if len(raw)>8192:return False
  lease=json.loads(raw)
  if lease.get('version')!=1 or lease.get('pid')!=os.getpid():return False
  expires=lease.get('expires_at');created=lease.get('created_at');now=time.time()*1000
  if type(expires) not in (int,float) or type(created) not in (int,float) or not created<=now+5000 or not created<expires<=created+60000:return False
  pinned=_live_stop_owner(lease.get('stop_owner'))
  if (now>=expires or lease.get('phase')=='cancelled') and not pinned:return False
  current=Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19]
  return str(lease.get('start'))==current and lease.get('action')=='drain'
 except (OSError,ValueError,TypeError,IndexError):return False
