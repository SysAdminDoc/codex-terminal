import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildCommandLine,
  buildLaunchPlan,
  buildTypedCommandLine,
  modeArgs,
  quoteCmd,
  quotePosix,
  quotePowerShell,
  resolveCommandPath,
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
  assert.deepEqual(plan.shellArgs, ['-NoLogo', '-NoExit', '-Command', "& 'codex'"]);
});

test('auto falls back to Windows PowerShell when pwsh 7 is absent', () => {
  const plan = buildLaunchPlan(req({ availableShells: [] }));
  assert.equal(plan.shellPath, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(plan.family, 'powershell');
});

test('pwsh uses Windows PowerShell when only the WindowsApps alias is available', () => {
  const plan = buildLaunchPlan(
    req({
      shell: 'pwsh',
      availableShells: ['C:\\Users\\matt\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe'],
    }),
  );
  assert.equal(plan.shellPath, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.match(plan.shellResolutionReason ?? '', /WindowsApps execution alias/);
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
  assert.deepEqual(plan.shellArgs, ['-NoLogo', '-Command', "& 'codex'"]);
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

test('cmd.exe arguments use an escaped quote pair for verbatim shell arguments', () => {
  assert.equal(quoteCmd('a b&c;d'), '^"a b^&c;d^"');
  assert.equal(quoteCmd('percent%PATH%'), '^"percent^%PATH^%^"');
  assert.equal(
    buildCommandLine('C:\\Program Files\\nodejs\\node.exe', ['a b&c;d'], 'cmd'),
    '"C:\\Program Files\\nodejs\\node.exe" ^"a b^&c;d^"',
  );
});

test('posix shells re-exec interactively so the tab survives Codex exiting', () => {
  const plan = buildLaunchPlan(req({ shell: 'bash', platform: 'linux' }));
  assert.equal(plan.family, 'posix');
  assert.deepEqual(plan.shellArgs, ['-c', "'codex'; exec 'bash' -i"]);
});

test('posix quoting closes and reopens around an embedded quote', () => {
  assert.equal(quotePosix("it's"), "'it'\\''s'");
});

test('extra args are quoted per family', () => {
  assert.equal(
    buildCommandLine('codex', ['--config', 'model="gpt"'], 'powershell'),
    `& 'codex' '--config' 'model="gpt"'`,
  );
  assert.equal(buildCommandLine('codex', ['--model', 'gpt-5.1'], 'posix'), "'codex' '--model' 'gpt-5.1'");
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

test('a bare command resolves through a Windows PATH including .cmd files', () => {
  const files = new Set(['C:\\tools\\codex.cmd']);
  assert.equal(
    resolveCommandPath('codex', {
      platform: 'win32',
      pathValue: 'C:\\tools;C:\\other',
      fileExists: (candidate) => files.has(candidate),
    }),
    'C:\\tools\\codex.cmd',
  );
});

test('an absolute command path containing spaces is validated without rewriting it', () => {
  const command = 'C:\\Program Files\\OpenAI Codex\\codex.cmd';
  assert.equal(
    resolveCommandPath(command, {
      platform: 'win32',
      fileExists: (candidate) => candidate === command,
    }),
    command,
  );
});

test('a missing command fails preflight resolution', () => {
  assert.equal(
    resolveCommandPath('codex', {
      platform: 'win32',
      pathValue: 'C:\\empty',
      fileExists: () => false,
    }),
    undefined,
  );
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
    "& 'codex' 'resume' '--last' '--model' 'gpt-5.1'",
  ]);
});

test('forking a chosen session targets that id, not the last one', () => {
  // `fork --last` ignores the session the user actually clicked in the sidebar; the id is
  // appended by the caller, so the subcommand must not carry --last.
  assert.deepEqual(modeArgs('forkPicker'), ['fork']);
  assert.deepEqual(modeArgs('forkLast'), ['fork', '--last']);
});


/**
 * The defect this replaced: quoting was conditional on a metacharacter set that had no `;`,
 * `$` or backtick, so `--model=a;calc` typed into the profile prompt reached `-Command` as two
 * statements and ran `calc`, and `x$HOME` expanded on the way through. Any such list is a
 * standing invitation to miss a character, so PowerShell and POSIX values are now quoted
 * unconditionally. Verified against real pwsh, Windows PowerShell and bash: all fifteen
 * arguments below arrive byte-for-byte.
 */
const HOSTILE_ARGUMENTS = [
  '--model=a;calc',
  'x$HOME',
  'back`tick',
  'brace{s}',
  'star*glob',
  'tilde~home',
  'quest?ion',
  'amp&ersand',
  'pipe|d',
  'paren(s)',
  'a b c',
  "it's",
  'percent%PATH%',
  'bang!x',
  'comma,semi;eq=',
];

test('every hostile argument is quoted for PowerShell, whatever it contains', () => {
  for (const argument of HOSTILE_ARGUMENTS) {
    const line = buildCommandLine('codex', [argument], 'powershell');
    assert.ok(line.startsWith("& 'codex' '"), line);
    assert.ok(line.endsWith("'"), line);
    // Nothing outside the quotes but the call operator and the command.
    assert.equal(line, `& 'codex' ${quotePowerShell(argument)}`);
  }
});

test('every hostile argument is quoted for POSIX, whatever it contains', () => {
  for (const argument of HOSTILE_ARGUMENTS) {
    assert.equal(
      buildCommandLine('codex', [argument], 'posix'),
      `'codex' ${quotePosix(argument)}`,
    );
  }
});

test('a value with no metacharacters is quoted anyway, and is unchanged by it', () => {
  // Single-quoted literals honour no escapes, so quoting something that did not need it
  // cannot alter it — which is what makes unconditional quoting safe rather than merely tidy.
  assert.equal(buildCommandLine('codex', ['--version'], 'powershell'), "& 'codex' '--version'");
  assert.equal(buildCommandLine('codex', ['--version'], 'posix'), "'codex' '--version'");
});

test('cmd quotes everything it could otherwise execute', () => {
  // The caret-escaped quote pair is what survives the verbatim shellArgs path; a plain pair is
  // what node-pty would create when it re-quotes a string[].
  for (const argument of ['amp&ersand', 'pipe|d', 'redirect>out', 'in<put', 'caret^x', 'paren(s)', 'a b']) {
    assert.ok(
      buildCommandLine('codex', [argument], 'cmd').endsWith(quoteCmd(argument)),
      `${argument} was left bare`,
    );
  }
});


test('editorDefault types a bare command, because the shell is not ours to assume', () => {
  // The typed line lands in whatever profile the operator has set. `& 'codex'` is valid
  // PowerShell and a syntax error in cmd.exe, so the command stays bare when it can - while
  // the arguments, which are the injection surface, are quoted either way.
  assert.equal(buildTypedCommandLine('codex', [], 'powershell'), 'codex');
  assert.equal(
    buildTypedCommandLine('codex', ['--model=a;calc'], 'powershell'),
    "codex '--model=a;calc'",
  );
  assert.equal(buildTypedCommandLine('codex', ['x$HOME'], 'posix'), "codex 'x$HOME'");
  // A command that cannot be left bare still gets the call operator it needs.
  assert.equal(
    buildTypedCommandLine('C:/Program Files/codex.cmd', [], 'powershell'),
    "& 'C:/Program Files/codex.cmd'",
  );
});
