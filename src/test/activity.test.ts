import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import {
  INITIAL_ACTIVITY,
  MAX_SUBJECT_LENGTH,
  activityStatusFromIndexedTurn,
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
import { parseSessionMeta, rolloutSchemaGeneration } from '../transcript';

function fixtureLines(name: string): string[] {
  return readFileSync(path.resolve(__dirname, '../../src/test/fixtures', name), 'utf8')
    .trim()
    .split(/\r?\n/);
}

test('SQLite turn states map to the live activity vocabulary', () => {
  assert.equal(activityStatusFromIndexedTurn('inProgress'), 'working');
  assert.equal(activityStatusFromIndexedTurn('interrupted'), 'aborted');
  assert.equal(activityStatusFromIndexedTurn('failed'), 'aborted');
  assert.equal(activityStatusFromIndexedTurn('completed'), 'idle');
  assert.equal(activityStatusFromIndexedTurn('future-status'), undefined);
});

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
      // On the first turn the last request *is* the whole session, so both blocks agree.
      // That coincidence is why dividing the lifetime total by the window looked correct.
      last_token_usage: { input_tokens: 15667, output_tokens: 1138, total_tokens: 16805 },
      model_context_window: 258400,
    },
  },
});

/** Verbatim from a 0.147 rollout: the model lives here and nowhere else. */
const TURN_CONTEXT = JSON.stringify({
  timestamp: '2026-08-09T16:27:35.000Z',
  ordinal: 5,
  type: 'turn_context',
  payload: {
    turn_id: '019fe870-ca21-74d2-bc32-487db19d3325',
    cwd: 'C:\\Users\\me',
    approval_policy: 'never',
    model: 'gpt-5.6-luna',
  },
});

/** The same record with the fields a cost estimate needs, cache split and plan included. */
const TOKEN_COUNT_FULL = JSON.stringify({
  timestamp: '2026-08-09T16:28:01.229Z',
  ordinal: 22,
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: 14434,
        cached_input_tokens: 9984,
        cache_write_input_tokens: 0,
        output_tokens: 689,
        reasoning_output_tokens: 445,
        total_tokens: 15123,
      },
      last_token_usage: {
        input_tokens: 14434,
        cached_input_tokens: 9984,
        cache_write_input_tokens: 0,
        output_tokens: 689,
        reasoning_output_tokens: 445,
        total_tokens: 15123,
      },
      model_context_window: 258400,
    },
    rate_limits: { limit_id: 'codex', plan_type: 'pro' },
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
  assert.equal(state.contextTokens, 15667);
  const used = contextUsed(state);
  assert.ok(used !== undefined && used > 0.06 && used < 0.07);
});

/**
 * The regression that motivated splitting the two figures apart. `total_token_usage` is the
 * session-lifetime running total, so on a long session it exceeds the window by orders of
 * magnitude — 180,572,005 against 258,400 on the machine this was measured on, and 120 of
 * 121 local rollouts landed the old formula on a clamped 100%.
 */
test('a lifetime total far past the window still reports the real occupancy', () => {
  const line = JSON.stringify({
    ordinal: 90,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 179870381,
          cached_input_tokens: 176930560,
          output_tokens: 701624,
          total_tokens: 180572005,
        },
        last_token_usage: {
          input_tokens: 145672,
          cached_input_tokens: 143104,
          output_tokens: 1308,
          total_tokens: 146980,
        },
        model_context_window: 258400,
      },
    },
  });
  const state = reduceActivity(INITIAL_ACTIVITY, [TASK_STARTED, line]);
  assert.equal(state.totalTokens, 180572005);
  assert.equal(state.contextTokens, 145672);
  const used = contextUsed(state);
  assert.ok(used !== undefined && used > 0.56 && used < 0.57, `expected ~56%, got ${used}`);
});

/**
 * A rollout old enough to predate `last_token_usage` reports nothing rather than falling back
 * to the lifetime total — the fallback is the defect, not a degraded mode.
 */
test('a token_count without last_token_usage yields no context reading at all', () => {
  const line = JSON.stringify({
    ordinal: 91,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 900000, output_tokens: 1000, total_tokens: 901000 },
        model_context_window: 258400,
      },
    },
  });
  const state = reduceActivity(INITIAL_ACTIVITY, [TASK_STARTED, line]);
  assert.equal(state.totalTokens, 901000);
  assert.equal(state.contextTokens, undefined);
  assert.equal(contextUsed(state), undefined);
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

test('the model comes off turn_context, which is not an event_msg at all', () => {
  // Every other record the reducer folds is `type: event_msg`; `turn_context` is a top-level
  // type, and `session_meta` names the provider but never the model. Skipping it means the
  // rate table can never match anything.
  const state = reduceActivity(INITIAL_ACTIVITY, [TASK_STARTED, TURN_CONTEXT]);
  assert.equal(state.model, 'gpt-5.6-luna');
  // Ordinals are one sequence across every record type, so folding it advances the counter.
  assert.equal(state.ordinal, 5);
  assert.equal(state.status, 'working');
});

