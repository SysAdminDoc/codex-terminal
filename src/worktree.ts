import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Which repository — and which checkout of it — a directory belongs to.
 *
 * Sessions were grouped by working directory, which files every git worktree of a repository
 * as if it were an unrelated project. That is exactly backwards for the way worktrees are
 * used: several agents working the same repository in parallel, one checkout each. Grouped by
 * cwd they scatter; grouped by repository they sit together, with the checkout named.
 *
 * The distinction is readable from disk without running git. A main checkout has `.git` as a
 * *directory*; a linked worktree has `.git` as a *file* containing
 * `gitdir: <main>/.git/worktrees/<name>`, which names both the parent repository and the
 * worktree in one line. Parsing that is cheap, offline, and cannot be defeated by git not
 * being on PATH — which matters, because this runs while listing history.
 */

export interface Checkout {
  /** Absolute path of the main checkout, which is the grouping key. */
  repositoryRoot: string;
  /** Directory this checkout lives in — the same as `repositoryRoot` for a main checkout. */
  root: string;
  /** Set only for a linked worktree, from the directory git records it under. */
  worktree?: string;
}

/**
 * Pull the gitdir out of a `.git` file.
 *
 * The format is a single `gitdir: <path>` line. Everything else — including a `.git` file
 * that is something other than a worktree link — returns undefined rather than a guess.
 */
export function parseGitFile(content: string): string | undefined {
  const match = /^\s*gitdir:\s*(.+?)\s*$/m.exec(content);
  return match ? match[1] : undefined;
}

/**
 * Split `<main>/.git/worktrees/<name>` into the repository and the worktree name.
 *
 * Both separators are accepted: the gitdir is written by whichever git wrote it, and a
 * Windows checkout can hold either.
 */
export function parseWorktreeGitdir(
  gitdir: string,
): { repositoryRoot: string; worktree: string } | undefined {
  const normalised = gitdir.replace(/\\/g, '/').replace(/\/+$/, '');
  const match = /^(.*)\/\.git\/worktrees\/([^/]+)$/.exec(normalised);
  if (!match || !match[1]) {
    return undefined;
  }
  return { repositoryRoot: path.normalize(match[1]), worktree: match[2] };
}

interface CheckoutReaders {
  isDirectory(target: string): Promise<boolean>;
  isFile(target: string): Promise<boolean>;
  readText(target: string): Promise<string>;
}

const realReaders: CheckoutReaders = {
  isDirectory: async (target) => {
    try {
      return (await stat(target)).isDirectory();
    } catch {
      return false;
    }
  },
  isFile: async (target) => {
    try {
      return (await stat(target)).isFile();
    } catch {
      return false;
    }
  },
  readText: (target) => readFile(target, 'utf8'),
};

/**
 * Walk up from a directory to the checkout that contains it.
 *
 * Returns undefined outside a repository, which is an ordinary case — plenty of Codex
 * sessions run somewhere that is not a git checkout at all, and those keep being grouped by
 * their working directory.
 */
export async function findCheckout(
  directory: string,
  readers: CheckoutReaders = realReaders,
): Promise<Checkout | undefined> {
  let current = path.resolve(directory);
  // Bounded by the filesystem root: `path.dirname` of a root returns the root itself.
  for (;;) {
    const dotGit = path.join(current, '.git');
    if (await readers.isDirectory(dotGit)) {
      return { repositoryRoot: current, root: current };
    }
    if (await readers.isFile(dotGit)) {
      try {
        const gitdir = parseGitFile(await readers.readText(dotGit));
        const linked = gitdir ? parseWorktreeGitdir(gitdir) : undefined;
        if (linked) {
          return {
            repositoryRoot: linked.repositoryRoot,
            root: current,
            worktree: linked.worktree,
          };
        }
      } catch {
        // An unreadable `.git` file is treated as "not a checkout" rather than as an error:
        // the only cost is that this session groups by directory, as it did before.
      }
      // A `.git` file that is not a worktree link (a submodule, say) still marks a checkout.
      return { repositoryRoot: current, root: current };
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}
