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
    if (path === '/api/maintenance/activity') {
      const aurl = new URL(req.url), arepo = repositories.find(item => item.id === aurl.searchParams.get('repo'));
      if (!arepo) return reply({ok:false,error:'请选择已有代码仓库'},400);
      const span = Math.min(1095, Math.max(30, Number(aurl.searchParams.get('days')||365) || 365));
      try {
        const head = (await git(arepo, ['rev-parse','--verify','HEAD'])).trim();
        const out = await git(arepo, ['log', head, '--no-show-signature', '--since='+span+' days ago',
          '--date=format:%Y-%m-%d', '--format=%ad%x00%h%x00%s', '--']);
        const daily = new Map(), types = new Map(), commits = [];
        for (const line of out.split('\n')) {
          if (!line) continue;
          const [day, hash, subject] = line.split('\0');
          if (!day || !hash) continue;
          daily.set(day, (daily.get(day)||0) + 1);
          commits.push([day, hash, subject||'']);
          const matched = /^([A-Za-z][\w-]*)(?:\([^)]*\))?!?:/.exec(subject||'');
          const key = matched ? matched[1].toLowerCase() : '其他';
          types.set(key, (types.get(key)||0) + 1);
        }
        const keys = [...daily.keys()].sort(), stamp = day => Date.parse(day+'T00:00:00');
        let longest = 0, run = 0, prev = 0;
        for (const day of keys) {
          const at = stamp(day);
          run = prev && at - prev === 86400000 ? run + 1 : 1;
          prev = at; if (run > longest) longest = run;
        }
        const today = new Date().toLocaleDateString('sv-SE');
        const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('sv-SE');
        let current = 0, cursor = daily.has(today) ? today : (daily.has(yesterday) ? yesterday : null);
        while (cursor && daily.has(cursor)) { current++; cursor = new Date(stamp(cursor) - 86400000).toLocaleDateString('sv-SE'); }
        const typeList = [...types.entries()].sort((a,b) => b[1]-a[1]).slice(0,8).map(([key,count]) => ({key,count}));
        return reply({ok:true, repository:arepo.id, ref:head, days:span, today, total:commits.length,
          longest, current, daily:Object.fromEntries(daily), types:typeList,
          last: commits.length ? {day:commits[0][0], hash:commits[0][1], subject:commits[0][2]} : null,
          commits});
      } catch (error) { return reply({ok:false,error:error.message},503); }
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
