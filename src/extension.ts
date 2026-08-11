import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { ActionsViewProvider, getActions } from './actionsView';
import type { RateTable } from './cost';
import {
  askAboutSelection,
  checkAppServer,
  reviewBase,
  reviewCommit,
  reviewUncommitted,
  runDoctor,
  sendFileReference,
} from './editorCommands';
import { HistoryViewProvider } from './historyView';
import {
  copyHistorySessionId,
  copyHistoryCommand,
  forkHistorySession,
  nameSession,
  openRawHistorySession,
  openTranscript,
  resumeHistorySession,
  runSessionLifecycle,
  searchHistory,
  sendRecentPrompt,
  sessionNames,
} from './historyCommands';
import { runCommand } from './doctor';
import { JournalStore } from './journal';
import { resolveCommandPath } from './launcher';
import {
  focusCodex,
  launch,
  launchWithProfile,
  preflightCodexCommand,
  readLaunchRequest,
  resumeFromSessionPicker,
  syncNotifyBridge,
  terminalOptions,
} from './launch';
import { migrateSettings, type MigrationTarget } from './migrate';
import { registerMcpServerProvider, type McpProviderRegistration } from './mcpProvider';
import { SessionMonitor } from './monitor';
import { clearNotifyEvents } from './notify';
import { DEFAULT_STALL_SECONDS, configurePresentation } from './present';
import {
  adoptSurvivingTerminals,
  dismissRecovery,
  offerRecovery,
  restoreAllSessions,
  restoreSession,
} from './recovery';
import {
  animationAllowed,
  clearServices,
  config,
  peekServices,
  setServices,
  type ExtensionServices,
} from './services';
import { applyWorkbenchPreferences, revertWorkbenchPreferences } from './settingsSync';
import { codexHomeDirectory, codexSessionsDirectory } from './sessions';
import { createStatusBarItem } from './statusBar';
import { presentationLabels, strings } from './strings';
import { TerminalRegistry } from './terminals';
import { TRANSCRIPT_SCHEME, TranscriptContentProvider } from './transcriptDocument';
import { AGENT_CLI_TITLE_SETTING, CONFIRM_ON_KILL_SETTING } from './workbench';

