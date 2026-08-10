import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  partitionTitleItems,
  planAgentCliTitle,
  planConfirmOnKill,
  planTabDescription,
  titleItemsArgs,
} from '../workbench';
import { DEFAULT_TITLE_ITEMS } from '../naming';
import { buildLaunchPlan } from '../launcher';

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
  // Single-quoted TOML literal strings: a double-quoted array cannot survive cmd.exe,
  // which has no escape for `"` inside a quoted argument.
  assert.deepEqual(titleItemsArgs(['activity', 'project-name']), [
    '-c',
    "tui.terminal_title=['activity','project-name']",
  ]);
  assert.throws(() => titleItemsArgs(['bad item']), /Invalid codexTerminal.titleItems/);
});

test('the title override survives every supported shell family', () => {
  const args = titleItemsArgs([...DEFAULT_TITLE_ITEMS]);
  for (const shell of ['cmd', 'pwsh', 'bash'] as const) {
    const plan = buildLaunchPlan({
      shell,
      customShellPath: '',
      command: 'codex',
      args: [...args],
      keepShellOpen: true,
      platform: 'win32',
      availableShells: [],
    });
    // `cmd` used to throw here, which made that shell setting unusable outright.
    assert.ok(plan.shellArgs.some((argument) => argument.includes('terminal_title')), shell);
  }
});

test('unknown title items are separated from the ones Codex knows', () => {
  const { known, unknown } = partitionTitleItems([
    'activity',
    'bogus-item',
    ' project-name ',
    '',
    'app-name',
  ]);
  // Codex keeps the known ones and drops the rest silently, so both halves matter: the
  // known list is what the tab will show, the unknown list is what to warn about.
  assert.deepEqual(known, ['activity', 'project-name', 'app-name']);
  assert.deepEqual(unknown, ['bogus-item']);
});

test('every default title item is in the known vocabulary', () => {
  // A default Codex would reject is a silent, self-inflicted bug.
  assert.deepEqual(partitionTitleItems([...DEFAULT_TITLE_ITEMS]).unknown, []);
});
