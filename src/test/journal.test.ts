import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import {
  JournalStore,
  STALE_HEARTBEAT_MS,
  emptyJournal,
  interruptedSessions,
  isCrashed,
  isDisposable,
  parseJournal,
  recoverableSessions,
  upsertSession,
  type JournalSession,
  type JournalState,
} from '../journal';

const NOW = 1_786_000_000_000;

function session(overrides: Partial<JournalSession> = {}): JournalSession {
  return {
    key: 'w-1',
    sessionId: '019fe759-5303-7681-b98a-16ffcb95a268',
    rolloutPath: 'C:\\Users\\me\\.codex\\sessions\\2026\\08\\09\\rollout.jsonl',
    cwd: 'C:\\Users\\me\\repos\\codex-terminal',
    project: 'codex-terminal',
    label: 'codex-terminal — Codex',
    mode: 'new',
    launchedAt: NOW - 600_000,
    lastActiveAt: NOW - 120_000,
    status: 'idle',
    completedTurns: 3,
    ...overrides,
  };
}

function journal(overrides: Partial<JournalState> = {}): JournalState {
  return { ...emptyJournal('window-a'), heartbeatAt: NOW, sessions: [session()], ...overrides };
}

test('a session is inserted once and then updated in place', () => {
  const first = upsertSession(emptyJournal('w'), session());
  const second = upsertSession(first, session({ status: 'working', completedTurns: 4 }));
  assert.equal(second.sessions.length, 1);
  assert.equal(second.sessions[0].status, 'working');
  assert.equal(second.sessions[0].completedTurns, 4);
});

test('a window that heartbeat recently is not treated as crashed', () => {
  assert.equal(isCrashed(journal({ heartbeatAt: NOW - 1_000 }), NOW), false);
});

test('a stale heartbeat with no clean shutdown is a crash', () => {
  assert.equal(isCrashed(journal({ heartbeatAt: NOW - STALE_HEARTBEAT_MS - 1 }), NOW), true);
});

test('a clean shutdown is never a crash, however old', () => {
  const state = journal({ heartbeatAt: NOW - 86_400_000, cleanShutdownAt: NOW - 86_400_000 });
  assert.equal(isCrashed(state, NOW), false);
});

test('only sessions still open and bound to a rollout can be recovered', () => {
  const state = journal({
    sessions: [
      session({ key: 'open' }),
      session({ key: 'closed', closedAt: NOW - 60_000 }),
      // A launch that never produced a rollout has no conversation to return to.
      session({ key: 'unbound', sessionId: undefined }),
    ],
  });
  assert.deepEqual(
    recoverableSessions(state).map((entry) => entry.key),
    ['open'],
  );
});

test('a window never offers to recover its own sessions', () => {
  const own = journal({ windowId: 'me', heartbeatAt: NOW - STALE_HEARTBEAT_MS - 1 });
  assert.deepEqual(interruptedSessions([own], NOW, 'me'), []);
});

test('crashed windows surface their sessions, newest first', () => {
  const older = journal({
    windowId: 'a',
    heartbeatAt: NOW - 200_000,
    sessions: [session({ key: 'a1', sessionId: 'aaa', lastActiveAt: NOW - 300_000 })],
  });
  const newer = journal({
    windowId: 'b',
    heartbeatAt: NOW - 200_000,
    sessions: [session({ key: 'b1', sessionId: 'bbb', lastActiveAt: NOW - 100_000 })],
  });
  const found = interruptedSessions([older, newer], NOW, 'me');
  assert.deepEqual(
    found.map((entry) => entry.sessionId),
    ['bbb', 'aaa'],
  );
});

test('a session recorded by two crashed windows is offered once, from the newer record', () => {
  const first = journal({
    windowId: 'a',
    heartbeatAt: NOW - 200_000,
    sessions: [session({ key: 'a1', lastActiveAt: NOW - 300_000, completedTurns: 1 })],
  });
  const second = journal({
    windowId: 'b',
    heartbeatAt: NOW - 200_000,
    sessions: [session({ key: 'b1', lastActiveAt: NOW - 100_000, completedTurns: 9 })],
  });
  const found = interruptedSessions([first, second], NOW, 'me');
  assert.equal(found.length, 1);
  assert.equal(found[0].completedTurns, 9);
});

