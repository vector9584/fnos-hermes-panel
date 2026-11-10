"""Cross-language fixtures, using installed python-dotenv and actual Node helper."""
import json,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3];sys.path.insert(0,str(ROOT/'app/server'));from panel_env_txn import parse
cases=['','# comment\n','\ufeffA=one\r\nexport B=two\r\n','A=\nEMPTY\n','A=bare#literal\nB=bare # comment\n','A="quoted # value" # comment\n',"A='single \\' quote \\\\ slash'\n",'A="escaped \\" quote \\\\ slash \\n newline"\n','A="line one\nline two"\n','A=one\nA=two\n','A=${REFERENCE:-fallback}\n','A=one\n  \t','__proto__=literal\nconstructor=literal\n']
script="import {parseEnv} from "+json.dumps((ROOT/'app/server/panel-env-format.js').as_uri())+";let s='';for await(const c of process.stdin)s+=c;console.log(JSON.stringify(JSON.parse(s).map(x=>parseEnv(x).values)))"
result=subprocess.run(['/vol1/@apphome/hermes-agent/data/node/bin/node','--input-type=module','-e',script],input=json.dumps(cases),text=True,capture_output=True,check=True);actual=json.loads(result.stdout)
for index,case in enumerate(cases):assert actual[index]==parse(case)[1],{'case':index,'error':'parser mismatch'}
print(json.dumps({'dotenv_parity_cases':len(cases),'passed':True}))
