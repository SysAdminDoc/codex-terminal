import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

interface Manifest {
  activationEvents?: string[];
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

test('the extension does not force activation in every window at startup', () => {
  const manifestPath = path.resolve(__dirname, '../../package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  assert.ok(!manifest.activationEvents?.includes('onStartupFinished'));
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
