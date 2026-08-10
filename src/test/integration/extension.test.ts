import * as assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { suite, test } from 'mocha';

interface TestApi {
  getActionCount: () => number;
  getTerminalProfileOptions: () => Promise<vscode.TerminalOptions | undefined>;
}

const OWNERSHIP_ENV_VAR = 'CODEX_TERMINAL_OWNED';

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

  test('creates an owned Codex terminal from the command', async () => {
    const terminal = await openCodexTerminal('codexTerminal.new');
    try {
      assert.ok(isOwned(terminal));
    } finally {
      terminal.dispose();
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

  test('the contributed profile resolves a shell path', async () => {
    const extension = vscode.extensions.getExtension<TestApi>('sysadmindoc.codex-terminal');
    assert.ok(extension);
    const api = await extension.activate();
    const options = await api.getTerminalProfileOptions();
    assert.ok(options?.shellPath);
  });
});
