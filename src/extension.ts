import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import {
  buildLaunchPlan,
  modeArgs,
  type LaunchMode,
  type LaunchRequest,
  type ShellKind,
} from './launcher';
import { buildFileReference } from './reference';
import { ActionsViewProvider } from './actionsView';

const PWSH_PROBE = [
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
];

let log: vscode.LogOutputChannel;
/** Terminals this extension created, newest last. Pruned as they close. */
const owned: vscode.Terminal[] = [];

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('codexTerminal');
}

function readLaunchRequest(mode: LaunchMode): LaunchRequest {
  const cfg = config();
  return {
    shell: cfg.get<ShellKind>('shell', 'auto'),
    customShellPath: cfg.get<string>('customShellPath', ''),
    command: cfg.get<string>('command', 'codex'),
    args: [...modeArgs(mode), ...cfg.get<string[]>('args', [])],
    keepShellOpen: cfg.get<boolean>('keepShellOpen', true),
    platform: process.platform,
    availableShells: PWSH_PROBE.filter((p) => existsSync(p)),
  };
}

function resolveCwd(): string | undefined {
  const mode = config().get<string>('cwd', 'activeFileWorkspaceFolder');
  const folders = vscode.workspace.workspaceFolders;
  const activeUri = vscode.window.activeTextEditor?.document.uri;

  if (mode === 'activeFileFolder' && activeUri?.scheme === 'file') {
    return path.dirname(activeUri.fsPath);
  }
  if (mode === 'activeFileWorkspaceFolder' && activeUri) {
    const folder = vscode.workspace.getWorkspaceFolder(activeUri);
    if (folder) {
      return folder.uri.fsPath;
    }
  }
  return folders?.[0]?.uri.fsPath;
}

function resolveLocation(): vscode.TerminalOptions['location'] {
  switch (config().get<string>('location', 'editor')) {
    case 'panel':
      return vscode.TerminalLocation.Panel;
    case 'editorBeside':
      return { viewColumn: vscode.ViewColumn.Beside };
    case 'editor':
    default:
      return { viewColumn: vscode.ViewColumn.Active };
  }
}

function iconColor(): vscode.ThemeColor | undefined {
  const id = config().get<string>('iconColor', 'terminal.ansiMagenta').trim();
  return id ? new vscode.ThemeColor(id) : undefined;
}

/** Shared between the commands and the contributed terminal profile. */
function terminalOptions(
  mode: LaunchMode,
  withLocation: boolean,
): { options: vscode.TerminalOptions; plan: ReturnType<typeof buildLaunchPlan> } {
  const plan = buildLaunchPlan(readLaunchRequest(mode));
  const cfg = config();
  const options: vscode.TerminalOptions = {
    name: cfg.get<string>('terminalName', 'Codex'),
    cwd: resolveCwd(),
    env: cfg.get<Record<string, string>>('env', {}),
    iconPath: new vscode.ThemeIcon('sparkle'),
    color: iconColor(),
    isTransient: false,
  };
  if (withLocation) {
    options.location = resolveLocation();
  }
  if (plan.shellPath) {
    options.shellPath = plan.shellPath;
    options.shellArgs = plan.shellArgs;
  }
  log.info(
    `launch mode=${mode} shell=${plan.shellPath ?? '<editor default>'} ` +
      `args=${JSON.stringify(plan.shellArgs)} cwd=${options.cwd ?? '<none>'}` +
      (plan.sendTextFallback ? ` sendText=${JSON.stringify(plan.sendTextFallback)}` : ''),
  );
  return { options, plan };
}

function liveOwnedTerminal(): vscode.Terminal | undefined {
  for (let i = owned.length - 1; i >= 0; i -= 1) {
    if (owned[i].exitStatus === undefined) {
      return owned[i];
    }
  }
  return undefined;
}

