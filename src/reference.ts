/** Pure helpers for the "send file reference" command. No `vscode` import. */

export interface ReferenceInput {
  /** Path of the file, already made relative to the workspace folder if possible. */
  relativePath: string;
  /** Zero-based selection bounds, or undefined for a whole-file reference. */
  selection?: { startLine: number; endLine: number };
}

/**
 * Codex CLI resolves `@path` mentions relative to its working directory, and
 * accepts a `#L<start>-L<end>` suffix for a range. Paths are emitted with forward
 * slashes because a Windows backslash inside an `@` mention reads as an escape.
 */
export function buildFileReference(input: ReferenceInput): string {
  const path = input.relativePath.replace(/\\/g, '/');
  const quoted = /\s/.test(path) ? `"${path}"` : path;
  if (!input.selection) {
    return `@${quoted}`;
  }
  const start = input.selection.startLine + 1;
  const end = input.selection.endLine + 1;
  const range = start === end ? `#L${start}` : `#L${start}-L${end}`;
  return `@${quoted}${range}`;
}
