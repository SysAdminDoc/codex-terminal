import assert from 'node:assert/strict';
import { test } from 'node:test';

import { collectDoctorReport } from '../doctor';
import type { LaunchRequest } from '../launcher';

function request(overrides: Partial<LaunchRequest> = {}): LaunchRequest {
  return {
    shell: 'auto',
    customShellPath: '',
    command: 'codex',
    args: [],
    keepShellOpen: true,
    platform: 'win32',
    availableShells: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe'],
    ...overrides,
  };
}

test('doctor reports shell, command, version, cwd, and UI visibility', async () => {
  const files = new Set([
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\tools\\codex.cmd',
  ]);
  const report = await collectDoctorReport({
    request: request({ command: 'codex' }),
    cwd: 'C:\\workspace',
    statusBarVisible: false,
    editorTitleButtonCanRender: false,
    pathValue: 'C:\\tools',
    fileExists: (candidate) => files.has(candidate),
    runVersion: async (command) => `${command} 0.147.0`,
  });

  assert.equal(report.shellExists, true);
  assert.equal(report.commandPath, 'C:\\tools\\codex.cmd');
  assert.equal(report.version, 'C:\\tools\\codex.cmd 0.147.0');
  assert.equal(report.cwd, 'C:\\workspace');
  assert.equal(report.statusBarVisible, false);
  assert.equal(report.editorTitleButtonCanRender, false);
});

test('doctor does not run a missing command', async () => {
  let versionProbes = 0;
  const report = await collectDoctorReport({
    request: request({ command: 'missing-codex' }),
    statusBarVisible: true,
    editorTitleButtonCanRender: true,
    pathValue: 'C:\\empty',
    fileExists: () => false,
    runVersion: async () => {
      versionProbes += 1;
      return 'unexpected';
    },
  });

  assert.equal(versionProbes, 0);
  assert.equal(report.commandPath, undefined);
  assert.equal(report.version, '');
});