function launch(mode: LaunchMode): void {
  try {
    if (mode === 'new' && config().get<boolean>('reuseTerminal', false)) {
      const existing = liveOwnedTerminal();
      if (existing) {
        existing.show(false);
        return;
      }
    }

    const { options, plan } = terminalOptions(mode, true);
    const terminal = vscode.window.createTerminal(options);
    owned.push(terminal);
    terminal.show(false);

    if (plan.sendTextFallback) {
      // editorDefault only: no shell of our own to hand arguments to.
      terminal.sendText(plan.sendTextFallback, true);
    }
  } catch (error) {
    reportError(error, 'Could not start Codex');
  }
}

function reportError(error: unknown, headline: string): void {
  const message = error instanceof Error ? error.message : String(error);
  log.error(`${headline}: ${message}`);
  void vscode.window
    .showErrorMessage(`${headline}: ${message}`, 'Show Log')
    .then((choice) => {
      if (choice === 'Show Log') {
        log.show(true);
      }
    });
}

function sendFileReference(): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage('Codex Terminal: no active editor to reference.');
    return;
  }
  const terminal = liveOwnedTerminal() ?? vscode.window.activeTerminal;
  if (!terminal) {
    void vscode.window.showWarningMessage('Codex Terminal: no terminal to send the reference to.');
    return;
  }

  const uri = editor.document.uri;
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const relativePath = folder ? path.relative(folder.uri.fsPath, uri.fsPath) : uri.fsPath;
  const selection = editor.selection;
  const reference = buildFileReference({
    relativePath,
    selection: selection.isEmpty
      ? undefined
      : { startLine: selection.start.line, endLine: selection.end.line },
  });

  terminal.show(false);
  // `false` leaves the reference on the prompt so a question can be typed after it.
  terminal.sendText(`${reference} `, false);
  log.info(`sent reference ${reference}`);
}

function createStatusBarItem(context: vscode.ExtensionContext): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = 'codexTerminal.new';
  item.text = '$(sparkle) Codex';
  item.tooltip = 'Open Codex CLI in a terminal';
  context.subscriptions.push(item);

  const sync = (): void => {
    if (config().get<boolean>('showStatusBarItem', true)) {
      item.show();
    } else {
      item.hide();
    }
  };
  sync();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('codexTerminal.showStatusBarItem')) {
        sync();
      }
    }),
  );
}

export function activate(context: vscode.ExtensionContext): void {
  log = vscode.window.createOutputChannel('Codex Terminal', { log: true });
  context.subscriptions.push(log);

  const commands: Array<[string, () => void]> = [
    ['codexTerminal.new', () => launch('new')],
    ['codexTerminal.resumeLast', () => launch('resumeLast')],
    ['codexTerminal.resumePicker', () => launch('resumePicker')],
    ['codexTerminal.forkLast', () => launch('forkLast')],
    ['codexTerminal.sendFileReference', sendFileReference],
    ['codexTerminal.showLog', () => log.show(true)],
    [
      'codexTerminal.focus',
      () => {
        const terminal = liveOwnedTerminal();
        if (terminal) {
          terminal.show(false);
        } else {
          launch('new');
        }
      },
    ],
  ];
  for (const [id, handler] of commands) {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  }

  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider('codexTerminal.profile', {
      provideTerminalProfile: () => {
        // The terminal service owns placement for a profile launch, so no location.
        return new vscode.TerminalProfile(terminalOptions('new', false).options);
      },
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((closed) => {
      const index = owned.indexOf(closed);
      if (index !== -1) {
        owned.splice(index, 1);
      }
    }),
  );

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('codexTerminal.actions', new ActionsViewProvider()),
  );

  createStatusBarItem(context);

  // Worth logging: with `workbench.statusBar.visible: false` the status bar item is created
  // successfully and is simply never rendered, with no error anywhere to explain it.
  const statusBarVisible = vscode.workspace
    .getConfiguration('workbench')
    .get<boolean>('statusBar.visible', true);
  log.info(
    `Codex Terminal activated (workbench.statusBar.visible=${statusBarVisible}` +
      `${statusBarVisible ? '' : ' — status bar button cannot render; use the activity bar'})`,
  );
}

export function deactivate(): void {
  owned.length = 0;
}
