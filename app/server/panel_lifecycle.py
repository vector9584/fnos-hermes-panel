"""fnOS process lifecycle. Linux only; never imports Monitor or native Hermes.

Serialize lifecycle commands with flock; match exact executable/script and
start ticks before every signal. All bookkeeping is confined to application VAR.
"""
import fcntl,http.client,json,os,pwd,signal,socket,stat,struct,subprocess,sys,time
from pathlib import Path

from panel_drain_store import locked_record,write_record,DrainStoreError

class LifecycleError(Exception):pass

def _samefile(a,b):
 try:return os.path.samefile(a,b)
 except OSError:return False

class Lifecycle:
 def __init__(self,app,home,var,node):
  self.app=Path(app).resolve();self.home=Path(home).resolve();self.var=Path(var).resolve();self.node=str(Path(node).resolve());self.script=str(self.app/'server/monitor.js');self.pidfile=self.var/'app.pid';self.sock=self.app/'hermes-agent.sock'
 def identity(self,pid,kind='monitor'):
  try:
   if not isinstance(pid,int) or pid<=0:return None
   base=Path('/proc')/str(pid);argv=(base/'cmdline').read_bytes().decode().rstrip('\0').split('\0');raw=(base/'stat').read_text();fields=raw[raw.rfind(')')+2:].split()
   if fields[0] in ('Z','X'):return None
   # argv[0] 可能是裸 'node'（老入口用 cd+node 启动），Path('node').resolve() 会指向
   # 当前工作目录而不是真实解释器，永远和 self.node 不等 —— 于是 status 恒为 3、
   # 服务端拿不到「运行中」的结论。以 /proc/<pid>/exe 的真实路径为准，argv 仅作兜底。
   try:exe=str(Path(os.readlink(base/'exe')).resolve())
   except OSError:exe=''
   if kind=='monitor':
    # 判定「同一个 node 解释器」有三种合法形态：路径相同、同一文件（硬链/软链）、
    # 或直接就是裸 node。脚本路径才是这个应用独有的标识，解释器只做粗校验。
    node_ok=bool(exe) and (exe==self.node or _samefile(exe,self.node))
    if not node_ok:node_ok=Path(exe or argv[0]).name in ('node','nodejs')
    owned=len(argv)>1 and argv[1]==self.script and node_ok
   else:
    binary=str(self.home/'venv/bin/hermes');python=[str(self.home/'venv/bin/python'),str(self.home/'venv/bin/python3')];args=argv[1:] if argv[0] in python else argv
    owned=(len(args)>1 and args[0]==binary and (args[1]=='dashboard' or args[1:3]==['gateway','run'])) or (argv[0] in python and argv[1:3]==['-m','hermes_cli.main'] and (argv[3:4]==['dashboard'] or argv[3:5]==['gateway','run']))
   return (pid,fields[19],kind) if owned else None
  except (OSError,ValueError,IndexError,UnicodeError):return None
 def discover(self,kind='monitor'):
  return [found for p in Path('/proc').iterdir() if p.name.isdigit() and (found:=self.identity(int(p.name),kind))]
 def same(self,record):return self.identity(record[0],record[2])==record
 def stored(self):
  try:
   if self.pidfile.is_symlink():raise LifecycleError('PID文件是链接，已拒绝操作')
   return self.identity(int(self.pidfile.read_text().strip()))
  except (OSError,ValueError):return None
 def write_pid(self,pid):
  if self.pidfile.is_symlink():raise LifecycleError('PID文件是链接，已拒绝操作')
  temp=self.var/('.app.pid-'+str(os.getpid()));fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
  try:
   with os.fdopen(fd,'w') as stream:stream.write(str(pid));stream.flush();os.fsync(stream.fileno())
   os.replace(temp,self.pidfile)
  finally:
   if temp.exists():temp.unlink()
 def health(self,pid=None):
  connection=http.client.HTTPConnection('localhost',timeout=1)
  try:
   connection.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);connection.sock.settimeout(1);connection.sock.connect(str(self.sock))
   peer=struct.unpack('3i',connection.sock.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[0]
   if pid is not None and peer!=pid:return False
   connection.request('GET','/api/health');response=connection.getresponse();raw=response.read(8193)
   return response.status==200 and len(raw)<=8192 and json.loads(raw).get('ok') is True
  except (OSError,ValueError,http.client.HTTPException):return False
  finally:connection.close()
 def connected_socket(self):
  if self.sock.is_symlink():raise LifecycleError('socket路径是链接，已拒绝操作')
  if not self.sock.exists():return False
  if self.sock.is_symlink() or not stat.S_ISSOCK(self.sock.lstat().st_mode):raise LifecycleError('socket路径不是应用套接字，已保留原文件')
  probe=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);probe.settimeout(1)
  try:probe.connect(str(self.sock));return True
  except ConnectionRefusedError:return False
  except OSError:raise LifecycleError('套接字归属暂不可核实，已停止启动')
  finally:probe.close()
 def peer_pid(self):
  # Who really owns the listening socket; SO_PEERCRED on a fresh connect.
  probe=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);probe.settimeout(1)
  try:probe.connect(str(self.sock));return struct.unpack('3i',probe.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[0]
  except OSError:return None
  finally:probe.close()
 def adopt(self):
  """Trust a healthy Monitor that owns the socket even if /proc discovery missed it.

  连续 4 次 start 返回 {"ok": false, "error": "应用套接字已被其他进程占用，未接管"}
  就是这条路走进来的：Monitor 明明活着、/api/health 也回 ok，但 discover() 没能从
  /proc 认出来（解释器路径、argv 形态、启动入口不同都可能），于是既不起新实例也不认
  旧实例，只能报错退出 —— fnOS 收到 exit 1，记 START_FAILED_LOCAL_APP_RUN_EXCEPTION，
  卡片翻成「启用」。健康套接字就是唯一裁判：认它，把 pid 同步进 app.pid，返回成功。
  """
  pid=self.peer_pid()
  if not pid or not self.health(pid):return None
  self.write_pid(pid)
  return {'ok':True,'already_running':True,'adopted':True,'pid':pid,'healthy':True}
 def terminate(self,record,timeout=15):
  # pidfd pins the process incarnation across the final identity/signal window.
  if not self.same(record):return
  try:fd=os.pidfd_open(record[0])
  except ProcessLookupError:return
  try:
   if not self.same(record):return
   signal.pidfd_send_signal(fd,signal.SIGTERM)
   deadline=time.monotonic()+timeout
   while self.same(record) and time.monotonic()<deadline:time.sleep(.1)
   if self.same(record):signal.pidfd_send_signal(fd,signal.SIGKILL)
   deadline=time.monotonic()+2
   while self.same(record) and time.monotonic()<deadline:time.sleep(.05)
   if self.same(record):raise LifecycleError('应用进程尚未退出，停止未完成')
  except ProcessLookupError:pass
  except PermissionError:raise LifecycleError('没有权限停止应用进程，原PID记录已保留')
  finally:os.close(fd)
 def start(self):
  if self.pidfile.is_symlink():raise LifecycleError('PID文件是链接，已拒绝操作')
  existing=self.discover()
  if len(existing)>1:raise LifecycleError('此安装有多个Monitor，请先核对运行进程')
  if existing:
   if not self.health(existing[0][0]):raise LifecycleError('Monitor存在但尚未恢复健康，未启动第二实例')
   self.write_pid(existing[0][0]);return {'ok':True,'already_running':True,'pid':existing[0][0]}
  adopted=self.adopt()
  if adopted:return adopted
  if self.connected_socket():raise LifecycleError('应用套接字已被其他进程占用，未接管')
  if self.sock.exists():self.sock.unlink()
  env={**os.environ,'HOME':str(self.home),'HERMES_HOME':str(self.home),'APP_DIR':str(self.app),'DATA_DIR':str(self.home),'VAR_DIR':str(self.var),'MONITOR_SOCKET_PATH':str(self.sock),'BASE_PATH':'/app/hermes-agent','PATH':str(self.home/'venv/bin')+':'+os.environ.get('PATH','')}
  fd=os.open(self.var/'info.log',os.O_WRONLY|os.O_APPEND|os.O_CREAT|os.O_NOFOLLOW,0o600)
  try:child=subprocess.Popen([self.node,self.script],env=env,stdin=subprocess.DEVNULL,stdout=fd,stderr=fd,start_new_session=True,close_fds=True)
  finally:os.close(fd)
  record=None
  try:
   self.write_pid(child.pid);deadline=time.monotonic()+30
   while time.monotonic()<deadline:
    if child.poll() is not None:raise LifecycleError('Monitor启动后已退出，请检查应用日志')
    record=self.identity(child.pid)
    if record and self.health(child.pid):return {'ok':True,'pid':child.pid,'healthy':True}
    time.sleep(.2)
   raise LifecycleError('Monitor未在30秒内恢复健康，启动未完成')
  except Exception:
   record=record or self.identity(child.pid)
   if record:self.terminate(record)
   elif child.poll() is None:
    child.terminate();child.wait(timeout=5)
   if child.poll() is not None or not self.identity(child.pid):
    try:
     if self.pidfile.read_text().strip()==str(child.pid):self.pidfile.unlink()
    except OSError:pass
   raise
 def capture_stop(self):
  """Pin targets before waiting for the lifecycle lock; never adopt newer ones."""
  try:
   path=self.var/'panel-state/gateway-drain.json'
   with locked_record(path) as lease:
    return {'monitors':self.discover(),'services':self.discover('service'),'drain_id':lease.get('id') if lease else None}
  except (DrainStoreError,OSError,ValueError,TypeError):raise LifecycleError('停止目标无法核实，未停止应用')
 def claim_panel_drain(self,expected=None):
  """Claim the current drain under the same lock as Monitor mutations."""
  path=self.var/'panel-state/gateway-drain.json'
  try:
   with locked_record(path) as lease:
    if expected is not None and (lease.get('id') if lease else None)!=expected['drain_id']:raise LifecycleError('等待期间排空操作已改变，未停止应用')
    if lease is None:return
    gateway=self.identity(lease.get('pid'),'service')
    if not gateway or gateway[1]!=str(lease.get('start')):return
    now=time.time()*1000;created=lease.get('created_at');expires=lease.get('expires_at')
    if lease.get('version')!=1 or lease.get('action')!='drain' or lease.get('phase')!='dispatched' or type(created) not in (int,float) or type(expires) not in (int,float) or not created<=now+5000 or not now+1000<expires<=created+60000:
     raise LifecycleError('排空期限已失效，未停止应用；请核对运行状态后重新发起重启')
    own_start=Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19]
    lease['stop_owner']={'pid':os.getpid(),'start':own_start,'script':str(Path(__file__).resolve())}
    write_record(path,lease)
  except LifecycleError:raise
  except (DrainStoreError,OSError,ValueError,TypeError,IndexError):raise LifecycleError('排空记录无法核实，未停止应用')
 def stop(self,expected=None):
  expected=self.capture_stop() if expected is None else expected
  monitors=self.discover();services=self.discover('service')
  if any(record not in expected['monitors'] for record in monitors) or any(record not in expected['services'] for record in services):
   raise LifecycleError('等待期间应用进程已改变，未停止新的进程')
  self.claim_panel_drain(expected)
  socket_inode=self.sock.lstat().st_ino if self.sock.exists() else None
  for record in expected['monitors']:self.terminate(record)
  for record in expected['services']:self.terminate(record,5)
  # A service respawned after the snapshot is not an authorized signal target.
  if self.discover() or self.discover('service'):raise LifecycleError('应用进程仍在运行，停止未完成；未停止新出现的进程')
  # 反向的假停止：discover 认不出 Monitor 时一个信号都没发，却敢回 stopped:true，
  # fnOS 记"已停止"而应用还在跑。套接字还有健康响应就说明没停成，如实报错。
  if self.connected_socket() and self.health():raise LifecycleError('套接字仍有Monitor响应，停止未完成；未改动其他进程')
  if self.pidfile.exists() and not self.pidfile.is_symlink():self.pidfile.unlink()
  if self.sock.exists() and not self.sock.is_symlink() and self.sock.lstat().st_ino==socket_inode and not self.connected_socket():self.sock.unlink()
  return {'ok':True,'stopped':True}
 def status(self):
  record=self.stored()
  if record and self.health(record[0]):return True
  # app.pid 落后于真身（内部重启、旧 pid 残留）时，健康套接字说了算并顺手纠正 pid 文件，
  # 否则 status 恒为 3 → fnOS 5 秒轮询判崩溃 → 卡片翻「启用」。
  return bool(self.adopt())

