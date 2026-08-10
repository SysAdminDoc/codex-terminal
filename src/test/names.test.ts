import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_NAME_LENGTH,
  displayName,
  idForName,
  normaliseName,
  setSessionName,
} from '../names';

test('a name is collapsed to one line and capped', () => {
  // Names are drawn inline beside a status and a duration; a newline would break the row.
  assert.equal(normaliseName('  auth\n  refactor  '), 'auth refactor');
  assert.equal(normaliseName('x'.repeat(200)).length, MAX_NAME_LENGTH);
  assert.equal(normaliseName('   '), '');
});

test('an empty name clears rather than storing a blank', () => {
  const named = setSessionName({}, 'id-1', 'auth refactor');
  assert.equal(named['id-1'], 'auth refactor');
  assert.deepEqual(setSessionName(named, 'id-1', '   '), {});
});

test('naming one session does not disturb the others', () => {
  const names = setSessionName(setSessionName({}, 'a', 'first'), 'b', 'second');
  assert.deepEqual(names, { a: 'first', b: 'second' });
  assert.deepEqual(setSessionName(names, 'a', 'renamed'), { a: 'renamed', b: 'second' });
});

test('an unnamed session falls back rather than showing a blank row', () => {
  assert.equal(displayName({}, 'id-1', 'codex-terminal'), 'codex-terminal');
  assert.equal(displayName({ 'id-1': 'auth' }, 'id-1', 'codex-terminal'), 'auth');
  // A session with no id yet cannot have a name, and must still render.
  assert.equal(displayName({ 'id-1': 'auth' }, undefined, 'starting…'), 'starting…');
});

test('a name resolves back to its session id, case-insensitively', () => {
  const names = { 'id-1': 'Auth Refactor', 'id-2': 'docs' };
  assert.equal(idForName(names, 'auth refactor'), 'id-1');
  assert.equal(idForName(names, '  AUTH   REFACTOR '), 'id-1', 'the same normalisation applies');
  assert.equal(idForName(names, 'nothing'), undefined);
  assert.equal(idForName(names, ''), undefined);
});
