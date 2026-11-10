"""Run as vector on NAS. Uses only a newly created /tmp fixture directory."""
import hashlib,json,os,pwd,signal,subprocess,tempfile,threading
from datetime import datetime, timezone
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
PYTHON='/vol1/@apphome/hermes-agent/data/venv/bin/python3'
root=Path(tempfile.mkdtemp(prefix='hermes-echo-identities-',dir='/tmp'));root.chmod(0o755)
queue=root/'tasks/tasks.json';actor=pwd.getpwuid(os.getuid()).pw_name
app_manifest=ROOT/'app-source-manifest.json'
candidate_manifest=ROOT/'candidate-manifest.json'
acceptance_metadata=json.loads((ROOT/'acceptance-metadata.json').read_text())
source_hash=hashlib.sha256(app_manifest.read_bytes()).hexdigest()
candidate_hash=hashlib.sha256(candidate_manifest.read_bytes()).hexdigest()
commit=json.loads(app_manifest.read_text())['commit']
acceptance_id=hashlib.sha256(f'{commit}:{source_hash}:{candidate_hash}'.encode()).hexdigest()[:16]
assert acceptance_metadata.get('commit')==commit
assert acceptance_metadata.get('acceptance_id')==acceptance_id
assert acceptance_metadata.get('app_source_manifest_sha256')==source_hash
assert acceptance_metadata.get('candidate_manifest_sha256')==candidate_hash
assert acceptance_metadata.get('built_at_utc','').endswith('+00:00')
assert acceptance_metadata.get('release_candidate_sha256')==hashlib.sha256((ROOT/'release-candidate.tar.gz').read_bytes()).hexdigest()
started_at=datetime.now(timezone.utc).isoformat(timespec='seconds')
print(json.dumps({'event':'started','acceptance_id':acceptance_id,'candidate_commit':commit,
                  'bundle_built_at_utc':acceptance_metadata['built_at_utc'],
                  'release_candidate_sha256':acceptance_metadata['release_candidate_sha256'],
                  'app_source_manifest_sha256':source_hash,'candidate_manifest_sha256':candidate_hash,
                  'started_at_utc':started_at},ensure_ascii=False),flush=True)


def run(args,allow_error=False,**options):
    input_data=options.pop('input',None)
    process=subprocess.Popen(args,text=True,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                             start_new_session=True,**options)
    try:
        stdout,stderr=process.communicate(input_data,timeout=30)
    except subprocess.TimeoutExpired:
        try: os.killpg(process.pid,signal.SIGTERM)
        except ProcessLookupError: pass
        try: stdout,stderr=process.communicate(timeout=2)
        except subprocess.TimeoutExpired:
            try: os.killpg(process.pid,signal.SIGKILL)
            except ProcessLookupError: pass
            stdout,stderr=process.communicate()
        raise subprocess.TimeoutExpired(args,30,output=stdout,stderr=stderr)
    result=subprocess.CompletedProcess(args,process.returncode,stdout,stderr)
    if process.returncode and not allow_error:
        raise subprocess.CalledProcessError(process.returncode,args,stdout,stderr)
    return result


def finish_group(process,timeout=30):
    try:
        process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try: os.killpg(process.pid,signal.SIGTERM)
        except ProcessLookupError: pass
        try: process.communicate(timeout=2)
        except subprocess.TimeoutExpired:
            try: os.killpg(process.pid,signal.SIGKILL)
            except ProcessLookupError: pass
            process.communicate()


