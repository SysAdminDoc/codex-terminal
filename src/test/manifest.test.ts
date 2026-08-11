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
    mcpServerDefinitionProviders?: Array<{ id?: string; label?: string }>;
    walkthroughs?: Array<{
      id?: string;
      title?: string;
      description?: string;
      isFeatured?: boolean;
      steps?: Array<{
        id?: string;
        title?: string;
        description?: string;
        media?: { image?: string; markdown?: string; altText?: string };
        completionEvents?: string[];
      }>;
    }>;
    commands?: Array<{ command?: string }>;
    menus?: Record<string, Array<{ command?: string; when?: string }>>;
    terminal?: { profiles?: Array<{ id?: string; titleTemplate?: string }> };
    configuration?: {
      properties?: Record<string, { scope?: string; default?: unknown }>;
    };
  };
}

/** Locales with a `package.nls.<locale>.json` and an `l10n/bundle.l10n.<locale>.json`. */
const SHIPPED_LOCALES = ['es'];

/** The `{0}`-style indices a string uses, sorted, so order changes in translation are fine. */
function placeholders(value: string | undefined): string {
  return [...String(value ?? '').matchAll(/\{(\d+)\}/g)]
    .map((match) => match[1])
    .sort()
    .join(',');
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

test('the first-run walkthrough covers the real Codex workflow', () => {
  const manifest = readManifest();
  const walkthrough = manifest.contributes?.walkthroughs?.find(
    (candidate) => candidate.id === 'codexTerminal.getStarted',
  );
  assert.ok(walkthrough);
  assert.equal(walkthrough.isFeatured, true);

  const steps = walkthrough.steps ?? [];
  assert.deepEqual(
    steps.map((step) => step.id),
    ['installCodex', 'launchCodex', 'chooseProfile', 'openHistory'],
  );
  for (const step of steps) {
    assert.match(step.title ?? '', /^%walkthrough\./);
    assert.match(step.description ?? '', /^%walkthrough\./);
    assert.equal(step.media?.image, 'resources/activity-icon.svg');
    assert.equal(step.media?.altText, '%extension.displayName%');
    assert.ok((step.completionEvents ?? []).length > 0, `${step.id} needs a completion event`);
  }

  assert.deepEqual(steps[0].completionEvents, ['onCommand:codexTerminal.doctor']);
  assert.deepEqual(steps[1].completionEvents, ['onCommand:codexTerminal.new']);
  assert.deepEqual(steps[2].completionEvents, ['onCommand:codexTerminal.newWithProfile']);
  assert.deepEqual(steps[3].completionEvents, ['onView:codexTerminal.history']);
});

test('the Codex MCP provider is contributed for hosts that support it', () => {
  const providers = readManifest().contributes?.mcpServerDefinitionProviders ?? [];
  const provider = providers.find((candidate) => candidate.id === 'codexTerminal.mcp');
  assert.ok(provider);
  assert.equal(provider.label, '%mcp.provider.label%');
});

test('Git SCM menus expose the three Codex review targets', () => {
  const manifest = readManifest();
  const commands = new Set(
    (manifest.contributes?.commands ?? []).map((command) => command.command),
  );
  assert.ok(commands.has('codexTerminal.reviewUncommitted'));
  assert.ok(commands.has('codexTerminal.reviewBase'));
  assert.ok(commands.has('codexTerminal.reviewCommit'));

  const title = manifest.contributes?.menus?.['scm/title'] ?? [];
  assert.ok(title.some((item) => item.command === 'codexTerminal.reviewUncommitted'));
  assert.ok(title.some((item) => item.command === 'codexTerminal.reviewBase'));
  const history = manifest.contributes?.menus?.['scm/historyItem/context'] ?? [];
  assert.ok(history.some((item) => item.command === 'codexTerminal.reviewCommit'));
});

test('archived history sessions expose an unarchive command', () => {
  const manifest = readManifest();
  const commands = new Set(
    (manifest.contributes?.commands ?? []).map((command) => command.command),
  );
  assert.ok(commands.has('codexTerminal.unarchiveSession'));
  const history = manifest.contributes?.menus?.['view/item/context'] ?? [];
  assert.ok(
    history.some(
      (item) =>
        item.command === 'codexTerminal.unarchiveSession' &&
        item.when?.includes('codexTerminal.archivedSession'),
    ),
  );
});

test('every command a menu offers is a command the manifest declares', () => {
  // Found in the running editor, not here: VS Code silently drops a menu item whose command
  // is undeclared and logs `Menu item references a command … which is not defined in the
  // 'commands' section`. `codexTerminal.nameSession` was registered at runtime and wired into
  // two context menus, so the code was complete and the tests were green — and the feature was
  // unreachable through the UI for two releases because the manifest never named the command.
  const manifest = readManifest();
  const declared = new Set((manifest.contributes?.commands ?? []).map((entry) => entry.command));
  const referenced = new Set<string>();
  for (const items of Object.values(manifest.contributes?.menus ?? {})) {
    for (const item of items) {
      if (item.command) {
        referenced.add(item.command);
      }
    }
  }
  assert.ok(referenced.size > 0, 'the manifest must contribute menu items');
  const undeclared = [...referenced].filter((command) => !declared.has(command));
  assert.deepEqual(undeclared, [], `menu commands missing from contributes.commands: ${undeclared.join(', ')}`);
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

test('every shipped locale translates the whole manifest, with no orphan keys', () => {
  // A partial language pack is invisible: VS Code silently falls back to English per key, so
  // half a translation looks like a working one. Parity in both directions is the only check
  // that fails when a new setting is added and the locale is not updated with it.
  const root = path.resolve(__dirname, '../..');
  const english = Object.keys(
    JSON.parse(readFileSync(path.join(root, 'package.nls.json'), 'utf8')) as Record<string, string>,
  );
  for (const locale of SHIPPED_LOCALES) {
    const translated = new Set(
      Object.keys(
        JSON.parse(
          readFileSync(path.join(root, `package.nls.${locale}.json`), 'utf8'),
        ) as Record<string, string>,
      ),
    );
    const missing = english.filter((key) => !translated.has(key));
    assert.deepEqual(missing, [], `package.nls.${locale}.json is missing: ${missing.join(', ')}`);
    const orphans = [...translated].filter((key) => !english.includes(key));
    assert.deepEqual(orphans, [], `package.nls.${locale}.json translates keys that no longer exist: ${orphans.join(', ')}`);
  }
});

test('every shipped locale translates the whole extension-host bundle', () => {
  const root = path.resolve(__dirname, '../..');
  const english = JSON.parse(
    readFileSync(path.join(root, 'l10n', 'bundle.l10n.json'), 'utf8'),
  ) as Record<string, string>;
  const keys = Object.keys(english);
  assert.ok(keys.length > 0, 'the exported bundle must not be empty');

  for (const locale of SHIPPED_LOCALES) {
    const translated = JSON.parse(
      readFileSync(path.join(root, 'l10n', `bundle.l10n.${locale}.json`), 'utf8'),
    ) as Record<string, string>;
    const missing = keys.filter((key) => !(key in translated));
    assert.deepEqual(missing, [], `bundle.l10n.${locale}.json is missing: ${missing.slice(0, 5).join(' | ')}`);
    const orphans = Object.keys(translated).filter((key) => !(key in english));
    assert.deepEqual(orphans, [], `bundle.l10n.${locale}.json has strings the source no longer uses: ${orphans.slice(0, 5).join(' | ')}`);

    // A dropped or renumbered placeholder is the failure that survives review: the string
    // reads fine and renders `{0}` at the user, or silently loses the value entirely.
    const mismatched = keys.filter(
      (key) => placeholders(key) !== placeholders(translated[key]),
    );
    assert.deepEqual(mismatched, [], `placeholders differ in ${locale}: ${mismatched.slice(0, 5).join(' | ')}`);
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
