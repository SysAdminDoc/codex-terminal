
import * as path from 'node:path';

import { codexHomeDirectory } from './sessions';

/** Return profile names represented by `<name>.config.toml` files. */
export function profileNamesFromFiles(fileNames: readonly string[]): string[] {
  return fileNames
    .filter((fileName) => /\.config\.toml$/i.test(fileName))
    .map((fileName) => fileName.replace(/\.config\.toml$/i, ''))
    .filter((name) => name.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Where Codex keeps its profiles, which is `$CODEX_HOME` itself.
 *
 * `userHomeDirectory` is the **user's** home, not Codex's — the opposite of the parameter
 * `codexHomeDirectory` takes, which already *is* the Codex home. Handing this function the
 * result of that one therefore produces `~/.codex/.codex`. Only one call site exists and it
 * passes nothing, so the trap is latent; the name is what stops it being armed later.
 */
export function codexProfilesDirectory(userHomeDirectory?: string): string {
  const home = userHomeDirectory?.trim();
  // No argument: defer entirely, so `$CODEX_HOME` is honoured.
  return home ? path.join(home, '.codex') : codexHomeDirectory();
}