try:
    run(['sudo','-n','install','-d','-m','1777','-o','www-data','-g','www-data',str(queue.parent)])
    initial=json.dumps({'seq':1,'tasks':[{'id':1,'status':'pending','title':'交替保存','detail':'隔离验收','star':3,'type':'开发'}]})
    run(['sudo','-n','-u','hermes-agent',PYTHON,'-B','-c','import os,sys;open(sys.argv[1],"w").write(sys.argv[2]);os.chmod(sys.argv[1],0o666)',str(queue),initial])
    php_code='''$a=json_decode(stream_get_contents(STDIN),true);define('DATA',$a['queue']);define('ECHO_TEST_BACKUPS',$a['backups']);define('STATUSES',['staged','pending','doing','review','done','failed','dropped']);function out(array $d,int $s=200):void{echo json_encode($d);exit;}require $a['store'];$_SERVER['REQUEST_METHOD']='POST';$_SERVER['HTTP_X_ECHO_REQUEST']='1';$action='update';$id=1;$body=['_request_id'=>$a['request'],'_revision'=>$a['revision']??echo_revision(echo_read()[1]['tasks'][0])];$r=mutate(function(array &$d)use($a){$d['tasks'][0]['detail']=$a['text'];return $d['tasks'][0];});out(['ok'=>true,'task'=>$r]);'''
    run(['sudo','-n','install','-d','-m','0700','-o','www-data','-g','www-data',str(root/'web-backups')])
    run(['sudo','-n','install','-d','-m','0700','-o','hermes-agent','-g','hermes-agent',str(root/'python-backups')])
    def php(index):
        return json.loads(run(['sudo','-n','-u','www-data','php','-r',php_code],input=json.dumps({'queue':str(queue),'backups':str(root/'web-backups'),'store':str(ROOT/'app/echo-web/store.php'),'request':'identity-php-'+str(index),'text':'PHP '+str(index)})).stdout)
    def python_write(index):
        listed=run(['sudo','-n','-u','hermes-agent',PYTHON,'-B',str(ROOT/'app/server/panel-echo.py'),str(queue),str(root/'python-backups')],input='{"action":"list"}')
        task=json.loads(listed.stdout)['tasks'][0]
        result=run(['sudo','-n','-u','hermes-agent',PYTHON,'-B',str(ROOT/'app/server/panel-echo.py'),str(queue),str(root/'python-backups')],allow_error=True,input=json.dumps({'action':'update','id':1,'revision':task['panel_revision'],'request_id':'identity-python-'+str(index),'body':{'detail':'Python '+str(index)}}))
        return json.loads(result.stdout)
    # PHP owns the directory, so it can replace Hermes' file; the reverse fails.
    assert php(0)['ok'];before=queue.read_bytes();failed=python_write(0);assert not failed['ok'],failed;assert queue.read_bytes()==before
    # Restrict the directory to its owner and explicitly authorized Hermes UID.
    run(['sudo','-n','chmod','0770',str(queue.parent)])
    run(['sudo','-n','setfacl','-m','u:hermes-agent:rwx,u:'+actor+':rwx,o::---',str(queue.parent)])
    for index in range(4):
        assert php(index+1)['ok']
        assert python_write(index+1)['ok']
        assert queue.stat().st_mode & 0o777==0o666
    # Capture each UI's own revision before either writer commits. The shared
    # flock must allow one update and reject the stale loser without losing data.
    php_revision_code='''$a=json_decode(stream_get_contents(STDIN),true);define('DATA',$a['queue']);define('STATUSES',['staged','pending','doing','review','done','failed','dropped']);function out(array $d,int $s=200):void{echo json_encode($d);exit;}require $a['store'];out(['revision'=>echo_revision(echo_read()[1]['tasks'][0])]);'''
    php_revision=json.loads(run(['sudo','-n','-u','www-data','php','-r',php_revision_code],input=json.dumps({'queue':str(queue),'store':str(ROOT/'app/echo-web/store.php')})).stdout)['revision']
    listed=run(['sudo','-n','-u','hermes-agent',PYTHON,'-B',str(ROOT/'app/server/panel-echo.py'),str(queue),str(root/'python-backups')],input='{"action":"list"}')
    python_revision=json.loads(listed.stdout)['tasks'][0]['panel_revision']
    php_process=subprocess.Popen(['sudo','-n','-u','www-data','php','-r',php_code],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
    python_process=subprocess.Popen(['sudo','-n','-u','hermes-agent',PYTHON,'-B',str(ROOT/'app/server/panel-echo.py'),str(queue),str(root/'python-backups')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
    php_input={'queue':str(queue),'backups':str(root/'web-backups'),'store':str(ROOT/'app/echo-web/store.php'),'request':'race-php-final','revision':php_revision,'text':'并发 PHP'}
    python_input={'action':'update','id':1,'revision':python_revision,'request_id':'race-python-final','body':{'detail':'并发 Hermes'}}
    # Feed both processes before waiting, so the test exercises the lock under
    # an actual same-revision race rather than two sequential submissions.
    outputs={}
    def communicate(name,process,payload):
        try:
            outputs[name]=process.communicate(json.dumps(payload),timeout=30)
        except BaseException as error:
            outputs[name]=error
    php_thread=threading.Thread(target=communicate,args=('php',php_process,php_input))
    python_thread=threading.Thread(target=communicate,args=('python',python_process,python_input))
    race_threads=[php_thread,python_thread]
    php_thread.start();python_thread.start();php_thread.join(32);python_thread.join(32)
    if php_thread.is_alive() or python_thread.is_alive():
        for process in (php_process,python_process):
            try: os.killpg(process.pid,signal.SIGTERM)
            except ProcessLookupError: pass
        php_thread.join(2);python_thread.join(2)
        for process,thread in ((php_process,php_thread),(python_process,python_thread)):
            if thread.is_alive():
                try: os.killpg(process.pid,signal.SIGKILL)
                except ProcessLookupError: pass
        php_thread.join();python_thread.join()
        raise TimeoutError('双入口并发写入超过32秒')
    for name in ('php','python'):
        if isinstance(outputs[name],BaseException): raise outputs[name]
    php_out,php_err=outputs['php']
    python_out,python_err=outputs['python']
    assert php_process.returncode==0,php_err
    php_result=json.loads(php_out)
    python_result=json.loads(python_out)
    assert php_result.get('ok') != python_result.get('ok'),(php_result,python_result)
    loser=python_result if not python_result.get('ok') else php_result
    assert '更新' in loser.get('error','') or '刷新' in loser.get('error',''),loser
    final=json.loads(queue.read_text())
    assert final['tasks'][0]['detail'] in ('并发 PHP','并发 Hermes')
    assert len(final['tasks'])==1 and final['tasks'][0]['id']==1
    print(json.dumps({'event':'completed','acceptance_id':acceptance_id,'candidate_commit':commit,
                      'bundle_built_at_utc':acceptance_metadata['built_at_utc'],
                      'release_candidate_sha256':acceptance_metadata['release_candidate_sha256'],
                      'app_source_manifest_sha256':source_hash,'candidate_manifest_sha256':candidate_hash,
                      'started_at_utc':started_at,'completed_at_utc':datetime.now(timezone.utc).isoformat(timespec='seconds'),
                      'old_sticky_directory_failure_reproduced':True,'alternating_php_python_writes':8,
                      'simultaneous_stale_writes':True,'stale_write_rejected':True,'task_count':1,
                      'preserved_file_mode':'0666','restricted_directory_acl':True},ensure_ascii=False),flush=True)
finally:
    for process in locals().get('php_process'),locals().get('python_process'):
        if process and process.poll() is None: finish_group(process)
    # Restore ownership only inside this created fixture so normal cleanup works.
    run(['sudo','-n','chown','-R',actor,str(root)])
    import shutil
    shutil.rmtree(root)
