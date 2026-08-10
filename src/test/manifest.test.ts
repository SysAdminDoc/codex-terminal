import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

interface Manifest {
  activationEvents?: string[];
  categories?: string[];
  extensionKind?: string[];
  capabilities?: {
    untrustedWorkspaces?: {
      supported?: boolean | string;
      description?: string;
      restrictedConfigurations?: string[];
    };
    virtualWorkspaces?: { supported?: boolean | string; description?: string };
  };
  contributes?: {
    views?: Record<string, Array<{ id?: string }>>;
    commands?: Array<{ command?: string }>;
    terminal?: { profiles?: Array<{ id?: string; titleTemplate?: string }> };
    configuration?: {
      properties?: Record<string, { scope?: string; default?: unknown }>;
    };
  };
}

function readManifest(): Manifest {
  return JSON.parse(
    readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'),
  ) as Manifest;
}

test('command-bearing settings stay machine-overridable', () => {
  const manifestPath = path.resolve(__dirname, '../../package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  const properties = manifest.contributes?.configuration?.properties ?? {};

  for (const key of [
    'codexTerminal.command',
    'codexTerminal.customShellPath',
    'codexTerminal.args',
    'codexTerminal.env',
  ]) {
    assert.equal(
      properties[key]?.scope,
      'machine-overridable',
      `${key} must remain machine-overridable so workspace settings cannot inject commands`,
    );
  }
});

test('startup activation is deferred, never eager', () => {
  const manifestPath = path.resolve(__dirname, '../../package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  const events = manifest.activationEvents ?? [];

  // `onStartupFinished` is required, not merely tolerated: crash recovery and the journal
  // heartbeat both live in `activate`, so without it the editor reopens after the crash this
  // feature exists for and says nothing until the operator goes looking. The event fires
  // *after* the workbench has started — it is the sanctioned slot for exactly this work.
  assert.ok(
    events.includes('onStartupFinished'),
    'recovery cannot be offered by an extension that has not activated',
  );
  // `*` is the one that would actually cost the operator startup time.
  assert.ok(!events.includes('*'), 'eager activation blocks the window opening');
});

test('history view and live title settings remain contributed', () => {
  const manifest = readManifest();
  const views = manifest.contributes?.views?.codexTerminalContainer ?? [];
  assert.ok(views.some((view) => view.id === 'codexTerminal.history'));

  const properties = manifest.contributes?.configuration?.properties ?? {};
  assert.equal(properties['codexTerminal.history.maxSessions']?.default, 200);
});

test('the default title items keep the tab animated and identifiable', () => {
  const properties = readManifest().contributes?.configuration?.properties ?? {};
  const titleItems = properties['codexTerminal.titleItems']?.default as string[];

  // `activity` is the animated item: without it Codex emits a static title and a working
  // tab looks identical to an idle one.
  assert.equal(titleItems[0], 'activity');
  // `app-name` is the constant substring that identifies our tabs after a window reload,
  // when `live` titles mean no name of ours appears in the label.
  assert.ok(titleItems.includes('app-name'));
});

test('the contributed profile carries the live title template', () => {
  const profile = readManifest().contributes?.terminal?.profiles?.find(
    (candidate) => candidate.id === 'codexTerminal.profile',
  );
  // Without this the workbench falls back to `terminal.integrated.tabs.title`, which is
  // `${process}` by default and renders every Codex tab as "pwsh".
  assert.equal(profile?.titleTemplate, '${sequence}');
});

test('tab title defaults to the mode that can animate', () => {
  const properties = readManifest().contributes?.configuration?.properties ?? {};
  assert.equal(properties['codexTerminal.tabTitle']?.default, 'live');
});

test('every recovery command reaches the manifest', () => {
  const commands = new Set(
    (readManifest().contributes?.commands ?? []).map((command) => command.command),
  );
  for (const id of [
    'codexTerminal.restoreSession',
    'codexTerminal.restoreAllSessions',
    'codexTerminal.dismissRecovery',
  ]) {
    assert.ok(commands.has(id), `${id} must be contributed or the tree item cannot invoke it`);
  }
});

test('the extension declares how it behaves in an untrusted workspace', () => {
  const manifest = readManifest();
  const untrusted = manifest.capabilities?.untrustedWorkspaces;
  // Undeclared is not neutral: VS Code disables the extension in Restricted Mode with no
  // explanation. `true` would be worse -- it would let an untrusted folder choose the
  // program that runs.
  assert.equal(untrusted?.supported, 'limited');
  assert.ok(untrusted?.description, 'the restriction must explain itself to the user');
});

test('every command-bearing setting is restricted in an untrusted workspace', () => {
  const manifest = readManifest();
  const restricted = new Set(
    manifest.capabilities?.untrustedWorkspaces?.restrictedConfigurations ?? [],
  );
  const properties = manifest.contributes?.configuration?.properties ?? {};

  // Anything that names a program, its arguments, or its environment decides what executes
  // when a folder is opened, so a workspace must not be able to set it untrusted.
  for (const key of Object.keys(properties)) {
    const leaf = key.split('.').pop() ?? '';
    if (['command', 'customShellPath', 'shell', 'args', 'env', 'titleItems'].includes(leaf)) {
      assert.ok(restricted.has(key), `${key} must be restricted in untrusted workspaces`);
    }
  }
});

test('a virtual workspace is declared unsupported rather than silently broken', () => {
  const virtualWorkspaces = readManifest().capabilities?.virtualWorkspaces;
  assert.equal(virtualWorkspaces?.supported, false);
  assert.ok(virtualWorkspaces?.description);
});

test('the extension runs where the shell and the code are', () => {
  // Without this a remote window can load the extension on the UI side, where it would
  // spawn a shell on the wrong machine.
  assert.deepEqual(readManifest().extensionKind, ['workspace', 'ui']);
});

test('categories describe the extension for the marketplace', () => {
  const categories = readManifest().categories ?? [];
  const valid = new Set([
    'AI', 'Azure', 'Chat', 'Data Science', 'Debuggers', 'Extension Packs', 'Education',
    'Formatters', 'Keymaps', 'Language Packs', 'Linters', 'Machine Learning', 'Notebooks',
    'Programming Languages', 'SCM Providers', 'Snippets', 'Testing', 'Themes',
    'Visualization', 'Other',
  ]);
  assert.ok(categories.length > 0);
  for (const category of categories) {
    assert.ok(valid.has(category), `${category} is not a valid marketplace category`);
  }
});

test('every %placeholder% in the manifest has a translation', () => {
  // `npm run check` compiles, lints and tests a manifest with a missing key perfectly happily.
  // Only `vsce package` refuses it, which is far too late — and a shipped placeholder renders
  // as the literal `%command.x.title%` in the operator's Command Palette.
  const root = path.resolve(__dirname, '../..');
  const manifest = readFileSync(path.join(root, 'package.json'), 'utf8');
  const translations = JSON.parse(
    readFileSync(path.join(root, 'package.nls.json'), 'utf8'),
  ) as Record<string, string>;

  const used = [...manifest.matchAll(/"%([^%"]+)%"/g)].map((match) => match[1]);
  assert.ok(used.length > 0, 'the manifest must use translation placeholders');
  const missing = [...new Set(used)].filter((key) => !(key in translations));
  assert.deepEqual(missing, [], `used in package.json but absent from package.nls.json: ${missing.join(', ')}`);
});
