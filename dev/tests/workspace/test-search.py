from pathlib import Path
import tempfile,json,sqlite3,subprocess,sys
script=Path(__file__).with_name('panel-search.py')
if not script.exists():script=Path(__file__).resolve().parents[3]/'app/server/panel-search.py'
with tempfile.TemporaryDirectory() as td:
 root=Path(td);d=root/'data';v=root/'var';d.mkdir();(v/'chat/sessions').mkdir(parents=True)
 (v/'chat/sessions/a.json').write_text(json.dumps({'id':'a','title':'测试标题','messages':[{'role':'user','content':'中文检索定位','ts':5},{'role':'assistant','content':[{'type':'text','text':'中文检索定位'}],'ts':6}]}))
 (v/'chat/sessions/internal.json').write_text(json.dumps({'id':'internal','group':'room_x','messages':[{'role':'user','content':'中文检索定位'}]}))
 (d/'rooms.json').write_text(json.dumps([{'id':'r','title':'房间','messages':[{'kind':'assistant','text':'中文检索定位','ts':7}]}]))
 c=sqlite3.connect(d/'state.db');c.executescript("CREATE TABLE sessions(id TEXT,source TEXT,title TEXT,display_name TEXT,last_activity_at REAL); CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,timestamp REAL,active INTEGER); CREATE VIRTUAL TABLE messages_fts_trigram USING fts5(content,tokenize='trigram');")
 c.execute('INSERT INTO sessions VALUES(?,?,?,?,?)',('s','telegram','渠道标题','',100))
 for i in range(50):
  c.execute('INSERT INTO messages VALUES(?,?,?,?,?,?)',(i+1,'s','user','中文检索定位 quote "plus"',100+i,1));c.execute('INSERT INTO messages_fts_trigram(rowid,content) VALUES(?,?)',(i+1,'中文检索定位 quote "plus"'))
 c.commit();c.close()
 def search(q,offset=0):return json.loads(subprocess.check_output([sys.executable,str(script),str(d),str(v),q,str(offset)]))
 r=search('中文检索');assert r['total']==53 and len(r['results'])==40 and r['has_more'] and not r['partial'],r
 r2=search('中文检索',40);assert len(r2['results'])==13 and not r2['has_more'];assert {x['kind'] for x in r2['results']}=={'panel','room','channel'}
 assert search('中文')['total']==53
 assert search('"plus"')['total']==50
 assert search('测试标题')['results'][0]['message_index']==-1
 assert search('不存在')['total']==0
 print('PASS: Chinese substring/short terms, quotes, panel/room/channel coverage, raw message index, pagination, internal duplicates excluded')
