import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  partitionTitleItems,
  planAgentCliTitle,
  planConfirmOnKill,
  planTabDescription,
  planWorkbenchChanges,
  titleItemsArgs,
  planRestore,
  recordOverrides,
  type OverrideLedger,
  type WorkbenchState,
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

test('the ledger records what a setting held before we first changed it', () => {
  const first = recordOverrides({}, [
    { key: 'terminal.integrated.confirmOnKill', from: 'editor', to: 'never' },
  ]);
  assert.deepEqual(first['terminal.integrated.confirmOnKill'], {
    key: 'terminal.integrated.confirmOnKill',
    previous: 'editor',
    applied: 'never',
  });

  // First write wins: the value worth giving back is the one from before this extension ever
  // touched the setting, not whatever it held the last time it did.
  const second = recordOverrides(first, [
    { key: 'terminal.integrated.confirmOnKill', from: 'never', to: 'never' },
  ]);
  assert.equal(second['terminal.integrated.confirmOnKill'].previous, 'editor');
});

test('a setting still holding our value is restored verbatim', () => {
  const record = { key: 'terminal.integrated.confirmOnKill', previous: 'editor', applied: 'never' };
  assert.deepEqual(planRestore(record, 'never'), {
    key: 'terminal.integrated.confirmOnKill',
    to: 'editor',
  });
});

test('a setting that was unset before is unset again, not blanked', () => {
  const record = { key: 'terminal.integrated.confirmOnKill', previous: undefined, applied: 'never' };
  const restore = planRestore(record, 'never');
  // `undefined` removes the global override; an empty string would be a value of its own.
  assert.equal(restore?.to, undefined);
  assert.ok(restore, 'the key must still be restored, just to nothing');
});

test('a setting the operator has since changed is left alone', () => {
  const record = { key: 'terminal.integrated.confirmOnKill', previous: 'editor', applied: 'never' };
  assert.equal(planRestore(record, 'always'), undefined);
});

test('an edited tab description keeps the edit and loses only our token', () => {
  const record = {
    key: 'terminal.integrated.tabs.description',
    previous: '${task}',
    applied: '${task}${separator}${sequence}',
  };
  // The operator appended their own token after ours; restoring the old value verbatim would
  // silently discard their work, so only ours is removed.
  const restore = planRestore(record, '${task}${separator}${sequence}${separator}${cwdFolder}');
  assert.ok(restore);
  assert.ok(!restore.to?.includes('${sequence}'));
  assert.ok(restore.to?.includes('${cwdFolder}'), 'their addition survives');
});


/** A workbench with every setting at VS Code's own default, i.e. nothing applied yet. */
function untouched(overrides: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    confirmOnKill: 'editor',
    agentCliTitle: false,
    tabDescription: undefined,
    liveTabTitle: true,
    ...overrides,
  };
}

test('a fresh workbench is planned in full', () => {
  const plan = planWorkbenchChanges(untouched(), {});
  assert.deepEqual(
    plan.changes.map((change) => change.key),
    [
      'terminal.integrated.confirmOnKill',
      'terminal.integrated.tabs.allowAgentCliTitle',
      'terminal.integrated.tabs.description',
    ],
  );
  assert.deepEqual(plan.declined, []);
});

test('a setting already holding what we want is neither changed nor declined', () => {
  const plan = planWorkbenchChanges(
    untouched({ confirmOnKill: 'never', agentCliTitle: true, tabDescription: '${sequence}' }),
    {},
  );
  assert.deepEqual(plan.changes, []);
  assert.deepEqual(plan.declined, []);
});

/**
 * The defect this planner exists to fix. The configuration-change listener calls the apply
 * path, and the operator's own edit is what fires it — so re-planning from the current value
 * meant every attempt to put `confirmOnKill` back was overwritten within milliseconds, and the
 * setting could not be kept at anything but `never` while the extension was installed.
 */
test('a setting the operator has moved back is left alone once it has been written', () => {
  const ledger: OverrideLedger = {
    'terminal.integrated.confirmOnKill': {
      key: 'terminal.integrated.confirmOnKill',
      previous: 'editor',
      applied: 'never',
    },
  };
  const plan = planWorkbenchChanges(untouched({ confirmOnKill: 'editor' }), ledger);
  assert.deepEqual(plan.declined, ['terminal.integrated.confirmOnKill']);
  assert.ok(!plan.changes.some((change) => change.key === 'terminal.integrated.confirmOnKill'));
  // The keys that were never written are still planned: declining one is not opting out of all.
  assert.deepEqual(
    plan.changes.map((change) => change.key),
    ['terminal.integrated.tabs.allowAgentCliTitle', 'terminal.integrated.tabs.description'],
  );
});

test('re-applying is idempotent across repeated configuration-change events', () => {
  let state = untouched();
  let ledger: OverrideLedger = {};
  for (let round = 0; round < 3; round += 1) {
    const plan = planWorkbenchChanges(state, ledger);
    ledger = recordOverrides(ledger, plan.changes);
    // Simulate the writes landing.
    for (const change of plan.changes) {
      if (change.key === 'terminal.integrated.confirmOnKill') {
        state.confirmOnKill = change.to;
      }
      if (change.key === 'terminal.integrated.tabs.allowAgentCliTitle') {
        state.agentCliTitle = true;
      }
      if (change.key === 'terminal.integrated.tabs.description') {
        state.tabDescription = change.to;
      }
    }
    // Only the first round may write anything; a second notification is a bug, not a nag.
    assert.equal(plan.changes.length === 0, round > 0, `round ${round} wrote settings`);
  }
});

test('the tab description is not re-appended after the operator removes the token', () => {
  const ledger = recordOverrides({}, [
    {
      key: 'terminal.integrated.tabs.description',
      from: undefined,
      to: '${task}${separator}${local}${separator}${cwdFolder}${separator}${sequence}',
    },
  ]);
  const plan = planWorkbenchChanges(
    untouched({
      confirmOnKill: 'never',
      agentCliTitle: true,
      tabDescription: '${task}${separator}${cwdFolder}',
    }),
    ledger,
  );
  assert.deepEqual(plan.changes, []);
  assert.deepEqual(plan.declined, ['terminal.integrated.tabs.description']);
});

test('a static tab title never plans the description at all', () => {
  const plan = planWorkbenchChanges(untouched({ liveTabTitle: false }), {});
  assert.ok(!plan.changes.some((change) => change.key === 'terminal.integrated.tabs.description'));
});
