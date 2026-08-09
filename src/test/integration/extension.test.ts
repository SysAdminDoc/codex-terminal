import * as assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { suite, test } from 'mocha';

interface TestApi {
  getActionCount: () => number;
  getTerminalProfileOptions: () => Promise<vscode.TerminalOptions | undefined>;
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

  test('creates a Codex terminal from the command', async () => {
    const opened = new Promise<vscode.Terminal>((resolve) => {
      const disposable = vscode.window.onDidOpenTerminal((terminal) => {
        if (terminal.name === 'Codex') {
          disposable.dispose();
          resolve(terminal);
        }
      });
    });
    await vscode.commands.executeCommand('codexTerminal.new');
    const terminal = await opened;
    assert.equal(terminal.name, 'Codex');
    terminal.dispose();
  });

  test('the contributed profile resolves a shell path', async () => {
    const extension = vscode.extensions.getExtension<TestApi>('sysadmindoc.codex-terminal');
    assert.ok(extension);
    const api = await extension.activate();
    const options = await api.getTerminalProfileOptions();
    assert.ok(options?.shellPath);
  });
});
