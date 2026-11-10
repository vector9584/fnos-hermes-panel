export function skillInstallName(value){
 const name=String(value||'').trim().replace(/^['"]|['"]$/g,'').replace(/[^\w.-]/g,'_');
 if(!name||name==='.'||name==='..'||name.length>100||!/^[A-Za-z0-9_][\w.-]*$/.test(name))return null;
 return name;
}
