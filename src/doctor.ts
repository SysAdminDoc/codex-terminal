import { execFile } from 'node:child_process';

import {
  buildLaunchPlan,
  resolveCommandPath,
  type LaunchRequest,
  type LaunchPlan,
} from './launcher';
import { partitionTitleItems, titleItemsArgs } from './workbench';
import {
  diagnoseTitle,
  notableChecks,
  parseCodexDoctor,
  type CodexCheck,
  type TitleDiagnosis,
} from './codexDoctor';

export interface DoctorInput {
  request: LaunchRequest;
  cwd?: string;
  statusBarVisible: boolean;
  editorTitleButtonCanRender: boolean;
  /** The configured workbench motion setting; `auto` cannot be resolved by the extension host. */
  reduceMotion?: string;
  /** Title items the extension will launch with, so Codex validates the real override. */
  titleItems?: readonly string[];
  pathValue?: string;
  fileExists?: (candidate: string) => boolean;
  runVersion?: (command: string, platform: NodeJS.Platform) => Promise<string>;
  runDoctorJson?: (
    command: string,
    titleItems: readonly string[],
    platform: NodeJS.Platform,
  ) => Promise<string>;
}

export interface DoctorReport {
  plan: LaunchPlan;
  shellExists: boolean | undefined;
  command: string;
  commandPath: string | undefined;
  version: string;
  cwd: string | undefined;
  statusBarVisible: boolean;
  editorTitleButtonCanRender: boolean;
  reduceMotion: string;
  /** Items rejected against the known vocabulary before Codex is even consulted. */
  unknownTitleItems: string[];
  /** What Codex reports it resolved, absent when its doctor could not be read. */
  title?: TitleDiagnosis;
  codexVersion?: string;
  codexChecks: CodexCheck[];
  /** Why Codex's own doctor could not be read, when it could not. */
  codexDoctorNote?: string;
}

interface Invocation {
  file: string;
  args: string[];
  /**
   * cmd.exe needs its command line handed over untouched. Node's default Windows quoting
   * would re-quote the line we carefully built and hand cmd a path it cannot resolve.
   */
  verbatim?: boolean;
}

export interface CommandResult {
  ok: boolean;
  output: string;
}

function commandInvocation(
  command: string,
  platform: NodeJS.Platform,
  commandArgs: readonly string[],
): Invocation {
  if (platform !== 'win32') {
    return { file: command, args: [...commandArgs] };
  }

  if (/\.(cmd|bat)$/i.test(command)) {
    // Node refuses to execFile a .cmd directly (BatBadBut, CVE-2024-27980), so the shim
    // has to go through cmd.exe. `/s` makes cmd strip exactly the outer quote pair and run
    // the remainder verbatim, which is what lets an argument keep its own quoting.
    const rendered = commandArgs
      .map((argument) => {
        if (argument.includes('"')) {
          throw new Error(`cmd.exe cannot quote an argument containing a double quote: ${argument}`);
        }
        return /[\s&|<>^]/.test(argument) ? `"${argument}"` : argument;
      })
      .join(' ');
    return {
      file: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `""${command}" ${rendered}"`.trim()],
      verbatim: true,
    };
  }

  if (/\.ps1$/i.test(command)) {
    const escaped = command.replace(/'/g, "''");
    const rendered = commandArgs.map((argument) => `'${argument.replace(/'/g, "''")}'`).join(' ');
    return {
      file: process.env.SystemRoot
        ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
        : 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', `& '${escaped}' ${rendered}`.trim()],
    };
  }

  return { file: command, args: [...commandArgs] };
}

/** Run a Codex probe without opening a console window on Windows. */
export function runCommandResult(
  command: string,
  commandArgs: readonly string[],
  platform: NodeJS.Platform = process.platform,
  maxBuffer = 16 * 1024,
  timeoutMs = 5000,
): Promise<CommandResult> {
  let invocation: Invocation;
  try {
    invocation = commandInvocation(command, platform, commandArgs);
  } catch (error) {
    return Promise.resolve({
      ok: false,
      output: error instanceof Error ? error.message : String(error),
    });
  }
  return new Promise((resolve) => {
    execFile(
      invocation.file,
      invocation.args,
      {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer,
        ...(invocation.verbatim ? { windowsVerbatimArguments: true } : {}),
      },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim();
        if (error) {
          resolve({ ok: false, output: output || error.message });
          return;
        }
        resolve({ ok: true, output: output || '<no output>' });
      },
    );
  });
}

