import * as vscode from 'vscode';

import { nodeEntryFor, setThreadName } from './appServer';
import { runCommandResult } from './doctor';
import { isRunningSessionNode } from './actionsView';
import { isSessionNode } from './historyView';
import { launch, preflightCodexCommand } from './launch';
import { idForName, normaliseName, setSessionName, type SessionNames } from './names';
import { SESSION_NAMES_KEY, config, log, reportError, services } from './services';
import { strings } from './strings';
import { transcriptUri } from './transcriptDocument';

/** Commands that act on a row in the History or Running trees. */

export function sessionNames(): SessionNames {
  return services().context.globalState.get<SessionNames>(SESSION_NAMES_KEY) ?? {};
}

/**
 * Name a session, from either tree.
 *
 * The name is the extension's own: Codex accepts a session name wherever it accepts an id,
 * but its CLI has no way to *set* one (0.147 has no rename subcommand and no flag), so the
 * only writer is `app-server`'s `thread/name/set`, which is not yet spoken here. A local name
 * still does the job names are for — telling several running agents apart — and resume works
 * because the name resolves to an id before the command is built.
 */
export async function nameSession(node: unknown): Promise<void> {
  const session = isSessionNode(node)
    ? { id: node.session.id, fallback: node.session.preview ?? node.project }
    : isRunningSessionNode(node) && node.session.sessionId
      ? { id: node.session.sessionId, fallback: node.session.project || node.session.label }
      : undefined;
  if (!session) {
    void vscode.window.showWarningMessage(strings.names.notBound());
    return;
  }

  const names = sessionNames();
  const typed = await vscode.window.showInputBox({
    prompt: strings.names.prompt(session.fallback),
    placeHolder: strings.names.placeholder(),
    value: names[session.id] ?? '',
    ignoreFocusOut: true,
  });
  if (typed === undefined) {
    return;
  }

  const clash = idForName(names, typed);
  if (clash && clash !== session.id) {
    void vscode.window.showWarningMessage(strings.names.duplicate(typed.trim()));
    return;
  }

  await services().context.globalState.update(SESSION_NAMES_KEY, setSessionName(names, session.id, typed));
  services().history.refresh();
  services().monitor.refreshViews();
  // Only a real name is pushed. Codex rejects an empty one outright ("thread name must not
  // be empty") and offers no way to unset an existing one — there is no `thread/name/clear`
  // and `null` is refused — so clearing here clears the local name only, and says so.
  const cleared = !normaliseName(typed);
  if (cleared) {
    log().info(strings.names.clearedLocally(session.id));
    return;
  }
  await pushNameToCodex(session.id, typed);
}

/**
 * Mirror the name into Codex itself, so `codex resume <name>` finds it from any shell and the
 * `thread-title` tab item can show it.
 *
 * Best effort on purpose. The local name is already stored and already visible by the time
 * this runs; failing to reach the app-server is worth a log line, not an error dialog that
 * implies the rename did not happen.
 */
async function pushNameToCodex(sessionId: string, name: string): Promise<void> {
  const command = config().get<string>('command', 'codex');
  const resolved = preflightCodexCommand(command);
  if (!resolved) {
    return;
  }
  const entry = nodeEntryFor(resolved);
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: strings.names.syncing() },
      () =>
        setThreadName(
          {
            command: entry ?? resolved,
            ...(entry ? { nodeExecutable: process.execPath } : {}),
            log: log(),
          },
          String(services().context.extension.packageJSON.version),
          sessionId,
          name.trim(),
        ),
    );
    log().info(strings.names.synced(sessionId, name.trim()));
  } catch (error) {
    log().warn(
      strings.names.syncFailed(error instanceof Error ? error.message : String(error)),
    );
  }
}

export async function openTranscript(node: unknown): Promise<void> {
  if (!isSessionNode(node)) {
    return;
  }
  try {
    const uri = transcriptUri(node.session.id, node.session.filePath, node.project);
    // Re-read before showing: a session being read is very often still being written, and
    // the alternative is a stale document that looks current.
    services().transcript.refresh(uri);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true });
    log().info(strings.history.opened(node.session.id));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log().error(strings.history.exportFailed(message));
    void vscode.window.showErrorMessage(strings.history.exportFailed(message));
  }
}

/** Resume in the directory the conversation was written in, not the current workspace. */
export function resumeHistorySession(node: unknown): void {
  if (isSessionNode(node)) {
    void launch({
      mode: 'resumePicker',
      sessionId: node.session.id,
      cwd: node.session.cwd || undefined,
    });
  }
}

/** Fork the chosen conversation into a new session, in the directory it was written in. */
export function forkHistorySession(node: unknown): void {
  if (isSessionNode(node)) {
    void launch({
      mode: 'forkPicker',
      sessionId: node.session.id,
      cwd: node.session.cwd || undefined,
    });
  }
}

export async function copyHistorySessionId(node: unknown): Promise<void> {
  if (!isSessionNode(node)) {
    return;
  }
  await vscode.env.clipboard.writeText(node.session.id);
  void vscode.window.showInformationMessage(strings.history.copied(node.session.id));
}

export async function openRawHistorySession(node: unknown): Promise<void> {
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
 * `codex archive`, `codex unarchive` and `codex delete` take a session id and keep both in step.
 */
export async function runSessionLifecycle(
  node: unknown,
  action: 'archive' | 'unarchive' | 'delete',
): Promise<void> {
  if (!isSessionNode(node)) {
    return;
  }
  const { id } = node.session;
  const confirm =
    action === 'delete'
      ? strings.history.confirmDelete(id)
      : action === 'unarchive'
        ? strings.history.confirmUnarchive(id)
        : strings.history.confirmArchive(id);
  const actionLabel =
    action === 'delete'
      ? strings.history.deleteAction()
      : action === 'unarchive'
        ? strings.history.unarchiveAction()
        : strings.history.archiveAction();
  const proceed = await vscode.window.showWarningMessage(
    confirm,
    { modal: true },
    actionLabel,
  );
  if (!proceed) {
    return;
  }

  const command = config().get<string>('command', 'codex');
  const resolved = preflightCodexCommand(command);
  if (!resolved) {
    return;
  }
  const result = await runCommandResult(resolved, [action, id], process.platform);
  if (!result.ok) {
    reportError(result.output, strings.history.lifecycleFailed(action, id));
    return;
  }
  log().info(strings.history.lifecycleRan(action, id, result.output));
  void vscode.window.showInformationMessage(strings.history.lifecycleSucceeded(action, id));
  services().history.refresh(true);
}

export async function searchHistory(): Promise<void> {
  const value = await vscode.window.showInputBox({
    prompt: strings.history.searchPrompt(),
    placeHolder: strings.history.searchPlaceholder(),
    value: services().history.getFilter(),
    ignoreFocusOut: true,
  });
  if (value !== undefined) {
    services().history.setFilter(value);
  }
}
