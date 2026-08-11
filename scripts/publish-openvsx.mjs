/**
 * Publish the already-built VSIX to Open VSX without putting a token on the command line.
 *
 * Namespace creation and the Eclipse Publisher Agreement are deliberately separate operator
 * steps. This script only publishes the manifest's current version after `npm run package`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const vsix = path.join(root, 'dist', `codex-terminal-${manifest.version}.vsix`);

if (!process.env.OVSX_PAT) {
  throw new Error(
    'OVSX_PAT is not set. Accept the Eclipse Open VSX Publisher Agreement and create a token before publishing.',
  );
}
if (!existsSync(vsix)) {
  throw new Error(`Missing ${vsix}; run npm run package first.`);
}

const ovsxPackagePath = require.resolve('ovsx/package.json', { paths: [root] });
const ovsxPackage = JSON.parse(readFileSync(ovsxPackagePath, 'utf8'));
const binValue =
  typeof ovsxPackage.bin === 'string' ? ovsxPackage.bin : ovsxPackage.bin?.ovsx;
if (typeof binValue !== 'string') {
  throw new Error('The pinned ovsx package does not expose an ovsx executable.');
}

// Invoke the JavaScript entry with this Node rather than a Windows .cmd shim. OVSX_PAT stays in
// the inherited environment and never appears in a process argument or this script's output.
execFileSync(process.execPath, [path.resolve(path.dirname(ovsxPackagePath), binValue), 'publish', vsix], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env },
});
