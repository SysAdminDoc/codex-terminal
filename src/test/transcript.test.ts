import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
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
