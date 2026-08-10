import * as path from 'node:path';
import * as vscode from 'vscode';

import { collectDoctorReport } from './doctor';
import { liveOwnedTerminal, readLaunchRequest, resolveCwd } from './launch';
import { DEFAULT_TITLE_ITEMS } from './naming';
import { buildFileReference } from './reference';
import { config, log, reportError } from './services';
import { strings } from './strings';

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
  const terminal = liveOwnedTerminal() ?? vscode.window.activeTerminal;
  if (!terminal) {
    void vscode.window.showWarningMessage(strings.warnings.noTerminal());
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
