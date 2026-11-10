import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const root = new URL('./', import.meta.url);
const read = (name) => readFileSync(new URL(name, root), 'utf8');

test('NAS ECHO identity runner pipes JSON input to child processes', () => {
  const source = read('echo-identities.test.py');
  assert.match(source, /Popen\(args,text=True,stdin=subprocess\.PIPE,stdout=subprocess\.PIPE,stderr=subprocess\.PIPE/);
  assert.match(source, /process\.communicate\(input_data,timeout=30\)/);
});

test('voice browser fixture records intercepted playback calls before assertions', () => {
  const source = read('voice-save-browser.py');
  assert.match(source, /held=\[\];saved=\[\];calls=\[\];errors=\[\]/);
  assert.match(source, /calls\.append\(\{'path':path,'body':r\.request\.post_data_json\}\)/);
});

test('visible state fixture passes Playwright wait arguments by keyword', () => {
  const source = read('visible-state-browser.py');
  assert.match(source, /page\.wait_for_function\([\s\S]*?, arg=destination\)/);
});

test('native dialog cleanup assertions wait for close-event removal', () => {
  const library = read('library-browser.py');
  assert.match(library, /page\.locator\('dialog:modal'\)\.count\(\)==0/);
  const history = read('review-history-browser.py');
  assert.match(history, /review\.wait_for\(state='detached'\)/);
  assert.match(history, /page\.keyboard\.press\('Escape'\);dialog\.wait_for\(state='detached'\)/);
});
