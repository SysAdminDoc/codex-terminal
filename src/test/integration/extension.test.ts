import * as assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { suite, test } from 'mocha';

interface TestApi {
  getActionCount: () => number;
  getTerminalProfileOptions: () => Promise<vscode.TerminalOptions | undefined>;
  getActivationMs: () => number;
  getInventoryRows: (of: 'plugins' | 'mcp') => Promise<string[]>;
}

/**
 * Ceiling for `activate`, in milliseconds.
 *
 * The extension activates on `onStartupFinished` in every window, because an extension that
 * has not activated cannot notice that the previous one died — and crash recovery is the
 * point. That makes activation cost everyone's problem, so it is asserted rather than
 * assured. Measured at 25ms on Windows 11 against a 2.0 GB rollout store, 2026-08-10; the
 * budget is an order of magnitude above that so it fails on a regression in kind — a
 * synchronous directory walk, an awaited settings write — not on a slower machine.
 */
const ACTIVATION_BUDGET_MS = 250;

const OWNERSHIP_ENV_VAR = 'CODEX_TERMINAL_OWNED';
const LAUNCH_KEY_ENV_VAR = 'CODEX_TERMINAL_KEY';

/**
 * Recognise our terminal the way the extension does.
 *
 * Not by label: with `tabTitle: "live"` the extension deliberately supplies no name, because
 * naming a terminal stops VS Code from ever subscribing to the title Codex emits. A test that
 * waits for a terminal called "Codex" therefore waits forever and reports only a timeout.
 */
function isOwned(terminal: vscode.Terminal): boolean {
  const options = terminal.creationOptions;
  return 'env' in options && options.env?.[OWNERSHIP_ENV_VAR] === '1';
}

/** Wait for the next Codex terminal, failing with a usable message rather than hanging. */
async function openCodexTerminal(command: string, timeoutMs = 10_000): Promise<vscode.Terminal> {
  let disposable: vscode.Disposable | undefined;
  const opened = new Promise<vscode.Terminal>((resolve) => {
    disposable = vscode.window.onDidOpenTerminal((terminal) => {
      if (isOwned(terminal)) {
        resolve(terminal);
      }
    });
  });
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(
      () =>
        reject(
          new Error(
            `${command} opened no terminal carrying ${OWNERSHIP_ENV_VAR} within ${timeoutMs}ms`,
          ),
        ),
      timeoutMs,
    );
  });

  try {
    await vscode.commands.executeCommand(command);
    return await Promise.race([opened, timeout]);
  } finally {
    disposable?.dispose();
  }
}

async function waitForFile(filePath: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, 'utf8');
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

/** Global scope only: it lands in the throwaway test user-data dir, never in the fixture. */
async function withTabTitle(mode: string, body: () => Promise<void>): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('codexTerminal');
  const previous = configuration.inspect<string>('tabTitle')?.globalValue;
  await configuration.update('tabTitle', mode, vscode.ConfigurationTarget.Global);
  try {
    await body();
  } finally {
    await vscode.workspace
      .getConfiguration('codexTerminal')
      .update('tabTitle', previous, vscode.ConfigurationTarget.Global);
  }
}

