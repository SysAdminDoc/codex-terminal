/**
 * Generate the app-server protocol types from the Codex executable on PATH.
 *
 * The generated directory is committed because the extension must compile without Codex
 * installed on the build host. Keep this script independent of the extension bundle: it is a
 * development-time bridge to the CLI, not runtime code.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outputDirectory = path.join(root, 'src', 'generated', 'appServer');
const versionPattern = /\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/;

function locateCodex() {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(locator, ['codex'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error('Could not find `codex` on PATH. Install Codex CLI before generating app-server types.');
  }

  const candidates = result.stdout
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0 && existsSync(candidate));
  const command = candidates.find((candidate) => /\.cmd$/i.test(candidate)) ?? candidates[0];
  if (!command) {
    throw new Error('`codex` was reported on PATH, but no executable path could be resolved.');
  }
  return command;
}

function nodeEntryFor(command) {
  if (process.platform !== 'win32' || !/\.cmd$/i.test(command)) {
    return undefined;
  }
  const entry = path.join(path.dirname(command), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (!existsSync(entry)) {
    throw new Error(`The Codex shim ${command} has no adjacent JavaScript entry point.`);
  }
  return entry;
}

function invoke(command, args) {
  const entry = nodeEntryFor(command);
  const executable = entry ? process.execPath : command;
  const executableArgs = entry ? [entry, ...args] : args;
  const result = spawnSync(executable, executableArgs, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with code ${result.status ?? 'unknown'}.`);
  }
  return result.stdout;
}

function codexVersion(command) {
  const output = invoke(command, ['--version']);
  const match = output.match(versionPattern);
  if (!match) {
    throw new Error(`Could not read a semantic version from codex --version: ${output.trim()}`);
  }
  return match[0];
}

function previousVersion() {
  const metadata = path.join(outputDirectory, 'metadata.ts');
  if (!existsSync(metadata)) {
    return undefined;
  }
  const match = readFileSync(metadata, 'utf8').match(/APP_SERVER_CLI_VERSION = ["']([^"']+)["']/);
  return match?.[1];
}

function metadataSource(version) {
  return `// GENERATED CODE! DO NOT MODIFY BY HAND!\n// cli_version: ${version}\n// This file is written by scripts/generate-app-server-types.mjs.\n\nexport const APP_SERVER_CLI_VERSION = ${JSON.stringify(version)};\n`;
}

const command = locateCodex();
const version = codexVersion(command);
const prior = previousVersion();
const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'codex-terminal-app-server-'));

try {
  invoke(command, ['app-server', 'generate-ts', '--out', temporaryDirectory]);
  const generatedIndex = path.join(temporaryDirectory, 'index.ts');
  if (!existsSync(generatedIndex)) {
    throw new Error('Codex generated no app-server index.ts; refusing to replace the committed types.');
  }

  if (prior && prior !== version) {
    console.warn(
      `[app-server] warning: replacing types generated from Codex CLI ${prior} with ${version}; ` +
        'the extension will warn again if a running server does not match.',
    );
  }

  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(path.dirname(outputDirectory), { recursive: true });
  cpSync(temporaryDirectory, outputDirectory, { recursive: true });
  writeFileSync(path.join(outputDirectory, 'metadata.ts'), metadataSource(version), 'utf8');
  console.log(`[app-server] generated protocol types from Codex CLI ${version}`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
