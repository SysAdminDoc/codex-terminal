import { existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import {
  HostedAppServer,
  nodeEntryFor,
  remoteArgs,
  webSocketAvailable,
} from './appServer';
import {
  buildLaunchPlan,
  modeArgs,
  profileArgs,
  resolveCommandPath,
  type LaunchMode,
  type LaunchRequest,
  type ShellKind,
} from './launcher';
import {
  DEFAULT_TERMINAL_NAME_TEMPLATE,
  DEFAULT_TITLE_ITEMS,
  LAUNCH_KEY_ENV_VAR,
  OWNERSHIP_ENV_VAR,
  projectName,
  renderTerminalName,
} from './naming';
import { NotifyBridge, resolveNodeExecutable } from './notify';
import {
  DEFAULT_STALL_SECONDS,
  describeActivity,
  pickerOrder,
  presentStatus,
} from './present';
import { codexProfilesDirectory, profileNamesFromFiles } from './profiles';
import {
  animationAllowed,
  config,
  log,
  peekServices,
  reportError,
  services,
  tabTitleMode,
} from './services';
import {
  codexHomeDirectory,
  discoverSessions,
  sessionProject,
  type SessionRecord,
} from './sessions';
import { strings } from './strings';
import { KNOWN_TITLE_ITEMS, partitionTitleItems, titleItemsArgs } from './workbench';

/**
 * Everything between "the operator asked for a Codex session" and "a terminal exists".
 *
 * Split out of `extension.ts`, which had grown to 1,376 lines mixing this with recovery,
 * status-bar rendering, history commands and activation wiring. The shared handles it needs
 * come from `services`, which is what made the move possible at all.
 */

const PWSH_PROBE = [
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
];
const CODEX_INSTALL_URL = 'https://github.com/openai/codex#installation';

/** Empty unless this window is hosting an app-server for launched terminals to attach to. */
function remoteArgsFor(server: HostedAppServer | undefined): string[] {
  return server ? remoteArgs(server.port) : [];
}

export function readLaunchRequest(
  mode: LaunchMode,
  profile?: string,
  sessionId?: string,
  additionalArgs: readonly string[] = [],
  attachAppServer = true,
): LaunchRequest {
  const cfg = config();
  const titleItems = cfg.get<string[]>('titleItems', [...DEFAULT_TITLE_ITEMS]);
  // Codex drops identifiers it does not recognise without complaining, so an unknown item
  // silently costs the user part of their tab title. Say so once, at launch.
  const { unknown } = partitionTitleItems(titleItems);
  if (unknown.length > 0) {
    log().warn(strings.logs.unknownTitleItems(unknown.join(', '), KNOWN_TITLE_ITEMS.join(', ')));
  }
  return {
    shell: cfg.get<ShellKind>('shell', 'auto'),
    customShellPath: cfg.get<string>('customShellPath', ''),
    command: cfg.get<string>('command', 'codex'),
    args: [
      ...modeArgs(mode),
      ...(sessionId ? [sessionId] : []),
      ...additionalArgs,
      ...(profile ? profileArgs(profile) : []),
      ...cfg.get<string[]>('args', []),
      // Codex writes this title through OSC sequences. The activity item is a live
      // spinner while it is working and the project item is derived from the repo root.
      ...titleItemsArgs(titleItems),
      // Attach the TUI to the app-server this window is hosting, so its turns are reported
      // over the protocol instead of inferred from a rollout file. Absent unless the
      // experimental setting is on and the server actually came up.
      ...remoteArgsFor(attachAppServer ? services().appServer : undefined),
      ...(services().notify?.launchArgs() ?? []),
    ],
    keepShellOpen: cfg.get<boolean>('keepShellOpen', true),
    platform: process.platform,
    availableShells: PWSH_PROBE.filter((p) => existsSync(p)),
  };
}

/**
 * Bring up this window's app-server, if the experimental setting asks for one.
 *
 * Started on demand rather than during activation: it is a subprocess, activation now runs in
 * every window at startup, and a window that never launches Codex should never pay for it.
 *
 * Every failure path here falls back to a plain `codex` launch and says why. The feature is
 * experimental and opt-in; refusing to start a terminal because an optional control plane did
 * not come up would be the wrong trade.
 */
export async function ensureAppServer(): Promise<void> {
  const state = services();
  if (!config().get<boolean>('appServer.enabled', false)) {
    state.appServer?.dispose();
    state.appServer = undefined;
    return;
  }
  // `isAlive` rather than mere presence: a server that has exited leaves its handle behind,
  // and returning here is what used to point every later launch at a closed port.
  if (state.appServer?.isAlive()) {
    return;
  }
  state.appServer = undefined;
  if (!webSocketAvailable()) {
    // `WebSocket` became a Node global in 22, which the 1.101 engine floor supplies. Keep the
    // probe because downstream hosts can bypass the manifest floor.
    log().warn(strings.appServer.noWebSocket());
    return;
  }

  const command = config().get<string>('command', 'codex');
  const resolved = resolveCommandPath(command, {
    platform: process.platform,
    pathValue: process.env.PATH,
    cwd: process.cwd(),
  });
  if (!resolved) {
    log().warn(strings.appServer.unavailable(command));
    return;
  }
  const entry = nodeEntryFor(resolved);
  const nodeExecutable = entry
    ? resolveNodeExecutable({
        execPath: process.execPath,
        pathValue: process.env.PATH,
        isWindows: process.platform === 'win32',
        exists: existsSync,
      })
    : undefined;
  if (entry && !nodeExecutable) {
    log().warn(strings.appServer.unavailable('node'));
    return;
  }
  try {
    state.appServer = await HostedAppServer.start({
      command: entry ?? resolved,
      // A resolved Node, not `process.execPath`: that is the editor's Electron binary, which
      // only runs a script while `ELECTRON_RUN_AS_NODE` happens to be inherited.
      ...(entry && nodeExecutable ? { nodeExecutable } : {}),
      log: log(),
      onExit: () => {
        // Drop the handle so the next launch starts a fresh server instead of attaching to
        // a port nothing is listening on.
        peekServices()?.appServer?.dispose();
        const live = peekServices();
        if (live) {
          live.appServer = undefined;
        }
      },
    });
  } catch (error) {
    log().warn(
      strings.appServer.startFailed(error instanceof Error ? error.message : String(error)),
    );
  }
}

export async function resolveCwd(): Promise<string | undefined> {
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
        title: strings.folders.prompt(),
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

export interface LaunchOptions {
  mode: LaunchMode;
  profile?: string;
  sessionId?: string;
  /** Overrides the resolved workspace cwd, so a saved chat resumes where it was written. */
  cwd?: string;
  /** Extra Codex arguments for commands such as `codex review`. */
  additionalArgs?: readonly string[];
  /** Set false for non-TUI subcommands that do not accept the app-server attachment flag. */
  attachAppServer?: boolean;
  /** Review commands must get their own terminal even when terminal reuse is enabled. */
  reuseTerminal?: boolean;
  /**
   * Journal key for this launch, stamped into the terminal environment so a window reload
   * can find the conversation again. Absent for the contributed terminal profile, whose
   * terminal the terminal service owns and which this extension never tracks.
   */
  launchKey?: string;
}

/** Shared between the commands and the contributed terminal profile. */
export async function terminalOptions(
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
  const plan = buildLaunchPlan(
    readLaunchRequest(
      mode,
      profile,
      sessionId,
      request.additionalArgs,
      request.attachAppServer !== false,
    ),
  );
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
    env: {
      ...cfg.get<Record<string, string>>('env', {}),
      [OWNERSHIP_ENV_VAR]: '1',
      ...(request.launchKey ? { [LAUNCH_KEY_ENV_VAR]: request.launchKey } : {}),
    },
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
    // VS Code accepts a Windows-only string form that reaches cmd.exe verbatim. Passing the
    // same command line as string[] lets node-pty quote the second element again, which changes
    // cmd's outer-quote parsing and splits otherwise valid arguments containing spaces or `&`.
    options.shellArgs =
      plan.family === 'cmd' && process.platform === 'win32'
        ? plan.shellArgs.join(' ')
        : plan.shellArgs;
  }
  log().info(
    strings.logs.launch(
      mode,
      plan.shellPath ?? '<editor default>',
      JSON.stringify(plan.shellArgs),
      String(options.cwd ?? '<none>'),
      plan.sendTextFallback ? JSON.stringify(plan.sendTextFallback) : '',
    ),
  );
  if (plan.shellResolutionReason) {
    log().info(strings.logs.shellResolution(plan.shellResolutionReason));
  }
  return { options, plan, cwd, project: projectName(nameContext), label };
}

export function preflightCodexCommand(command: string): string | undefined {
  const resolved = resolveCommandPath(command, {
    platform: process.platform,
    pathValue: process.env.PATH,
    cwd: process.cwd(),
  });
  if (resolved) {
    log().info(strings.logs.commandPreflightPassed(JSON.stringify(command), resolved));
    return resolved;
  }

  const message = strings.errors.missingCommand(command);
  log().error(message);
  void vscode.window
    .showErrorMessage(message, strings.errors.showLog(), strings.errors.install())
    .then((choice) => {
      if (choice === strings.errors.showLog()) {
        log().show(true);
      } else if (choice === strings.errors.install()) {
        void vscode.env.openExternal(vscode.Uri.parse(CODEX_INSTALL_URL));
      }
    });
  return undefined;
}

export function liveOwnedTerminal(): vscode.Terminal | undefined {
  const live = services().monitor.live() ?? [];
  return live.length > 0 ? live[live.length - 1].terminal : undefined;
}

export async function launch(request: LaunchOptions): Promise<void> {
  try {
    await syncNotifyBridge();
    if (request.attachAppServer !== false) {
      await ensureAppServer();
    }
    if (
      request.mode === 'new' &&
      !request.profile &&
      request.reuseTerminal !== false &&
      config().get<boolean>('reuseTerminal', false)
    ) {
      const existing = liveOwnedTerminal();
      if (existing) {
        existing.show(false);
        return;
      }
    }

    const launchRequest = readLaunchRequest(
      request.mode,
      request.profile,
      request.sessionId,
      request.additionalArgs,
      request.attachAppServer !== false,
    );
    if (!preflightCodexCommand(launchRequest.command)) {
      return;
    }

    // Reserved before the terminal exists: the key has to be in the environment at creation,
    // and the journal has to record the same one, or a reload finds nothing to match.
    const launchKey = services().monitor.nextLaunchKey();
    const { options, plan, cwd, project, label } = await terminalOptions(
      { ...request, launchKey },
      true,
    );
    const terminal = vscode.window.createTerminal(options);
    if (!cwd) {
      // The tab works; nothing else does. Live status, the badge, the journal and crash
      // recovery all key off the working directory, and this used to be silent.
      log().info(strings.logs.untracked());
    }
    if (cwd) {
      services().monitor.track(terminal, {
        cwd,
        project,
        label,
        mode: request.mode,
        profile: request.profile,
        sessionId: request.sessionId,
        key: launchKey,
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

export async function launchWithProfile(): Promise<void> {
  const freeTextItem: vscode.QuickPickItem = {
    // Codicons are presentation, not translatable prose: keep the edit glyph outside the
    // localized string so screen readers and translators see the actual label.
    label: `$(edit) ${strings.profiles.freeText()}`,
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
    title: strings.profiles.prompt(),
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

export async function resumeFromSessionPicker(): Promise<void> {
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
    title: strings.sessions.prompt(),
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

export async function syncNotifyBridge(): Promise<void> {
  const enabled = config().get<boolean>('notifyOnCompletion', false);
  if (!enabled) {
    services().notify?.dispose();
    services().notify = undefined;
    return;
  }
  if (services().notify) {
    return;
  }

  const workspaceName =
    vscode.workspace.name ?? vscode.workspace.workspaceFolders?.[0]?.name ?? 'workspace';
  // Not `process.execPath`: in the extension host that is the editor's Electron binary, and
  // the editor deletes `ELECTRON_RUN_AS_NODE` from the environment a terminal runs in — so
  // Codex would hand the hook script to an editor, which opens a window instead of writing
  // the event. Without a real Node there is nothing to register that would work.
  const node = resolveNodeExecutable({
    execPath: process.execPath,
    pathValue: process.env.PATH,
    isWindows: process.platform === 'win32',
    exists: existsSync,
  });
  if (!node) {
    log().info(strings.notifications.needsNode());
    return;
  }
  const bridge = new NotifyBridge({
    directory: path.join(services().context.globalStorageUri.fsPath, 'notify'),
    executable: node,
    workspaceName,
    onTurnEnded: (event) => {
      services().history.refresh();
      void vscode.window.showInformationMessage(strings.notifications.turnCompleted(event.workspace));
    },
  });
  try {
    await bridge.start();
    services().notify = bridge;
    log().info(strings.notifications.notificationsEnabled(workspaceName));
  } catch (error) {
    bridge.dispose();
    const message = error instanceof Error ? error.message : String(error);
    log().error(strings.notifications.enableFailed(message));
  }
}

/**
 * The status bar's click target.
 *
 * With one live session this focuses it, as it always did. With several it asks which,
 * because the status bar advertises a count and then silently picked the most recent one —
 * a coin flip precisely when several agents are running, which is when the button matters.
 */
export async function focusCodex(): Promise<void> {
  const sessions = services().monitor.live() ?? [];
  if (sessions.length === 0) {
    void launch({ mode: 'new' });
    return;
  }
  if (sessions.length === 1) {
    sessions[0].terminal.show(false);
    return;
  }

  const now = Date.now();
  const stallSeconds = config().get<number>('stallSeconds', DEFAULT_STALL_SECONDS);
  const animate = animationAllowed();
  const picked = await vscode.window.showQuickPick(
    pickerOrder(sessions).map((session) => ({
      label: `$(${presentStatus(session.activity, animate).icon}) ${session.project || session.label}`,
      description: describeActivity(session.activity, now, stallSeconds),
      detail: session.cwd,
      session,
    })),
    {
      title: strings.sessions.focusPrompt(sessions.length),
      placeHolder: strings.sessions.focusPrompt(sessions.length),
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
  picked?.session.terminal.show(false);
}
