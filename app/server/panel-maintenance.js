import {execFile} from 'node:child_process';

const frozen = /^\/api\/(?:hermes\/update(?:\/|$)|app\/(?:update(?:\/|$)|auto-update$|hot-patch$))/;
export function createMaintenanceHandler({repositories, checkToken, run = execFile}) {
  const reply = (body, status = 200) => new Response(JSON.stringify(body), {status,
    headers: {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
  function git(repo, args) {
    return new Promise((resolve, reject) => run('git', ['-c', 'safe.directory='+repo.path, '-C', repo.path, ...args],
      {timeout:10000, maxBuffer:2*1024*1024, env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'}},
      (error, stdout) => error ? reject(new Error(error.killed?'读取版本记录超时，请重试':'无法读取此仓库，请检查仓库路径、访问权限或升级后的 Git 指针')) : resolve(stdout)));
  }
  return async function maintenance(req, path) {
    if (!path.startsWith('/api/maintenance/') && !frozen.test(path)) return null;
    if (!checkToken(req)) return reply({ok:false,error:'请重新登录后查看维护记录'},401);
    if (frozen.test(path)) return reply({ok:false,error:'此应用已采用本地维护，在线升级接口已停用'},410);
    if (req.method !== 'GET') return reply({ok:false,error:'版本记录仅支持读取'},405);
    if (path === '/api/maintenance/repositories') {
      const items = await Promise.all(repositories.map(async repo => {
        try {
          const [head, status] = await Promise.all([git(repo,['rev-parse','--verify','HEAD']),git(repo,['status','--porcelain=v1','-z','--untracked-files=normal'])]);
          const entries=status.split('\0').filter(Boolean);let changes=0;
          for(let i=0;i<entries.length;i++){changes++;if(/^[RC]|^.[RC]/.test(entries[i]))i++;}
          return {id:repo.id,name:repo.name,head:head.trim(),changes,available:true};
        } catch(error) {return {id:repo.id,name:repo.name,available:false,error:error.message};}
      }));
      return reply({ok:true,repositories:items});
    }
    if (path !== '/api/maintenance/history') return reply({ok:false,error:'维护记录接口不存在'},404);
    const url=new URL(req.url),repo=repositories.find(item=>item.id===url.searchParams.get('repo'));
    if (!repo) return reply({ok:false,error:'请选择已有代码仓库'},400);
    const offset=Number(url.searchParams.get('offset')||0), requested=url.searchParams.get('ref');
    if (!Number.isSafeInteger(offset)||offset<0||offset>100000||requested&&!/^[0-9a-f]{40}$/.test(requested)) return reply({ok:false,error:'版本分页参数不正确'},400);
    try {
      const head=requested||(await git(repo,['rev-parse','--verify','HEAD'])).trim();
      const output=await git(repo,['log',head,'--no-show-signature','-z','--format=%H%x00%aI%x00%an%x00%s%x00%b','--max-count=31','--skip='+offset,'--']);
      const fields=output.split('\0');if(fields.at(-1)==='')fields.pop();
      if(fields.length%5)throw new Error('Git 记录格式无法解析');
      const commits=[];
      for(let i=0;i<fields.length;i+=5)commits.push({hash:fields[i],date:fields[i+1],author:fields[i+2],subject:fields[i+3],body:fields[i+4]});
      return reply({ok:true,repository:repo.id,ref:head,commits:commits.slice(0,30),next:commits.length>30?offset+30:null});
    } catch(error){return reply({ok:false,error:error.message},503);}
  };
}