suite('Codex Terminal hostile settings integration', () => {
  test('keeps the activity bar view and all five actions available', async () => {
    const extension = vscode.extensions.getExtension<TestApi>('sysadmindoc.codex-terminal');
    assert.ok(extension, 'the development extension must be installed');
    const api = await extension.activate();
    const manifestPath = path.join(extension.extensionPath, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      contributes?: { views?: Record<string, Array<{ id: string }>> };
    };
    const views = manifest.contributes?.views?.codexTerminalContainer ?? [];
    assert.ok(views.some((view) => view.id === 'codexTerminal.actions'));
    assert.equal(api.getActionCount(), 5);
  });

  test('the inventory sections answer from the real Codex CLI', async () => {
    // The unit tests feed the provider captured JSON; this one runs the CLI that is actually
    // installed. It is the only check that fails when Codex renames a subcommand, changes the
    // shape of `--json`, or stops answering in the time allowed -- none of which the shipped
    // parsers can notice on their own.
    //
    // The fixture deliberately points `codexTerminal.command` at `node`, so it has to be put
    // back to `codex` here. That is not incidental: the first run of this test asserted
    // against the fixture and read `Could not read the plugin list (…)`, which was the
    // extension behaving correctly and the test asking the wrong question.
    const extension = vscode.extensions.getExtension<TestApi>('sysadmindoc.codex-terminal');
    assert.ok(extension);
    const api = await extension.activate();

    const settings = vscode.workspace.getConfiguration('codexTerminal');
    const previous = settings.inspect<string>('command')?.workspaceValue;
    await settings.update('command', 'codex', vscode.ConfigurationTarget.Workspace);
    try {
      for (const section of ['plugins', 'mcp'] as const) {
        const rows = await api.getInventoryRows(section);
        assert.ok(rows.length > 0, `the ${section} section must render at least one row`);
        for (const row of rows) {
          assert.ok(!/^Could not read/.test(row), `${section} came back unreadable: ${row}`);
        }
      }
    } finally {
      await vscode.workspace
        .getConfiguration('codexTerminal')
        .update('command', previous, vscode.ConfigurationTarget.Workspace);
    }
  });

  test('a section degrades to a stated failure rather than an empty list', async () => {
    // Back on the fixture's `codexTerminal.command: node`, which cannot answer `plugin list`.
    // The section must say so: an empty section would read as "no plugins installed", which is
    // a confident wrong answer about what a Codex run will have.
    const extension = vscode.extensions.getExtension<TestApi>('sysadmindoc.codex-terminal');
    assert.ok(extension);
    const api = await extension.activate();
    const rows = await api.getInventoryRows('plugins');
    assert.equal(rows.length, 1);
    assert.match(rows[0], /^Could not read the plugin list/);
  });

  test('every contributed command is actually registered', async () => {
    // The command table moved out of `extension.ts` when it was split into modules. A missed
    // registration does not fail to compile and does not fail any unit test — it fails when
    // the operator clicks the menu entry and the editor says the command does not exist.
    const extension = vscode.extensions.getExtension<TestApi>('sysadmindoc.codex-terminal');
    assert.ok(extension);
    await extension.activate();

    const manifest = JSON.parse(
      await readFile(path.join(extension.extensionPath, 'package.json'), 'utf8'),
    ) as { contributes?: { commands?: Array<{ command: string }> } };
    const contributed = (manifest.contributes?.commands ?? []).map((entry) => entry.command);
    assert.ok(contributed.length > 0, 'the manifest must contribute commands');

    const registered = new Set(await vscode.commands.getCommands(true));
    const missing = contributed.filter((id) => !registered.has(id));
    assert.deepEqual(missing, [], `contributed but never registered: ${missing.join(', ')}`);
  });

  test('creates an owned Codex terminal from the command', async () => {
    const terminal = await openCodexTerminal('codexTerminal.new');
    try {
      assert.ok(isOwned(terminal));
    } finally {
      terminal.dispose();
    }
  });

  test('cmd.exe passes an argument containing spaces, ampersand and semicolon verbatim', async () => {
    if (process.platform !== 'win32') {
      return;
    }

    const directory = await mkdtemp(path.join(tmpdir(), 'codex-cmd-'));
    const output = path.join(directory, 'argument.txt');
    const settings = vscode.workspace.getConfiguration('codexTerminal');
    const previous = {
      command: settings.inspect<string>('command')?.workspaceValue,
      shell: settings.inspect<string>('shell')?.workspaceValue,
      args: settings.inspect<string[]>('args')?.workspaceValue,
      keepShellOpen: settings.inspect<boolean>('keepShellOpen')?.workspaceValue,
    };
    const previousOutput = process.env.CODEX_ARG_OUTPUT;
    process.env.CODEX_ARG_OUTPUT = output;
    const script = "require('fs').writeFileSync(process.env.CODEX_ARG_OUTPUT, process.argv[1])";
    const hostile = 'a b&c;d';
    try {
      await settings.update('command', process.execPath, vscode.ConfigurationTarget.Workspace);
      await settings.update('shell', 'cmd', vscode.ConfigurationTarget.Workspace);
      await settings.update(
        'args',
        ['-e', script, hostile],
        vscode.ConfigurationTarget.Workspace,
      );
      await settings.update('keepShellOpen', false, vscode.ConfigurationTarget.Workspace);

      const terminal = await openCodexTerminal('codexTerminal.new');
      try {
        assert.equal(await waitForFile(output), hostile);
      } finally {
        terminal.dispose();
      }
    } finally {
      await settings.update('command', previous.command, vscode.ConfigurationTarget.Workspace);
      await settings.update('shell', previous.shell, vscode.ConfigurationTarget.Workspace);
      await settings.update('args', previous.args, vscode.ConfigurationTarget.Workspace);
      await settings.update(
        'keepShellOpen',
        previous.keepShellOpen,
        vscode.ConfigurationTarget.Workspace,
      );
      if (previousOutput === undefined) {
        delete process.env.CODEX_ARG_OUTPUT;
      } else {
        process.env.CODEX_ARG_OUTPUT = previousOutput;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('live mode leaves the name unset so Codex can drive the tab title', async () => {
    await withTabTitle('live', async () => {
      const terminal = await openCodexTerminal('codexTerminal.new');
      try {
        const options = terminal.creationOptions as vscode.TerminalOptions;
        // A name here would make VS Code skip the process-title subscription entirely,
        // which is the whole reason this mode exists.
        assert.equal(options.name, undefined);
      } finally {
        terminal.dispose();
      }
    });
  });

  test('static mode labels the tab with the configured terminal name', async () => {
    await withTabTitle('static', async () => {
      const terminal = await openCodexTerminal('codexTerminal.new');
      try {
        const options = terminal.creationOptions as vscode.TerminalOptions;
        assert.ok(options.name, 'static mode must supply a name');
        assert.match(options.name, /Codex/);
      } finally {
        terminal.dispose();
      }
    });
  });

  test('every launched terminal carries the journal key a reload needs', async () => {
    // The whole rebind-after-reload path rests on this one assumption: that the environment
    // handed to `createTerminal` is still readable from `creationOptions` afterwards. Assert
    // it against a real host rather than trusting it, because if it were ever untrue the
    // feature would fail silently and look like a binding bug.
    const first = await openCodexTerminal('codexTerminal.new');
    const second = await openCodexTerminal('codexTerminal.new');
    try {
      const keyOf = (terminal: vscode.Terminal): string | undefined => {
        const options = terminal.creationOptions as vscode.TerminalOptions;
        const value = options.env?.[LAUNCH_KEY_ENV_VAR];
        return typeof value === 'string' ? value : undefined;
      };
      const firstKey = keyOf(first);
      const secondKey = keyOf(second);
      assert.ok(firstKey, `no ${LAUNCH_KEY_ENV_VAR} on the launched terminal`);
      assert.ok(secondKey);
      assert.notEqual(firstKey, secondKey, 'two launches must not share a journal key');
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  test('a transcript opens read-only, never dirty, and reuses its document', async () => {
    // The point of the content provider is behaviour no type check can see: an untitled
    // buffer is dirty from birth and prompts to save on close, and opening the same session
    // twice used to produce two unrelated documents.
    const directory = await mkdtemp(path.join(tmpdir(), 'codex-transcript-'));
    const rollout = path.join(directory, 'rollout-test.jsonl');
    await writeFile(
      rollout,
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'abc123', timestamp: '2026-08-10T00:00:00.000Z', cwd: directory },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ text: 'hello from the fixture' }] },
        }),
      ].join('\n'),
      'utf8',
    );

    const uri = vscode.Uri.from({
      scheme: 'codex-transcript',
      path: '/abc123.md',
      query: new URLSearchParams({ path: rollout, project: 'fixture' }).toString(),
    });
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      assert.equal(document.languageId, 'markdown', 'the .md path is what sets the language');
      assert.equal(document.isDirty, false, 'a transcript must never ask to be saved');
      assert.equal(document.isUntitled, false);
      assert.match(document.getText(), /hello from the fixture/);

      const again = await vscode.workspace.openTextDocument(uri);
      assert.equal(again, document, 'the same session must resolve to the same document');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('activation stays inside its startup budget', async () => {
    const extension = vscode.extensions.getExtension<TestApi>('sysadmindoc.codex-terminal');
    assert.ok(extension);
    const api = await extension.activate();
    const cost = api.getActivationMs();
    // Printed whatever the verdict: a passing number that has been creeping is the useful
    // signal, and it is invisible if it is only reported on failure.
    console.log(`[activation] ${cost}ms (budget ${ACTIVATION_BUDGET_MS}ms)`);
    assert.ok(
      cost <= ACTIVATION_BUDGET_MS,
      `activate took ${cost}ms against a ${ACTIVATION_BUDGET_MS}ms budget — something on the ` +
        'activation path started blocking. Everything that can wait should be started with ' +
        '`void`, not awaited.',
    );
  });

  test('the contributed profile resolves a shell path', async () => {
    const extension = vscode.extensions.getExtension<TestApi>('sysadmindoc.codex-terminal');
    assert.ok(extension);
    const api = await extension.activate();
    const options = await api.getTerminalProfileOptions();
    assert.ok(options?.shellPath);
  });
});
