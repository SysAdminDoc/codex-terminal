import assert from 'node:assert/strict';
import Module from 'node:module';
import { test } from 'node:test';

/**
 * The settings synchronizer is an extension-host seam, so exercise its writes with a small
 * in-memory workbench and global-state stand-in. The planner has its own pure tests; this file
 * verifies the orchestration that makes a first apply reversible and later applies idempotent.
 */
interface LoaderInternals {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
}

interface Configuration {
  get<T>(key: string, fallback?: T): T;
  update(key: string, value: unknown, target: unknown): Promise<void>;
}

const loader = Module as unknown as LoaderInternals;
const originalLoad = loader._load;
const rootValues: Record<string, unknown> = {
  'terminal.integrated.confirmOnKill': 'editor',
  'terminal.integrated.tabs.allowAgentCliTitle': false,
};
const codexValues: Record<string, unknown> = {
  applyWorkbenchSettings: true,
  tabTitle: 'live',
};
const writes: Array<{ key: string; value: unknown }> = [];
let ledger: unknown;
const information: string[] = [];

function configuration(values: Record<string, unknown>): Configuration {
  return {
    get<T>(key: string, fallback?: T): T {
      return (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback) as T;
    },
    async update(key: string, value: unknown): Promise<void> {
      values[key] = value;
      writes.push({ key, value });
    },
  };
}

const rootConfiguration = configuration(rootValues);
const codexConfiguration = configuration(codexValues);
const vscodeStub = {
  ConfigurationTarget: { Global: 'global' },
  workspace: {
    getConfiguration: (section?: string): Configuration =>
      section === 'codexTerminal' ? codexConfiguration : rootConfiguration,
  },
  window: {
    showInformationMessage: async (message: string): Promise<undefined> => {
      information.push(message);
      return undefined;
    },
    showErrorMessage: async (): Promise<undefined> => undefined,
  },
  l10n: {
    t: (message: string, ...args: unknown[]): string =>
      message.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)])),
  },
};

loader._load = function patched(request: string, parent: unknown, isMain: boolean): unknown {
  return request === 'vscode' ? vscodeStub : originalLoad.call(this, request, parent, isMain);
};

/* eslint-disable @typescript-eslint/no-require-imports */
const { applyWorkbenchPreferences, revertWorkbenchPreferences } = require('../settingsSync') as typeof import('../settingsSync');
const { clearServices, setServices } = require('../services') as typeof import('../services');
/* eslint-enable @typescript-eslint/no-require-imports */

test('apply records the first values, avoids repeat writes, and reverts idempotently', async () => {
  ledger = undefined;
  writes.length = 0;
  information.length = 0;
  rootValues['terminal.integrated.confirmOnKill'] = 'editor';
  rootValues['terminal.integrated.tabs.allowAgentCliTitle'] = false;
  delete rootValues['terminal.integrated.tabs.description'];
  codexValues.applyWorkbenchSettings = true;
  codexValues.tabTitle = 'live';

  const globalState = {
    get: <T>(key: string): T | undefined =>
      key === 'codexTerminal.workbenchOverrides' ? (ledger as T | undefined) : undefined,
    update: async (key: string, value: unknown): Promise<void> => {
      if (key === 'codexTerminal.workbenchOverrides') {
        ledger = value;
      }
    },
  };
  setServices({
    log: { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    context: { globalState } as never,
  } as never);

  try {
    await applyWorkbenchPreferences();
    assert.deepEqual(
      writes.map((write) => write.key),
      [
        'terminal.integrated.confirmOnKill',
        'terminal.integrated.tabs.allowAgentCliTitle',
        'terminal.integrated.tabs.description',
      ],
    );
    assert.equal(rootValues['terminal.integrated.confirmOnKill'], 'never');
    assert.equal(rootValues['terminal.integrated.tabs.allowAgentCliTitle'], true);
    assert.match(String(rootValues['terminal.integrated.tabs.description']), /\$\{sequence\}/);
    assert.ok(ledger);
    assert.match(information[0], /live tab title/);
    assert.match(information[0], /Close confirmation is now off for every terminal/);
    assert.match(information[0], /not only Codex tabs/);

    const writesAfterFirstApply = writes.length;
    await applyWorkbenchPreferences();
    assert.equal(writes.length, writesAfterFirstApply, 'a second configuration event must be quiet');

    await revertWorkbenchPreferences();
    assert.equal(rootValues['terminal.integrated.confirmOnKill'], 'editor');
    assert.equal(rootValues['terminal.integrated.tabs.allowAgentCliTitle'], false);
    assert.equal(rootValues['terminal.integrated.tabs.description'], undefined);
    assert.equal(codexValues.applyWorkbenchSettings, false);

    const writesAfterRevert = writes.length;
    await applyWorkbenchPreferences();
    assert.equal(writes.length, writesAfterRevert, 'revert must disarm the apply path');
    assert.ok(information.length >= 2, 'apply and revert should each announce their work');
  } finally {
    clearServices();
  }
});
