import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import {
  BIND_SKEW_MS,
  bindRollout,
  candidateDirectories,
  parseRolloutFileName,
  samePath,
  scanRollouts,
  type RolloutCandidate,
} from '../binder';

const REAL_NAME =
  'rollout-2026-08-09T12-26-58-019fe759-5303-7681-b98a-16ffcb95a268.jsonl';

test('a rollout filename yields its session id and start time', () => {
  const parsed = parseRolloutFileName(REAL_NAME);
  assert.equal(parsed?.sessionId, '019fe759-5303-7681-b98a-16ffcb95a268');
  // Codex names the file in local time even though `session_meta.timestamp` is UTC — the
  // same session is stamped 16:26:58Z inside the file. Parsing the name as ISO would put
  // the session hours away from its launch and break every match.
  assert.equal(parsed?.startedAt, new Date(2026, 7, 9, 12, 26, 58).getTime());
});

test('names that are not rollouts are rejected', () => {
  for (const name of [
    'rollout-2026-08-09T12-26-58-not-a-uuid.jsonl',
    'rollout-2026-08-09-019fe759-5303-7681-b98a-16ffcb95a268.jsonl',
    'notes.jsonl',
    'rollout-2026-08-09T12-26-58-019fe759-5303-7681-b98a-16ffcb95a268.json',
  ]) {
    assert.equal(parseRolloutFileName(name), undefined, name);
  }
});

test('paths compare case-insensitively on Windows only', () => {
  assert.equal(samePath('C:\\Repos\\App', 'c:/repos/app', 'win32'), true);
  assert.equal(samePath('C:\\Repos\\App\\', 'C:\\Repos\\App', 'win32'), true);
  assert.equal(samePath('/home/me/App', '/home/me/app', 'linux'), false);
  assert.equal(samePath('/home/me/app/', '/home/me/app', 'linux'), true);
});

function candidate(startedAt: number, filePath: string): RolloutCandidate {
  return { filePath, sessionId: path.basename(filePath), startedAt };
}

test('the earliest rollout started after the launch wins', () => {
  const launchedAt = 1_000_000;
  const found = bindRollout(
    [
      candidate(launchedAt + 5_000, 'later.jsonl'),
      candidate(launchedAt + 500, 'first.jsonl'),
    ],
    { cwd: 'C:\\repo', launchedAt },
    new Set(),
  );
  assert.equal(found?.filePath, 'first.jsonl');
});

test('a rollout that predates the launch is never bound', () => {
  const launchedAt = 1_000_000;
  const found = bindRollout(
    [candidate(launchedAt - BIND_SKEW_MS - 1, 'previous.jsonl')],
    { cwd: 'C:\\repo', launchedAt },
    new Set(),
  );
  assert.equal(found, undefined);
});

test('a rollout stamped just before the launch is still bound', () => {
  const launchedAt = 1_000_000;
  // The filename is stamped by Codex a moment before we record the launch instant, so a
  // strict comparison would leave the very session we started permanently unbound.
  const found = bindRollout(
    [candidate(launchedAt - 2_000, 'just-before.jsonl')],
    { cwd: 'C:\\repo', launchedAt },
    new Set(),
  );
  assert.equal(found?.filePath, 'just-before.jsonl');
});

test('a rollout already claimed by another tab is skipped', () => {
  const launchedAt = 1_000_000;
  const found = bindRollout(
    [candidate(launchedAt + 100, 'taken.jsonl'), candidate(launchedAt + 200, 'free.jsonl')],
    { cwd: 'C:\\repo', launchedAt },
    new Set(['taken.jsonl']),
  );
  assert.equal(found?.filePath, 'free.jsonl');
});

test('the date-sharded search covers a session that crosses midnight', () => {
  const since = new Date(2026, 7, 9, 23, 55, 0).getTime();
  const now = new Date(2026, 7, 10, 0, 5, 0).getTime();
  const directories = candidateDirectories('root', since, now).map((entry) =>
    entry.split(path.sep).slice(-3).join('/'),
  );
  assert.deepEqual(directories, ['2026/08/09', '2026/08/10']);
});

test('a same-day search looks in exactly one directory', () => {
  const since = new Date(2026, 7, 9, 9, 0, 0).getTime();
  const now = new Date(2026, 7, 9, 9, 30, 0).getTime();
  assert.equal(candidateDirectories('root', since, now).length, 1);
});

test('scanning finds only rollouts from the matching working directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-binder-'));
  try {
    const started = new Date(2026, 7, 9, 12, 26, 58);
    const day = path.join(root, '2026', '08', '09');
    await mkdir(day, { recursive: true });

    const meta = (cwd: string, id: string): string =>
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id, timestamp: '2026-08-09T16:26:58.692Z', cwd },
      })}\n{"type":"event_msg","ordinal":1,"payload":{"type":"task_started"}}\n`;

    await writeFile(path.join(day, REAL_NAME), meta('C:\\repos\\wanted', 'a'), 'utf8');
    await writeFile(
      path.join(day, 'rollout-2026-08-09T12-27-10-019fe759-5303-7681-b98a-16ffcb95a999.jsonl'),
      meta('C:\\repos\\other', 'b'),
      'utf8',
    );
    // A file that is not a rollout at all must not be opened as one.
    await writeFile(path.join(day, 'stray.jsonl'), 'garbage', 'utf8');

    const found = await scanRollouts(
      root,
      'C:\\repos\\wanted',
      started.getTime(),
      started.getTime() + 60_000,
      'win32',
    );
    assert.equal(found.length, 1);
    assert.equal(found[0].sessionId, '019fe759-5303-7681-b98a-16ffcb95a268');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scanning a directory that does not exist yet returns nothing', async () => {
  const found = await scanRollouts(
    path.join(tmpdir(), 'codex-binder-missing'),
    'C:\\repo',
    Date.now(),
    Date.now(),
    'win32',
  );
  assert.deepEqual(found, []);
});
