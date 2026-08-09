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
  type NotifyEvent,
} from '../notify';

const execFileAsync = promisify(execFile);

test('notify config is an invocation-scoped TOML override', () => {
  assert.equal(
    buildNotifyConfigValue('C:\\Program Files\\nodejs\\node.exe', 'C:\\Codex\\notify.cjs'),
    "notify=['C:\\Program Files\\nodejs\\node.exe','C:\\Codex\\notify.cjs']",
  );
  assert.throws(() => buildNotifyConfigValue("C:\\user's\\node.exe", 'C:\\hook.cjs'), /apostrophes/);
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
