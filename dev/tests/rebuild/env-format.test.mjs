import test from 'node:test';
import assert from 'node:assert/strict';
import {parseEnv,envValue,setEnvValue} from '../../../app/server/panel-env-format.js';
test('dotenv export, duplicates, comments, multiline and escapes match native reader',()=>{
 const input='# keep\r\nexport KEY="a # b \\" q \\\\ slash" # note\r\nKEY=last # comment\nEMPTY=\nABSENT\nMULTI="first\nsecond"\n';
 assert.deepEqual({...parseEnv(input).values},{KEY:'last',EMPTY:'',ABSENT:null,MULTI:'first\nsecond'});
 const value='a # " \\ $REF ${REF}';const text=setEnvValue(input,'KEY',value);assert.equal(envValue(text,'KEY'),value);assert.equal(text.match(/KEY=/g).length,1);assert.ok(text.startsWith('# keep\r\n'));assert.equal(envValue(text,'MULTI'),'first\nsecond');
});
test('bad dotenv input fails without revealing values and rejects line injection',()=>{
 assert.throws(()=>parseEnv('KEY="fixture-private'),e=>e.status===503&&!e.message.includes('private'));
 assert.throws(()=>setEnvValue('KEY=one\n','KEY','two\nINJECT=true'),e=>e.status===400);
 assert.equal(setEnvValue('OTHER=one','KEY','two'),'OTHER=one\nKEY="two"\n');
});
