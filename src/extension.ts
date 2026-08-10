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
import { collectDoctorReport, runCommand } from './doctor';
import { codexProfilesDirectory, profileNamesFromFiles } from './profiles';
import { NotifyBridge } from './notify';
import { SessionMonitor } from './monitor';
import { JournalStore, interruptedSessions, type JournalSession } from './journal';
import {
  DEFAULT_STALL_SECONDS,
  motionAllowed,
  peakContextUsed,
  statusBarText,
} from './present';
import {
  codexHomeDirectory,
  codexSessionsDirectory,
  discoverSessions,
  exportTranscript,
  sessionProject,
  type SessionRecord,
} from './sessions';
import { strings } from './strings';
import { migrateSettings, type MigrationTarget } from './migrate';
import {
  DEFAULT_TERMINAL_NAME_TEMPLATE,
  DEFAULT_TITLE_ITEMS,
  OWNERSHIP_ENV_VAR,
  projectName,
  renderTerminalName,
  type TabTitleMode,
} from './naming';
import {
  AGENT_CLI_TITLE_SETTING,
  CONFIRM_ON_KILL_SETTING,
  KNOWN_TITLE_ITEMS,
  partitionTitleItems,
  planAgentCliTitle,
  planConfirmOnKill,
  planTabDescription,
  titleItemsArgs,
} from './workbench';
import { HistoryViewProvider, isRecoveryNode, isSessionNode } from './historyView';

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
let historyViewProvider: HistoryViewProvider | undefined;
let sessionMonitor: SessionMonitor | undefined;

export interface CodexTerminalExtensionApi {
  getActionCount: () => number;
  getTerminalProfileOptions: () => Promise<vscode.TerminalOptions | undefined>;
}

/**
 * `TerminalOptions.titleTemplate` is deliberately NOT used.
 *
 * It is not in the stable typings, and the host discards it unless the extension has the
 * `terminalTitle` **proposed** API — which cannot ship to a marketplace. Passing it anyway
 * bought nothing and logged
 * "`titleTemplate` was provided to window.createTerminal but is ignored because the
 * `terminalTitle` proposed API is not enabled" on every single launch (observed in the
 * integration host, 2026-08-10).
 *
 * What actually makes the tab live is leaving `name` unset — that is the branch on which
 * VS Code subscribes to the process title at all — combined with `${sequence}` in
 * `terminal.integrated.tabs.description`, which `applyWorkbenchPreferences` ensures.
 */

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('codexTerminal');
}

/** Honour the editor's reduced-motion preference for the animated indicators. */
function animationAllowed(): boolean {
  return motionAllowed(
    vscode.workspace.getConfiguration('workbench').get<string>('reduceMotion', 'auto'),
  );
}

