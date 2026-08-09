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
  assert.equal(codexProfilesDirectory('C:\\Users\\matt'), 'C:\\Users\\matt\\.codex');
});

test('profile names become explicit Codex profile arguments', () => {
  assert.deepEqual(profileArgs(' team-default '), ['--profile', 'team-default']);
  assert.throws(() => profileArgs('  '), /profile name is empty/);
});
