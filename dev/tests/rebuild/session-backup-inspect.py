"""Inspect selected session files inside a tar archive without extraction or message output."""
import argparse,hashlib,json,tarfile
from pathlib import Path

def inspect(archive,ids):
 result={'archive':str(archive),'matches':[],'json_member_count':0};hashes=hashlib.sha256()
 with archive.open('rb') as stream:
  for block in iter(lambda:stream.read(1024*1024),b''):hashes.update(block)
 result['archive_sha256']=hashes.hexdigest()
 with tarfile.open(archive,'r|*') as tar:
  for member in tar:
   if not member.isfile():continue
   name=Path(member.name).name
   if name.endswith('.json'):result['json_member_count']+=1
   if name not in {sid+'.json' for sid in ids}:continue
   row={'member':member.name,'size':member.size,'mtime':member.mtime}
   if member.size>32*1024*1024:row['error']='too_large';result['matches'].append(row);continue
   raw=tar.extractfile(member).read();row['sha256']=hashlib.sha256(raw).hexdigest()
   try:
    data=json.loads(raw);row.update({'id':data.get('id'),'messages':len(data.get('messages',[])),'created_at':data.get('created_at'),'updated_at':data.get('updated_at'),'group':data.get('group')})
   except Exception as error:row['error']=type(error).__name__
   result['matches'].append(row)
 return result
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('archive');parser.add_argument('ids',nargs='+');args=parser.parse_args();print(json.dumps(inspect(Path(args.archive),args.ids),ensure_ascii=False,indent=2))
