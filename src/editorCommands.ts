import * as path from 'node:path';
import * as vscode from 'vscode';

import { AppServerClient, nodeEntryFor, type AppServerHandshake } from './appServer';
import { collectDoctorReport, runCommandResult } from './doctor';
import { reviewArgs } from './launcher';
import {
  launch,
  liveOwnedTerminal,
  preflightCodexCommand,
  readLaunchRequest,
  resolveCwd,
} from './launch';
import { DEFAULT_TITLE_ITEMS } from './naming';
import { buildFileReference } from './reference';
import { config, log, reportError, services } from './services';
import { strings } from './strings';
import { findCheckout } from './worktree';

/** Commands driven from the editor: diagnostics, and getting a selection to Codex. */

export async function runDoctor(): Promise<void> {
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
    log().info(text);
    const choice = await vscode.window.showInformationMessage(text, strings.errors.showLog());
    if (choice === strings.errors.showLog()) {
      log().show(true);
    }
  } catch (error) {
    reportError(error, strings.errors.couldNotRunDoctor());
  }
}

/** The `@path#L10-L20` for what is selected right now, with the terminal to send it to. */
function resolveReferenceTarget():
  | { reference: string; terminal: vscode.Terminal }
  | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage(strings.warnings.noEditor());
    return undefined;
  }
  // Deliberately not `?? vscode.window.activeTerminal`. With no Codex session tracked, that
  // typed the file reference — and, for "Ask Codex about selection", pressed Enter — into
  // whatever terminal happened to be focused: a running build, an SSH session, a REPL.
  const terminal = liveOwnedTerminal();
  if (!terminal) {
    void vscode.window
      .showWarningMessage(strings.warnings.noTerminal(), strings.warnings.startSession())
      .then((choice) => {
        if (choice === strings.warnings.startSession()) {
          void vscode.commands.executeCommand('codexTerminal.new');
        }
      });
    return undefined;
  }

  const uri = editor.document.uri;
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const relativePath = folder ? path.relative(folder.uri.fsPath, uri.fsPath) : uri.fsPath;
  const selection = editor.selection;
  return {
    terminal,
    reference: buildFileReference({
      relativePath,
      selection: selection.isEmpty
        ? undefined
        : { startLine: selection.start.line, endLine: selection.end.line },
    }),
  };
}

/**
 * Put the reference on the prompt and stop, so the question can be typed after it.
 *
 * Kept exactly as it was. It is the right command when the question is easier to type in the
 * terminal — with Codex's own completion and history — than in a modal input box.
 */
export function sendFileReference(): void {
  const target = resolveReferenceTarget();
  if (!target) {
    return;
  }
  const { reference, terminal } = target;
  terminal.show(false);
  // `false` leaves the reference on the prompt so a question can be typed after it.
  terminal.sendText(`${reference} `, false);
  log().info(strings.logs.sentReference(reference));
}

/**
 * Reference plus question, submitted in one step.
 *
 * The reference-only command deliberately stops at the prompt, which means finding the right
 * terminal and typing there. This is the path for when the question is already in your head
 * while you are looking at the code: ask it here, and the whole line is submitted.
 */
export async function askAboutSelection(): Promise<void> {
  const target = resolveReferenceTarget();
  if (!target) {
    return;
  }
  const question = await vscode.window.showInputBox({
    prompt: strings.reference.askPrompt(target.reference),
    placeHolder: strings.reference.askPlaceholder(),
    ignoreFocusOut: true,
  });
  // Cancelled, or nothing typed: submitting a bare reference would start a turn asking
  // Codex nothing at all.
  if (!question?.trim()) {
    return;
  }

  const line = `${target.reference} ${question.trim()}`;
  target.terminal.show(false);
  target.terminal.sendText(line, true);
  log().info(strings.logs.sentReference(line));
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' ? (value as UnknownRecord) : undefined;
}

function filePath(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value;
  }
  const record = asRecord(value);
  const fsPath = record?.fsPath;
  return typeof fsPath === 'string' && fsPath.trim() ? fsPath : undefined;
}

/** SCM menu arguments are intentionally read structurally: the history API is still proposed. */
function repositoryPath(context: unknown): string | undefined {
  const record = asRecord(context);
  if (!record) {
    return undefined;
  }
  return (
    filePath(record.root) ??
    filePath(record.rootUri) ??
    repositoryPath(record.sourceControl)
  );
}

