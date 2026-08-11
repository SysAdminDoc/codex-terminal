import { existsSync } from 'node:fs';
import * as path from 'node:path';

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

export interface CommandResolutionOptions {
  platform?: NodeJS.Platform;
  pathValue?: string;
  cwd?: string;
  fileExists?: (candidate: string) => boolean;
}

export interface LaunchPlan {
  /** Absolute path or bare name of the shell binary, or undefined for `editorDefault`. */
  shellPath?: string;
  shellArgs: string[];
  family: ShellFamily;
  /** Why a configured shell was replaced with a safer fallback, if applicable. */
  shellResolutionReason?: string;
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
 * Characters cmd.exe can run *code* with, which is a shorter list than it looks.
 *
 * `;` and `,` are argument delimiters in cmd, not command separators — only `&`, `|`, `<`,
 * `>`, `^` and grouping parentheses can start something executing, and `()` was missing here
 * while being present in the (now removed) PowerShell/POSIX predicate.
 *
 * `;`, `,` and `=` are not command separators, but values containing them still use the same
 * escaped argument form when they also contain spaces. `%` expands even inside a normal quoted
 * argument, so it is escaped with a caret as well. The escaped quote pair is intentional: a
 * plain `"..."` pair is what node-pty re-creates when it receives an argument array, while
 * `^"...^"` survives as one argument when the complete command line is handed to cmd verbatim.
 */
const CMD_METACHARACTERS = /[\s&|<>^()%!,;=]/;
const CMD_ESCAPABLE = /([&|<>^()%!])/g;

/**
 * cmd.exe has no escape for `"` inside a quoted string, so a value containing one is unquotable.
 * Values that need protection use a caret-escaped quote pair; that pair is removed by cmd while
 * the inner carets protect metacharacters during its expansion pass.
 */
export function quoteCmd(value: string): string {
  if (value.includes('"')) {
    throw new Error(`cmd.exe cannot quote a path containing a double quote: ${value}`);
  }
  return CMD_METACHARACTERS.test(value)
    ? `^"${value.replace(CMD_ESCAPABLE, '^$1')}^"`
    : value;
}

/** The executable is the first token, so it needs ordinary path quoting rather than an argv. */
function quoteCmdCommand(value: string): string {
  if (value.includes('"')) {
    throw new Error(`cmd.exe cannot quote a path containing a double quote: ${value}`);
  }
  return CMD_METACHARACTERS.test(value) ? `"${value}"` : value;
}

/**
 * Build the command line the shell will execute, quoted for that shell's family.
 *
 * PowerShell and POSIX values are quoted **unconditionally**. They used to be quoted only when
 * they matched a metacharacter set, and that set was incomplete — it had no `;`, `$` or
 * backtick, so `--model=a;calc` typed into the profile prompt reached `-Command` as two
 * statements and ran `calc`, and `x$HOME` expanded on the way through. Any such list is a
 * standing invitation to miss a character; quoting everything removes the question. Both
 * families use single-quoted literals, in which nothing but the quote itself is special, so a
 * value that did not need quoting is unchanged by having been quoted.
 */
export function buildCommandLine(command: string, args: string[], family: ShellFamily): string {
  if (family === 'powershell') {
    // `&` is the call operator: without it a quoted string is a value to echo, not a program
    // to run. It is unconditional now because the quoting is.
    return [`& ${quotePowerShell(command)}`, ...args.map(quotePowerShell)].join(' ');
  }
  if (family === 'cmd') {
    return [quoteCmdCommand(command), ...args.map(quoteCmd)].join(' ');
  }
  return [command, ...args].map(quotePosix).join(' ');
}

/** A command that has to be quoted is one that cannot be left bare in any of the families. */
const NEEDS_QUOTING = /[\s'"&|<>^()$;`{}[\],*?~!=%]/;

/**
 * The same line, for `editorDefault`, where it is *typed* into a shell we did not choose.
 *
 * Arguments are quoted exactly as above, because that is the injection surface. The command
 * itself is left bare when it can be — `codex`, the default, needs no quoting — because the
 * quoted PowerShell form `& 'codex'` is a syntax error in cmd.exe, and in this one mode the
 * shell on the other end is whatever the operator's default profile happens to be.
 */
export function buildTypedCommandLine(
  command: string,
  args: string[],
  family: ShellFamily,
): string {
  const quote = family === 'powershell' ? quotePowerShell : quotePosix;
  const head = NEEDS_QUOTING.test(command)
    ? `${family === 'powershell' ? '& ' : ''}${quote(command)}`
    : command;
  return [head, ...args.map(quote)].join(' ');
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

interface ShellResolution {
  path?: string;
  reason?: string;
}

function resolvePwsh(req: LaunchRequest): ShellResolution {
  if (req.platform !== 'win32') {
    return { path: 'pwsh' };
  }
  const available = req.availableShells ?? [];
  const found = PWSH_WINDOWS_CANDIDATES.find((c) => available.includes(c));
  if (found) {
    return { path: found };
  }
  return {
    path: WINDOWS_POWERSHELL,
    reason:
      'PowerShell 7 was not found in Program Files; using Windows PowerShell instead of bare pwsh.exe to avoid the WindowsApps execution alias.',
  };
}

function resolveShell(req: LaunchRequest): ShellResolution {
  switch (req.shell) {
    case 'editorDefault':
      return {};
    case 'custom': {
      const custom = req.customShellPath.trim();
      if (!custom) {
        throw new Error(
          'codexTerminal.shell is "custom" but codexTerminal.customShellPath is empty.',
        );
      }
      return { path: custom };
    }
    case 'pwsh':
      return resolvePwsh(req);
    case 'powershell':
      return { path: req.platform === 'win32' ? WINDOWS_POWERSHELL : 'powershell' };
    case 'cmd':
      return { path: req.platform === 'win32' ? CMD : 'cmd.exe' };
    case 'bash':
      return { path: 'bash' };
    case 'zsh':
      return { path: 'zsh' };
    case 'auto':
    default: {
      if (req.platform !== 'win32') {
        return { path: process.env.SHELL || 'bash' };
      }
      const available = req.availableShells ?? [];
      const pwsh = PWSH_WINDOWS_CANDIDATES.find((c) => available.includes(c));
      if (pwsh) {
        return { path: pwsh };
      }
      // Windows PowerShell ships with the OS, so this always exists as a floor.
      return { path: WINDOWS_POWERSHELL };
    }
  }
}

/** Resolve the configured shell to a concrete executable. */
export function resolveShellPath(req: LaunchRequest): string | undefined {
  return resolveShell(req).path;
}

/** Explain a shell fallback without exposing the internal resolver. */
export function shellResolutionReason(req: LaunchRequest): string | undefined {
  return resolveShell(req).reason;
}

function commandCandidates(command: string, options: Required<CommandResolutionOptions>): string[] {
  const platform = options.platform;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const extensions =
    platform === 'win32'
      ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter(Boolean)
          .map((extension) => extension.toLowerCase())
      : [''];
  const hasPath = platform === 'win32' ? /[\\/]/.test(command) : command.includes('/');
  const isAbsolute = pathApi.isAbsolute(command);

  if (hasPath || isAbsolute) {
    const base = isAbsolute ? command : pathApi.resolve(options.cwd, command);
    if (pathApi.extname(base)) {
      return [base];
    }
    return extensions.map((extension) => `${base}${extension}`);
  }

  return options.pathValue
    .split(platform === 'win32' ? ';' : ':')
    .filter(Boolean)
    .flatMap((directory) => {
      const base = pathApi.join(directory, command);
      return extensions.map((extension) => `${base}${extension}`);
    });
}

/** Resolve a configured Codex command without invoking it. */
export function resolveCommandPath(
  command: string,
  suppliedOptions: CommandResolutionOptions = {},
): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) {
    return undefined;
  }
  const options: Required<CommandResolutionOptions> = {
    platform: suppliedOptions.platform ?? process.platform,
    pathValue: suppliedOptions.pathValue ?? process.env.PATH ?? '',
    cwd: suppliedOptions.cwd ?? process.cwd(),
    fileExists: suppliedOptions.fileExists ?? existsSync,
  };
  return commandCandidates(trimmed, options).find(options.fileExists);
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

  const shell = resolveShell(req);
  const shellPath = shell.path;

  if (shellPath === undefined) {
    // editorDefault: no shell binary of our own, so the command has to be typed.
    return {
      shellPath: undefined,
      shellArgs: [],
      family: req.platform === 'win32' ? 'powershell' : 'posix',
      shellResolutionReason: shell.reason,
      sendTextFallback: buildTypedCommandLine(
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
    return {
      shellPath,
      shellArgs: [...flags, '-Command', commandLine],
      family,
      shellResolutionReason: shell.reason,
    };
  }

  if (family === 'cmd') {
    return {
      shellPath,
      shellArgs: [req.keepShellOpen ? '/K' : '/C', commandLine],
      family,
      shellResolutionReason: shell.reason,
    };
  }

  // POSIX: re-exec an interactive shell so the tab survives Codex exiting.
  const script = req.keepShellOpen
    ? `${commandLine}; exec ${quotePosix(shellPath)} -i`
    : commandLine;
  return { shellPath, shellArgs: ['-c', script], family, shellResolutionReason: shell.reason };
}

/** Codex subcommand for each launch mode the extension exposes. */
export type LaunchMode = 'new' | 'resumeLast' | 'resumePicker' | 'forkLast' | 'forkPicker';

/** Arguments for Codex's non-interactive review command. */
export function reviewArgs(
  target: 'uncommitted' | { base: string } | { commit: string },
): string[] {
  if (target === 'uncommitted') {
    return ['review', '--uncommitted'];
  }
  if ('base' in target) {
    const base = target.base.trim();
    if (!base) {
      throw new Error('Codex review base is empty.');
    }
    return ['review', '--base', base];
  }
  const commit = target.commit.trim();
  if (!commit) {
    throw new Error('Codex review commit is empty.');
  }
  return ['review', '--commit', commit];
}

export function modeArgs(mode: LaunchMode): string[] {
  switch (mode) {
    case 'resumeLast':
      return ['resume', '--last'];
    case 'resumePicker':
      return ['resume'];
    case 'forkLast':
      return ['fork', '--last'];
    // The session id is appended by the caller, giving `codex fork <id>`.
    case 'forkPicker':
      return ['fork'];
    case 'new':
    default:
      return [];
  }
}

/** Arguments for the Codex profile selected by the profile picker. */
export function profileArgs(profile: string): string[] {
  const name = profile.trim();
  if (!name) {
    throw new Error('Codex profile name is empty.');
  }
  return ['--profile', name];
}
