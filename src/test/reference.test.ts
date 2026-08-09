import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildFileReference } from '../reference';

test('a whole-file reference is just the mention', () => {
  assert.equal(buildFileReference({ relativePath: 'src/extension.ts' }), '@src/extension.ts');
});

test('windows separators become forward slashes', () => {
  assert.equal(buildFileReference({ relativePath: 'src\\test\\a.ts' }), '@src/test/a.ts');
});

test('a multi-line selection becomes an L range, one-based', () => {
  assert.equal(
    buildFileReference({ relativePath: 'a.ts', selection: { startLine: 9, endLine: 19 } }),
    '@a.ts#L10-L20',
  );
});

test('a single-line selection collapses to one L marker', () => {
  assert.equal(
    buildFileReference({ relativePath: 'a.ts', selection: { startLine: 4, endLine: 4 } }),
    '@a.ts#L5',
  );
});

test('a path with spaces is quoted', () => {
  assert.equal(buildFileReference({ relativePath: 'my docs/a.ts' }), '@"my docs/a.ts"');
});
