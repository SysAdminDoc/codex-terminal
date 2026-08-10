import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import {
  codexHomeDirectory,
  discoverSessions,
  formatBytes,
  groupSessionsByProject,
  measureStore,
  selectNewestRollouts,
} from '../sessions';

test('session discovery reads metadata headers, sorts newest first, and skips malformed files', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-terminal-sessions-'));
  try {
    const directory = path.join(home, 'sessions', '2026', '08', '09');
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'old.jsonl'),
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: 'old', timestamp: '2026-08-09T10:00:00.000Z', cwd: 'C:\\old' },
      })}\nlarge conversation body is intentionally not parsed\n`,
    );
    await writeFile(
      path.join(directory, 'new.jsonl'),
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: 'new', timestamp: '2026-08-09T11:00:00.000Z', cwd: 'C:\\new' },
      })}\n`,
    );
    await writeFile(path.join(directory, 'broken.jsonl'), 'not json\n');
    const sessions = await discoverSessions({ homeDirectory: home });
    assert.deepEqual(
      sessions.map((session) => ({ id: session.id, cwd: session.cwd })),
      [
        { id: 'new', cwd: 'C:\\new' },
        { id: 'old', cwd: 'C:\\old' },
      ],
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('session discovery respects the result limit', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-terminal-sessions-'));
  try {
    const directory = path.join(home, 'sessions');
    await mkdir(directory, { recursive: true });
    for (const [index, hour] of [12, 11, 10].entries()) {
      await writeFile(
        path.join(directory, `${index}.jsonl`),
        `${JSON.stringify({
          type: 'session_meta',
          payload: {
            id: String(index),
            timestamp: `2026-08-09T${hour}:00:00.000Z`,
            cwd: 'C:\\workspace',
          },
        })}\n`,
      );
    }
    const sessions = await discoverSessions({ homeDirectory: home, maxResults: 2 });
    assert.deepEqual(sessions.map((session) => session.id), ['0', '1']);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('session discovery extracts the first real prompt and groups by project', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-terminal-sessions-'));
  try {
    const directory = path.join(home, 'sessions', '2026', '08', '09');
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'conversation.jsonl'),
      [
        JSON.stringify({
          type: 'session_meta',
          payload: {
            id: 'conversation',
            timestamp: '2026-08-09T12:00:00.000Z',
            cwd: 'C:\\Users\\--\\repos\\codex-terminal',
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '<environment_context>injected</environment_context>' }],
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Add the history sidebar' }],
          },
        }),
      ].join('\n'),
    );
    const sessions = await discoverSessions({ homeDirectory: home });
    assert.equal(sessions[0]?.preview, 'Add the history sidebar');
    assert.deepEqual(groupSessionsByProject(sessions).map((group) => group.project), [
      'codex-terminal',
    ]);
    assert.equal(codexHomeDirectory(home), home);
    assert.equal(codexHomeDirectory(undefined, 'C:\\codex-state'), 'C:\\codex-state');
    assert.equal(codexHomeDirectory(undefined, undefined), path.join(os.homedir(), '.codex'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('the scan cost is bounded by maxResults, not by the size of the store', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-terminal-scale-'));
  try {
    const directory = path.join(home, 'sessions', '2026', '08', '09');
    await mkdir(directory, { recursive: true });

    // A body far larger than the head the reader is allowed to touch. If selection happened
    // after reading, 1,000 of these would be opened to display 20.
    const body = 'x'.repeat(64 * 1024);
    for (let index = 0; index < 1000; index += 1) {
      const minute = String(index % 60).padStart(2, '0');
      const second = String(Math.floor(index / 60)).padStart(2, '0');
      const id = `019fe759-5303-7681-b98a-${String(index).padStart(12, '0')}`;
      await writeFile(
        path.join(directory, `rollout-2026-08-09T10-${minute}-${second}-${id}.jsonl`),
        `${JSON.stringify({
          type: 'session_meta',
          payload: { id, timestamp: `2026-08-09T10:${minute}:${second}.000Z`, cwd: 'C:\repo' },
        })}\n${body}\n`,
      );
    }

    const started = Date.now();
    const sessions = await discoverSessions({ homeDirectory: home, maxResults: 20 });
    const elapsed = Date.now() - started;

    assert.equal(sessions.length, 20);
    assert.ok(elapsed < 2000, `refresh over 1000 rollouts took ${elapsed}ms`);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('rollouts sharing a session id collapse to the newest before anything is read', () => {
  const files = [
    { filePath: 'a', sessionId: 'same', startedAt: 100 },
    { filePath: 'b', sessionId: 'same', startedAt: 300 },
    { filePath: 'c', sessionId: 'other', startedAt: 200 },
  ];
  assert.deepEqual(
    selectNewestRollouts(files, 10).map((file) => file.filePath),
    ['b', 'c'],
  );
});

test('a rollout with an unrecognised filename is kept but sorted last', () => {
  const files = [
    { filePath: 'strange.jsonl', startedAt: 0 },
    { filePath: 'named', sessionId: 'x', startedAt: 500 },
  ];
  assert.deepEqual(
    selectNewestRollouts(files, 10).map((file) => file.filePath),
    ['named', 'strange.jsonl'],
  );
  // It must still be reachable when the cap allows it, or a differently-named rollout
  // would become permanently invisible.
  assert.equal(selectNewestRollouts(files, 1).length, 1);
});

test('store usage counts every rollout without opening any of them', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-terminal-usage-'));
  try {
    const directory = path.join(home, 'sessions', '2026', '08', '09');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'a.jsonl'), 'x'.repeat(2048));
    await writeFile(path.join(directory, 'b.jsonl'), 'y'.repeat(1024));
    // Not a rollout, so it must not be counted against Codex's store.
    await writeFile(path.join(directory, 'notes.txt'), 'z'.repeat(9999));

    const usage = await measureStore(home);
    assert.equal(usage.fileCount, 2);
    assert.equal(usage.totalBytes, 3072);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('an absent store reports zero rather than failing', async () => {
  const usage = await measureStore(path.join(os.tmpdir(), 'codex-terminal-missing-store'));
  assert.deepEqual(usage, { fileCount: 0, totalBytes: 0 });
});

test('sizes stay readable from bytes to gigabytes', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  // The measured local store was 2.01 GB; a store this size must not render as "2058 MB".
  assert.equal(formatBytes(2.01 * 1024 * 1024 * 1024), '2.01 GB');
});
