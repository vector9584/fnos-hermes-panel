#!/usr/bin/env python3
"""Read-only search across panel, room and channel conversations."""
import json,sqlite3,sys,time
from pathlib import Path
root=Path(sys.argv[1]);var=Path(sys.argv[2]);q=sys.argv[3].strip();offset=int(sys.argv[4]) if len(sys.argv)>4 else 0
out=[];partial=False;needle=q.casefold()
def text(v):
 if isinstance(v,str):return v
 if isinstance(v,list):return '\n'.join(str(x.get('text','')) for x in v if isinstance(x,dict))
 return ''
def add(kind,sid,title,body,index,ts,role='assistant',message_id=None):
 p=body.casefold().find(needle)
 if p<0:return
 start=max(0,p-65);end=min(len(body),p+len(q)+140)
 out.append(dict(kind=kind,session_id=sid,title=title or '未命名会话',snippet=('…' if start else '')+body[start:end]+('…' if end<len(body) else ''),message_index=index,message_id=message_id,ts=ts or 0,role=role))
if not q:print('{"results":[],"total":0}');sys.exit()
for f in (var/'chat/sessions').glob('*.json'):
 try:s=json.loads(f.read_text())
 except Exception:continue
 if s.get('group'):continue
 add('panel',s['id'],s.get('title'),s.get('title',''),-1,s.get('updated_at'))
 for i,m in enumerate(s.get('messages',[])):
  if m.get('role') in ('user','assistant'):add('panel',s['id'],s.get('title'),text(m.get('content')),i,m.get('ts'),m['role'])
try:rooms={r['id']:r for r in json.loads((root/'rooms.json').read_text())}
except Exception:rooms={}
for file in (var/'panel-state/rooms').glob('*.json'):
 try:
  room=json.loads(file.read_text());rooms[room['id']]=room
 except Exception:partial=True
for r in rooms.values():
 add('room',r['id'],r.get('title'),r.get('title',''),-1,r.get('updated_at'))
 for i,m in enumerate(r.get('messages',[])):
  # Old array indices remain a compatibility fallback; overlay messages carry a stable id.
  add('room',r['id'],r.get('title'),text(m.get('text')),i,m.get('ts'),m.get('kind'),m.get('id'))
try:
 c=sqlite3.connect('file:'+str(root/'state.db')+'?mode=ro',uri=True,timeout=2)
 deadline=time.monotonic()+7;c.set_progress_handler(lambda:1 if time.monotonic()>deadline else 0,10000)
 for sid,title,ts in c.execute("SELECT id,COALESCE(title,display_name,''),last_activity_at FROM sessions WHERE source!='api_server' AND instr(lower(COALESCE(title,display_name,'')),lower(?))>0",(q,)):
  add('channel',sid,title,title,-1,(ts or 0)*1000)
 if len(q)>=3:
  query='"'+q.replace('"','""')+'"'
  sql="SELECT s.id,COALESCE(s.title,s.display_name,s.source),m.content,m.id,m.timestamp,m.role FROM messages_fts_trigram f JOIN messages m ON m.id=f.rowid JOIN sessions s ON s.id=m.session_id WHERE messages_fts_trigram MATCH ? AND s.source!='api_server' AND m.role IN ('user','assistant') AND m.active=1"
  args=(query,)
 else:
  sql="SELECT s.id,COALESCE(s.title,s.display_name,s.source),m.content,m.id,m.timestamp,m.role FROM messages m JOIN sessions s ON s.id=m.session_id WHERE instr(lower(m.content),lower(?))>0 AND s.source!='api_server' AND m.role IN ('user','assistant') AND m.active=1"
  args=(q,)
 for sid,title,content,mid,ts,role in c.execute(sql,args):add('channel',sid,title,text(content),mid,(ts or 0)*1000,role)
 c.close()
except sqlite3.Error:partial=True
out.sort(key=lambda x:x['ts'],reverse=True)
print(json.dumps({'results':out[offset:offset+40],'total':len(out),'offset':offset,'has_more':offset+40<len(out),'partial':partial},ensure_ascii=False))
