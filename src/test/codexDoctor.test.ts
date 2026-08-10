import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  diagnoseTitle,
  findCheck,
  notableChecks,
  parseCodexDoctor,
} from '../codexDoctor';

/**
 * Shape captured verbatim from `codex doctor --json -c 'tui.terminal_title=[…]'` on
 * codex-cli 0.147.0 (2026-08-10), including the quoting of `terminal title invalid items`
 * and the fact that `checks` is a map keyed by id rather than an array — both are places a
 * plausible guess would parse to nothing and report a healthy config.
 */
const PAYLOAD = JSON.stringify({
  schemaVersion: 1,
  codexVersion: '0.147.0',
  overallStatus: 'warning',
  checks: {
    'terminal.title': {
      id: 'terminal.title',
      category: 'title',
      status: 'warning',
      summary: 'terminal title configured with invalid items',
      details: {
        'terminal title activity': 'true',
        'terminal title invalid items': '"bogus-item"',
        'terminal title items': 'activity, project-name',
        'terminal title source': 'configured',
      },
      issues: [
        {
          severity: 'warning',
          cause: 'terminal title configuration contains unknown item identifiers',
          measured: '"bogus-item"',
          remedy: 'Remove or replace the unknown entries in [tui].terminal_title.',
        },
      ],
    },
    'app_server.status': {
      id: 'app_server.status',
      category: 'app-server',
      status: 'ok',
      summary: 'background server is not running',
      details: {},
      issues: [],
    },
    'rollouts.disk': {
      id: 'rollouts.disk',
      status: 'warning',
      summary: '121 active files · 2.01 GB on disk',
      details: {},
      issues: [],
    },
  },
});

test('a doctor payload parses into checks keyed by id', () => {
  const report = parseCodexDoctor(PAYLOAD);
  assert.ok(report);
  assert.equal(report.codexVersion, '0.147.0');
  assert.equal(report.checks.length, 3);
  assert.equal(findCheck(report, 'app_server.status')?.status, 'ok');
});

test('the title check reports what Codex actually resolved', () => {
  const title = diagnoseTitle(parseCodexDoctor(PAYLOAD)!);
  assert.ok(title);
  assert.deepEqual(title.items, ['activity', 'project-name']);
  // The quotes around the invalid item are Codex's, not JSON's, and must be stripped or
  // the name shown back to the user is `"bogus-item"` with literal quotes.
  assert.deepEqual(title.invalidItems, ['bogus-item']);
  assert.equal(title.activity, true);
  assert.equal(title.source, 'configured');
});

test('a source of "default" means our override never reached Codex', () => {
  const payload = JSON.parse(PAYLOAD) as Record<string, unknown>;
  const checks = payload.checks as Record<string, { details: Record<string, string> }>;
  checks['terminal.title'].details['terminal title source'] = 'default';
  const title = diagnoseTitle(parseCodexDoctor(JSON.stringify(payload))!);
  assert.equal(title?.source, 'default');
});

test('only checks Codex is unhappy about are notable', () => {
  const notable = notableChecks(parseCodexDoctor(PAYLOAD)!).map((check) => check.id);
  assert.deepEqual(notable.sort(), ['rollouts.disk', 'terminal.title']);
});

test('an absent title check yields nothing rather than empty defaults', () => {
  const report = parseCodexDoctor(
    JSON.stringify({ codexVersion: '0.1.0', checks: { other: { id: 'other', status: 'ok' } } }),
  );
  assert.ok(report);
  assert.equal(diagnoseTitle(report), undefined);
});

test('unreadable output is rejected so the caller falls back to its own diagnostics', () => {
  for (const text of ['', 'not json', '[]', '{}', JSON.stringify({ checks: 'nope' })]) {
    assert.equal(parseCodexDoctor(text), undefined, JSON.stringify(text));
  }
});

test('a check missing details or issues still parses', () => {
  const report = parseCodexDoctor(
    JSON.stringify({ checks: { bare: { id: 'bare', status: 'warning' } } }),
  );
  assert.equal(report?.checks[0].status, 'warning');
  assert.deepEqual(report?.checks[0].details, {});
  assert.deepEqual(report?.checks[0].issues, []);
});
