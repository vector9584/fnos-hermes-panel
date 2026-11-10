import os,subprocess,sys
from pathlib import Path
root=Path(__file__).resolve().parent
for name in ['config-txn.test.py','config-bundle.test.py','env-txn.test.py','env-parser-parity.py','native-config.test.py','native-config-pipeline.test.py','native-config-integration.test.py','mcp.test.py','models.test.py','typing.test.py','auxiliary.test.py']:
 print('TEST',name,flush=True)
 result=subprocess.run([sys.executable,'-B',str(root/name)],env={**os.environ,'PYTHONDONTWRITEBYTECODE':'1'})
 if result.returncode:raise SystemExit(result.returncode)
