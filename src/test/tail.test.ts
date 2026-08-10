import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { RolloutTailer } from '../tail';

/**
 * Collect what a fold sees, which is only safe because these files are a few bytes each.
 * Production never does this — the fold exists precisely so a 41 MB rollout is not
 * materialised as an array of strings.
 */
async function collect(tailer: RolloutTailer): Promise<string[]> {
  const { value } = await tailer.fold<string[]>([], (lines, line) => [...lines, line]);
  return value;
}

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
  assert.deepEqual(await collect(tailer), []);
});

test('only newly appended lines are returned', async () => {
  await withTempFile(async (filePath) => {
    await writeFile(filePath, 'one\ntwo\n', 'utf8');
    const tailer = new RolloutTailer(filePath);
    assert.deepEqual(await collect(tailer), ['one', 'two']);
    assert.deepEqual(await collect(tailer), []);

    await appendFile(filePath, 'three\n', 'utf8');
    assert.deepEqual(await collect(tailer), ['three']);
  });
});

test('a half-written final line is held back until its newline arrives', async () => {
  await withTempFile(async (filePath) => {
    // Codex's appends are not atomic at line granularity, so a poll can land mid-record.
    // Emitting the fragment would hand `JSON.parse` a truncated object every time.
    await writeFile(filePath, 'complete\n{"partial":', 'utf8');
    const tailer = new RolloutTailer(filePath);
    assert.deepEqual(await collect(tailer), ['complete']);

    await appendFile(filePath, 'true}\n', 'utf8');
    assert.deepEqual(await collect(tailer), ['{"partial":true}']);
  });
});

test('a truncated or replaced file is re-read from the start', async () => {
  await withTempFile(async (filePath) => {
    await writeFile(filePath, 'first\nsecond\nthird\n', 'utf8');
    const tailer = new RolloutTailer(filePath);
    await collect(tailer);

    // Resuming from a stale offset into a shorter file would decode the middle of a line
    // as though it were the start of one.
    await writeFile(filePath, 'fresh\n', 'utf8');
    assert.deepEqual(await collect(tailer), ['fresh']);
  });
});

test('carriage returns are stripped so JSON parses on Windows checkouts', async () => {
  await withTempFile(async (filePath) => {
    await writeFile(filePath, '{"a":1}\r\n{"b":2}\r\n', 'utf8');
    const tailer = new RolloutTailer(filePath);
    assert.deepEqual(await collect(tailer), ['{"a":1}', '{"b":2}']);
  });
});

test('seeking to the end skips history a caller has already accounted for', async () => {
  await withTempFile(async (filePath) => {
    await writeFile(filePath, 'old\n', 'utf8');
    const tailer = new RolloutTailer(filePath);
    await tailer.seekToEnd();
    assert.deepEqual(await collect(tailer), []);

    await appendFile(filePath, 'new\n', 'utf8');
    assert.deepEqual(await collect(tailer), ['new']);
  });
});

test('multi-byte characters survive being split across two polls', async () => {
  await withTempFile(async (filePath) => {
    await writeFile(filePath, '', 'utf8');
    const tailer = new RolloutTailer(filePath);
    await collect(tailer);

    // The spinner glyphs and em dashes in Codex messages are multi-byte; a naive reader
    // that decodes each chunk independently turns a split one into U+FFFD.
    const text = '{"m":"⠹ working — done"}\n';
    const bytes = Buffer.from(text, 'utf8');
    await appendFile(filePath, bytes.subarray(0, 12));
    await collect(tailer);
    await appendFile(filePath, bytes.subarray(12));
    assert.deepEqual(await collect(tailer), [text.trimEnd()]);
  });
});

test('a file many chunks long is folded once, in order, without materialising it', async () => {
  await withTempFile(async (filePath) => {
    // Comfortably past the 1 MiB chunk size, so the loop runs many times and the remainder
    // is carried across chunk boundaries repeatedly.
    const line = `{"pad":"${'x'.repeat(1000)}"}`;
    const count = 32_000;
    await writeFile(filePath, '', 'utf8');
    for (let batch = 0; batch < 32; batch += 1) {
      const chunk: string[] = [];
      for (let index = 0; index < count / 32; index += 1) {
        chunk.push(`${line.slice(0, -1)},"n":${batch * (count / 32) + index}}`);
      }
      await appendFile(filePath, `${chunk.join('\n')}\n`, 'utf8');
    }

    const tailer = new RolloutTailer(filePath);
    const baseline = process.memoryUsage().external;
    let seen = 0;
    let first = '';
    let last = '';
    let externalAtFirstLine = 0;
    const { lines, dropped } = await tailer.fold(undefined, (_, text) => {
      if (seen === 0) {
        first = text;
        // Sampled here rather than after the fold, because heap totals depend on when the
        // collector happens to run and this does not: the read buffer is certainly alive at
        // the moment the first line is handed over. A reader that took the whole unread span
        // in one allocation — the shape this replaced — would be holding ~32 MB right now.
        externalAtFirstLine = process.memoryUsage().external - baseline;
      }
      last = text;
      seen += 1;
      return undefined;
    });

    assert.equal(lines, count);
    assert.equal(seen, count);
    assert.equal(dropped, 0);
    assert.ok(first.endsWith(',"n":0}'), first.slice(-16));
    assert.ok(last.endsWith(`,"n":${count - 1}}`), last.slice(-16));
    assert.ok(
      externalAtFirstLine < 4 * 1024 * 1024,
      `read buffer held ${Math.round(externalAtFirstLine / 1024 / 1024)} MB of a ~32 MB file`,
    );
  });
});

test('an invalid UTF-8 byte corrupts its own line and no others', async () => {
  await withTempFile(async (filePath) => {
    // Upstream reports one bad byte making an entire thread unreadable. A record is one
    // line, so the blast radius has to be one line.
    const bytes = Buffer.concat([
      Buffer.from('{"a":1}\n', 'utf8'),
      Buffer.from('{"b":"'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('"}\n{"c":3}\n', 'utf8'),
    ]);
    await writeFile(filePath, bytes);

    const lines = await collect(new RolloutTailer(filePath));
    assert.equal(lines.length, 3);
    assert.equal(lines[0], '{"a":1}');
    assert.equal(lines[2], '{"c":3}');
    assert.ok(lines[1].includes('�'), lines[1]);
  });
});

test('a line past the size limit is dropped and reading resynchronises', async () => {
  await withTempFile(async (filePath) => {
    const oversized = `{"blob":"${'y'.repeat(80_000)}"}`;
    await writeFile(filePath, `{"first":1}\n${oversized}\n{"third":3}\n`, 'utf8');

    const tailer = new RolloutTailer(filePath, 16_000);
    const { value, lines, dropped } = await tailer.fold<string[]>([], (kept, line) => [
      ...kept,
      line,
    ]);
    assert.equal(dropped, 1);
    assert.equal(lines, 2);
    // The record after the oversized one is intact — the drop cost one line, not the rest.
    assert.deepEqual(value, ['{"first":1}', '{"third":3}']);
  });
});
