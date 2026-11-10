import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';

const script=fileURLToPath(new URL('./scale-acceptance.mjs',import.meta.url));
const repo=resolve(dirname(script),'../../..');

test('joint synthetic scale paths preserve pagination/search and stay under the local operation budget',()=>{
 const run=spawnSync(process.execPath,[script],{cwd:repo,encoding:'utf8',timeout:30000,env:{...process.env,SCALE_REPEATS:'5'}});
 assert.equal(run.status,0,run.stderr||run.stdout);
 const result=JSON.parse(run.stdout);
 assert.deepEqual(result.dataset,{skills:3000,knowledge_files:1000,experts:315,sessions:1000,messages:20000});
 assert.equal(result.knowledge_catalog.total,1000);
 assert.equal(result.knowledge_catalog.returned_items,40);
 assert.equal(result.knowledge_search.total,1);
 assert.equal(result.knowledge_search.partial,false);
 assert.equal(result.expert_catalog.total,315);
 assert.equal(result.expert_catalog.returned,36);
 assert.equal(result.session_and_global_search.total,2);
 assert.equal(result.session_and_global_search.returned,2);
 for(const [name,measurement] of Object.entries(result)){
  if(measurement&&typeof measurement==='object'&&typeof measurement.p95_ms==='number')assert.ok(measurement.p95_ms<1500,`${name} p95 ${measurement.p95_ms}ms`);
 }
});