function tabTitleMode(): TabTitleMode {
  return config().get<TabTitleMode>('tabTitle', 'live') === 'static' ? 'static' : 'live';
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
      historyViewProvider?.refresh();
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
  const titleItems = cfg.get<string[]>('titleItems', [...DEFAULT_TITLE_ITEMS]);
  // Codex drops identifiers it does not recognise without complaining, so an unknown item
  // silently costs the user part of their tab title. Say so once, at launch.
  const { unknown } = partitionTitleItems(titleItems);
  if (unknown.length > 0) {
    log.warn(strings.logs.unknownTitleItems(unknown.join(', '), KNOWN_TITLE_ITEMS.join(', ')));
  }
  return {
    shell: cfg.get<ShellKind>('shell', 'auto'),
    customShellPath: cfg.get<string>('customShellPath', ''),
    command: cfg.get<string>('command', 'codex'),
    args: [
      ...modeArgs(mode),
      ...(sessionId ? [sessionId] : []),
      ...(profile ? profileArgs(profile) : []),
      ...cfg.get<string[]>('args', []),
      // Codex writes this title through OSC sequences. The activity item is a live
      // spinner while it is working and the project item is derived from the repo root.
      ...titleItemsArgs(titleItems),
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

interface LaunchOptions {
  mode: LaunchMode;
  profile?: string;
  sessionId?: string;
  /** Overrides the resolved workspace cwd, so a saved chat resumes where it was written. */
  cwd?: string;
}

/** Shared between the commands and the contributed terminal profile. */
async function terminalOptions(
  request: LaunchOptions,
  withLocation: boolean,
): Promise<{
  options: vscode.TerminalOptions;
  plan: ReturnType<typeof buildLaunchPlan>;
  cwd?: string;
  project: string;
  label: string;
}> {
  const { mode, profile, sessionId } = request;
  const plan = buildLaunchPlan(readLaunchRequest(mode, profile, sessionId));
  const cfg = config();
  const baseName = cfg.get<string>('terminalName', 'Codex');
  const cwd = request.cwd ?? (await resolveCwd());
  const workspaceFolder = cwd
    ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd))?.name
    : undefined;
  const nameContext = { name: baseName, cwd, workspaceFolder, mode, profile, sessionId };
  const label = renderTerminalName(DEFAULT_TERMINAL_NAME_TEMPLATE, nameContext);

  const options: vscode.TerminalOptions = {
    cwd,
    env: { ...cfg.get<Record<string, string>>('env', {}), [OWNERSHIP_ENV_VAR]: '1' },
    iconPath: new vscode.ThemeIcon('sparkle'),
    color: iconColor(),
    isTransient: false,
  };

  // Only `static` names the terminal. Naming it is what stops the workbench subscribing to
  // the process title, so `live` says nothing at all and lets Codex own the tab text.
  if (tabTitleMode() === 'static') {
    options.name = label;
  }

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
  return { options, plan, cwd, project: projectName(nameContext), label };
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
  const live = sessionMonitor?.live() ?? [];
  return live.length > 0 ? live[live.length - 1].terminal : undefined;
}

async function launch(request: LaunchOptions): Promise<void> {
  try {
    await syncNotifyBridge();
    if (
      request.mode === 'new' &&
      !request.profile &&
      config().get<boolean>('reuseTerminal', false)
    ) {
      const existing = liveOwnedTerminal();
      if (existing) {
        existing.show(false);
        return;
      }
    }

    const launchRequest = readLaunchRequest(request.mode, request.profile, request.sessionId);
    if (!preflightCodexCommand(launchRequest.command)) {
      return;
    }

    const { options, plan, cwd, project, label } = await terminalOptions(request, true);
    const terminal = vscode.window.createTerminal(options);
    if (cwd) {
      sessionMonitor?.track(terminal, {
        cwd,
        project,
        label,
        mode: request.mode,
        profile: request.profile,
        sessionId: request.sessionId,
      });
    }
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
  void launch({ mode: 'new', profile: profile.trim() });
}

async function resumeFromSessionPicker(): Promise<void> {
  const sessions = await discoverSessions({ homeDirectory: codexHomeDirectory() });
  if (sessions.length === 0) {
    void launch({ mode: 'resumePicker' });
    return;
  }

  const items = sessions.map((session: SessionRecord) => ({
    label: session.preview || strings.history.noPrompt(),
    description: sessionProject(session),
    detail: strings.sessions.resumeLabel(
      new Date(session.timestamp).toLocaleString(),
      session.id.slice(0, 8),
    ),
    session,
  }));
  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: strings.sessions.prompt(),
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
  if (selected) {
    void launch({
      mode: 'resumePicker',
      sessionId: selected.session.id,
      cwd: selected.session.cwd || undefined,
    });
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
    const cwd = await resolveCwd();
    const titleItems = config().get<string[]>('titleItems', [...DEFAULT_TITLE_ITEMS]);
    // `codex doctor` walks the whole rollout store; 38s against 2 GB is normal and grows.
    // Without progress this looks like a command that did nothing.
    const report = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: strings.doctor.running() },
      () =>
        collectDoctorReport({
          request,
          cwd,
          statusBarVisible,
          editorTitleButtonCanRender,
          titleItems,
        }),
    );
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

function settingText(value: unknown): string {
  return value === undefined ? strings.workbench.unset() : JSON.stringify(value);
}

/**
 * The terminal API has no per-terminal close-confirmation switch. These settings are the
 * editor's supported controls for the requested behaviour and for Codex's live OSC title:
 * `${sequence}` in the tab description is what surfaces that title on hosts that ignore
 * the per-terminal template, and it is the reason a working tab shows Codex's spinner.
 */
async function applyWorkbenchPreferences(): Promise<void> {
  const root = vscode.workspace.getConfiguration();
  const changes: Array<{ key: string; value: unknown }> = [];
  const confirmOnKill = planConfirmOnKill(root.get<string>(CONFIRM_ON_KILL_SETTING, 'editor'));
  if (confirmOnKill) {
    changes.push({ key: confirmOnKill.key, value: confirmOnKill.to });
  }
  const agentCliTitle = planAgentCliTitle(
    root.get<boolean>(AGENT_CLI_TITLE_SETTING, true),
  );
  if (agentCliTitle) {
    changes.push({ key: agentCliTitle.key, value: agentCliTitle.to });
  }
  if (tabTitleMode() === 'live') {
    const description = planTabDescription(
      root.get<string>('terminal.integrated.tabs.description'),
    );
    if (description) {
      changes.push({ key: description.key, value: description.to });
    }
  }

  for (const change of changes) {
    const before = root.get<unknown>(change.key);
    try {
      await root.update(change.key, change.value, vscode.ConfigurationTarget.Global);
      log.info(strings.workbench.applied(change.key, settingText(before), settingText(change.value)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(strings.workbench.failed(change.key, message));
    }
  }
}

async function openTranscript(node: unknown): Promise<void> {
  if (!isSessionNode(node)) {
    return;
  }
  try {
    const result = await exportTranscript(node.session.filePath, node.project);
    const document = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: result.markdown,
    });
    await vscode.window.showTextDocument(document, { preview: true });
    if (result.truncated) {
      void vscode.window.showWarningMessage(strings.history.exportTruncated());
    } else {
      log.info(strings.history.exported(result.entryCount));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(strings.history.exportFailed(message));
    void vscode.window.showErrorMessage(strings.history.exportFailed(message));
  }
}

/** Resume in the directory the conversation was written in, not the current workspace. */
function resumeHistorySession(node: unknown): void {
  if (isSessionNode(node)) {
    void launch({
      mode: 'resumePicker',
      sessionId: node.session.id,
      cwd: node.session.cwd || undefined,
    });
  }
}

/** Fork the chosen conversation into a new session, in the directory it was written in. */
function forkHistorySession(node: unknown): void {
  if (isSessionNode(node)) {
    void launch({
      mode: 'forkPicker',
      sessionId: node.session.id,
      cwd: node.session.cwd || undefined,
    });
  }
}

function restoreJournalSession(session: JournalSession): void {
  if (!session.sessionId) {
    return;
  }
  void vscode.window.showInformationMessage(
    strings.recovery.restored(session.project || session.label),
  );
  historyViewProvider?.clearRecoverable(session.sessionId);
  void launch({
    mode: 'resumePicker',
    sessionId: session.sessionId,
    cwd: session.cwd || undefined,
  });
}

function restoreSession(node: unknown): void {
  if (isRecoveryNode(node)) {
    restoreJournalSession(node.session);
  }
}

function restoreAllSessions(): void {
  for (const session of [...(historyViewProvider?.getRecoverable() ?? [])]) {
    restoreJournalSession(session);
  }
}

function dismissRecovery(): void {
  historyViewProvider?.clearRecoverable();
}

async function copyHistorySessionId(node: unknown): Promise<void> {
  if (!isSessionNode(node)) {
    return;
  }
  await vscode.env.clipboard.writeText(node.session.id);
  void vscode.window.showInformationMessage(strings.history.copied(node.session.id));
}

async function openRawHistorySession(node: unknown): Promise<void> {
  if (!isSessionNode(node)) {
    return;
  }
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(node.session.filePath));
  await vscode.window.showTextDocument(document, { preview: false });
}

/**
 * Hand session lifecycle to Codex rather than unlinking rollout files.
 *
 * Codex keeps a state database alongside the rollouts, so deleting a file behind its back
 * leaves the two disagreeing — `codex doctor` reports exactly that as a parity check.
 * `codex archive` and `codex delete` take a session id and keep both in step.
 */
async function runSessionLifecycle(node: unknown, action: 'archive' | 'delete'): Promise<void> {
  if (!isSessionNode(node)) {
    return;
  }
  const { id } = node.session;
  const confirm =
    action === 'delete' ? strings.history.confirmDelete(id) : strings.history.confirmArchive(id);
  const proceed = await vscode.window.showWarningMessage(
    confirm,
    { modal: true },
    action === 'delete' ? strings.history.deleteAction() : strings.history.archiveAction(),
  );
  if (!proceed) {
    return;
  }

  const command = config().get<string>('command', 'codex');
  const resolved = preflightCodexCommand(command);
  if (!resolved) {
    return;
  }
  const output = await runCommand(resolved, [action, id], process.platform);
  log.info(strings.history.lifecycleRan(action, id, output));
  historyViewProvider?.refresh(true);
}

async function searchHistory(): Promise<void> {
  if (!historyViewProvider) {
    return;
  }
  const value = await vscode.window.showInputBox({
    prompt: strings.history.searchPrompt(),
    placeHolder: strings.history.searchPlaceholder(),
    value: historyViewProvider.getFilter(),
    ignoreFocusOut: true,
  });
  if (value !== undefined) {
    historyViewProvider.setFilter(value);
  }
}

/**
 * Status bar item, driven by live session state.
 *
 * `$(loading~spin)` is the workbench's animated-codicon syntax: the `~spin` modifier
 * becomes `codicon-modifier-spin` and the animation is CSS, so this costs one label
 * update per state change rather than a timer.
 */
function createStatusBarItem(context: vscode.ExtensionContext, monitor: SessionMonitor): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = 'codexTerminal.focus';
  context.subscriptions.push(item);

  const render = (): void => {
    const sessions = monitor.live();
    const live = sessions.length;
    const working = monitor.workingCount();
    const peak = config().get<boolean>('showContextInStatusBar', true)
      ? peakContextUsed(sessions.map((session) => session.activity))
      : undefined;
    item.text = statusBarText(working, live, peak, animationAllowed());
    const stalled = monitor.stalledCount(config().get<number>('stallSeconds', DEFAULT_STALL_SECONDS));
    const base =
      working > 0
        ? strings.status.workingTooltip(working, live)
        : live > 0
          ? strings.status.liveTooltip(live)
          : strings.status.tooltip();
    item.tooltip = stalled > 0 ? `${base} ${strings.status.stalledTooltip(stalled)}` : base;
    item.accessibilityInformation = {
      label:
        working > 0
          ? strings.status.accessibilityWorking(working)
          : strings.status.accessibility(),
      role: 'button',
    };
    if (config().get<boolean>('showStatusBarButton', true)) {
      item.show();
    } else {
      item.hide();
    }
  };

  render();
  context.subscriptions.push(
    monitor.onDidChange(render),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('codexTerminal.showStatusBarButton') ||
        event.affectsConfiguration('codexTerminal.showContextInStatusBar') ||
        event.affectsConfiguration('workbench.reduceMotion')
      ) {
        render();
      }
    }),
  );
}

