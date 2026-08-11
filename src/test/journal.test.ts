import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import {
  JournalStore,
  MAX_CLOSED_JOURNAL_SESSIONS,
  STALE_HEARTBEAT_MS,
  emptyJournal,
  findLaunch,
  interruptedSessions,
  isCrashed,
  isDisposable,
  parseJournal,
  recoverableSessions,
  stampShutdown,
  stripMessages,
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

test('journal history retains every open session but caps closed records', () => {
  let state = emptyJournal('w');
  state = upsertSession(state, session({ key: 'open', closedAt: undefined }));
  for (let index = 0; index < MAX_CLOSED_JOURNAL_SESSIONS + 5; index += 1) {
    state = upsertSession(
      state,
      session({
        key: `closed-${index}`,
        closedAt: NOW - index,
        lastActiveAt: NOW - index,
      }),
    );
  }

  assert.equal(state.sessions.length, MAX_CLOSED_JOURNAL_SESSIONS + 1);
  assert.ok(state.sessions.some((entry) => entry.key === 'open'));
  assert.ok(state.sessions.some((entry) => entry.key === 'closed-0'));
  assert.ok(!state.sessions.some((entry) => entry.key === 'closed-204'));
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

test('pruning removes stale invalid journals but keeps a recent invalid file', async () => {
  await withStore(async (store, directory) => {
    const now = Date.now();
    const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
    const old = (now - maxAgeMs - 1_000) / 1_000;
    const recent = (now - maxAgeMs + 1_000) / 1_000;
    const corrupt = path.join(directory, 'window-corrupt.json');
    const foreign = path.join(directory, 'window-foreign.json');
    const recentCorrupt = path.join(directory, 'window-recent-corrupt.json');

    await writeFile(corrupt, '{ not json', 'utf8');
    await writeFile(
      foreign,
      JSON.stringify({ version: 99, windowId: 'foreign', heartbeatAt: now, sessions: [] }),
      'utf8',
    );
    await writeFile(recentCorrupt, '{ not json', 'utf8');
    await utimes(corrupt, old, old);
    await utimes(foreign, old, old);
    await utimes(recentCorrupt, recent, recent);

    assert.equal(await store.prune(now, maxAgeMs), 2);
    assert.deepEqual(await readdir(directory), ['window-recent-corrupt.json']);
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

test('a shutdown stamp closes every open session and clears the crashed signal', () => {
  const before = journal({
    heartbeatAt: NOW - 300_000,
    sessions: [
      session({ key: 'w-1', closedAt: undefined }),
      session({ key: 'w-2', closedAt: NOW - 60_000 }),
    ],
  });

  const after = stampShutdown(before, NOW);

  assert.equal(after.cleanShutdownAt, NOW);
  assert.equal(after.heartbeatAt, NOW);
  assert.equal(after.sessions[0].closedAt, NOW, 'an open session is closed at the stamp');
  assert.equal(after.sessions[1].closedAt, NOW - 60_000, 'an already-closed session keeps its time');
  assert.equal(isCrashed(after, NOW + STALE_HEARTBEAT_MS * 10), false);
  assert.deepEqual(recoverableSessions(after), [], 'nothing is left to offer back');
});

test('the shutdown stamp is written without awaiting anything', async (t) => {
  // `deactivate` gets no promise honoured by the host, so the stamp has to land on the
  // synchronous path or it does not land at all.
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-journal-sync-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JournalStore(directory, 'window-a');

  store.writeSync(stampShutdown(journal({ sessions: [session()] }), NOW));

  const [written] = await store.readAll();
  assert.equal(written.cleanShutdownAt, NOW);
  assert.equal(written.sessions[0].closedAt, NOW);
  assert.deepEqual(
    (await readdir(directory)).filter((entry) => entry.endsWith('.tmp')),
    [],
    'the temporary file is renamed away, not left behind',
  );
});

test('a launch is found across journals by the key stamped into its terminal', () => {
  const other = journal({ windowId: 'other', sessions: [session({ key: 'other-1' })] });
  const mine = journal({
    windowId: 'mine',
    sessions: [session({ key: 'mine-1', sessionId: 'wanted' }), session({ key: 'mine-2' })],
  });

  assert.equal(findLaunch([other, mine], 'mine-1')?.sessionId, 'wanted');
  assert.equal(findLaunch([other, mine], 'nobody-9'), undefined);
});

test('a launch closed by a reload is still findable', () => {
  // The outgoing window stamps every session closed on its way out. Honouring that here
  // would reject exactly the records this lookup exists to find.
  const state = stampShutdown(journal({ sessions: [session({ key: 'w-1' })] }), NOW);
  assert.equal(findLaunch([state], 'w-1')?.sessionId, session().sessionId);
});

test('a launch recorded by two windows resolves to the newer record', () => {
  const older = journal({
    windowId: 'a',
    sessions: [session({ key: 'shared', lastActiveAt: NOW - 300_000, completedTurns: 1 })],
  });
  const newer = journal({
    windowId: 'b',
    sessions: [session({ key: 'shared', lastActiveAt: NOW - 10_000, completedTurns: 7 })],
  });
  assert.equal(findLaunch([older, newer], 'shared')?.completedTurns, 7);
  assert.equal(findLaunch([newer, older], 'shared')?.completedTurns, 7);
});


/**
 * `journal.storeMessages: false` used to stop only *new* text being written. `upsertSession`
 * merges over the previous record, so a message already on disk survived every later update
 * and sat there for the full retention window: the setting read as an opt-out and behaved as
 * a tap.
 */
test('turning message storage off removes text that is already recorded', () => {
  const before = upsertSession(
    upsertSession(emptyJournal('w1'), session({ key: 'a', lastMessage: 'the secret plan' })),
    session({ key: 'b' }),
  );
  const after = stripMessages(before);
  assert.equal(after.sessions.length, 2);
  assert.ok(!JSON.stringify(after).includes('the secret plan'));
  assert.ok(!('lastMessage' in after.sessions[0]));
  // Everything that is not conversation text is untouched — recovery still needs it.
  assert.equal(after.sessions[0].key, 'a');
  assert.equal(after.sessions[0].launchedAt, NOW - 600_000);
  assert.equal(after.sessions[0].sessionId, '019fe759-5303-7681-b98a-16ffcb95a268');
});

test('stripping a journal with no text at all returns it unchanged', () => {
  // Identity, so the rewrite pass can skip files that would not change.
  const state = upsertSession(emptyJournal('w1'), session({ key: 'a' }));
  assert.equal(stripMessages(state), state);
});

test('an update with the setting off overwrites the recorded message', () => {
  // The merge is what made this subtle: omitting the key preserves the old value, so the
  // key has to be present and undefined.
  const stored = upsertSession(
    emptyJournal('w1'),
    session({ key: 'a', lastMessage: 'the secret plan' }),
  );
  const updated = upsertSession(stored, session({ key: 'a', lastMessage: undefined }));
  assert.equal(updated.sessions[0].lastMessage, undefined);
  assert.ok(!JSON.stringify(updated).includes('the secret plan'));
});


test('every window\'s journal on disk is rewritten, not just this one\'s', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-journal-strip-'));
  try {
    const mine = new JournalStore(directory, 'w1');
    await mine.write(upsertSession(emptyJournal('w1'), session({ lastMessage: 'mine' })));
    const theirs = new JournalStore(directory, 'w2');
    await theirs.write(upsertSession(emptyJournal('w2'), session({ lastMessage: 'theirs' })));
    // Not a journal, and not to be touched.
    await writeFile(path.join(directory, 'notes.txt'), 'theirs', 'utf8');

    // They share a directory, so a setting that says text is not stored has to be true of
    // what is on disk rather than of what this process writes next.
    const rewritten = await mine.stripMessagesEverywhere();
    assert.equal(rewritten, 2);

    for (const entry of await readdir(directory)) {
      const contents = await readFile(path.join(directory, entry), 'utf8');
      if (entry.endsWith('.json')) {
        assert.ok(!contents.includes('mine'), entry);
        assert.ok(!contents.includes('theirs'), entry);
        // Still a journal: recovery needs everything that is not conversation text.
        assert.ok(parseJournal(contents)?.sessions.length === 1, entry);
      } else {
        assert.equal(contents, 'theirs');
      }
    }

    // Nothing left to do the second time, which is what lets the caller log a real count.
    assert.equal(await mine.stripMessagesEverywhere(), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
