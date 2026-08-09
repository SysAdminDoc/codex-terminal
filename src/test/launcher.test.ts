import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildCommandLine,
  buildLaunchPlan,
  modeArgs,
  quoteCmd,
  quotePosix,
  quotePowerShell,
  type LaunchRequest,
} from '../launcher';

function req(overrides: Partial<LaunchRequest> = {}): LaunchRequest {
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

test('auto picks pwsh 7 when it is present', () => {
  const plan = buildLaunchPlan(req());
  assert.equal(plan.shellPath, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  assert.equal(plan.family, 'powershell');
  assert.deepEqual(plan.shellArgs, ['-NoLogo', '-NoExit', '-Command', 'codex']);
});

test('auto falls back to Windows PowerShell when pwsh 7 is absent', () => {
  const plan = buildLaunchPlan(req({ availableShells: [] }));
  assert.equal(plan.shellPath, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(plan.family, 'powershell');
});

test('the command is passed as an argument, never typed', () => {
  const plan = buildLaunchPlan(req());
  assert.equal(plan.sendTextFallback, undefined);
});

test('editorDefault is the only mode that types the command', () => {
  const plan = buildLaunchPlan(req({ shell: 'editorDefault' }));
  assert.equal(plan.shellPath, undefined);
  assert.deepEqual(plan.shellArgs, []);
  assert.equal(plan.sendTextFallback, 'codex');
});

test('keepShellOpen=false drops -NoExit so the tab closes with Codex', () => {
  const plan = buildLaunchPlan(req({ keepShellOpen: false }));
  assert.deepEqual(plan.shellArgs, ['-NoLogo', '-Command', 'codex']);
});

test('a Codex path with spaces gets PowerShell call-operator quoting', () => {
  const plan = buildLaunchPlan(
    req({ command: 'C:\\Program Files\\OpenAI Codex\\codex.cmd' }),
  );
  assert.deepEqual(plan.shellArgs, [
    '-NoLogo',
    '-NoExit',
    '-Command',
    "& 'C:\\Program Files\\OpenAI Codex\\codex.cmd'",
  ]);
});

test("a single quote in a path is doubled, not backslash-escaped", () => {
  assert.equal(quotePowerShell("C:\\dev\\matt's tools\\codex.cmd"), "'C:\\dev\\matt''s tools\\codex.cmd'");
});

test('cmd.exe uses /K to stay open and /C to exit', () => {
  assert.deepEqual(buildLaunchPlan(req({ shell: 'cmd' })).shellArgs, ['/K', 'codex']);
  assert.deepEqual(
    buildLaunchPlan(req({ shell: 'cmd', keepShellOpen: false })).shellArgs,
    ['/C', 'codex'],
  );
});

test('cmd.exe refuses a path it cannot quote rather than emitting a broken line', () => {
  assert.throws(() => quoteCmd('C:\\we"ird\\codex.cmd'), /cannot quote/);
});

test('posix shells re-exec interactively so the tab survives Codex exiting', () => {
  const plan = buildLaunchPlan(req({ shell: 'bash', platform: 'linux' }));
  assert.equal(plan.family, 'posix');
  assert.deepEqual(plan.shellArgs, ['-c', "codex; exec 'bash' -i"]);
});

test('posix quoting closes and reopens around an embedded quote', () => {
  assert.equal(quotePosix("it's"), "'it'\\''s'");
});

test('extra args are quoted per family', () => {
  assert.equal(
    buildCommandLine('codex', ['--config', 'model="gpt"'], 'powershell'),
    `codex --config 'model="gpt"'`,
  );
  assert.equal(buildCommandLine('codex', ['--model', 'gpt-5.1'], 'posix'), 'codex --model gpt-5.1');
});

test('custom shell requires a path', () => {
  assert.throws(() => buildLaunchPlan(req({ shell: 'custom' })), /customShellPath is empty/);
  assert.equal(
    buildLaunchPlan(req({ shell: 'custom', customShellPath: 'C:\\tools\\nu.exe' })).shellPath,
    'C:\\tools\\nu.exe',
  );
});

test('an empty command is rejected', () => {
  assert.throws(() => buildLaunchPlan(req({ command: '   ' })), /command is empty/);
});

test('resume and fork map to real Codex subcommands', () => {
  assert.deepEqual(modeArgs('new'), []);
  assert.deepEqual(modeArgs('resumeLast'), ['resume', '--last']);
  assert.deepEqual(modeArgs('resumePicker'), ['resume']);
  assert.deepEqual(modeArgs('forkLast'), ['fork', '--last']);
});

test('mode args land ahead of the user args on the command line', () => {
  const plan = buildLaunchPlan(req({ args: [...modeArgs('resumeLast'), '--model', 'gpt-5.1'] }));
  assert.deepEqual(plan.shellArgs, [
    '-NoLogo',
    '-NoExit',
    '-Command',
    'codex resume --last --model gpt-5.1',
  ]);
});
