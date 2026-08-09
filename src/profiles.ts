import * as os from 'node:os';
import * as path from 'node:path';

/** Return profile names represented by `<name>.config.toml` files. */
export function profileNamesFromFiles(fileNames: readonly string[]): string[] {
  return fileNames
    .filter((fileName) => /\.config\.toml$/i.test(fileName))
    .map((fileName) => fileName.replace(/\.config\.toml$/i, ''))
    .filter((name) => name.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

export function codexProfilesDirectory(homeDirectory: string = os.homedir()): string {
  return path.join(homeDirectory, '.codex');
}