/**
 * Offer back the sessions a window was holding when it died.
 *
 * Presented once: the crashed journals are stamped as handled straight after, so opening
 * a second window does not raise the same prompt again. The sidebar group stays until it
 * is used or dismissed.
 */
async function offerRecovery(store: JournalStore, windowId: string): Promise<void> {
  try {
    const journals = await store.readAll();
    const now = Date.now();
    const active = sessionMonitor?.activeSessionIds() ?? new Set<string>();
    const candidates = interruptedSessions(journals, now, windowId).filter(
      (session) => session.sessionId && !active.has(session.sessionId),
    );
    if (candidates.length === 0) {
      return;
    }

    const handled = journals
      .filter((journal) =>
        candidates.some((candidate) =>
          journal.sessions.some((session) => session.key === candidate.key),
        ),
      )
      .map((journal) => journal.windowId);

    historyViewProvider?.setRecoverable(candidates);
    log.info(`found ${candidates.length} interrupted Codex session(s) from a previous window`);
    await store.markHandled(handled);

    const choice = await vscode.window.showWarningMessage(
      strings.recovery.prompt(candidates.length),
      strings.recovery.restoreAll(),
      strings.recovery.review(),
      strings.recovery.dismiss(),
    );
    if (choice === strings.recovery.restoreAll()) {
      restoreAllSessions();
    } else if (choice === strings.recovery.review()) {
      await vscode.commands.executeCommand('codexTerminal.history.focus');
    } else if (choice === strings.recovery.dismiss()) {
      dismissRecovery();
    }
  } catch (error) {
    log.warn(
      `could not check for interrupted sessions: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function runSettingsMigrations(context: vscode.ExtensionContext): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('codexTerminal');
  const events = await migrateSettings(
    String(context.extension.packageJSON.version),
    context.globalState,
    {
      inspect: (key) => {
        const inspection = configuration.inspect<unknown>(key);
        return inspection
          ? {
              globalValue: inspection.globalValue,
              workspaceValue: inspection.workspaceValue,
              workspaceFolderValue: inspection.workspaceFolderValue,
            }
          : undefined;
      },
      update: async (key, value, target: MigrationTarget) => {
        const targets: Record<MigrationTarget, vscode.ConfigurationTarget> = {
          global: vscode.ConfigurationTarget.Global,
          workspace: vscode.ConfigurationTarget.Workspace,
          workspaceFolder: vscode.ConfigurationTarget.WorkspaceFolder,
        };
        await configuration.update(key, value, targets[target]);
      },
    },
  );
  for (const event of events) {
    log.info(strings.migration.event(event));
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<CodexTerminalExtensionApi> {
  log = vscode.window.createOutputChannel('Codex Terminal', { log: true });
  context.subscriptions.push(log);
  extensionContext = context;
  try {
    await runSettingsMigrations(context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(strings.migration.failed(message));
  }
  await applyWorkbenchPreferences();

  const windowId = vscode.env.sessionId;
  const store = new JournalStore(
    path.join(context.globalStorageUri.fsPath, 'sessions'),
    windowId,
  );
  const monitor = new SessionMonitor({
    store,
    windowId,
    workspaceName: vscode.workspace.name,
    codexHome: () => codexHomeDirectory(),
    log,
  });
  sessionMonitor = monitor;
  context.subscriptions.push(monitor);

  terminalRegistry = new TerminalRegistry();
  const adopted = terminalRegistry.adopt(
    vscode.window.terminals,
    config().get<string>('terminalName', 'Codex'),
  );
  if (adopted > 0) {
    log.info(strings.logs.adopted(adopted));
    // Survivors of a reload can be shown and focused, but their rollout cannot be
    // inferred after the fact: the launch instant that makes the match unambiguous is
    // exactly what the reload destroyed.
    for (const tracked of terminalRegistry.live()) {
      monitor.track(tracked.terminal, {
        cwd: tracked.cwd ?? '',
        project: tracked.cwd ? path.basename(tracked.cwd) : tracked.terminal.name,
        label: tracked.terminal.name,
        mode: 'adopted',
        bindable: false,
      });
    }
  }

  const commands: Array<[string, () => void]> = [
    ['codexTerminal.new', () => void launch({ mode: 'new' })],
    ['codexTerminal.resumeLast', () => void launch({ mode: 'resumeLast' })],
    [
      'codexTerminal.resumePicker',
      () => {
        void resumeFromSessionPicker();
      },
    ],
    ['codexTerminal.forkLast', () => void launch({ mode: 'forkLast' })],
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
    ['codexTerminal.refreshHistory', () => historyViewProvider?.refresh(true)],
    [
      'codexTerminal.searchHistory',
      () => {
        void searchHistory();
      },
    ],
    ['codexTerminal.restoreAllSessions', restoreAllSessions],
    ['codexTerminal.dismissRecovery', dismissRecovery],
    [
      'codexTerminal.focus',
      () => {
        const terminal = liveOwnedTerminal();
        if (terminal) {
          terminal.show(false);
        } else {
          void launch({ mode: 'new' });
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
    vscode.commands.registerCommand('codexTerminal.openTranscript', openTranscript),
    vscode.commands.registerCommand('codexTerminal.resumeHistorySession', resumeHistorySession),
    vscode.commands.registerCommand('codexTerminal.copyHistorySessionId', copyHistorySessionId),
    vscode.commands.registerCommand('codexTerminal.openRawHistorySession', openRawHistorySession),
    vscode.commands.registerCommand('codexTerminal.restoreSession', restoreSession),
    vscode.commands.registerCommand('codexTerminal.forkHistorySession', forkHistorySession),
    vscode.commands.registerCommand('codexTerminal.archiveSession', (node: unknown) => {
      void runSessionLifecycle(node, 'archive');
    }),
    vscode.commands.registerCommand('codexTerminal.deleteSession', (node: unknown) => {
      void runSessionLifecycle(node, 'delete');
    }),
  );

  const provideTerminalProfile = async (): Promise<vscode.TerminalProfile | undefined> => {
    // The terminal service owns placement for a profile launch, so no location.
    await syncNotifyBridge();
    const request = readLaunchRequest('new');
    if (!preflightCodexCommand(request.command)) {
      return undefined;
    }
    const { options } = await terminalOptions({ mode: 'new' }, false);
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
      monitor.close(closed);
    }),
  );

  const actionsProvider = new ActionsViewProvider(
    monitor,
    () => config().get<number>('stallSeconds', DEFAULT_STALL_SECONDS),
    animationAllowed,
  );
  historyViewProvider = new HistoryViewProvider(() =>
    config().get<number>('history.maxSessions', 200),
  );
  const actionsView = vscode.window.createTreeView('codexTerminal.actions', {
    treeDataProvider: actionsProvider,
  });
  const historyDirectory = codexSessionsDirectory(codexHomeDirectory());
  const historyWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(historyDirectory), '**/*.jsonl'),
  );

  // The activity-bar badge is the one indicator visible while the sidebar is collapsed.
  const renderBadge = (): void => {
    const working = monitor.workingCount();
    actionsView.badge =
      working > 0
        ? { value: working, tooltip: strings.status.workingTooltip(working, monitor.live().length) }
        : undefined;
  };
  renderBadge();

  context.subscriptions.push(
    actionsView,
    actionsProvider,
    monitor.onDidChange(renderBadge),
    vscode.window.registerTreeDataProvider('codexTerminal.history', historyViewProvider),
    historyViewProvider,
    historyWatcher,
    // Debounced: an active turn appends to its rollout several times a second.
    historyWatcher.onDidCreate(() => historyViewProvider?.scheduleRefresh()),
    historyWatcher.onDidChange(() => historyViewProvider?.scheduleRefresh()),
    historyWatcher.onDidDelete(() => historyViewProvider?.scheduleRefresh(true)),
  );

  createStatusBarItem(context, monitor);

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
      if (
        event.affectsConfiguration(CONFIRM_ON_KILL_SETTING) ||
        event.affectsConfiguration(AGENT_CLI_TITLE_SETTING) ||
        event.affectsConfiguration('codexTerminal.tabTitle')
      ) {
        void applyWorkbenchPreferences();
      }
    }),
    {
      dispose: () => {
        notifyBridge?.dispose();
        notifyBridge = undefined;
        historyViewProvider = undefined;
        extensionContext = undefined;
      },
    },
  );
  void syncNotifyBridge();
  void monitor.pruneJournals();
  void offerRecovery(store, windowId);

  return {
    getActionCount: () => actionsProvider.getChildren().length,
    getTerminalProfileOptions: async () => (await provideTerminalProfile())?.options,
  };
}

export function deactivate(): void {
  notifyBridge?.dispose();
  notifyBridge = undefined;
  extensionContext = undefined;
  // Stamps the journal so the next window does not treat these sessions as crashed.
  void sessionMonitor?.shutdown();
  sessionMonitor = undefined;
  terminalRegistry?.dispose();
  terminalRegistry = undefined;
}
