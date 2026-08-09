import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { discoverSessions } from '../sessions';

test('session discovery reads metadata headers, sorts newest first, and skips malformed files', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-terminal-sessions-'));
  try {
    const directory = path.join(home, '.codex', 'sessions', '2026', '08', '09');
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
    const directory = path.join(home, '.codex', 'sessions');
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
