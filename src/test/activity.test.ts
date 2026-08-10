import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  INITIAL_ACTIVITY,
  contextUsed,
  elapsedSeconds,
  isWorking,
  reduceActivity,
  reduceActivityLine,
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