test('a live window is left alone even when it has open sessions', () => {
  const live = journal({ windowId: 'other', heartbeatAt: NOW - 5_000 });
  assert.deepEqual(interruptedSessions([live], NOW, 'me'), []);
});

test('disposable journals exclude our own and anything still beating', () => {
  const week = 7 * 24 * 60 * 60 * 1000;
  assert.equal(isDisposable(journal({ windowId: 'me' }), NOW, 'me', week), false);
  assert.equal(isDisposable(journal({ heartbeatAt: NOW - 1_000 }), NOW, 'me', week), false);
  // Cleanly closed: nothing left to offer, so it can go.
  assert.equal(
    isDisposable(
      journal({ heartbeatAt: NOW - 200_000, cleanShutdownAt: NOW - 200_000 }),
      NOW,
      'me',
      week,
    ),
    true,
  );
  // A crash older than the retention window stops being useful.
  assert.equal(isDisposable(journal({ heartbeatAt: NOW - week - 1 }), NOW, 'me', week), true);
  // A recent crash must survive so it can still be offered.
  assert.equal(isDisposable(journal({ heartbeatAt: NOW - 200_000 }), NOW, 'me', week), false);
});

test('malformed and foreign-version journals are rejected, not half-read', () => {
  assert.equal(parseJournal('not json'), undefined);
  assert.equal(parseJournal('[]'), undefined);
  assert.equal(parseJournal(JSON.stringify({ version: 99, windowId: 'a', heartbeatAt: 1, sessions: [] })), undefined);
  assert.equal(parseJournal(JSON.stringify({ version: 1, windowId: 'a', heartbeatAt: 1 })), undefined);
  assert.ok(parseJournal(JSON.stringify(journal())));
});

async function withStore(
  body: (store: JournalStore, directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-journal-'));
  try {
    await body(new JournalStore(directory, 'window-a'), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('a journal round-trips through the store', async () => {
  await withStore(async (store) => {
    await store.write(journal());
    const all = await store.readAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].sessions[0].project, 'codex-terminal');
  });
});

test('unreadable files in the directory do not break a read', async () => {
  await withStore(async (store, directory) => {
    await store.write(journal());
    await writeFile(path.join(directory, 'window-broken.json'), '{ not json', 'utf8');
    await writeFile(path.join(directory, 'unrelated.txt'), 'ignore me', 'utf8');
    assert.equal((await store.readAll()).length, 1);
  });
});

test('marking a crash handled stops it being offered again', async () => {
  await withStore(async (store, directory) => {
    const crashed = journal({ windowId: 'dead', heartbeatAt: NOW - 200_000 });
    await new JournalStore(directory, 'dead').write(crashed);

    assert.equal(interruptedSessions(await store.readAll(), NOW, 'window-a').length, 1);
    await store.markHandled(['dead']);
    assert.equal(interruptedSessions(await store.readAll(), NOW, 'window-a').length, 0);
  });
});

test('pruning removes finished journals and keeps a recent crash', async () => {
  await withStore(async (store, directory) => {
    await new JournalStore(directory, 'clean').write(
      journal({ windowId: 'clean', heartbeatAt: NOW - 200_000, cleanShutdownAt: NOW - 200_000 }),
    );
    await new JournalStore(directory, 'crashed').write(
      journal({ windowId: 'crashed', heartbeatAt: Date.now() - 200_000 }),
    );

    await store.prune(Date.now(), 7 * 24 * 60 * 60 * 1000);
    const remaining = (await readdir(directory)).filter((entry) => entry.endsWith('.json'));
    assert.deepEqual(remaining, ['window-crashed.json']);
  });
});

test('a window id cannot escape the journal directory', async () => {
  await withStore(async (_store, directory) => {
    const hostile = new JournalStore(directory, '../../escaped');
    await hostile.write(emptyJournal('../../escaped'));
    const entries = await readdir(directory);
    assert.equal(entries.length, 1);
    assert.ok(entries[0].startsWith('window-'));
    assert.ok(!entries[0].includes('..'));
    // Written where we expected, not two directories up.
    assert.ok(await readFile(path.join(directory, entries[0]), 'utf8'));
  });
});
