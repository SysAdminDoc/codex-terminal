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

export function codexProfilesDirectory(homeDirectory?: string): string {
  if (!homeDirectory) {
    return codexHomeDirectory();
  }
  return path.join(homeDirectory, '.codex');
}
