import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  INITIAL_ACTIVITY,
  MAX_SUBJECT_LENGTH,
  contextUsed,
  elapsedSeconds,
  isStalled,
  isWorking,
  reduceActivity,
  reduceActivityLine,
  settleActivity,
  silentFor,
  SILENT_AFTER_SECONDS,
} from '../activity';

/**
 * Fixtures copied from a real rollout (`~/.codex/sessions/2026/08/09/…`), including the
 * exact field spellings — `started_at` in unix *seconds*, `turn_id`, the nested
 * `info.total_token_usage.total_tokens` — because every one of those is a place a
 * plausible-looking guess would silently produce an always-idle session.
 */
const TASK_STARTED = JSON.stringify({
  timestamp: '2026-08-09T16:27:34.545Z',
  ordinal: 1,
  type: 'event_msg',
  payload: {
    type: 'task_started',
    turn_id: '019fe759-df05-7d01-bbb4-5895318198e3',
    started_at: 1786292854,
    model_context_window: 258400,
  },
});

const TOKEN_COUNT = JSON.stringify({
  timestamp: '2026-08-09T16:28:00.229Z',
  ordinal: 21,
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: 15667, output_tokens: 1138, total_tokens: 16805 },
      model_context_window: 258400,
    },
  },
});

const TURN_ABORTED = JSON.stringify({
  timestamp: '2026-08-09T16:28:14.550Z',
  ordinal: 31,
  type: 'event_msg',
  payload: {
    type: 'turn_aborted',
    turn_id: '019fe759-df05-7d01-bbb4-5895318198e3',
    reason: 'interrupted',
  },
});

const TASK_COMPLETE = JSON.stringify({
  timestamp: '2026-08-09T16:28:31.222Z',
  ordinal: 42,
  type: 'event_msg',
  payload: {
    type: 'task_complete',
    turn_id: '019fe75a-7b59-7970-a727-738e1adc4df6',
    last_agent_message: 'There were no code errors in the output.',
  },
});

const RESPONSE_ITEM = JSON.stringify({
  timestamp: '2026-08-09T16:27:40.000Z',
  ordinal: 5,
  type: 'response_item',
  payload: { type: 'message', role: 'assistant', content: [{ text: 'hello' }] },
});

test('a started task reports working, with the turn and context window', () => {
  const state = reduceActivityLine(INITIAL_ACTIVITY, TASK_STARTED);
  assert.equal(state.status, 'working');
  assert.ok(isWorking(state));
  assert.equal(state.turnId, '019fe759-df05-7d01-bbb4-5895318198e3');
  assert.equal(state.contextWindow, 258400);
  // `started_at` is unix seconds; treating it as milliseconds would date the turn to 1970
  // and render an elapsed time of half a century.
  assert.equal(state.turnStartedAt, 1786292854000);
});

test('a completed task returns to idle and counts the turn', () => {
  const state = reduceActivity(INITIAL_ACTIVITY, [TASK_STARTED, TASK_COMPLETE]);
  assert.equal(state.status, 'idle');
  assert.equal(state.completedTurns, 1);
  assert.equal(state.lastMessage, 'There were no code errors in the output.');
  assert.equal(state.turnStartedAt, undefined);
  assert.ok(!isWorking(state));
});

test('an aborted turn is distinguished from a completed one', () => {
  const state = reduceActivity(INITIAL_ACTIVITY, [TASK_STARTED, TURN_ABORTED]);
  assert.equal(state.status, 'aborted');
  assert.equal(state.abortReason, 'interrupted');
  // An abort is not a completed turn; counting it would inflate the session summary.
  assert.equal(state.completedTurns, 0);
});

test('a new turn after an abort clears the abort reason', () => {
  const restarted = JSON.stringify({
    ordinal: 50,
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: 'next', started_at: 1786292900 },
  });
  const state = reduceActivity(INITIAL_ACTIVITY, [TASK_STARTED, TURN_ABORTED, restarted]);
  assert.equal(state.status, 'working');
  assert.equal(state.abortReason, undefined);
});

test('token counts feed the context gauge without changing the status', () => {
  const state = reduceActivity(INITIAL_ACTIVITY, [TASK_STARTED, TOKEN_COUNT]);
  assert.equal(state.status, 'working');
  assert.equal(state.totalTokens, 16805);
  const used = contextUsed(state);
  assert.ok(used !== undefined && used > 0.06 && used < 0.07);
});

test('conversation records and malformed lines leave the status alone', () => {
  const working = reduceActivityLine(INITIAL_ACTIVITY, TASK_STARTED);
  for (const line of [RESPONSE_ITEM, '', '   ', 'not json at all', '{"type":"event_msg"}']) {
    assert.equal(reduceActivityLine(working, line).status, 'working');
  }
});

test('a line re-read after a partial write is not folded twice', () => {
  const once = reduceActivity(INITIAL_ACTIVITY, [TASK_STARTED, TASK_COMPLETE]);
  // A tailer that re-reads the same bytes must not report a second completed turn.
  const twice = reduceActivity(once, [TASK_STARTED, TASK_COMPLETE]);
  assert.equal(twice.completedTurns, 1);
  assert.equal(twice.status, 'idle');
});

