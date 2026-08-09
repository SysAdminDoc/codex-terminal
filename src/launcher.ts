/**
 * Pure launch-plan construction. Deliberately free of any `vscode` import so the
 * quoting rules below can be unit tested with plain `node --test`.
 *
 * The whole point of this extension: Codex is handed to the shell as an argument
 * (`pwsh -NoExit -Command codex`) rather than typed into a live prompt with
 * `Terminal.sendText`. Passing it as an argument cannot interleave with shell
 * startup output, leaves nothing in shell history, and survives a shell profile
 * that prints a banner.
 */

export type ShellKind =
  | 'auto'
  | 'pwsh'
  | 'powershell'
  | 'cmd'
  | 'bash'
  | 'zsh'
  | 'custom'
  | 'editorDefault';

export type ShellFamily = 'powershell' | 'cmd' | 'posix';

export interface LaunchRequest {
  shell: ShellKind;
  customShellPath: string;
  /** Codex executable, e.g. `codex` or `C:\Program Files\OpenAI Codex\codex.cmd`. */
  command: string;
  /** Arguments appended to the Codex command itself. */
  args: string[];
  keepShellOpen: boolean;
  /** `process.platform`, injected so tests can exercise every platform. */
  platform: NodeJS.Platform;
  /** Absolute paths that exist on this machine, used to resolve `auto` and `pwsh`. */
  availableShells?: string[];
}

export interface LaunchPlan {
  /** Absolute path or bare name of the shell binary, or undefined for `editorDefault`. */
  shellPath?: string;
  shellArgs: string[];
  family: ShellFamily;
  /**
   * Set only for `editorDefault`, where we have no shell to pass arguments to and
   * must fall back to typing the command. Documented as the racy mode.
   */
  sendTextFallback?: string;
}

const PWSH_WINDOWS_CANDIDATES = [
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
];
const WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const CMD = 'C:\\Windows\\System32\\cmd.exe';

/**
 * PowerShell single-quoted literal: no escapes are honoured inside except `''`
 * for an embedded quote, which is exactly what we need for Windows paths full of
 * backslashes.
 */
export function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** POSIX single-quoted literal. `'` has to leave and re-enter the quoting. */
export function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * cmd.exe has no escape for `"` inside a quoted string, so a path containing one
 * is unquotable. Quote when we must, leave bare otherwise.
 */
export function quoteCmd(value: string): string {
  if (value.includes('"')) {
    throw new Error(`cmd.exe cannot quote a path containing a double quote: ${value}`);
  }
  return /[\s&|<>^]/.test(value) ? `"${value}"` : value;
}

function needsQuoting(value: string): boolean {
  return /[\s'"&|<>^()]/.test(value);
}

/** Build the command line the shell will execute, quoted for that shell's family. */
export function buildCommandLine(command: string, args: string[], family: ShellFamily): string {
  if (family === 'powershell') {
    // `&` is required before a quoted path, otherwise PowerShell treats the
    // string as a value to echo rather than a program to run.
    const head = needsQuoting(command) ? `& ${quotePowerShell(command)}` : command;
    const tail = args.map((a) => (needsQuoting(a) ? quotePowerShell(a) : a));
    return [head, ...tail].join(' ');
  }
  if (family === 'cmd') {
    return [command, ...args].map(quoteCmd).join(' ');
  }
  const head = needsQuoting(command) ? quotePosix(command) : command;
  const tail = args.map((a) => (needsQuoting(a) ? quotePosix(a) : a));
  return [head, ...tail].join(' ');
}

function familyOf(shellPath: string): ShellFamily {
  const leaf = shellPath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  if (leaf.startsWith('pwsh') || leaf.startsWith('powershell')) {
    return 'powershell';
  }
  if (leaf.startsWith('cmd')) {
    return 'cmd';
  }
  return 'posix';
}

function resolvePwsh(req: LaunchRequest): string {
  if (req.platform !== 'win32') {
    return 'pwsh';
  }
  const available = req.availableShells ?? [];
  const found = PWSH_WINDOWS_CANDIDATES.find((c) => available.includes(c));
  return found ?? 'pwsh.exe';
}

/** Resolve the configured shell to a concrete executable. */
export function resolveShellPath(req: LaunchRequest): string | undefined {
  switch (req.shell) {
    case 'editorDefault':
      return undefined;
    case 'custom': {
      const custom = req.customShellPath.trim();
      if (!custom) {
        throw new Error(
          'codexTerminal.shell is "custom" but codexTerminal.customShellPath is empty.',
        );
      }
      return custom;
    }
    case 'pwsh':
      return resolvePwsh(req);
    case 'powershell':
      return req.platform === 'win32' ? WINDOWS_POWERSHELL : 'powershell';
    case 'cmd':
      return req.platform === 'win32' ? CMD : 'cmd.exe';
    case 'bash':
      return 'bash';
    case 'zsh':
      return 'zsh';
    case 'auto':
    default: {
      if (req.platform !== 'win32') {
        return process.env.SHELL || 'bash';
      }
      const available = req.availableShells ?? [];
      const pwsh = PWSH_WINDOWS_CANDIDATES.find((c) => available.includes(c));
      if (pwsh) {
        return pwsh;
      }
      // Windows PowerShell ships with the OS, so this always exists as a floor.
      return WINDOWS_POWERSHELL;
    }
  }
}

/**
 * Turn settings into the exact `createTerminal` arguments.
 *
 * `keepShellOpen` is what makes a crashed or exited Codex leave a usable prompt
 * behind instead of a tab that vanishes before the error can be read.
 */
export function buildLaunchPlan(req: LaunchRequest): LaunchPlan {
  const command = req.command.trim();
  if (!command) {
    throw new Error('codexTerminal.command is empty.');
  }

  const shellPath = resolveShellPath(req);

  if (shellPath === undefined) {
    // editorDefault: no shell binary of our own, so the command has to be typed.
    return {
      shellPath: undefined,
      shellArgs: [],
      family: req.platform === 'win32' ? 'powershell' : 'posix',
      sendTextFallback: buildCommandLine(
        command,
        req.args,
        req.platform === 'win32' ? 'powershell' : 'posix',
      ),
    };
  }

  const family = familyOf(shellPath);
  const commandLine = buildCommandLine(command, req.args, family);

  if (family === 'powershell') {
    const flags = ['-NoLogo'];
    if (req.keepShellOpen) {
      flags.push('-NoExit');
    }
    return { shellPath, shellArgs: [...flags, '-Command', commandLine], family };
  }

  if (family === 'cmd') {
    return { shellPath, shellArgs: [req.keepShellOpen ? '/K' : '/C', commandLine], family };
  }

  // POSIX: re-exec an interactive shell so the tab survives Codex exiting.
  const script = req.keepShellOpen
    ? `${commandLine}; exec ${quotePosix(shellPath)} -i`
    : commandLine;
  return { shellPath, shellArgs: ['-c', script], family };
}

/** Codex subcommand for each launch mode the extension exposes. */
export type LaunchMode = 'new' | 'resumeLast' | 'resumePicker' | 'forkLast';

export function modeArgs(mode: LaunchMode): string[] {
  switch (mode) {
    case 'resumeLast':
      return ['resume', '--last'];
    case 'resumePicker':
      return ['resume'];
    case 'forkLast':
      return ['fork', '--last'];
    case 'new':
    default:
      return [];
  }
}