if __name__=='__main__':
 try:
  action,app,home,var,node=sys.argv[1:];lifecycle=Lifecycle(app,home,var,node)
  owner=lifecycle.app.stat()
  if os.geteuid()==0 and owner.st_uid!=0:
   account=pwd.getpwuid(owner.st_uid);os.initgroups(account.pw_name,owner.st_gid);os.setgid(owner.st_gid);os.setuid(owner.st_uid)
  elif os.geteuid()!=owner.st_uid:raise LifecycleError('请以应用属主运行生命周期命令，未修改目录权限')
  if action=='status':raise SystemExit(0 if lifecycle.status() else 3)
  if action not in ('start','stop'):raise LifecycleError('不支持的生命周期操作')
  lifecycle.var.mkdir(parents=True,exist_ok=True)
  stop_targets=lifecycle.capture_stop() if action=='stop' else None
  fd=os.open(lifecycle.var/'lifecycle.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
  with os.fdopen(fd,'r+') as lock:
   fcntl.flock(lock,fcntl.LOCK_EX);print(json.dumps(lifecycle.stop(stop_targets) if action=='stop' else lifecycle.start(),ensure_ascii=False))
 except LifecycleError as error:print(json.dumps({'ok':False,'error':str(error)},ensure_ascii=False));sys.exit(1)
 except Exception:print(json.dumps({'ok':False,'error':'生命周期操作失败，请检查应用目录权限和日志'},ensure_ascii=False));sys.exit(1)
