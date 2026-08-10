import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SKIPPED_RECORD_TYPES,
  isInjectedContext,
  parseSessionMeta,
  parseTranscriptLine,
  renderTranscriptEntry,
  summarise,
} from '../transcript';

test('transcript parsing keeps metadata and real conversation messages', () => {
  const meta = parseSessionMeta(
    JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'session-1',
        timestamp: '2026-08-09T12:00:00.000Z',
        cwd: 'C:\\repo',
      },
    }),
  );
  assert.deepEqual(meta, {
    id: 'session-1',
    timestamp: '2026-08-09T12:00:00.000Z',
    cwd: 'C:\\repo',
  });

  const line = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Fix the tab title' }],
    },
  });
  assert.deepEqual(parseTranscriptLine(line), { role: 'user', text: 'Fix the tab title' });
});

test('injected Codex context is hidden from previews and rendered transcripts', () => {
  assert.equal(isInjectedContext('<environment_context>'), true);
  assert.equal(isInjectedContext('# AGENTS.md instructions'), true);
  assert.equal(isInjectedContext('Please add a History sidebar'), false);
  const entry = { role: 'user' as const, text: '<environment_context>hidden</environment_context>' };
  assert.equal(renderTranscriptEntry(entry), undefined);
  assert.equal(summarise('  Please   add a History sidebar  '), 'Please add a History sidebar');
});

test('a compaction is rendered as a visible boundary, not a silent gap', () => {
  // Shape captured from a real rollout (codex-cli 0.147.0, 2026-08-10): compaction
  // replaces prior history, so omitting it makes the transcript jump between unrelated
  // turns with nothing to explain why.
  const entry = parseTranscriptLine(
    JSON.stringify({
      timestamp: '2026-08-10T16:22:30.784Z',
      ordinal: 664,
      type: 'compacted',
      payload: { message: '', replacement_history: [{ type: 'message' }, { type: 'message' }] },
    }),
  );
  assert.equal(entry?.role, 'compaction');
  assert.match(entry!.text, /2 summarised item/);

  const rendered = renderTranscriptEntry(entry!);
  assert.match(rendered!, /Context compacted/);
});

test('a compaction carrying a summary shows the summary', () => {
  const entry = parseTranscriptLine(
    JSON.stringify({ type: 'compacted', payload: { message: 'Summary of earlier work.' } }),
  );
  assert.equal(entry?.text, 'Summary of earlier work.');
});

test('record types with no transcript content are skipped by name', () => {
  // Named rather than merely unhandled: an unrecognised type looks exactly like one we
  // chose to skip, so a future addition would vanish the same way these do.
  for (const type of SKIPPED_RECORD_TYPES) {
    assert.equal(
      parseTranscriptLine(JSON.stringify({ type, payload: { anything: true } })),
      undefined,
      type,
    );
  }
});
