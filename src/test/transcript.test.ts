import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SKIPPED_RECORD_TYPES,
  isInjectedContext,
  parseSessionMeta,
  parseTranscriptLine,
  renderTranscriptEntry,
  summarise,
  mayContainFileChange,
  netFileChanges,
  parseFileChanges,
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

test('a file-change record yields paths and kinds without their contents', () => {
  const line = JSON.stringify({
    type: 'event_msg',
    ordinal: 9,
    payload: {
      type: 'item_completed',
      item: {
        type: 'FileChange',
        id: 'exec-1',
        changes: {
          '/repo/added.ts': { type: 'add', content: 'x'.repeat(5000) },
          '/repo/gone.ts': { type: 'delete' },
          '/repo/touched.ts': { type: 'update', content: 'y' },
        },
      },
    },
  });
  const changes = parseFileChanges(line);
  assert.deepEqual(changes, [
    { path: '/repo/added.ts', kind: 'add' },
    { path: '/repo/gone.ts', kind: 'delete' },
    { path: '/repo/touched.ts', kind: 'update' },
  ]);
  // The contents are what make rollouts reach 128 MB; keeping them would defeat streaming.
  assert.ok(!JSON.stringify(changes).includes('xxxxx'));
});

test('records that are not file changes are rejected before parsing', () => {
  assert.equal(mayContainFileChange('{"type":"event_msg","payload":{"type":"token_count"}}'), false);
  assert.equal(parseFileChanges('{"type":"event_msg","payload":{"type":"token_count"}}'), undefined);
  assert.equal(parseFileChanges('not json "FileChange"'), undefined);
  assert.equal(
    parseFileChanges(JSON.stringify({ type: 'response_item', payload: { type: 'FileChange' } })),
    undefined,
  );
});

test('an unknown change kind is treated as an edit rather than dropped', () => {
  const line = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: { type: 'FileChange', changes: { '/repo/a.ts': { type: 'rename-in-2027' } } },
    },
  });
  assert.deepEqual(parseFileChanges(line), [{ path: '/repo/a.ts', kind: 'update' }]);
});

test('repeated changes to one file collapse to their net effect', () => {
  assert.deepEqual(
    netFileChanges([
      { path: 'a', kind: 'add' },
      { path: 'a', kind: 'update' },
      { path: 'a', kind: 'update' },
    ]),
    [{ path: 'a', kind: 'add' }],
    'a file this session created reads as added however often it was then edited',
  );
  assert.deepEqual(
    netFileChanges([
      { path: 'b', kind: 'add' },
      { path: 'b', kind: 'delete' },
    ]),
    [{ path: 'b', kind: 'delete' }],
    'a removal is the last word whatever preceded it',
  );
  assert.deepEqual(
    netFileChanges([
      { path: 'c', kind: 'update' },
      { path: 'c', kind: 'update' },
    ]),
    [{ path: 'c', kind: 'update' }],
  );
});

test('tool calls and tool output are gated separately', () => {
  const call = { role: 'tool' as const, name: 'exec', text: 'npm run check' };
  const output = { role: 'output' as const, name: 'exec', text: 'ok' };

  assert.equal(renderTranscriptEntry(call), undefined, 'both off by default');
  assert.equal(renderTranscriptEntry(output), undefined);

  // Commands without their output is the useful middle setting: it answers "what did it do"
  // without the payload that made the full export 3.8 MB against 35 KB of prose.
  assert.ok(renderTranscriptEntry(call, { includeToolCalls: true }));
  assert.equal(renderTranscriptEntry(output, { includeToolCalls: true, includeToolOutput: false }), undefined);
  assert.ok(renderTranscriptEntry(output, { includeToolOutput: true }));
});

test('a tool block is capped far tighter than prose', () => {
  const long = 'x'.repeat(5000);
  const tool = renderTranscriptEntry(
    { role: 'tool', name: 'apply_patch', text: long },
    { includeToolCalls: true },
  );
  // An apply_patch call carries the whole new file; the transcript wants the command, not
  // a second copy of the source tree.
  assert.ok(tool && tool.length < 1200, `tool block was ${tool?.length} characters`);
  assert.match(tool as string, /truncated \(4600 more characters\)/);

  const prose = renderTranscriptEntry({ role: 'assistant', text: long });
  assert.ok(prose && prose.length > 4900, 'prose keeps the far larger budget');
});
