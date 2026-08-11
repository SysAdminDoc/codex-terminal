import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import {
  codexHomeDirectory,
  discoverSessions,
  exportTranscript,
  formatBytes,
  groupSessionsByProject,
  indexCheckouts,
  measureStore,
  selectNewestRollouts,
  type SessionRecord,
} from '../sessions';

test('transcript export redacts secrets by default and warns when opted out', async () => {
  const fixture = path.resolve(__dirname, '../../src/test/fixtures/transcript-secrets.jsonl');
  const safe = await exportTranscript(fixture, 'fixture');
  assert.equal(safe.redactionCount, 2);
  assert.match(safe.markdown, /Secret redactions:\*\* 2/);
  assert.doesNotMatch(safe.markdown, /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9/);
  assert.doesNotMatch(safe.markdown, /sk-proj-1234567890abcdef1234567890/);

  const unsafe = await exportTranscript(fixture, 'fixture', { redactSecrets: false });
  assert.equal(unsafe.redactionCount, 0);
  assert.match(unsafe.markdown, /Secret redaction:\*\* disabled/);
  assert.match(unsafe.markdown, /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9/);
  assert.match(unsafe.markdown, /sk-proj-1234567890abcdef1234567890/);
});

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

function record(cwd: string, id: string): SessionRecord {
  return {
    id,
    timestamp: '2026-08-10T10:00:00.000Z',
    cwd,
    filePath: `/rollouts/${id}.jsonl`,
    sizeBytes: 1,
    modifiedAt: Date.parse('2026-08-10T10:00:00.000Z'),
  };
}

test('sessions in different worktrees group under one repository', () => {
  const main = 'C:\\repos\\app';
  const feature = 'C:\\repos\\app-feature';
  const checkouts = new Map([
    [main.toLowerCase(), { repositoryRoot: main, root: main }],
    [feature.toLowerCase(), { repositoryRoot: main, root: feature, worktree: 'feature' }],
  ]);

  const [group, ...rest] = groupSessionsByProject(
    [record(main, 'a'), record(feature, 'b'), record(feature, 'c')],
    checkouts,
  );
  assert.deepEqual(rest, [], 'one repository means one group, however many worktrees');
  assert.equal(group.project, 'app');
  assert.equal(group.sessions.length, 3);
  assert.deepEqual(
    group.checkouts?.map((checkout) => `${checkout.worktree ?? 'main'}:${checkout.sessions.length}`),
    ['main:1', 'feature:2'],
  );
});

test('a repository used from one directory gains no extra level', () => {
  const main = 'C:\\repos\\app';
  const checkouts = new Map([[main.toLowerCase(), { repositoryRoot: main, root: main }]]);
  const [group] = groupSessionsByProject([record(main, 'a'), record(main, 'b')], checkouts);
  // An extra click that disambiguates nothing is worse than no extra click.
  assert.equal(group.checkouts, undefined);
  assert.equal(group.sessions.length, 2);
});

test('sessions outside any checkout still group by working directory', () => {
  const groups = groupSessionsByProject(
    [record('C:\\scratch\\one', 'a'), record('C:\\scratch\\two', 'b')],
    new Map(),
  );
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.project).sort(), ['one', 'two']);
});


/**
 * The checkout index is a `.git` walk up the tree per distinct directory, and it used to run
 * again on every debounced refresh — twice a second for the length of a Codex turn, for an
 * answer that changes only when a repository is created, moved or turned into a worktree.
 */
test('a checkout index reuses what a previous scan already resolved', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-checkout-'));
  try {
    const repository = path.join(directory, 'repo');
    await mkdir(path.join(repository, '.git'), { recursive: true });
    const sessions = [
      { id: 'a', timestamp: '', cwd: repository, filePath: 'a', sizeBytes: 0, modifiedAt: 0 },
      { id: 'b', timestamp: '', cwd: repository, filePath: 'b', sizeBytes: 0, modifiedAt: 0 },
    ];

    const first = await indexCheckouts(sessions);
    assert.equal(first.size, 1);
    const resolved = first.get(repository.toLowerCase());
    assert.ok(resolved, 'the repository should have resolved');

    // Remove the marker: a second scan from scratch would now resolve to nothing, so an
    // index that still reports the repository is one that reused the previous answer.
    await rm(path.join(repository, '.git'), { recursive: true, force: true });
    const reused = await indexCheckouts(sessions, first);
    assert.deepEqual(reused.get(repository.toLowerCase()), resolved);

    // And an explicit refresh, which passes no previous index, sees the new truth.
    const rescanned = await indexCheckouts(sessions);
    assert.equal(rescanned.get(repository.toLowerCase()), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a directory absent from the previous index is still resolved', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-checkout-'));
  try {
    const repository = path.join(directory, 'repo');
    await mkdir(path.join(repository, '.git'), { recursive: true });
    const stale = await indexCheckouts([]);
    const index = await indexCheckouts(
      [{ id: 'a', timestamp: '', cwd: repository, filePath: 'a', sizeBytes: 0, modifiedAt: 0 }],
      stale,
    );
    assert.ok(index.get(repository.toLowerCase()), 'a new directory must still be walked');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


/**
 * A missing store, an unreadable one and a genuinely empty one all produced an identical empty
 * list, an identical "No Codex sessions recorded yet" row, and nothing in the log — so the
 * most common "it does nothing" report could not be diagnosed from either.
 */
test('a store that does not exist is reported as missing, not as empty', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-store-'));
  try {
    const scans: Array<{ problem?: string }> = [];
    const sessions = await discoverSessions({ homeDirectory: home, onScan: (scan) => scans.push(scan) });
    assert.deepEqual(sessions, []);
    assert.equal(scans.length, 1);
    assert.equal(scans[0].problem, 'missing');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('a store that exists and holds nothing reports no problem at all', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-store-'));
  try {
    await mkdir(path.join(home, 'sessions', '2026', '08', '10'), { recursive: true });
    const scans: Array<{ problem?: string }> = [];
    const sessions = await discoverSessions({ homeDirectory: home, onScan: (scan) => scans.push(scan) });
    assert.deepEqual(sessions, []);
    // Empty is not a fault, and saying it is would send the operator looking for one.
    assert.equal(scans[0].problem, undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('a directory that vanishes mid-walk does not condemn the whole store', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-store-'));
  try {
    const day = path.join(home, 'sessions', '2026', '08', '10');
    await mkdir(day, { recursive: true });
    await writeFile(
      path.join(day, 'rollout-2026-08-10T10-00-00-019fe759-5303-7681-b98a-16ffcb95a268.jsonl'),
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: 'x', timestamp: '2026-08-10T10:00:00.000Z', cwd: home },
      })}\n`,
      'utf8',
    );
    const scans: Array<{ problem?: string }> = [];
    const sessions = await discoverSessions({ homeDirectory: home, onScan: (scan) => scans.push(scan) });
    assert.equal(sessions.length, 1);
    // Only the root of the scan decides the verdict.
    assert.equal(scans[0].problem, undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
