import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { RolloutTailer } from '../tail';

async function withTempFile(
  body: (filePath: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-tail-'));
  try {
    await body(path.join(directory, 'rollout.jsonl'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('a missing file yields nothing rather than throwing', async () => {
  const tailer = new RolloutTailer(path.join(tmpdir(), 'codex-does-not-exist.jsonl'));
  assert.deepEqual(await tailer.poll(), []);
});

test('only newly appended lines are returned', async () => {
  await withTempFile(async (filePath) => {
    await writeFile(filePath, 'one\ntwo\n', 'utf8');
    const tailer = new RolloutTailer(filePath);
    assert.deepEqual(await tailer.poll(), ['one', 'two']);
    assert.deepEqual(await tailer.poll(), []);

    await appendFile(filePath, 'three\n', 'utf8');
    assert.deepEqual(await tailer.poll(), ['three']);
  });
});

test('a half-written final line is held back until its newline arrives', async () => {
  await withTempFile(async (filePath) => {
    // Codex's appends are not atomic at line granularity, so a poll can land mid-record.
    // Emitting the fragment would hand `JSON.parse` a truncated object every time.
    await writeFile(filePath, 'complete\n{"partial":', 'utf8');
    const tailer = new RolloutTailer(filePath);
    assert.deepEqual(await tailer.poll(), ['complete']);

    await appendFile(filePath, 'true}\n', 'utf8');
    assert.deepEqual(await tailer.poll(), ['{"partial":true}']);
  });
});

test('a truncated or replaced file is re-read from the start', async () => {
  await withTempFile(async (filePath) => {
    await writeFile(filePath, 'first\nsecond\nthird\n', 'utf8');
    const tailer = new RolloutTailer(filePath);
    await tailer.poll();

    // Resuming from a stale offset into a shorter file would decode the middle of a line
    // as though it were the start of one.
    await writeFile(filePath, 'fresh\n', 'utf8');
    assert.deepEqual(await tailer.poll(), ['fresh']);
  });
});

test('carriage returns are stripped so JSON parses on Windows checkouts', async () => {
  await withTempFile(async (filePath) => {
    await writeFile(filePath, '{"a":1}\r\n{"b":2}\r\n', 'utf8');
    const tailer = new RolloutTailer(filePath);
    assert.deepEqual(await tailer.poll(), ['{"a":1}', '{"b":2}']);
  });
});

test('seeking to the end skips history a caller has already accounted for', async () => {
  await withTempFile(async (filePath) => {
    await writeFile(filePath, 'old\n', 'utf8');
    const tailer = new RolloutTailer(filePath);
    await tailer.seekToEnd();
    assert.deepEqual(await tailer.poll(), []);

    await appendFile(filePath, 'new\n', 'utf8');
    assert.deepEqual(await tailer.poll(), ['new']);
  });
});

test('multi-byte characters survive being split across two polls', async () => {
  await withTempFile(async (filePath) => {
    await writeFile(filePath, '', 'utf8');
    const tailer = new RolloutTailer(filePath);
    await tailer.poll();

    // The spinner glyphs and em dashes in Codex messages are multi-byte; a naive reader
    // that decodes each chunk independently turns a split one into U+FFFD.
    const text = '{"m":"⠹ working — done"}\n';
    const bytes = Buffer.from(text, 'utf8');
    await appendFile(filePath, bytes.subarray(0, 12));
    await tailer.poll();
    await appendFile(filePath, bytes.subarray(12));
    assert.deepEqual(await tailer.poll(), [text.trimEnd()]);
  });
});
