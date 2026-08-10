import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

import {
  buildNotifyConfigValue,
  buildNotifyHookScript,
  NotifyBridge,
  resolveNodeExecutable,
  type NotifyEvent,
} from '../notify';

const execFileAsync = promisify(execFile);

test('notify config is an invocation-scoped TOML override', () => {
  assert.equal(
    buildNotifyConfigValue('C:\\Program Files\\nodejs\\node.exe', 'C:\\Codex\\notify.cjs'),
    "notify=['C:\\Program Files\\nodejs\\node.exe','C:\\Codex\\notify.cjs']",
  );
  // An apostrophe used to throw here, which meant every launch failed for anyone whose home
  // directory contains one. TOML's multi-line literal form carries it; only a value that
  // cannot be represented at all is still refused.
  assert.equal(
    buildNotifyConfigValue("C:\\user's\\node.exe", 'C:\\hook.cjs'),
    "notify=['''C:\\user's\\node.exe''','C:\\hook.cjs']",
  );
  assert.throws(() => buildNotifyConfigValue("C:\\a'''b\\node.exe", 'C:\\hook.cjs'), /TOML/);
});

test('the generated hook writes a turn-ended event the bridge consumes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-terminal-notify-'));
  const events: NotifyEvent[] = [];
  const bridge = new NotifyBridge({
    directory,
    executable: process.execPath,
    workspaceName: 'codex-terminal',
    onTurnEnded: (event) => events.push(event),
  });
  try {
    await bridge.start();
    await execFileAsync(process.execPath, [path.join(directory, 'notify-hook.cjs'), 'turn-ended'], {
      windowsHide: true,
    });
    const deadline = Date.now() + 2000;
    while (events.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(events.length, 1);
    assert.equal(events[0].workspace, 'codex-terminal');
    assert.deepEqual(events[0].args, ['turn-ended']);
    assert.match(buildNotifyHookScript(directory, 'codex-terminal'), /process\.argv\.slice\(2\)/);
  } finally {
    bridge.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * The defect: `process.execPath` in the extension host is the editor's Electron binary, which
 * behaves as Node only under `ELECTRON_RUN_AS_NODE=1` — and the editor deletes that variable
 * from the environment a terminal runs in. Codex spawns the notify program from there, so the
 * hook was handed to an editor with a `.cjs` argument. This test's whole job is to fail if the
 * editor binary is ever chosen again.
 */
test('an editor binary is never chosen as the hook runtime', () => {
  const resolved = resolveNodeExecutable({
    execPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\VSCodium\\VSCodium.exe',
    pathValue: 'C:\\nowhere;C:\\Program Files\\nodejs',
    isWindows: true,
    exists: (candidate) => candidate === 'C:\\Program Files\\nodejs\\node.exe',
  });
  assert.equal(resolved, 'C:\\Program Files\\nodejs\\node.exe');
});

test('a real Node running the host is used directly, without searching PATH', () => {
  let probed = 0;
  const resolved = resolveNodeExecutable({
    execPath: '/usr/local/bin/node',
    pathValue: '/usr/bin',
    isWindows: false,
    exists: () => {
      probed += 1;
      return true;
    },
  });
  assert.equal(resolved, '/usr/local/bin/node');
  assert.equal(probed, 0);
});

test('no Node anywhere resolves to nothing, so no hook is registered', () => {
  assert.equal(
    resolveNodeExecutable({
      execPath: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
      pathValue: '/usr/bin:/bin',
      isWindows: false,
      exists: () => false,
    }),
    undefined,
  );
});

test('a node.cmd shim is not accepted on Windows', () => {
  // Codex spawns the program directly and `CreateProcess` cannot run a batch file, so a shim
  // would resolve here and then fail to launch with nothing to explain it.
  assert.equal(
    resolveNodeExecutable({
      execPath: 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
      pathValue: 'C:\\shims',
      isWindows: true,
      exists: (candidate) => candidate === 'C:\\shims\\node.cmd',
    }),
    undefined,
  );
});

test('a path containing an apostrophe is still representable as TOML', () => {
  // `C:\\Users\\O'Brien` is an ordinary Windows home directory, and it used to throw on every
  // launch with notifications enabled — including from `provideTerminalProfile`, which has no
  // handler, so the contributed profile itself failed.
  const value = buildNotifyConfigValue(
    'C:\\Program Files\\nodejs\\node.exe',
    "C:\\Users\\O'Brien\\hook.cjs",
  );
  assert.equal(
    value,
    "notify=['C:\\Program Files\\nodejs\\node.exe','''C:\\Users\\O'Brien\\hook.cjs''']",
  );
});