/** Run a Codex probe, retaining whether the process actually exited successfully. */
export function runCommand(
  command: string,
  commandArgs: readonly string[],
  platform: NodeJS.Platform = process.platform,
  maxBuffer = 16 * 1024,
  timeoutMs = 5000,
): Promise<string> {
  return runCommandResult(command, commandArgs, platform, maxBuffer, timeoutMs).then(
    (result) => result.output,
  );
}

export function runCommandVersion(
  command: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  return runCommand(command, ['--version'], platform);
}

/**
 * `codex doctor` walks the whole rollout store before answering — measured at 38s against
 * 121 files / 2.01 GB on 2026-08-10, and that grows with the store. The version probe's 5s
 * budget kills it silently, so this gets its own, far longer one, and callers are expected
 * to show progress rather than block a command handler invisibly.
 */
export const CODEX_DOCTOR_TIMEOUT_MS = 90_000;

/**
 * Ask Codex what it resolved, passing the *same* title override the extension launches
 * with, so the answer describes the real launch rather than the user's ambient config.
 */
export function runCodexDoctorJson(
  command: string,
  titleItems: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const args = ['doctor', '--json', ...titleItemsArgs(titleItems)];
  return runCommand(command, args, platform, 4 * 1024 * 1024, CODEX_DOCTOR_TIMEOUT_MS);
}

/** Build the complete diagnostic report without any VS Code API dependencies. */
export async function collectDoctorReport(input: DoctorInput): Promise<DoctorReport> {
  const plan = buildLaunchPlan(input.request);
  const pathValue = input.pathValue ?? process.env.PATH ?? '';
  const resolveOptions = {
    platform: input.request.platform,
    pathValue,
    fileExists: input.fileExists,
  };
  const shellPath = plan.shellPath;
  const shellResolved = shellPath
    ? resolveCommandPath(shellPath, resolveOptions)
    : undefined;
  const commandPath = resolveCommandPath(input.request.command, resolveOptions);
  const version = commandPath
    ? await (input.runVersion ?? runCommandVersion)(commandPath, input.request.platform)
    : '';
  const shellExists = shellPath ? shellResolved !== undefined : undefined;

  const titleItems = input.titleItems ?? [];
  const { unknown } = partitionTitleItems(titleItems);
  const reduceMotion = input.reduceMotion ?? 'auto';

  // Only worth asking Codex when there is a Codex to ask; a missing command already has a
  // dedicated error path and a failed probe would add noise, not information.
  let title: TitleDiagnosis | undefined;
  let codexVersion: string | undefined;
  let codexChecks: CodexCheck[] = [];
  let codexDoctorNote: string | undefined;
  if (commandPath) {
    const raw = await (input.runDoctorJson ?? runCodexDoctorJson)(
      commandPath,
      titleItems,
      input.request.platform,
    );
    const report = parseCodexDoctor(raw);
    if (report) {
      title = diagnoseTitle(report);
      codexVersion = report.codexVersion;
      codexChecks = notableChecks(report);
    } else {
      // Reporting nothing here reads as "Codex is fine", which is exactly the silent
      // failure this whole check exists to eliminate.
      codexDoctorNote = raw.split('\n')[0]?.slice(0, 200) || 'no output';
    }
  }

  return {
    plan,
    shellExists,
    command: input.request.command,
    commandPath,
    version,
    cwd: input.cwd,
    statusBarVisible: input.statusBarVisible,
    editorTitleButtonCanRender: input.editorTitleButtonCanRender,
    reduceMotion,
    unknownTitleItems: unknown,
    ...(title ? { title } : {}),
    ...(codexVersion ? { codexVersion } : {}),
    codexChecks,
    ...(codexDoctorNote ? { codexDoctorNote } : {}),
  };
}
