import assert from 'node:assert/strict';
import Module from 'node:module';
import { test } from 'node:test';

import { INITIAL_ACTIVITY } from '../activity';
import { buildLaunchPlan, type ShellFamily } from '../launcher';

interface LoaderInternals {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
}

interface Configuration {
  get<T>(key: string, fallback?: T): T;
}

const settings: Record<string, unknown> = {
  shell: 'powershell',
  customShellPath: '',
  command: 'codex',
  args: ['--model', 'gpt-5.1'],
  titleItems: ['activity'],
  keepShellOpen: true,
};
const configuration: Configuration = {
  get<T>(key: string, fallback?: T): T {
    return (Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : fallback) as T;
  },
};

type QuickPickEntry = { session?: unknown };
type QuickPickOptions = { title?: string; placeHolder?: string };
let chooseQuickPick:
  | ((items: readonly QuickPickEntry[], options: QuickPickOptions) => Promise<QuickPickEntry | undefined>)
  | undefined;

const loader = Module as unknown as LoaderInternals;
const originalLoad = loader._load;
const vscodeStub = {
  workspace: {
    getConfiguration: (): Configuration => configuration,
  },
  window: {
    activeTextEditor: undefined,
    showQuickPick: (items: readonly QuickPickEntry[], options: QuickPickOptions) =>
      chooseQuickPick?.(items, options) ?? Promise.resolve(undefined),
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
const { pickLiveSession, readLaunchRequest } = require('../launch') as typeof import('../launch');
const { clearServices, setServices } = require('../services') as typeof import('../services');
/* eslint-enable @typescript-eslint/no-require-imports */

test('launch settings become one safely quoted argv plan in every shell family', () => {
  setServices({
    log: { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    context: {} as never,
  } as never);

  try {
    const cases: Array<{ shell: string; family: ShellFamily }> = [
      { shell: 'powershell', family: 'powershell' },
      { shell: 'cmd', family: 'cmd' },
      { shell: 'bash', family: 'posix' },
    ];
    for (const { shell, family } of cases) {
      settings.shell = shell;
      const request = readLaunchRequest(
        'new',
        undefined,
        undefined,
        ['review', '--commit', 'abc1234'],
        false,
      );
      assert.deepEqual(request.args, [
        'review',
        '--commit',
        'abc1234',
        '--model',
        'gpt-5.1',
        '-c',
        "tui.terminal_title=['activity']",
      ]);

      const plan = buildLaunchPlan(request);
      assert.equal(plan.family, family, shell);
      const commandLine = plan.shellArgs[plan.shellArgs.length - 1] ?? '';
      assert.match(commandLine, /review/);
      assert.match(commandLine, /--commit/);
      assert.match(commandLine, /abc1234/);
      assert.match(commandLine, /gpt-5\.1/);
      assert.match(commandLine, /terminal_title/);
    }
  } finally {
    clearServices();
  }
});

test('a single live session is selected silently for reference commands', async () => {
  const terminal = { show: () => undefined };
  const session = {
    key: 'one',
    terminal,
    cwd: 'C:\\repo',
    project: 'repo',
    label: 'Codex',
    mode: 'new',
    launchedAt: 1,
    activity: INITIAL_ACTIVITY,
    bindable: true,
  };
  let pickerCalls = 0;
  chooseQuickPick = async () => {
    pickerCalls += 1;
    return undefined;
  };
  setServices({
    log: { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    context: {} as never,
    monitor: { live: () => [session] } as never,
  } as never);

  try {
    assert.equal(await pickLiveSession([session] as never, 'Choose a reference target'), session);
    assert.equal(pickerCalls, 0);
  } finally {
    chooseQuickPick = undefined;
    clearServices();
  }
});

test('multiple live sessions use the status picker and cancellation has no target', async () => {
  const idle = {
    key: 'idle',
    terminal: { show: () => undefined },
    cwd: 'C:\\repo',
    project: 'older',
    label: 'Codex',
    mode: 'new',
    launchedAt: 2,
    activity: { ...INITIAL_ACTIVITY, status: 'idle' as const },
    bindable: true,
  };
  const working = {
    key: 'working',
    terminal: { show: () => undefined },
    cwd: 'C:\\repo',
    project: 'newer',
    label: 'Codex',
    mode: 'new',
    launchedAt: 1,
    activity: { ...INITIAL_ACTIVITY, status: 'working' as const },
    bindable: true,
  };
  const sessions = [idle, working];
  let pickerCalls = 0;
  chooseQuickPick = async (items, options) => {
    pickerCalls += 1;
    assert.equal(options.title, 'Choose a reference target');
    // The shared picker puts the working session first even though it was launched earlier.
    assert.equal(items[0]?.session, working);
    return undefined;
  };
  setServices({
    log: { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    context: {} as never,
    monitor: { live: () => sessions } as never,
  } as never);

  try {
    assert.equal(await pickLiveSession(sessions as never, 'Choose a reference target'), undefined);
    assert.equal(pickerCalls, 1);
  } finally {
    chooseQuickPick = undefined;
    clearServices();
  }
});
