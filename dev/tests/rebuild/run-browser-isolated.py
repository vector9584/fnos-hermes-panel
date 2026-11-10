import os,signal,subprocess,tempfile,json,time,sys
from pathlib import Path
root=Path(__file__).resolve().parent
sys.path.insert(0,str(root))
from preview_process import preview_launcher, read_startup_line
env=os.environ.copy();env['HOME']='/tmp/hermes-rebuild-browser';env['PREVIEW_PORT']='0'
env['PREVIEW_STATE_ROOT']=tempfile.mkdtemp(prefix='hermes-rebuild-preview-')
os.chmod(env['PREVIEW_STATE_ROOT'],0o777)
runenv=['env']+[f'{key}={env[key]}' for key in ('HOME','PREVIEW_STATE_ROOT','PREVIEW_PORT')]
server=subprocess.Popen(preview_launcher()+runenv+['/vol1/@apphome/hermes-agent/data/node/bin/node',str(root/'preview-server.mjs')],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
try:
 line=read_startup_line(server)
 if not line: raise RuntimeError('durable preview failed: '+server.stderr.read())
 try: port=int(json.loads(line)['port'])
 except (ValueError,KeyError,TypeError,json.JSONDecodeError) as exc: raise RuntimeError(f'invalid startup line: {line!r}') from exc
 if not 1<=port<=65535: raise RuntimeError(f'invalid preview port: {port}')
 if server.poll() is not None: raise RuntimeError(f'preview exited after startup: {server.stderr.read()}')
 env['PREVIEW_PORT']=str(port)
 print(json.dumps({'port':port}),flush=True)
 result=subprocess.run(['/vol1/@apphome/hermes-agent/data/venv/bin/python3',str(root/'durable-browser.py')],env=env,timeout=180)
 raise SystemExit(result.returncode)
finally:
 try: os.killpg(server.pid,signal.SIGTERM)
 except ProcessLookupError: pass
 try: server.wait(timeout=5)
 except subprocess.TimeoutExpired:
  try: os.killpg(server.pid,signal.SIGKILL)
  except ProcessLookupError: pass
  server.wait()