test('elapsed time is reported only while a turn is running', () => {
  const working = reduceActivityLine(INITIAL_ACTIVITY, TASK_STARTED);
  assert.equal(elapsedSeconds(working, 1786292854000 + 42_000), 42);

  const idle = reduceActivityLine(working, TASK_COMPLETE);
  assert.equal(elapsedSeconds(idle, Date.now()), undefined);
});

test('the context gauge stays absent until both numbers are known', () => {
  assert.equal(contextUsed(INITIAL_ACTIVITY), undefined);
  assert.equal(contextUsed({ ...INITIAL_ACTIVITY, totalTokens: 100 }), undefined);
  assert.equal(contextUsed({ ...INITIAL_ACTIVITY, contextWindow: 1000 }), undefined);
});

test('a compaction does not disturb the activity state', () => {
  // Compaction happens mid-turn. Treating it as a turn boundary would report a working
  // session as idle for the rest of its life.
  const working = reduceActivityLine(INITIAL_ACTIVITY, TASK_STARTED);
  const after = reduceActivityLine(
    working,
    JSON.stringify({
      ordinal: 664,
      type: 'compacted',
      payload: { message: '', replacement_history: [{ type: 'message' }] },
    }),
  );
  assert.equal(after.status, 'working');
  assert.equal(after.turnId, working.turnId);
});

test('silence is measured only while a session claims to be working', () => {
  const working = reduceActivityLine(INITIAL_ACTIVITY, TASK_STARTED);
  const lastEvent = Date.parse('2026-08-09T16:27:34.545Z');
  assert.equal(silentFor(working, lastEvent + 90_000), 90);

  // An idle session is not silent, it is finished; reporting silence would imply a hang.
  assert.equal(silentFor(reduceActivityLine(working, TASK_COMPLETE), Date.now()), undefined);
});

test('a working session becomes stalled only past the threshold', () => {
  const working = reduceActivityLine(INITIAL_ACTIVITY, TASK_STARTED);
  const lastEvent = Date.parse('2026-08-09T16:27:34.545Z');
  assert.equal(isStalled(working, lastEvent + 10_000, 45), false);
  assert.equal(isStalled(working, lastEvent + 45_000, 45), true);
});

/**
 * `item_completed` fixtures.
 *
 * Field spellings are taken from real rollouts (`type: "CommandExecution"` in PascalCase,
 * `changes` keyed by absolute path, `Extension` carrying `query`); the *content* is
 * synthetic, because the real lines hold the operator's prompts and repository paths and
 * this repository is public.
 */
function itemLine(ordinal: number, item: unknown): string {
  return JSON.stringify({
    timestamp: '2026-08-10T12:02:11.001Z',
    ordinal,
    type: 'event_msg',
    payload: { type: 'item_completed', item },
  });
}

test('a shell command is reduced to the script, not the interpreter path', () => {
  const state = reduceActivityLine(
    INITIAL_ACTIVITY,
    itemLine(1, {
      type: 'CommandExecution',
      id: 'exec-1',
      command: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', '-Command', 'npm run   check'],
    }),
  );
  assert.equal(state.lastItem?.kind, 'command');
  // Whitespace collapsed, and the 40-character pwsh path that prefixes every single
  // command dropped — otherwise every row reads identically.
  assert.equal(state.lastItem?.subject, 'npm run check');
});

test('a non-shell command keeps its own name and arguments', () => {
  const state = reduceActivityLine(
    INITIAL_ACTIVITY,
    itemLine(1, { type: 'CommandExecution', id: 'e', command: ['/usr/bin/git', 'status', '-sb'] }),
  );
  assert.equal(state.lastItem?.subject, 'git status -sb');
});

test('file changes are named by basename and counted past the second', () => {
  const one = reduceActivityLine(
    INITIAL_ACTIVITY,
    itemLine(1, {
      type: 'FileChange',
      id: 'e',
      changes: { 'C:\\repos\\app\\src\\monitor.ts': { type: 'update', content: 'x' } },
    }),
  );
  assert.equal(one.lastItem?.kind, 'fileChange');
  assert.equal(one.lastItem?.subject, 'monitor.ts');

  const many = reduceActivityLine(
    INITIAL_ACTIVITY,
    itemLine(1, {
      type: 'FileChange',
      id: 'e',
      changes: {
        '/repo/a.ts': { type: 'add' },
        '/repo/b.ts': { type: 'update' },
        '/repo/c.ts': { type: 'delete' },
        '/repo/d.ts': { type: 'add' },
      },
    }),
  );
  assert.equal(many.lastItem?.subject, 'a.ts, b.ts +2 more');
});