export interface CodexTerminalExtensionApi {
  getActionCount: () => number;
  getTerminalProfileOptions: () => Promise<vscode.TerminalOptions | undefined>;
  /** Wall-clock milliseconds spent inside `activate`, for the startup budget check. */
  getActivationMs: () => number;
  /**
   * Rendered labels of an inventory section, for the integration suite. The section is only
   * reachable by expanding it in the sidebar, which a test cannot do without synthesising
   * input, so the provider is asked the same question the tree asks it.
   */
  getInventoryRows: (of: 'plugins' | 'mcp') => Promise<string[]>;
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

function focusSession(terminal: vscode.Terminal | undefined): void {
  if (terminal && terminal.exitStatus === undefined) {
    terminal.show(false);
  }
}

function stopSession(terminal: vscode.Terminal | undefined): void {
  terminal?.dispose();
}

/**
 * Ask Codex what it has plugged in, quietly.
 *
 * Deliberately not `preflightCodexCommand`: that one raises an error dialog, which is the right
 * answer when the operator asked to launch Codex and wrong when a tree section was expanded.
 * An unresolvable command comes back as text the parser rejects, and the row says so.
 */
function readCodexInventory(args: readonly string[]): Promise<string> {
  const command = config().get<string>('command', 'codex');
  const resolved = resolveCommandPath(command, {
    platform: process.platform,
    pathValue: process.env.PATH,
    cwd: process.cwd(),
  });
  if (!resolved) {
    return Promise.resolve(strings.errors.missingCommand(command));
  }
  peekServices()?.log.info(`codex ${args.join(' ')} via ${resolved}`);
  return runCommand(resolved, args, process.platform, 4 * 1024 * 1024, 15_000);
}

async function runSettingsMigrations(
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel,
): Promise<void> {
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

/**
 * Activation runs on `onStartupFinished`, in every window, whether or not Codex is used
 * there. That is the price of offering crash recovery without being asked for it — an
 * extension that has not activated cannot notice that the last window died. The bargain is
 * that activation stays cheap: no synchronous disk walk, and everything that can wait is
 * started with `void` rather than awaited. `getActivationMs` exists so the cost is a number
 * the test suite can hold us to rather than an assurance.
 *
 * This function is wiring and nothing else. Every command it registers lives in its own
 * module and reaches the shared handles through `services`, which is set once — here, before
 * anything that could invoke a command.
 */
export async function activate(context: vscode.ExtensionContext): Promise<CodexTerminalExtensionApi> {
  const activationStartedAt = Date.now();
  const log = vscode.window.createOutputChannel('Codex Terminal', { log: true });
  context.subscriptions.push(log);
  try {
    await runSettingsMigrations(context, log);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(strings.migration.failed(message));
  }

  // Generated here rather than taken from `vscode.env.sessionId`, which is documented to
  // change every time the editor starts and on VSCodium does not: its telemetry patch
  // compiles the value to the constant `"someValue.sessionId"`, identical in every window
  // of every launch forever. The journal is built on that id — one file per window, and
  // `interruptedSessions` skips journals whose id is its own — so a constant collapsed the
  // whole store to a single file that every new window classified as itself and skipped.
  // Crash recovery could not fire on this editor at all, which is how a night of sessions
  // came back as empty tabs. A fresh id per activation is what the journal actually wants.
  const windowId = randomUUID();
  const store = new JournalStore(path.join(context.globalStorageUri.fsPath, 'sessions'), windowId);
  const monitor = new SessionMonitor({
    store,
    windowId,
    workspaceName: vscode.workspace.name,
    codexHome: () => codexHomeDirectory(),
    log,
    stallSeconds: () => config().get<number>('stallSeconds', DEFAULT_STALL_SECONDS),
    enabled: () => config().get<boolean>('monitor.enabled', true),
    storeMessages: () => config().get<boolean>('journal.storeMessages', true),
    clearStoredNotifications: () =>
      clearNotifyEvents(path.join(context.globalStorageUri.fsPath, 'notify')),
  });
  const registry = new TerminalRegistry();
  const history = new HistoryViewProvider(
    () => config().get<number>('history.maxSessions', 200),
    () => codexHomeDirectory(),
    sessionNames,
  );
  const transcript = new TranscriptContentProvider(() => ({
    includeToolCalls: config().get<boolean>('transcript.includeToolCalls', true),
    includeToolOutput: config().get<boolean>('transcript.includeToolOutput', false),
    redactSecrets: config().get<boolean>('transcript.redactSecrets', true),
  }));

  // Set before anything that could reach a command: every extracted module reads its handles
  // from here, so this is the line that has to come first.
  const state: ExtensionServices = { log, context, monitor, registry, history, transcript };
  setServices(state);
  // Before anything renders: these are the words every session row, tooltip and
  // screen-reader announcement is built from.
  configurePresentation(presentationLabels());
  context.subscriptions.push(monitor, history, transcript);

  await adoptSurvivingTerminals(store);

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
    ['codexTerminal.sendRecentPrompt', () => void sendRecentPrompt()],
    [
      'codexTerminal.newWithProfile',
      () => {
        void launchWithProfile();
      },
    ],
    ['codexTerminal.sendFileReference', () => void sendFileReference()],
    [
      'codexTerminal.askAboutSelection',
      () => {
        void askAboutSelection();
      },
    ],
    [
      'codexTerminal.checkAppServer',
      () => {
        void checkAppServer();
      },
    ],
    [
      'codexTerminal.doctor',
      () => {
        void runDoctor();
      },
    ],
    ['codexTerminal.showLog', () => log.show(true)],
    [
      'codexTerminal.revertWorkbenchSettings',
      () => {
        void revertWorkbenchPreferences();
      },
    ],
    ['codexTerminal.refreshHistory', () => history.refresh(true)],
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
        void focusCodex();
      },
    ],
  ];
  for (const [id, handler] of commands) {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('codexTerminal.nameSession', (node: unknown) => {
      void nameSession(node);
    }),
    vscode.commands.registerCommand('codexTerminal.focusSession', focusSession),
    vscode.commands.registerCommand('codexTerminal.stopSession', stopSession),
    vscode.commands.registerCommand('codexTerminal.openTranscript', openTranscript),
    vscode.commands.registerCommand('codexTerminal.resumeHistorySession', resumeHistorySession),
    vscode.commands.registerCommand('codexTerminal.copyHistorySessionId', copyHistorySessionId),
    vscode.commands.registerCommand('codexTerminal.copyHistoryCommand', copyHistoryCommand),
    vscode.commands.registerCommand('codexTerminal.openRawHistorySession', openRawHistorySession),
    vscode.commands.registerCommand('codexTerminal.restoreSession', restoreSession),
    vscode.commands.registerCommand('codexTerminal.forkHistorySession', forkHistorySession),
    vscode.commands.registerCommand('codexTerminal.reviewUncommitted', (repository: unknown) => {
      void reviewUncommitted(repository);
    }),
    vscode.commands.registerCommand('codexTerminal.reviewBase', (repository: unknown) => {
      void reviewBase(repository);
    }),
    vscode.commands.registerCommand(
      'codexTerminal.reviewCommit',
      (repository: unknown, historyItem: unknown) => {
        void reviewCommit(repository, historyItem);
      },
    ),
    vscode.commands.registerCommand('codexTerminal.archiveSession', (node: unknown) => {
      void runSessionLifecycle(node, 'archive');
    }),
    vscode.commands.registerCommand('codexTerminal.unarchiveSession', (node: unknown) => {
      void runSessionLifecycle(node, 'unarchive');
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

  const actionsProvider = new ActionsViewProvider(
    monitor,
    () => config().get<number>('stallSeconds', DEFAULT_STALL_SECONDS),
    animationAllowed,
    sessionNames,
    () => config().get<RateTable>('modelRates'),
    readCodexInventory,
  );
  const mcpProvider: McpProviderRegistration | undefined = registerMcpServerProvider(() =>
    readCodexInventory(['mcp', 'list', '--json']),
  );
  if (mcpProvider) {
    context.subscriptions.push(mcpProvider);
  }
  const actionsView = vscode.window.createTreeView('codexTerminal.actions', {
    treeDataProvider: actionsProvider,
  });
  const historyWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(
      vscode.Uri.file(codexSessionsDirectory(codexHomeDirectory())),
      '**/*.jsonl',
    ),
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

  /**
   * Tell the operator their shells died, in the window it happened to.
   *
   * Recovery used to be reachable only from the *next* window's activation, which assumes
   * the editor goes down with the sessions. A pty host can die on its own and leave the
   * window sitting there with a row of tabs that look fine and are not, and nobody should
   * have to learn that restarting is what surfaces them.
   *
   * Coalesced, because that failure closes every terminal in the same tick: announcing per
   * close event meant thirteen identical warnings for one event. Announced ids are
   * remembered so a later close does not re-raise sessions already offered.
   */
  const announced = new Set<string>();
  let announcement: NodeJS.Timeout | undefined;
  const announceLostSessions = (): void => {
    clearTimeout(announcement);
    announcement = setTimeout(() => {
      const lost = monitor.lostSessions();
      const fresh = lost.filter(
        (session) => session.sessionId && !announced.has(session.sessionId),
      );
      if (fresh.length === 0) {
        return;
      }
      for (const session of fresh) {
        announced.add(session.sessionId as string);
      }
      history.setRecoverable(lost);
      void vscode.window
        .showWarningMessage(
          strings.recovery.lost(fresh.length),
          strings.recovery.restoreAll(),
          strings.recovery.review(),
          strings.recovery.dismiss(),
        )
        .then((choice) => {
          if (choice === strings.recovery.restoreAll()) {
            restoreAllSessions();
          } else if (choice === strings.recovery.review()) {
            void vscode.commands.executeCommand('codexTerminal.history.focus');
          } else if (choice === strings.recovery.dismiss()) {
            dismissRecovery();
          }
        });
    }, 250);
  };

  context.subscriptions.push(
    new vscode.Disposable(() => clearTimeout(announcement)),
    vscode.window.registerTerminalProfileProvider('codexTerminal.profile', {
      provideTerminalProfile,
    }),
    vscode.window.onDidCloseTerminal((closed) => {
      registry.remove(closed);
      monitor.close(closed);
      announceLostSessions();
    }),
    vscode.workspace.registerTextDocumentContentProvider(TRANSCRIPT_SCHEME, transcript),
    vscode.window.registerTreeDataProvider('codexTerminal.history', history),
    actionsView,
    actionsProvider,
    monitor.onDidChange(renderBadge),
    historyWatcher,
    // Debounced: an active turn appends to its rollout several times a second.
    historyWatcher.onDidCreate(() => history.scheduleRefresh()),
    historyWatcher.onDidChange(() => history.scheduleRefresh()),
    historyWatcher.onDidDelete(() => history.scheduleRefresh(true)),
  );

  createStatusBarItem(context, monitor);

  const statusBarVisible = vscode.workspace
    .getConfiguration('workbench')
    .get<boolean>('statusBar.visible', true);
  log.info(strings.logs.activation(statusBarVisible));

  // Which store this window watches, and whether the terminals it launches will write to a
  // different one. `codexTerminal.env.CODEX_HOME` is the documented way to point Codex
  // somewhere else, and doing so used to make history, live status and recovery all go
  // quietly empty with nothing anywhere to explain it.
  const sessionsRoot = codexSessionsDirectory();
  log.info(strings.store.resolved(sessionsRoot));
  const terminalHome = config().get<Record<string, string>>('env', {})?.CODEX_HOME;
  if (terminalHome && path.resolve(terminalHome) !== path.resolve(codexHomeDirectory())) {
    log.warn(strings.store.diverged(codexHomeDirectory(), path.resolve(terminalHome)));
  }
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
      if (event.affectsConfiguration('codexTerminal.command')) {
        actionsProvider.refreshInventory();
        mcpProvider?.refresh();
      }
      if (
        event.affectsConfiguration('codexTerminal.journal.storeMessages') &&
        config().get<boolean>('journal.storeMessages', true) === false
      ) {
        // Turning the setting off has to act on what is already written, not only on what
        // would be written next.
        void monitor.stripStoredMessages();
      }
    }),
    {
      dispose: () => {
        state.notify?.dispose();
        state.notify = undefined;
      },
    },
  );
  // Everything below is deliberately not awaited: none of it has to finish before the
  // window is usable, and activation now happens on every startup.
  void applyWorkbenchPreferences();
  void syncNotifyBridge();
  void monitor.pruneJournals();
  void offerRecovery(store, windowId);

  const activationMs = Date.now() - activationStartedAt;
  log.info(strings.logs.activationCost(activationMs));
  return {
    getActionCount: () => getActions().length,
    getTerminalProfileOptions: async () => (await provideTerminalProfile())?.options,
    getActivationMs: () => activationMs,
    getInventoryRows: async (of) => {
      const rows = await actionsProvider.getChildren({ kind: 'inventory-group', of });
      return rows.map((row) => String(actionsProvider.getTreeItem(row).label));
    },
  };
}

export function deactivate(): void {
  // `peekServices` rather than `services()`: deactivate can run after a failed activation,
  // and throwing here would replace a startup error with a shutdown one.
  const state = peekServices();
  state?.notify?.dispose();
  state?.appServer?.dispose();
  // Stamps the journal so the next window does not treat these sessions as crashed.
  // Synchronous on purpose: nothing waits for a promise returned from `deactivate`.
  state?.monitor.shutdown();
  state?.registry.dispose();
  clearServices();
}
