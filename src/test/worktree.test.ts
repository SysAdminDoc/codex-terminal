import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';

import { findCheckout, parseGitFile, parseWorktreeGitdir } from '../worktree';

test('a .git file yields its gitdir, and anything else yields nothing', () => {
  assert.equal(
    parseGitFile('gitdir: /home/me/repo/.git/worktrees/feature\n'),
    '/home/me/repo/.git/worktrees/feature',
  );
  assert.equal(parseGitFile('gitdir:C:\\repo\\.git\\worktrees\\wt'), 'C:\\repo\\.git\\worktrees\\wt');
  assert.equal(parseGitFile('not a git file'), undefined);
  assert.equal(parseGitFile(''), undefined);
});

test('a worktree gitdir names both the repository and the worktree', () => {
  const posix = parseWorktreeGitdir('/home/me/repo/.git/worktrees/feature');
  assert.equal(posix?.worktree, 'feature');
  assert.equal(path.normalize(posix?.repositoryRoot ?? ''), path.normalize('/home/me/repo'));

  // Written by whichever git wrote it; a Windows checkout can hold either separator.
  const windows = parseWorktreeGitdir('C:\\repos\\app\\.git\\worktrees\\hotfix');
  assert.equal(windows?.worktree, 'hotfix');
  assert.equal(path.normalize(windows?.repositoryRoot ?? ''), path.normalize('C:/repos/app'));
});

test('a gitdir that is not a worktree link is not mistaken for one', () => {
  assert.equal(parseWorktreeGitdir('/home/me/repo/.git'), undefined);
  assert.equal(parseWorktreeGitdir('/home/me/repo/.git/modules/sub'), undefined);
  assert.equal(parseWorktreeGitdir(''), undefined);
});

/** Fake filesystem: keys are absolute paths, values are `dir` or the file's contents. */
function readers(tree: Record<string, string>) {
  const at = (target: string): string | undefined =>
    tree[path.resolve(target).replace(/\\/g, '/')];
  return {
    isDirectory: async (target: string) => at(target) === 'dir',
    isFile: async (target: string) => at(target) !== undefined && at(target) !== 'dir',
    readText: async (target: string) => at(target) ?? '',
  };
}

const key = (target: string): string => path.resolve(target).replace(/\\/g, '/');

test('a directory inside a main checkout resolves to the repository root', async () => {
  const root = path.resolve('/repos/app');
  const found = await findCheckout(
    path.join(root, 'src', 'deep'),
    readers({ [key(path.join(root, '.git'))]: 'dir' }),
  );
  assert.equal(found?.repositoryRoot, root);
  assert.equal(found?.root, root);
  assert.equal(found?.worktree, undefined);
});

test('a worktree resolves to its parent repository and keeps its own root', async () => {
  const main = path.resolve('/repos/app');
  const linked = path.resolve('/repos/app-feature');
  const found = await findCheckout(
    path.join(linked, 'src'),
    readers({
      [key(path.join(main, '.git'))]: 'dir',
      [key(path.join(linked, '.git'))]: `gitdir: ${main.replace(/\\/g, '/')}/.git/worktrees/feature`,
    }),
  );
  // The whole point: a worktree must not be filed under the main checkout's directory, and
  // must still group under the same repository as it.
  assert.equal(found?.repositoryRoot, main);
  assert.equal(found?.root, linked);
  assert.equal(found?.worktree, 'feature');
});

test('a directory outside any checkout resolves to nothing, which is not an error', async () => {
  // Plenty of Codex sessions run somewhere that is not a checkout; those keep grouping by
  // working directory exactly as before.
  assert.equal(await findCheckout(path.resolve('/scratch/nowhere'), readers({})), undefined);
});
