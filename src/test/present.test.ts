import assert from 'node:assert/strict';
import { test } from 'node:test';

import { INITIAL_ACTIVITY, type SessionActivity } from '../activity';
import {
  SPINNER_ICON,
  describeActivity,
  peakContextUsed,
  formatDuration,
  formatTokens,
  presentStatus,
  statusBarText,
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
    contextWindow: 258_400,
  });
  assert.equal(describeActivity(state, 1_045_000), 'Working · 45s · 17k tokens · 7% context');
});

test('the status bar reports the session closest to its context limit', () => {
  const sessions = [
    activity({ totalTokens: 10_000, contextWindow: 100_000 }),
    activity({ totalTokens: 80_000, contextWindow: 100_000 }),
    activity({ totalTokens: 5_000, contextWindow: 100_000 }),
  ];
  assert.equal(peakContextUsed(sessions), 0.8);
  assert.equal(statusBarText(1, 3, 0.8), `$(${SPINNER_ICON}) Codex 1/3 · 80%`);
});

test('context is absent, never zero, until a session has reported both numbers', () => {
  // A 0% here would read as "plenty of room" at exactly the moment nothing is known.
  assert.equal(peakContextUsed([activity(), activity({ totalTokens: 500 })]), undefined);
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
