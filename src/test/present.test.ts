import assert from 'node:assert/strict';
import { test } from 'node:test';

import { INITIAL_ACTIVITY, type SessionActivity } from '../activity';
import {
  SPINNER_ICON,
  announceActivity,
  describeActivity,
  motionAllowed,
  peakContextUsed,
  formatDuration,
  formatTokens,
  presentStatus,
  statusBarText,
  pickerOrder,
} from '../present';

function activity(overrides: Partial<SessionActivity> = {}): SessionActivity {
  return { ...INITIAL_ACTIVITY, ...overrides };
}

test('only a working session gets the animated icon', () => {
  assert.equal(presentStatus(activity({ status: 'working' })).icon, SPINNER_ICON);
  for (const status of ['idle', 'aborted', 'unknown'] as const) {
    assert.notEqual(presentStatus(activity({ status })).icon, SPINNER_ICON);
  }
});

test('the spinner keeps the modifier syntax the workbench understands', () => {
  // `loading~spin` becomes `codicon codicon-loading codicon-modifier-spin`. A typo here
  // does not throw — it renders a blank square that never moves.
  assert.match(SPINNER_ICON, /^[a-z-]+~spin$/);
});

test('an interrupted turn reads differently from a stopped one', () => {
  assert.equal(
    presentStatus(activity({ status: 'aborted', abortReason: 'interrupted' })).label,
    'Interrupted',
  );
  assert.equal(presentStatus(activity({ status: 'aborted' })).label, 'Stopped');
});

test('durations stay short at every scale', () => {
  assert.equal(formatDuration(9), '9s');
  assert.equal(formatDuration(59), '59s');
  assert.equal(formatDuration(60), '1m 0s');
  assert.equal(formatDuration(125), '2m 5s');
  assert.equal(formatDuration(3_600), '1h 0m');
  assert.equal(formatDuration(7_265), '2h 1m');
});

test('token counts are abbreviated once they stop fitting', () => {
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1_500), '1.5k');
  assert.equal(formatTokens(16_805), '17k');
  assert.equal(formatTokens(2_400_000), '2.4M');
});

test('a working session describes what it is doing, for how long, and its context', () => {
  const state = activity({
    status: 'working',
    turnStartedAt: 1_000_000,
    totalTokens: 16_805,
    contextTokens: 15_667,
    contextWindow: 258_400,
  });
  assert.equal(describeActivity(state, 1_045_000), 'Working · 45s · 17k tokens · 6% context');
});

test('the status bar reports the session closest to its context limit', () => {
  const sessions = [
    activity({ contextTokens: 10_000, contextWindow: 100_000 }),
    activity({ contextTokens: 80_000, contextWindow: 100_000 }),
    activity({ contextTokens: 5_000, contextWindow: 100_000 }),
  ];
  assert.equal(peakContextUsed(sessions), 0.8);
  assert.equal(statusBarText(1, 3, 0.8), `$(${SPINNER_ICON}) Codex 1/3 · 80%`);
});

test('context is absent, never zero, until a session has reported both numbers', () => {
  // A 0% here would read as "plenty of room" at exactly the moment nothing is known.
  assert.equal(peakContextUsed([activity(), activity({ contextTokens: 500 })]), undefined);
  // A lifetime total is not a context reading: the session total says nothing about how full
  // the window is, so it must not stand in for one.
  assert.equal(
    peakContextUsed([activity({ totalTokens: 9_000_000, contextWindow: 100_000 })]),
    undefined,
  );
  assert.equal(statusBarText(0, 2, undefined), '$(sparkle) Codex 2');
});

test('facts that are not known yet are omitted rather than shown blank', () => {
  assert.equal(describeActivity(activity({ status: 'idle' }), Date.now()), 'Idle');
  assert.equal(describeActivity(INITIAL_ACTIVITY, Date.now()), 'Starting…');
});

test('the status bar animates only while something is working', () => {
  assert.equal(statusBarText(0, 0), '$(sparkle) Codex');
  assert.equal(statusBarText(0, 3), '$(sparkle) Codex 3');
  assert.equal(statusBarText(2, 3), `$(${SPINNER_ICON}) Codex 2/3`);
});

