import { existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import {
  buildLaunchPlan,
  modeArgs,
  profileArgs,
  resolveCommandPath,
  type LaunchMode,
  type LaunchRequest,
  type ShellKind,
} from './launcher';
import { buildFileReference } from './reference';
import { ActionsViewProvider } from './actionsView';
import { TerminalRegistry } from './terminals';
import { collectDoctorReport } from './doctor';
import { codexProfilesDirectory, profileNamesFromFiles } from './profiles';
import { NotifyBridge } from './notify';
import { discoverSessions, type SessionRecord } from './sessions';
import { strings } from './strings';

const PWSH_PROBE = [
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
];
const CODEX_INSTALL_URL = 'https://github.com/openai/codex#installation';

let log: vscode.LogOutputChannel;
let terminalRegistry: TerminalRegistry | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
let notifyBridge: NotifyBridge | undefined;

export interface CodexTerminalExtensionApi {
  getActionCount: () => number;
  getTerminalProfileOptions: () => Promise<vscode.TerminalOptions | undefined>;
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('codexTerminal');
}

async function syncNotifyBridge(): Promise<void> {
  const enabled = config().get<boolean>('notifyOnCompletion', false);
  if (!enabled) {
    notifyBridge?.dispose();
    notifyBridge = undefined;
    return;
  }
  if (notifyBridge || !extensionContext) {
    return;
  }

  const workspaceName =
    vscode.workspace.name ?? vscode.workspace.workspaceFolders?.[0]?.name ?? 'workspace';
  const bridge = new NotifyBridge({
    directory: path.join(extensionContext.globalStorageUri.fsPath, 'notify'),
    executable: process.execPath,
    workspaceName,
    onTurnEnded: (event) => {
      void vscode.window.showInformationMessage(strings.notifications.turnCompleted(event.workspace));
    },
  });
  try {
    await bridge.start();
    notifyBridge = bridge;
    log.info(strings.notifications.notificationsEnabled(workspaceName));
  } catch (error) {
    bridge.dispose();
    const message = error instanceof Error ? error.message : String(error);
    log.error(strings.notifications.enableFailed(message));
  }
}

function readLaunchRequest(mode: LaunchMode, profile?: string, sessionId?: string): LaunchRequest {
  const cfg = config();
  return {
    shell: cfg.get<ShellKind>('shell', 'auto'),
    customShellPath: cfg.get<string>('customShellPath', ''),
    command: cfg.get<string>('command', 'codex'),
    args: [
      ...modeArgs(mode),
      ...(sessionId ? [sessionId] : []),
      ...(profile ? profileArgs(profile) : []),
      ...cfg.get<string[]>('args', []),
      ...(notifyBridge?.launchArgs() ?? []),
    ],
    keepShellOpen: cfg.get<boolean>('keepShellOpen', true),
    platform: process.platform,
    availableShells: PWSH_PROBE.filter((p) => existsSync(p)),
  };
}

async function resolveCwd(): Promise<string | undefined> {
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
  if (mode === 'prompt' && folders && folders.length > 1) {
    const selected = await vscode.window.showQuickPick(
      folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
      {
        placeHolder: strings.folders.prompt(),
        ignoreFocusOut: true,
      },
    );
    return selected?.folder.uri.fsPath;
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
async function terminalOptions(
  mode: LaunchMode,
  withLocation: boolean,
  profile?: string,
  sessionId?: string,
): Promise<{ options: vscode.TerminalOptions; plan: ReturnType<typeof buildLaunchPlan> }> {
  const plan = buildLaunchPlan(readLaunchRequest(mode, profile, sessionId));
  const cfg = config();
  const baseName = cfg.get<string>('terminalName', 'Codex');
  const options: vscode.TerminalOptions = {
    name: [baseName, profile, sessionId ? `resume ${sessionId.slice(0, 8)}` : undefined]
      .filter(Boolean)
      .join(' — '),
    cwd: await resolveCwd(),
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
    strings.logs.launch(
      mode,
      plan.shellPath ?? '<editor default>',
      JSON.stringify(plan.shellArgs),
      String(options.cwd ?? '<none>'),
      plan.sendTextFallback ? JSON.stringify(plan.sendTextFallback) : '',
    ),
  );
  if (plan.shellResolutionReason) {
    log.info(strings.logs.shellResolution(plan.shellResolutionReason));
  }
  return { options, plan };
}

function preflightCodexCommand(command: string): string | undefined {
  const resolved = resolveCommandPath(command, {
    platform: process.platform,
    pathValue: process.env.PATH,
    cwd: process.cwd(),
  });
  if (resolved) {
    log.info(strings.logs.commandPreflightPassed(JSON.stringify(command), resolved));
    return resolved;
  }

  const message = strings.errors.missingCommand(command);
  log.error(message);
  void vscode.window
    .showErrorMessage(message, strings.errors.showLog(), strings.errors.install())
    .then((choice) => {
      if (choice === strings.errors.showLog()) {
        log.show(true);
      } else if (choice === strings.errors.install()) {
        void vscode.env.openExternal(vscode.Uri.parse(CODEX_INSTALL_URL));
      }
    });
  return undefined;
}

function liveOwnedTerminal(): vscode.Terminal | undefined {
  return terminalRegistry?.mostRecentLive()?.terminal;
}

async function launch(mode: LaunchMode, profile?: string, sessionId?: string): Promise<void> {
  try {
    await syncNotifyBridge();
    if (mode === 'new' && !profile && config().get<boolean>('reuseTerminal', false)) {
      const existing = liveOwnedTerminal();
      if (existing) {
        existing.show(false);
        return;
      }
    }

    const request = readLaunchRequest(mode, profile, sessionId);
    if (!preflightCodexCommand(request.command)) {
      return;
    }

    const { options, plan } = await terminalOptions(mode, true, profile, sessionId);
    const terminal = vscode.window.createTerminal(options);
    terminalRegistry?.track(
      terminal,
      typeof options.cwd === 'string' ? options.cwd : options.cwd?.fsPath,
    );
    terminal.show(false);

    if (plan.sendTextFallback) {
      // editorDefault only: no shell of our own to hand arguments to.
      terminal.sendText(plan.sendTextFallback, true);
    }
  } catch (error) {
    reportError(error, strings.errors.couldNotStart());
  }
}

function discoveredProfiles(): string[] {
  try {
    return profileNamesFromFiles(
      readdirSync(codexProfilesDirectory(), { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name),
    );
  } catch {
    return [];
  }
}

async function launchWithProfile(): Promise<void> {
  const freeTextItem: vscode.QuickPickItem = {
    label: strings.profiles.freeText(),
    description: strings.profiles.freeTextDescription(),
  };
  const items: vscode.QuickPickItem[] = [
    ...discoveredProfiles().map((name) => ({
      label: name,
      description: strings.profiles.argument(name),
    })),
    freeTextItem,
  ];
  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: strings.profiles.prompt(),
    ignoreFocusOut: true,
  });
  if (!selected) {
    return;
  }
  const profile =
    selected === freeTextItem
      ? await vscode.window.showInputBox({
          prompt: strings.profiles.inputPrompt(),
          placeHolder: strings.profiles.inputPlaceholder(),
          ignoreFocusOut: true,
        })
      : selected.label;
  if (!profile?.trim()) {
    return;
  }
  launch('new', profile.trim());
}

async function resumeFromSessionPicker(): Promise<void> {
  const sessions = await discoverSessions();
  if (sessions.length === 0) {
    launch('resumePicker');
    return;
  }

  const items = sessions.map((session: SessionRecord) => ({
    label: strings.sessions.resumeLabel(
      new Date(session.timestamp).toLocaleString(),
      session.id.slice(0, 8),
    ),
    description: session.cwd,
    detail: session.timestamp,
    session,
  }));
  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: strings.sessions.prompt(),
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
  if (selected) {
    launch('resumePicker', undefined, selected.session.id);
  }
}

function reportError(error: unknown, headline: string): void {
  const message = error instanceof Error ? error.message : String(error);
  const report = strings.errors.withDetail(headline, message);
  log.error(report);
  void vscode.window
    .showErrorMessage(report, strings.errors.showLog())
    .then((choice) => {
      if (choice === strings.errors.showLog()) {
        log.show(true);
      }
    });
}

async function runDoctor(): Promise<void> {
  try {
    const request = readLaunchRequest('new');
    const statusBarVisible = vscode.workspace
      .getConfiguration('workbench')
      .get<boolean>('statusBar.visible', true);
    const editorTitleButtonCanRender =
      config().get<boolean>('showEditorTitleButton', true) &&
      vscode.window.activeTextEditor !== undefined;
    const report = await collectDoctorReport({
      request,
      cwd: await resolveCwd(),
      statusBarVisible,
      editorTitleButtonCanRender,
    });
    const text = strings.doctor.report(report);
    log.info(text);
    const choice = await vscode.window.showInformationMessage(text, strings.errors.showLog());
    if (choice === strings.errors.showLog()) {
      log.show(true);
    }
  } catch (error) {
    reportError(error, strings.errors.couldNotRunDoctor());
  }
}

function sendFileReference(): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage(strings.warnings.noEditor());
    return;
  }
  const terminal = liveOwnedTerminal() ?? vscode.window.activeTerminal;
  if (!terminal) {
    void vscode.window.showWarningMessage(strings.warnings.noTerminal());
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
  log.info(strings.logs.sentReference(reference));
}

function focusSession(terminal: vscode.Terminal | undefined): void {
  if (terminal && terminal.exitStatus === undefined) {
    terminal.show(false);
  }
}

function stopSession(terminal: vscode.Terminal | undefined): void {
  terminal?.dispose();
}

function createStatusBarItem(context: vscode.ExtensionContext): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = 'codexTerminal.new';
  item.text = strings.status.text();
  item.tooltip = strings.status.tooltip();
  item.accessibilityInformation = {
    label: strings.status.accessibility(),
    role: 'button',
  };
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

export function activate(context: vscode.ExtensionContext): CodexTerminalExtensionApi {
  log = vscode.window.createOutputChannel('Codex Terminal', { log: true });
  context.subscriptions.push(log);
  extensionContext = context;
  terminalRegistry = new TerminalRegistry();
  const adopted = terminalRegistry.adopt(
    vscode.window.terminals,
    config().get<string>('terminalName', 'Codex'),
  );
  if (adopted > 0) {
    log.info(strings.logs.adopted(adopted));
  }

  const commands: Array<[string, () => void]> = [
    ['codexTerminal.new', () => launch('new')],
    ['codexTerminal.resumeLast', () => launch('resumeLast')],
    [
      'codexTerminal.resumePicker',
      () => {
        void resumeFromSessionPicker();
      },
    ],
    ['codexTerminal.forkLast', () => launch('forkLast')],
    [
      'codexTerminal.newWithProfile',
      () => {
        void launchWithProfile();
      },
    ],
    ['codexTerminal.sendFileReference', sendFileReference],
    [
      'codexTerminal.doctor',
      () => {
        void runDoctor();
      },
    ],
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
    vscode.commands.registerCommand('codexTerminal.focusSession', focusSession),
    vscode.commands.registerCommand('codexTerminal.stopSession', stopSession),
  );

  const provideTerminalProfile = async (): Promise<vscode.TerminalProfile | undefined> => {
    // The terminal service owns placement for a profile launch, so no location.
    await syncNotifyBridge();
    const request = readLaunchRequest('new');
    if (!preflightCodexCommand(request.command)) {
      return undefined;
    }
    const { options } = await terminalOptions('new', false);
    return new vscode.TerminalProfile(options);
  };
  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider('codexTerminal.profile', {
      provideTerminalProfile,
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((closed) => {
      terminalRegistry?.remove(closed);
    }),
  );

  const actionsProvider = new ActionsViewProvider(terminalRegistry);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('codexTerminal.actions', actionsProvider),
    actionsProvider,
  );

  createStatusBarItem(context);

  // Worth logging: with `workbench.statusBar.visible: false` the status bar item is created
  // successfully and is simply never rendered, with no error anywhere to explain it.
  const statusBarVisible = vscode.workspace
    .getConfiguration('workbench')
    .get<boolean>('statusBar.visible', true);
  log.info(
    strings.logs.activation(statusBarVisible),
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('codexTerminal.notifyOnCompletion')) {
        void syncNotifyBridge();
      }
    }),
    {
      dispose: () => {
        notifyBridge?.dispose();
        notifyBridge = undefined;
        extensionContext = undefined;
      },
    },
  );
  void syncNotifyBridge();

  return {
    getActionCount: () => actionsProvider.getChildren().length,
    getTerminalProfileOptions: async () => (await provideTerminalProfile())?.options,
  };
}

export function deactivate(): void {
  notifyBridge?.dispose();
  notifyBridge = undefined;
  extensionContext = undefined;
  terminalRegistry?.dispose();
  terminalRegistry = undefined;
}
