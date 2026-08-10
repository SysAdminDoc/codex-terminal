import assert from 'node:assert/strict';
import { test } from 'node:test';

import { profileArgs } from '../launcher';
import { codexProfilesDirectory, profileNamesFromFiles } from '../profiles';

test('profile discovery strips only the Codex config suffix and sorts names', () => {
  assert.deepEqual(
    profileNamesFromFiles([
      'zebra.config.toml',
      'base.config.toml',
      'README.md',
      'nested.config.toml.bak',
      '.config.toml',
    ]),
    ['base', 'zebra'],
  );
});

test('profile discovery uses the Codex home directory', () => {
  // The argument is the *user's* home. `codexHomeDirectory` takes the opposite - a Codex home
  // - so feeding this function that one's output yields `~/.codex/.codex`. The parameter name
  // is the guard; this asserts which of the two meanings is in force.
  assert.equal(codexProfilesDirectory('C:\\Users\\matt'), 'C:\\Users\\matt\\.codex');
  assert.equal(codexProfilesDirectory('  '), codexProfilesDirectory());
});

test('profile names become explicit Codex profile arguments', () => {
  assert.deepEqual(profileArgs(' team-default '), ['--profile', 'team-default']);
  assert.throws(() => profileArgs('  '), /profile name is empty/);
});
