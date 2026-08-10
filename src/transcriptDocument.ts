import * as vscode from 'vscode';

import { exportTranscript } from './sessions';
import { strings } from './strings';
import type { TranscriptRenderOptions } from './transcript';

/**
 * Transcripts as virtual documents rather than untitled buffers.
 *
 * `openTextDocument({ content })` produces an *untitled* document, which is dirty from the
 * moment it exists: closing one asks whether to save a file the operator never created, and
 * opening the same session twice yields two unrelated buffers with no relationship to each
 * other. That is a poor fit for something that is a read-only view of a file already on disk.
 *
 * A content provider fixes all three at once. The URI identifies the session, so re-opening
 * lands on the tab that is already there; the document is read-only because nothing backs it
 * with a save; and `onDidChange` re-reads in place, which matters because a session being
 * read is often still being written.
 *
 * The URI carries the rollout path in its query rather than relying on a lookup table: an
 * editor restored after a window reload asks for its content before anything has had a chance
 * to repopulate a table, and a self-describing URI simply answers.
 */

export const TRANSCRIPT_SCHEME = 'codex-transcript';

/** `.md` is load-bearing: the language id is derived from the path, and markdown is the point. */
export function transcriptUri(sessionId: string, filePath: string, project: string): vscode.Uri {
  const query = new URLSearchParams({ path: filePath, project });
  return vscode.Uri.from({
    scheme: TRANSCRIPT_SCHEME,
    path: `/${sessionId}.md`,
    query: query.toString(),
  });
}

export class TranscriptContentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly changes = new vscode.EventEmitter<vscode.Uri>();

  readonly onDidChange = this.changes.event;

  constructor(private readonly options: () => TranscriptRenderOptions = () => ({})) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const parameters = new URLSearchParams(uri.query);
    const filePath = parameters.get('path');
    if (!filePath) {
      return strings.history.exportFailed(uri.toString());
    }
    const project = parameters.get('project') ?? '';
    const result = await exportTranscript(filePath, project, this.options());
    // A footer rather than a toast: the caveat belongs with the text it describes, and it is
    // still there when the operator scrolls to the end and wonders why it stops.
    return result.truncated
      ? `${result.markdown}\n\n---\n\n_${strings.history.exportTruncated()}_\n`
      : result.markdown;
  }

  /** Re-read a transcript in place, for a session that is still being written. */
  refresh(uri: vscode.Uri): void {
    this.changes.fire(uri);
  }

  dispose(): void {
    this.changes.dispose();
  }
}
