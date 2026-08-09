import { execFile } from 'node:child_process';

import {
  buildLaunchPlan,
  resolveCommandPath,
  type LaunchRequest,
  type LaunchPlan,
} from './launcher';

export interface DoctorInput {
  request: LaunchRequest;
  cwd?: string;
  statusBarVisible: boolean;
  editorTitleButtonCanRender: boolean;
  pathValue?: string;
  fileExists?: (candidate: string) => boolean;
  runVersion?: (command: string, platform: NodeJS.Platform) => Promise<string>;
}

export interface DoctorReport {
  text: string;
  plan: LaunchPlan;
  shellExists: boolean | undefined;
  commandPath: string | undefined;
  version: string;
}

function commandInvocation(command: string, platform: NodeJS.Platform): {
  file: string;
  args: string[];
} {
  if (platform !== 'win32') {
    return { file: command, args: ['--version'] };
  }

  if (/\.(cmd|bat)$/i.test(command)) {
    const escaped = command.replace(/"/g, '""');
    return {
      file: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${escaped}" --version`],
    };
  }

  if (/\.ps1$/i.test(command)) {
    const escaped = command.replace(/'/g, "''");
    return {
      file: process.env.SystemRoot
        ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
        : 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', `& '${escaped}' --version`],
    };
  }

  return { file: command, args: ['--version'] };
}

/** Run a version probe without opening a console window on Windows. */
export function runCommandVersion(
  command: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const invocation = commandInvocation(command, platform);
  return new Promise((resolve) => {
    execFile(
      invocation.file,
      invocation.args,
      {
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 16 * 1024,
      },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim();
        if (error) {
          resolve(output || error.message);
          return;
        }
        resolve(output || '<no output>');
      },
    );
  });
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
    : 'not run (command not found)';
  const shellExists = shellPath ? shellResolved !== undefined : undefined;
  const text = [
    'Codex Terminal Doctor',
    `shell: ${shellPath ?? '<editor default>'}`,
    `shell exists: ${shellExists === undefined ? 'n/a' : shellExists}`,
    `Codex command: ${input.request.command}`,
    `resolved Codex command: ${commandPath ?? '<not found>'}`,
    `Codex --version: ${version}`,
    `cwd: ${input.cwd ?? '<none>'}`,
    `workbench.statusBar.visible: ${input.statusBarVisible}`,
    `editor-title button can render: ${input.editorTitleButtonCanRender}`,
    ...(plan.shellResolutionReason ? [`shell resolution: ${plan.shellResolutionReason}`] : []),
  ].join('\n');

  return { text, plan, shellExists, commandPath, version };
}
