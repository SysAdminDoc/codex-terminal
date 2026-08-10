import { open, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

/**
 * Incremental reader for an append-only JSONL file.
 *
 * Rollouts reach hundreds of megabytes and are appended to several times a second while a
 * turn runs, so the activity monitor never re-reads one. The tailer remembers a byte
 * offset and hands over only whole lines that have appeared since the last poll; a trailing
 * partial line is held back until its newline arrives, because Codex's writes are not
 * atomic at line granularity.
 *
 * Node's fs only — no `vscode` — so the read/rotate/truncate behaviour is unit tested.
 */

/**
 * Bytes read per iteration. The whole unread span used to be read into one buffer, turned
 * into one string and split into one array — three copies of a file that is 41 MB at the
 * high-water mark on the development machine, and the restore path deliberately starts at
 * offset 0. Past V8's maximum string length that is not slow, it throws
 * (`RangeError: Invalid string length`), which is how the same pattern fails for other
 * readers of this format. One reused buffer bounds it regardless of file size.
 */
const CHUNK_BYTES = 1024 * 1024;

/**
 * Longest single line kept. A JSONL line is one record, and Codex's own migration tooling
 * treats records past 16 MiB as exceptional, so a line four times that is a corrupt or
 * truncated file rather than a large one. Holding it would defeat the chunking, because the
 * remainder grows until a newline arrives — so it is dropped and reading resynchronises at
 * the next newline, which costs one record instead of the session.
 */
export const MAX_LINE_BYTES = 64 * 1024 * 1024;

export interface FoldResult<T> {
  value: T;
  /** Whole lines folded in this call. Zero means nothing new was appended. */
  lines: number;
  /** Lines discarded for exceeding `MAX_LINE_BYTES`; nonzero is worth logging. */
  dropped: number;
}

export class RolloutTailer {
  private offset = 0;
  private remainder = '';
  /** Set while discarding the tail of an over-long line, until its newline arrives. */
  private skipping = false;
  /**
   * A poll can land in the middle of a multi-byte character — Codex messages are full of
   * em dashes and spinner glyphs. Decoding each chunk independently would turn a split
   * character into U+FFFD in both halves; the decoder holds the incomplete bytes back
   * until the rest arrives.
   */
  private decoder = new StringDecoder('utf8');

  /** `maxLineBytes` is a parameter so the drop path can be tested without a 64 MiB fixture. */
  constructor(
    readonly filePath: string,
    private readonly maxLineBytes: number = MAX_LINE_BYTES,
  ) {}

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
    this.skipping = false;
    this.decoder = new StringDecoder('utf8');
  }

  /**
   * Fold every whole line appended since the previous call, a bounded chunk at a time.
   *
   * A fold rather than a returned array, and deliberately so: both callers immediately
   * reduce the lines to one small state object, so materialising them first is the only
   * reason the whole file was ever in memory at once. Nothing here retains more than one
   * chunk plus the line currently being assembled.
   *
   * A file that has shrunk was replaced rather than appended to, so the offset is reset
   * and the file is re-read from the start; anything else would decode the middle of a
   * line as if it were the beginning of one.
   */
  async fold<T>(seed: T, step: (accumulator: T, line: string) => T): Promise<FoldResult<T>> {
    let size: number;
    try {
      size = (await stat(this.filePath)).size;
    } catch {
      return { value: seed, lines: 0, dropped: 0 };
    }

    if (size < this.offset) {
      this.reset(0);
    }
    if (size === this.offset) {
      return { value: seed, lines: 0, dropped: 0 };
    }

    let value = seed;
    let lines = 0;
    let dropped = 0;
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size - this.offset));
    const handle = await open(this.filePath, 'r');
    try {
      // Re-`stat`ing is pointless here: a rollout only grows, and anything appended during
      // the loop is picked up by the next call rather than extending this one indefinitely.
      while (this.offset < size) {
        const want = Math.min(buffer.length, size - this.offset);
        const { bytesRead } = await handle.read(buffer, 0, want, this.offset);
        if (bytesRead === 0) {
          break;
        }
        this.offset += bytesRead;

        const text = this.remainder + this.decoder.write(buffer.subarray(0, bytesRead));
        const parts = text.split('\n');
        // The final element is whatever follows the last newline: either an empty string, or
        // a line the writer has not finished yet.
        this.remainder = parts.pop() ?? '';
        for (const part of parts) {
          if (this.skipping) {
            // The newline that ended the over-long line; the record itself is gone.
            this.skipping = false;
            continue;
          }
          // Enforced on whole lines too, not only on the remainder, so the guarantee is the
          // simple one: no line past the limit is ever handed on, however it arrived.
          if (part.length > this.maxLineBytes) {
            dropped += 1;
            continue;
          }
          value = step(value, part.endsWith('\r') ? part.slice(0, -1) : part);
          lines += 1;
        }
        if (this.remainder.length > this.maxLineBytes) {
          this.remainder = '';
          this.skipping = true;
          dropped += 1;
        }
      }
    } finally {
      await handle.close();
    }
    return { value, lines, dropped };
  }
}
