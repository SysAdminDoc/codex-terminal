import { open, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

/**
 * Incremental reader for an append-only JSONL file.
 *
 * Rollouts reach hundreds of megabytes and are appended to several times a second while a
 * turn runs, so the activity monitor never re-reads one. The tailer remembers a byte
 * offset and returns only whole lines that have appeared since the last poll; a trailing
 * partial line is held back until its newline arrives, because Codex's writes are not
 * atomic at line granularity.
 *
 * Node's fs only — no `vscode` — so the read/rotate/truncate behaviour is unit tested.
 */
export class RolloutTailer {
  private offset = 0;
  private remainder = '';
  /**
   * A poll can land in the middle of a multi-byte character — Codex messages are full of
   * em dashes and spinner glyphs. Decoding each chunk independently would turn a split
   * character into U+FFFD in both halves; the decoder holds the incomplete bytes back
   * until the rest arrives.
   */
  private decoder = new StringDecoder('utf8');

  constructor(readonly filePath: string) {}

  /** Start from the end, for a file whose history is already accounted for. */
  async seekToEnd(): Promise<void> {
    try {
      const stats = await stat(this.filePath);
      this.offset = stats.size;
    } catch {
      this.offset = 0;
    }
    this.reset(this.offset);
  }

  private reset(offset: number): void {
    this.offset = offset;
    this.remainder = '';
    this.decoder = new StringDecoder('utf8');
  }

  /**
   * Return whole lines appended since the previous call.
   *
   * A file that has shrunk was replaced rather than appended to, so the offset is reset
   * and the file is re-read from the start; anything else would decode the middle of a
   * line as if it were the beginning of one.
   */
  async poll(): Promise<string[]> {
    let size: number;
    try {
      size = (await stat(this.filePath)).size;
    } catch {
      return [];
    }

    if (size < this.offset) {
      this.reset(0);
    }
    if (size === this.offset) {
      return [];
    }

    const length = size - this.offset;
    const buffer = Buffer.alloc(length);
    const handle = await open(this.filePath, 'r');
    let bytesRead = 0;
    try {
      ({ bytesRead } = await handle.read(buffer, 0, length, this.offset));
    } finally {
      await handle.close();
    }
    this.offset += bytesRead;

    const text = this.remainder + this.decoder.write(buffer.subarray(0, bytesRead));
    const parts = text.split('\n');
    // The final element is whatever follows the last newline: either an empty string, or
    // a line the writer has not finished yet.
    this.remainder = parts.pop() ?? '';
    return parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  }
}