test('a response_item is still ignored, and does not advance the ordinal', () => {
  const state = reduceActivity(INITIAL_ACTIVITY, [
    TASK_STARTED,
    JSON.stringify({ ordinal: 99, type: 'response_item', payload: { type: 'message' } }),
  ]);
  assert.equal(state.ordinal, 1);
});

test('token usage keeps the cache split and the plan it was billed to', () => {
  const state = reduceActivity(INITIAL_ACTIVITY, [TOKEN_COUNT_FULL]);
  assert.equal(state.totalTokens, 15123);
  assert.equal(state.inputTokens, 14434);
  assert.equal(state.cachedInputTokens, 9984);
  assert.equal(state.outputTokens, 689);
  // Without this a subscription session would be presented as a per-token charge.
  assert.equal(state.plan, 'pro');
});

test('an older token_count without the cache fields still yields a total', () => {
  const state = reduceActivity(INITIAL_ACTIVITY, [TOKEN_COUNT]);
  assert.equal(state.totalTokens, 16805);
  assert.equal(state.cachedInputTokens, undefined);
  assert.equal(state.plan, undefined);
});

/**
 * Verbatim shape from a 0.147 rollout on a `pro` account: a populated weekly `primary`, a
 * `secondary` that is present as a key and null as a value. 55,975 of the 55,977 `token_count`
 * records in the local store carry `primary` this way.
 */
const RATE_LIMITED = JSON.stringify({
  ordinal: 95,
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: 1000, output_tokens: 10, total_tokens: 1010 },
      last_token_usage: { input_tokens: 1000, output_tokens: 10, total_tokens: 1010 },
      model_context_window: 258400,
    },
    rate_limits: {
      limit_id: 'premium',
      primary: { used_percent: 73.0, window_minutes: 10080, resets_at: 1786825753 },
      secondary: null,
      plan_type: 'pro',
    },
  },
});

test('legacy and modern rollout fixtures fold without unrecognised records', () => {
  for (const name of ['rollout-legacy.jsonl', 'rollout-modern.jsonl']) {
    const lines = fixtureLines(name);
    const meta = parseSessionMeta(lines[0]);
    assert.ok(meta, name);
    assert.equal(
      rolloutSchemaGeneration(meta),
      name.includes('legacy') ? 'legacy' : 'modern',
      name,
    );
    const state = reduceActivity(INITIAL_ACTIVITY, lines);
    assert.deepEqual(state.unknownRecordTypes, [], name);
  }
});

test('an unknown rollout record type is retained once for the session diagnostic', () => {
  const lines = [
    JSON.stringify({ ordinal: 1, type: 'future_record', payload: { value: true } }),
    JSON.stringify({ ordinal: 2, type: 'future_record', payload: { value: false } }),
    JSON.stringify({ ordinal: 3, type: 'event_msg', payload: { type: 'future_event' } }),
  ];
  const state = reduceActivity(INITIAL_ACTIVITY, lines);
  assert.deepEqual(state.unknownRecordTypes, ['future_record', 'future_event']);
});

test('the plan window Codex reports is folded, seconds converted to milliseconds', () => {
  const state = reduceActivity(INITIAL_ACTIVITY, [TASK_STARTED, RATE_LIMITED]);
  assert.deepEqual(state.rateLimits, {
    primary: { usedPercent: 73, windowMinutes: 10080, resetsAt: 1786825753000 },
  });
  assert.equal(state.plan, 'pro');
});

test('a null window stays absent rather than becoming a zero', () => {
  const state = reduceActivity(INITIAL_ACTIVITY, [TASK_STARTED, RATE_LIMITED]);
  // A zero would read as "nothing spent" at exactly the moment nothing is known — the same
  // mistake the context gauge made by clamping.
  assert.equal(state.rateLimits?.secondary, undefined);
  const none = JSON.stringify({
    ordinal: 96,
    type: 'event_msg',
    payload: { type: 'token_count', info: { model_context_window: 1 }, rate_limits: { plan_type: 'pro' } },
  });
  assert.equal(reduceActivityLine(INITIAL_ACTIVITY, none).rateLimits, undefined);
});

test('rate limits survive a record that carries no usage block at all', () => {
  const limitsOnly = JSON.stringify({
    ordinal: 97,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: { primary: { used_percent: 12.5, window_minutes: 300 } },
    },
  });
  const state = reduceActivityLine(INITIAL_ACTIVITY, limitsOnly);
  assert.deepEqual(state.rateLimits, { primary: { usedPercent: 12.5, windowMinutes: 300 } });
});