test('a long-silent working session says so instead of just claiming to work', () => {
  const state = activity({
    status: 'working',
    turnStartedAt: 1_000_000,
    lastEventAt: '2026-08-09T16:00:00.000Z',
  });
  const now = Date.parse('2026-08-09T16:02:00.000Z');
  // 'Working' alone for two minutes of silence is a claim the rollout cannot support.
  assert.match(describeActivity(state, now, 45), /no output for 2m 0s/);
  assert.doesNotMatch(describeActivity(state, now, 600), /no output/);
});

test('what a session row says out loud does not change just because time passed', () => {
  // The regression this guards: the accessible name used to be `describeActivity`, which
  // carries elapsed seconds, a token total and a context percentage. A tree row is re-read
  // aloud whenever its accessible name changes while it has focus, so a row whose name ticks
  // talks over everything else on screen for the whole length of a turn.
  const state = activity({
    status: 'working',
    turnStartedAt: 1_000_000,
    totalTokens: 16_805,
    contextTokens: 15_667,
    contextWindow: 258_400,
    lastEventAt: '2026-08-09T16:00:00.000Z',
  });
  const start = Date.parse('2026-08-09T16:00:00.000Z');
  const first = announceActivity(state, start);
  for (let second = 1; second <= 40; second += 1) {
    assert.equal(announceActivity(state, start + second * 1_000), first);
  }
  // And the value it drops is exactly the value that moved.
  assert.notEqual(describeActivity(state, start + 40_000), describeActivity(state, start));
});

test('a session row still announces the transitions that mean something', () => {
  const working = activity({ status: 'working', turnStartedAt: 1_000_000 });
  const now = Date.now();
  assert.equal(announceActivity(working, now), 'Working');
  // Finishing a turn is the transition a screen reader user is waiting for.
  assert.equal(
    announceActivity({ ...working, status: 'idle', completedTurns: 1 }, now),
    'Idle, 1 turn completed',
  );
  assert.equal(
    announceActivity({ ...working, status: 'idle', completedTurns: 4 }, now),
    'Idle, 4 turns completed',
  );
  // Going quiet is the other one: said once, when the threshold is crossed, without the
  // duration that would make it repeat.
  const quiet = { ...working, lastEventAt: '2026-08-09T16:00:00.000Z' };
  const later = Date.parse('2026-08-09T16:02:00.000Z');
  assert.equal(announceActivity(quiet, later, 45), 'Working, no recent output');
  assert.equal(announceActivity(quiet, later + 30_000, 45), 'Working, no recent output');
  assert.equal(announceActivity(quiet, later, 600), 'Working');
});

test('reduced motion replaces the spinner with a still icon, keeping the meaning', () => {
  const working = activity({ status: 'working' });
  assert.equal(presentStatus(working, true).icon, SPINNER_ICON);
  assert.equal(presentStatus(working, false).icon, 'sync');
  // The label must not change: only the motion is suppressed, not the information.
  assert.equal(presentStatus(working, false).label, 'Working');
  assert.equal(statusBarText(1, 1, undefined, false), '$(sync) Codex 1/1');
});

test('the reduced-motion preference is read the way VS Code defines it', () => {
  assert.equal(motionAllowed('on'), false);
  assert.equal(motionAllowed('off'), true);
  // `auto` defers to the operating system.
  assert.equal(motionAllowed('auto', true), false);
  assert.equal(motionAllowed('auto', false), true);
  assert.equal(motionAllowed(undefined), true);
});

test('the jump-to picker puts working sessions first, then the most recent', () => {
  const at = (status: 'working' | 'idle' | 'silent', launchedAt: number) => ({
    activity: { ...INITIAL_ACTIVITY, status },
    launchedAt,
  });
  const ordered = pickerOrder([
    at('idle', 300),
    at('working', 100),
    at('silent', 400),
    at('working', 200),
  ]);
  assert.deepEqual(
    ordered.map((entry) => `${entry.activity.status}:${entry.launchedAt}`),
    ['working:200', 'working:100', 'silent:400', 'idle:300'],
  );
});

test('ordering does not rank silent against idle', () => {
  // Both mean "not busy"; implying an order between them would assert a distinction the
  // session file cannot support. Only recency separates them.
  const ordered = pickerOrder([
    { activity: { ...INITIAL_ACTIVITY, status: 'silent' as const }, launchedAt: 1 },
    { activity: { ...INITIAL_ACTIVITY, status: 'idle' as const }, launchedAt: 2 },
  ]);
  assert.deepEqual(ordered.map((entry) => entry.launchedAt), [2, 1]);
});