test('a web search reports its query and a compaction reports itself', () => {
  const search = reduceActivityLine(
    INITIAL_ACTIVITY,
    itemLine(1, { type: 'Extension', kind: 'web.search', id: 'e', query: 'vscode terminal api' }),
  );
  assert.equal(search.lastItem?.kind, 'search');
  assert.equal(search.lastItem?.subject, 'vscode terminal api');

  const compaction = reduceActivityLine(
    INITIAL_ACTIVITY,
    itemLine(1, { type: 'ContextCompaction', id: 'e' }),
  );
  assert.deepEqual(compaction.lastItem, { kind: 'compaction', subject: '' });
});

test('an over-long subject is truncated rather than allowed to fill the row', () => {
  const state = reduceActivityLine(
    INITIAL_ACTIVITY,
    itemLine(1, { type: 'CommandExecution', id: 'e', command: ['git', 'x'.repeat(500)] }),
  );
  assert.ok((state.lastItem?.subject.length ?? 0) <= MAX_SUBJECT_LENGTH);
  assert.ok(state.lastItem?.subject.endsWith('…'));
});

test('an unrecognised item kind leaves the previous step in place', () => {
  const first = reduceActivityLine(
    INITIAL_ACTIVITY,
    itemLine(1, { type: 'CommandExecution', id: 'e', command: ['git', 'status'] }),
  );
  // A future Codex release adding an item type must cost the display nothing.
  const second = reduceActivityLine(first, itemLine(2, { type: 'SomethingNewIn2027', id: 'e' }));
  assert.equal(second.lastItem?.subject, 'git status');
  assert.equal(second.ordinal, 2, 'the record is still folded, only its item is unknown');
});

test('a malformed item does not throw or wipe the state', () => {
  const first = reduceActivityLine(
    INITIAL_ACTIVITY,
    itemLine(1, { type: 'CommandExecution', id: 'e', command: ['git', 'status'] }),
  );
  for (const broken of [null, 'text', 42, { type: 'FileChange', changes: null }]) {
    const next = reduceActivityLine(first, itemLine(first.ordinal + 1, broken));
    assert.ok(next, 'folding a malformed item must not throw');
  }
  assert.equal(
    reduceActivityLine(first, itemLine(2, { type: 'FileChange', changes: null })).lastItem?.subject,
    '',
  );
});

test('a turn that stops reporting is no longer counted as working', () => {
  const working = reduceActivity(INITIAL_ACTIVITY, [TASK_STARTED]);
  const startedAt = Date.parse(working.lastEventAt as string);

  // Inside the window that real turns actually go quiet for, the claim stands. The largest
  // intra-turn gap measured across 25 real sessions was 269s.
  const stillWorking = settleActivity(working, startedAt + 300_000, 45);
  assert.equal(stillWorking.status, 'working');
  assert.equal(stillWorking, working, 'an unchanged state is returned by identity');

  const settled = settleActivity(working, startedAt + SILENT_AFTER_SECONDS * 1000 + 1, 45);
  assert.equal(settled.status, 'silent');
  assert.equal(isWorking(settled), false, 'the badge and spinner must stop counting it');
});

test('giving up never happens sooner than the operator asked to be told about silence', () => {
  const working = reduceActivity(INITIAL_ACTIVITY, [TASK_STARTED]);
  const startedAt = Date.parse(working.lastEventAt as string);
  // An operator who raises the stall threshold is saying their sessions go quiet for longer.
  const patient = settleActivity(working, startedAt + 700_000, 3600);
  assert.equal(patient.status, 'working');
  assert.equal(settleActivity(working, startedAt + 7_300_000, 3600).status, 'silent');
});

test('elapsed silence is still reported once a session has been given up on', () => {
  const working = reduceActivity(INITIAL_ACTIVITY, [TASK_STARTED]);
  const startedAt = Date.parse(working.lastEventAt as string);
  const now = startedAt + SILENT_AFTER_SECONDS * 1000 + 60_000;
  const settled = settleActivity(working, now, 45);
  // The elapsed silence is the single most useful thing left to say about it.
  assert.equal(silentFor(settled, now), Math.floor((now - startedAt) / 1000));
});

test('one new record disproves silence and the session works again', () => {
  const working = reduceActivity(INITIAL_ACTIVITY, [TASK_STARTED]);
  const startedAt = Date.parse(working.lastEventAt as string);
  const settled = settleActivity(working, startedAt + 3_600_000, 45);
  assert.equal(settled.status, 'silent');

  // An answered approval prompt resumes the turn without a fresh task_started.
  const resumed = reduceActivityLine(
    settled,
    itemLine(settled.ordinal + 1, { type: 'CommandExecution', id: 'e', command: ['git', 'log'] }),
  );
  assert.equal(resumed.status, 'working');
  assert.equal(resumed.lastItem?.subject, 'git log');
});

test('a completed turn after silence still lands as idle, not working', () => {
  const working = reduceActivity(INITIAL_ACTIVITY, [TASK_STARTED]);
  const startedAt = Date.parse(working.lastEventAt as string);
  const settled = settleActivity(working, startedAt + 3_600_000, 45);
  const done = reduceActivity(settled, [TASK_COMPLETE]);
  assert.equal(done.status, 'idle');
});
