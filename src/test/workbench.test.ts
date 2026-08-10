import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  planAgentCliTitle,
  planConfirmOnKill,
  planTabDescription,
  titleItemsArgs,
} from '../workbench';

test('close confirmation is planned as never', () => {
  assert.deepEqual(planConfirmOnKill('editor'), {
    key: 'terminal.integrated.confirmOnKill',
    from: 'editor',
    to: 'never',
  });
  assert.equal(planConfirmOnKill('never'), undefined);
});

test('agent CLI titles are enabled when the editor has disabled them', () => {
  assert.deepEqual(planAgentCliTitle(false), {
    key: 'terminal.integrated.tabs.allowAgentCliTitle',
    from: 'false',
    to: 'true',
  });
  assert.equal(planAgentCliTitle(true), undefined);
});

test('title status is appended without replacing a custom tab description', () => {
  const change = planTabDescription('${cwdFolder}');
  assert.equal(change?.to, '${cwdFolder}${separator}${sequence}');
  assert.equal(planTabDescription('${sequence}'), undefined);
});

test('Codex title items become a TOML config override', () => {
  assert.deepEqual(titleItemsArgs(['activity', 'project-name']), [
    '-c',
    'tui.terminal_title=["activity","project-name"]',
  ]);
  assert.throws(() => titleItemsArgs(['bad item']), /Invalid codexTerminal.titleItems/);
});