async function reviewRepositoryRoot(...contexts: unknown[]): Promise<string | undefined> {
  for (const context of contexts) {
    const root = repositoryPath(context);
    if (root) {
      return root;
    }
  }

  const cwd = await resolveCwd();
  if (!cwd) {
    void vscode.window.showWarningMessage(strings.review.noRepository());
    return undefined;
  }
  const checkout = await findCheckout(cwd);
  if (!checkout) {
    void vscode.window.showWarningMessage(strings.review.noRepository());
    return undefined;
  }
  return checkout.root;
}

function reviewCommitId(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  for (const key of ['id', 'commit', 'hash']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function parsedBranches(output: string): string[] {
  return [...new Set(
    output
      .split(/\r?\n/)
      .map((branch) => branch.trim())
      .filter((branch) => branch && !branch.endsWith('/HEAD')),
  )].sort((left, right) => left.localeCompare(right));
}

async function startReview(repositoryRoot: string, args: readonly string[]): Promise<void> {
  await launch({
    mode: 'new',
    cwd: repositoryRoot,
    additionalArgs: args,
    attachAppServer: false,
    // A review is a separate non-interactive command; reusing a live session would silently
    // skip it and leave the operator looking at the wrong terminal.
    reuseTerminal: false,
  });
}

/** Review the current checkout's working tree from the SCM title menu. */
export async function reviewUncommitted(repository?: unknown): Promise<void> {
  const root = await reviewRepositoryRoot(repository);
  if (root) {
    await startReview(root, reviewArgs('uncommitted'));
  }
}

/** Pick a local or remote branch and review the current checkout against it. */
export async function reviewBase(repository?: unknown): Promise<void> {
  const root = await reviewRepositoryRoot(repository);
  if (!root) {
    return;
  }

  const result = await runCommandResult(
    'git',
    ['-C', root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'],
    process.platform,
    64 * 1024,
    5000,
  );
  if (!result.ok) {
    log().warn(strings.review.branchListFailed(result.output));
    void vscode.window.showWarningMessage(strings.review.branchListFailed(result.output));
    return;
  }

  const branches = parsedBranches(result.output);
  if (branches.length === 0) {
    void vscode.window.showWarningMessage(strings.review.noBranches());
    return;
  }
  const selected = await vscode.window.showQuickPick(
    branches.map((branch) => ({ label: branch, branch })),
    {
      placeHolder: strings.review.basePrompt(),
      ignoreFocusOut: true,
    },
  );
  if (selected) {
    await startReview(root, reviewArgs({ base: selected.branch }));
  }
}

/** Review a commit selected in the SCM history graph. */
export async function reviewCommit(
  repository?: unknown,
  historyItem?: unknown,
): Promise<void> {
  const commit = reviewCommitId(historyItem ?? repository);
  if (!commit || !/^[0-9a-f]{7,64}$/i.test(commit)) {
    void vscode.window.showWarningMessage(strings.review.invalidCommit());
    return;
  }
  const root = await reviewRepositoryRoot(repository, historyItem);
  if (root) {
    await startReview(root, reviewArgs({ commit }));
  }
}


/**
 * Connect to `codex app-server` once, report what came back, and disconnect.
 *
 * A probe rather than a live connection. Adopting the app-server as this extension's control
 * plane is a real architectural decision — it would replace the rollout reader — and the first
 * question is simply whether this machine can talk to it at all. Answering that costs one
 * handshake and leaves nothing running.
 *
 * `resolveCommandPath` lands on `codex.cmd` on Windows, which Node refuses to spawn without a
 * shell (BatBadBut, CVE-2024-27980) and reports as a bare `EINVAL`. The npm shim sits next to
 * a JS entry point, so the client is pointed at that instead and run under this Node.
 */
export async function checkAppServer(): Promise<void> {
  const command = config().get<string>('command', 'codex');
  const resolved = preflightCodexCommand(command);
  if (!resolved) {
    return;
  }

  const entry = nodeEntryFor(resolved);
  const client = new AppServerClient({
    command: entry ?? resolved,
    ...(entry ? { nodeExecutable: process.execPath } : {}),
    log: log(),
    onNotification: (method) => log().info(`app-server notification: ${method}`),
  });
  try {
    const handshake = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: strings.appServer.connecting() },
      () => client.start(String(services().context.extension.packageJSON.version)),
    );
    const report = describeHandshake(handshake);
    log().info(report);
    const choice = await vscode.window.showInformationMessage(report, strings.errors.showLog());
    if (choice === strings.errors.showLog()) {
      log().show(true);
    }
  } catch (error) {
    reportError(error, strings.appServer.failed());
  } finally {
    client.dispose();
  }
}

function describeHandshake(handshake: AppServerHandshake): string {
  return strings.appServer.connected(
    handshake.userAgent ?? 'unknown',
    handshake.codexHome ?? 'unknown',
    handshake.platformOs ?? 'unknown',
  );
}
