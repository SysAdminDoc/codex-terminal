/**
 * Build a reproducible VSIX and record its checksum.
 *
 * This project ships unsigned, outside any marketplace, so a user sideloading the `.vsix`
 * has no signature to check. A byte-identical rebuild plus a published SHA-256 is the
 * substitute: anyone can rebuild the same commit and compare hashes, which is verifiable
 * without a certificate authority and without a CI service.
 *
 * `vsce` honours `SOURCE_DATE_EPOCH` (vscode-vsce#1100, shipped in 3.2.2) by sorting entries
 * and fixing modification times. Without it every build differs purely by timestamp, and
 * "compare the hashes" becomes advice nobody can act on.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const output = path.join(root, 'dist', `codex-terminal-${manifest.version}.vsix`);

/** Commit time, so the stamp is a property of the source rather than of the build host. */
function sourceDateEpoch() {
  if (process.env.SOURCE_DATE_EPOCH) {
    return process.env.SOURCE_DATE_EPOCH;
  }
  try {
    return execFileSync('git', ['log', '-1', '--pretty=%ct'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    // A tarball export with no git history still builds; it just is not reproducible
    // against another machine's clock.
    return '0';
  }
}

const epoch = sourceDateEpoch();
console.log(`[package] SOURCE_DATE_EPOCH=${epoch}`);

// Run vsce's JS entry with this Node rather than the `.cmd` shim: Node refuses to spawn a
// batch file without a shell (BatBadBut, CVE-2024-27980), which fails as a bare EINVAL.
const vsce = path.join(root, 'node_modules', '@vscode', 'vsce', 'vsce');
execFileSync(process.execPath, [vsce, 'package', '--out', output], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, SOURCE_DATE_EPOCH: epoch },
});

const digest = createHash('sha256').update(readFileSync(output)).digest('hex');
const line = `${digest}  ${path.basename(output)}\n`;
writeFileSync(path.join(root, 'dist', 'SHA256SUMS.txt'), line, 'utf8');

console.log(`[package] ${line.trim()}`);
console.log('[package] wrote dist/SHA256SUMS.txt');
