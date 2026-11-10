"""Descriptor-relative workspace operations. Never imports or starts Hermes."""
import base64
import contextlib
import ctypes
import errno
import fcntl
import hashlib
import json
import os
import stat
import sys
import time
import uuid

LIMIT = 8 * 1024 * 1024
NOFOLLOW = os.O_NOFOLLOW
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW


class FileError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def digest(value):
    return hashlib.sha256(value).hexdigest()


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True).encode()


def json_file(path, value):
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    temporary = path + '.' + uuid.uuid4().hex
    try:
        fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(encode(value))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        fd = os.open(os.path.dirname(path), os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_json(path):
    try:
        with open(path, encoding='utf-8') as stream:
            return json.load(stream)
    except FileNotFoundError:
        return None


def exclusive_rename(source, target, source_fd, target_fd):
    """Do not replace a file created between the revision check and rename."""
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == 'linux':
        result = libc.renameat2(source_fd, os.fsencode(source), target_fd, os.fsencode(target), 1)
    elif sys.platform == 'darwin':
        result = libc.renameatx_np(source_fd, os.fsencode(source), target_fd, os.fsencode(target), 4)
    else:
        raise FileError('当前系统不支持安全归档操作', 503)
    if result:
        number = ctypes.get_errno()
        if number == errno.EEXIST:
            raise FileError('目标位置已有同名文件，请先处理后再恢复', 409)
        raise OSError(number, os.strerror(number))


class Files:
    def __init__(self, roots, state):
        self.roots = roots
        self.state = state

    def source(self, identifier):
        source = next((root for root in self.roots if root['id'] == identifier), None)
        if not source:
            raise FileError('工作目录不存在', 404)
        return source

    @contextlib.contextmanager
    def location(self, root_id, path='', write=False):
        source = self.source(root_id)
        if write and not source.get('editable'):
            raise FileError('此目录仅供查看和附加文件', 403)
        if not isinstance(path, str) or len(path) > 1600 or '\x00' in path or '\\' in path:
            raise FileError('文件路径不正确')
        parts = path.split('/') if path else []
        if any(not part or part in ('.', '..') or part.startswith('.') for part in parts):
            raise FileError('只能操作工作目录中的普通文件', 403)
        if any(part in ('.','..') for part in source['path'].split('/')):
            raise FileError('工作目录配置不正确',503)
        if not os.path.isabs(source['path']):
            raise FileError('工作目录配置必须是绝对路径', 503)
        # Configured roots may be mount aliases; trust that resolved root only.
        actual = os.path.normpath(source['path'])
        descriptors = [os.open('/', DIR_FLAGS)]
        try:
            for component in actual.strip('/').split('/'):
                descriptors.append(os.open(component, DIR_FLAGS, dir_fd=descriptors[-1]))
        except BaseException:
            for descriptor in reversed(descriptors):os.close(descriptor)
            raise
        root_index=len(descriptors)-1
        try:
            root_stat = os.fstat(descriptors[root_index])
            revision = digest(encode([root_id, actual, root_stat.st_dev, root_stat.st_ino]))
            for part in parts[:-1]:
                descriptors.append(os.open(part, DIR_FLAGS, dir_fd=descriptors[-1]))
            yield source, descriptors[root_index], descriptors[-1], parts[-1] if parts else '', revision
        finally:
            for descriptor in reversed(descriptors):
                os.close(descriptor)

    def check_root(self, body, revision):
        if body.get('root_revision') != revision:
            raise FileError('工作目录已变化，请重新打开文件核对', 409)

    def metadata(self, parent, name):
        st = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if stat.S_ISLNK(st.st_mode) or not (stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode)):
            raise FileError('链接或特殊文件不在面板中操作', 403)
        if stat.S_ISREG(st.st_mode) and st.st_nlink != 1:
            raise FileError('硬链接文件不在面板中操作，请在原位置处理', 403)
        return st

    def item(self, parent, name, path):
        st = self.metadata(parent, name)
        return {'name': name, 'path': path, 'type': 'dir' if stat.S_ISDIR(st.st_mode) else 'file',
                'bytes': st.st_size, 'mtime': st.st_mtime * 1000,
                'entry_revision': digest(encode([st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns]))}

    def listing(self, body):
        path = body.get('path', '')
        with self.location(body['root'], path) as (source, root, parent, name, revision):
            directory = os.open(name, DIR_FLAGS, dir_fd=parent) if name else os.dup(root)
            try:
                items, skipped = [], 0
                for entry in os.listdir(directory):
                    if entry.startswith('.'):
                        continue
                    try:
                        items.append(self.item(directory, entry, '/'.join(filter(None, [path, entry]))))
                    except (FileError, FileNotFoundError):
                        skipped += 1
                items.sort(key=lambda item: (item['type'] != 'dir', item['name'].casefold()))
                query = str(body.get('query', '')).strip().casefold()
                if query:
                    items = [item for item in items if query in item['name'].casefold()]
                offset = max(0, int(body.get('offset', 0)))
                return {'root': source['id'], 'path': path, 'absolute_path': os.path.join(source['path'], path),
                        'root_revision': revision, 'editable': bool(source.get('editable')), 'items': items[offset:offset+80],
                        'total': len(items), 'next': offset+80 if offset+80 < len(items) else None, 'skipped': skipped}
            finally:
                os.close(directory)

    @contextlib.contextmanager
    def opened(self, root, path):
        with self.location(root, path) as located:
            source, root_fd, parent, name, revision = located
            if not name:
                raise FileError('请选择一个文件')
            fd = os.open(name, os.O_RDONLY | NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                st = os.fstat(fd)
                if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
                    raise FileError('只能读取普通文件，不读取链接或设备', 403)
                yield fd, st, revision, source
            finally:
                os.close(fd)

    def upload(self, body):
        source=self.source(body['root'])
        if not source.get('upload'):
            raise FileError('此目录不接收上传',403)
        kind=body.get('kind')
        name=body.get('name','')
        if kind not in ('images','files') or not name or name.startswith('.') or any(c in name for c in ('/','\\','\x00')):
            raise FileError('附件名称不正确')
        content=base64.b64decode(body.get('base64',''),validate=True)
        if len(content)>(16 if kind=='images' else 64)*1024*1024:
            raise FileError('附件超过上传限制',413)
        if not os.path.lexists(source['path']):
            parent_source={'id':'upload-parent','path':os.path.dirname(source['path'])}
            parent_files=Files([parent_source],self.state)
            with parent_files.location('upload-parent') as (_,parent,_,_,_):
                try:os.mkdir(os.path.basename(source['path']),0o700,dir_fd=parent)
                except FileExistsError:pass
                os.fsync(parent)
        with self.location(body['root']) as (_,root,_,_,revision):
            try:os.mkdir(kind,0o700,dir_fd=root)
            except FileExistsError:pass
            directory=os.open(kind,DIR_FLAGS,dir_fd=root)
            try:
                fd=os.open(name,os.O_CREAT|os.O_EXCL|os.O_WRONLY|NOFOLLOW,0o600,dir_fd=directory)
                with os.fdopen(fd,'wb') as stream:
                    stream.write(content);stream.flush();os.fsync(stream.fileno())
                os.fsync(directory)
            finally:os.close(directory)
        return {'bytes':len(content),'path':os.path.join(source['path'],kind,name)}

    def inspect(self, body):
        with self.opened(body['root'], body['path']) as (fd, st, revision, source):
            return {'bytes':st.st_size}

    def image(self, body):
        with self.opened(body['root'], body['path']) as (fd, st, revision, source):
            if st.st_size>16*1024*1024:
                raise FileError('图片超过16MB，请作为文件附加',413)
            with os.fdopen(os.dup(fd),'rb') as stream:
                content=stream.read(16*1024*1024+1)
            if len(content)>16*1024*1024:
                raise FileError('图片超过16MB',413)
            return {'bytes':len(content),'base64':base64.b64encode(content).decode()}

    def read(self, body):
        with self.opened(body['root'], body['path']) as (fd, st, revision, source):
            if st.st_size > LIMIT:
                raise FileError('文件超过8MB，请下载查看', 413)
            with os.fdopen(os.dup(fd),'rb') as stream:
                content = stream.read(LIMIT+1)
            if len(content) > LIMIT:
                raise FileError('文件超过8MB，请下载查看', 413)
            try:
                text = content.decode('utf-8')
                if '\x00' in text:
                    raise ValueError()
            except (UnicodeError, ValueError):
                raise FileError('此文件不是UTF-8文本，请下载或预览', 415)
            return {'root': body['root'], 'path': body['path'], 'content': text, 'revision': digest(content),
                    'root_revision': revision, 'bytes': len(content), 'editable': bool(source.get('editable'))}

    def record_path(self, identifier):
        if not isinstance(identifier, str) or not identifier or len(identifier)>128 or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in identifier):
            raise FileError('操作编号不正确')
        return os.path.join(self.state, 'file-history', identifier+'.json')

    def history(self, body):
        source = self.source(body['root'])
        with self.location(body['root']) as located:
            revision = located[-1]
        directory = os.path.join(self.state, 'file-history')
        items = []
        for name in os.listdir(directory) if os.path.isdir(directory) else []:
            if not name.endswith('.json'):
                continue
            record = read_json(os.path.join(directory, name))
            if record['root'] != source['id'] or record['root_revision'] != revision:
                continue
            if body.get('path') is not None and record['path'] != body['path']:
                continue
            if body.get('archived') and record['kind'] != 'archive':
                continue
            item = {k: v for k, v in record.items() if k not in ('before', 'after', 'input_hash')}
            if record['kind'] == 'archive':
                with self.location(body['root']) as (_, root, _, _, _):
                    try:
                        trash = os.open('.panel-trash', DIR_FLAGS, dir_fd=root)
                        try:
                            os.stat(record['id'], dir_fd=trash, follow_symlinks=False)
                            item['status'] = 'archived'
                        finally:
                            os.close(trash)
                    except FileNotFoundError:
                        item['status'] = 'restored' if record.get('restored_at') else 'not_archived'
            items.append(item)
        items.sort(key=lambda item: item['created_at'], reverse=True)
        offset = max(0, int(body.get('offset', 0)))
        return {'items': items[offset:offset+40], 'total': len(items), 'next': offset+40 if offset+40<len(items) else None}

    def write(self, body):
        path = body['path']
        content = body.get('content')
        if not isinstance(content, str) or '\x00' in content or len(content.encode()) > LIMIT:
            raise FileError('文件必须是8MB以内的UTF-8文本', 413)
        after = content.encode()
        record_path = self.record_path(body['request_id'])
        fingerprint = digest(encode(body))
        existing = read_json(record_path)
        with self.location(body['root'], path, write=True) as (source, root, parent, name, revision):
            self.check_root(body, revision)
            if not name:
                raise FileError('不能覆盖工作目录')
            before, previous = b'', None
            try:
                previous = self.metadata(parent, name)
                before_doc = self.read(body)
                before = before_doc['content'].encode()
            except FileNotFoundError:
                pass
            if existing:
                if existing['input_hash'] != fingerprint:
                    raise FileError('操作编号已用于其他内容', 409)
                if previous and digest(before) == existing['after_hash']:
                    existing['status'] = 'committed'
                    json_file(record_path, existing)
                    return {**self.read(body), 'change_id': body['request_id'], 'duplicate': True}
                raise FileError('这次保存已记录，但文件后来改变，请重新读取', 409)
            if bool(previous) != bool(body.get('exists')) or digest(before) != body.get('revision'):
                raise FileError('原文件已变化，草稿已保留，请读取最新版本后合并', 409)
            record = {'id':body['request_id'], 'kind':'write', 'root':body['root'], 'path':path, 'root_revision':revision,
                      'input_hash':fingerprint, 'before':base64.b64encode(before).decode(), 'before_exists':bool(previous),
                      'after_hash':digest(after), 'created_at':int(time.time()*1000), 'status':'prepared'}
            json_file(record_path, record)
            temp = '.panel-save-'+uuid.uuid4().hex
            descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, stat.S_IMODE(previous.st_mode) if previous else 0o600, dir_fd=parent)
            try:
                with os.fdopen(descriptor, 'wb') as stream:
                    stream.write(after)
                    if previous and (previous.st_uid != os.getuid() or previous.st_gid != os.getgid()):
                        os.fchown(stream.fileno(), previous.st_uid, previous.st_gid)
                    os.fsync(stream.fileno())
                if previous:
                    latest = self.read(body)
                    latest_stat = self.metadata(parent, name)
                    if latest['revision'] != digest(before) or (latest_stat.st_dev,latest_stat.st_ino) != (previous.st_dev,previous.st_ino):
                        raise FileError('保存前原文件发生变化，请合并后重试', 409)
                    os.replace(temp, name, src_dir_fd=parent, dst_dir_fd=parent)
                else:
                    exclusive_rename(temp, name, parent, parent)
                os.fsync(parent)
                record['status'] = 'committed'
                json_file(record_path, record)
            finally:
                try:
                    os.unlink(temp, dir_fd=parent)
                except FileNotFoundError:
                    pass
        return {**self.read(body), 'change_id':body['request_id']}

    def mkdir(self, body):
        with self.location(body['root'], body['path'], write=True) as (_, root, parent, name, revision):
            self.check_root(body, revision)
            if not name:
                raise FileError('目录名称不能为空')
            try:
                os.mkdir(name, 0o700, dir_fd=parent)
            except FileExistsError:
                raise FileError('已有同名文件或目录，请换一个名称', 409)
            os.fsync(parent)
        return {'path': body['path']}

    def archive(self, body):
        identifier = body['request_id']
        record_path = self.record_path(identifier)
        existing = read_json(record_path)
        with self.location(body['root'], body['path'], write=True) as (_, root, parent, name, revision):
            self.check_root(body, revision)
            if not name:
                raise FileError('不能归档整个工作目录', 403)
            try:
                os.mkdir('.panel-trash', 0o700, dir_fd=root)
            except FileExistsError:
                pass
            trash = os.open('.panel-trash', DIR_FLAGS, dir_fd=root)
            try:
                if existing:
                    if existing['input_hash'] != digest(encode(body)):
                        raise FileError('操作编号已用于其他内容', 409)
                    try:
                        self.metadata(trash, identifier)
                        return {'change_id':identifier, 'duplicate':True}
                    except FileNotFoundError:
                        if existing.get('restored_at'):raise FileError('此归档已恢复，请重新选择文件',409)
                item = self.item(parent, name, body['path'])
                if item['entry_revision'] != body.get('entry_revision'):
                    raise FileError('文件或目录刚刚改变，请刷新后重新选择', 409)
                record = {'id':identifier, 'kind':'archive', 'root':body['root'], 'path':body['path'], 'root_revision':revision,
                          'input_hash':digest(encode(body)), 'created_at':int(time.time()*1000), 'status':'prepared',
                          'entry_revision':item['entry_revision']}
                source_stat=self.metadata(parent,name)
                record['entry_identity']=[source_stat.st_dev,source_stat.st_ino]
                json_file(record_path, record)
                exclusive_rename(name, identifier, parent, trash)
                os.fsync(parent)
                os.fsync(trash)
                record['status']='archived'
                json_file(record_path, record)
                return {'change_id':identifier}
            finally:
                os.close(trash)

    def restore(self, body):
        record_path = self.record_path(body['change_id'])
        record = read_json(record_path)
        if not record or record['kind']!='archive':
            raise FileError('归档记录不存在', 404)
        with self.location(record['root'], record['path'], write=True) as (_, root, parent, name, revision):
            self.check_root(record, revision)
            if record.get('restored_at'):
                return {'path':record['path'], 'duplicate':True}
            trash = os.open('.panel-trash', DIR_FLAGS, dir_fd=root)
            try:
                try:
                    self.metadata(trash, record['id'])
                except FileNotFoundError:
                    restored=self.metadata(parent,name)
                    if [restored.st_dev,restored.st_ino]!=record.get('entry_identity'):
                        raise FileError('归档文件已移动，请核对原位置后重试',409)
                else:
                    exclusive_rename(record['id'], name, trash, parent)
                os.fsync(parent)
                os.fsync(trash)
                record['status']='restored'
                record['restored_at']=int(time.time()*1000)
                json_file(record_path, record)
                return {'path':record['path']}
            finally:
                os.close(trash)

    def undo(self, body):
        record = read_json(self.record_path(body['change_id']))
        if not record or record['kind']!='write' or not record.get('before_exists'):
            raise FileError('这次操作没有可恢复的旧版本，请使用归档保留新建文件', 409)
        current = self.read(record)
        if current['revision'] != record['after_hash']:
            raise FileError('文件已有后续修改，请查看旧版本后手动合并', 409)
        return self.write({**current, 'exists':True, 'request_id':body['request_id'], 'content':base64.b64decode(record['before']).decode()})

    def version(self, body):
        record = read_json(self.record_path(body['change_id']))
        if not record or record['kind']!='write':
            raise FileError('旧版本不存在', 404)
        with self.location(record['root'],record['path']) as located:
            self.check_root(record, located[-1])
        return {'content':base64.b64decode(record['before']).decode(), 'path':record['path']}

    def draft(self, body):
        with self.location(body['root'],body['path']) as located:
            revision=located[-1]
        key=digest(encode([body['root'],body['path'],revision]))
        path=os.path.join(self.state,'file-drafts',key+'.json')
        current=read_json(path) or {'revision':0,'text':'','base_revision':'','root_revision':revision}
        if 'text' not in body:
            return {'draft':current}
        if not isinstance(body['text'],str) or len(body['text'].encode())>LIMIT:
            raise FileError('草稿超过8MB',413)
        if current['revision']!=body.get('revision'):
            if current['text']==body['text'] and current['base_revision']==body.get('base_revision'):
                return {'draft':current}
            raise FileError('另一台设备也在编辑此文件，当前输入已保留，请先合并草稿',409)
        next_draft={'revision':current['revision']+1,'text':body['text'],'base_revision':body.get('base_revision',''),
                    'root_revision':revision,'updated_at':int(time.time()*1000)}
        json_file(path,next_draft)
        return {'draft':next_draft}

    def run(self, body):
        action = body.get('action','list')
        if action not in ('list','read','write','mkdir','archive','restore','history','undo','version','image','inspect','draft','upload'):
            raise FileError('文件操作不存在', 404)
        method = self.listing if action == 'list' else getattr(self, action)
        if action in ('write','mkdir','archive','restore','undo','draft'):
            os.makedirs(self.state,mode=0o700,exist_ok=True)
            fd=os.open(os.path.join(self.state,'files.lock'),os.O_CREAT|os.O_RDWR|NOFOLLOW,0o600)
            try:
                fcntl.flock(fd,fcntl.LOCK_EX)
                return method(body)
            finally:
                os.close(fd)
        return method(body)


def main():
    payload=json.load(sys.stdin)
    files=Files(payload['roots'],payload['state'])
    body=payload['body']
    if body.get('action')=='stream':
        with files.opened(body['root'],body['path']) as (fd,st,revision,source):
            print(json.dumps({'ok':True,'bytes':st.st_size}),flush=True)
            while True:
                chunk=os.read(fd,256*1024)
                if not chunk:break
                sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
    else:
        print(json.dumps({'ok':True,**files.run(body)},ensure_ascii=False))


if __name__=='__main__':
    try:
        main()
    except Exception as error:
        status=getattr(error,'status',404 if isinstance(error,FileNotFoundError) else 403 if isinstance(error,PermissionError) or getattr(error,'errno',None) in (errno.ELOOP,errno.ENOTDIR) else 500)
        message=str(error) if isinstance(error,FileError) else '文件不存在，请刷新列表' if status==404 else '文件路径或权限不允许此操作' if status==403 else '文件操作未完成，原文件与操作记录已保留，请刷新核对'
        print(json.dumps({'ok':False,'error':message,'status':status},ensure_ascii=False))
        sys.exit(1)
