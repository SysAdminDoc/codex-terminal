import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_TERMINAL_NAME_TEMPLATE,
  isOwnedTerminalName,
  projectName,
  renderTerminalName,
} from '../naming';

test('project names use the workspace folder or cwd leaf', () => {
  assert.equal(projectName({ name: 'Codex', cwd: 'C:\\Users\\--\\repos\\codex-terminal', mode: 'new' }), 'codex-terminal');
  assert.equal(
    projectName({
      name: 'Codex',
      cwd: 'C:\\Users\\--\\repos\\other',
      workspaceFolder: 'other-workspace',
      mode: 'new',
    }),
    'other-workspace',
  );
});

test('terminal fallback names put the project before Codex', () => {
  assert.equal(
    renderTerminalName(DEFAULT_TERMINAL_NAME_TEMPLATE, {
      name: 'Codex',
      cwd: 'C:\\Users\\--\\repos\\codex-terminal',
      mode: 'new',
    }),
    'codex-terminal — Codex',
  );
  assert.equal(
    renderTerminalName(DEFAULT_TERMINAL_NAME_TEMPLATE, {
      name: 'Codex',
      cwd: 'C:\\Users\\--\\repos\\codex-terminal',
      mode: 'resumeLast',
      sessionId: '1234567890abcdef',
    }),
    'codex-terminal — Codex (resumed)',
  );
});

test('owned-terminal detection survives templated and agent-generated labels', () => {
  assert.equal(isOwnedTerminalName('codex-terminal — Codex', 'Codex'), true);
  assert.equal(isOwnedTerminalName('⟳ codex-terminal', 'Codex'), false);
  assert.equal(isOwnedTerminalName('PowerShell', 'Codex'), false);
});
