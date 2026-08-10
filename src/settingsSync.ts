import * as vscode from 'vscode';

import {
  AGENT_CLI_TITLE_SETTING,
  CONFIRM_ON_KILL_SETTING,
  planAgentCliTitle,
  planConfirmOnKill,
  planRestore,
  planTabDescription,
  recordOverrides,
  type OverrideLedger,
  type SettingChange,
} from './workbench';
import { OVERRIDE_LEDGER_KEY, log, services, tabTitleMode } from './services';
import { strings } from './strings';

/**
 * The three workbench settings a Codex tab needs, and giving them back.
 *
 * Kept together because they are one contract: nothing may be changed here that is not also
 * recorded, and nothing recorded may be left unrevertable.
 */

function settingText(value: unknown): string {
  return value === undefined ? strings.workbench.unset() : JSON.stringify(value);
}

/**
 * The terminal API has no per-terminal close-confirmation switch. These settings are the
 * editor's supported controls for the requested behaviour and for Codex's live OSC title:
 * `${sequence}` in the tab description is what surfaces that title on hosts that ignore
 * the per-terminal template, and it is the reason a working tab shows Codex's spinner.
 */
export async function applyWorkbenchPreferences(): Promise<void> {
  const root = vscode.workspace.getConfiguration();
  // Kept as full `SettingChange`s rather than key/value pairs: `from` is what makes the
  // change reversible, and discarding it here is what left these settings permanent.
  const changes: SettingChange[] = [];
  const confirmOnKill = planConfirmOnKill(root.get<string>(CONFIRM_ON_KILL_SETTING, 'editor'));
  if (confirmOnKill) {
    changes.push(confirmOnKill);
  }
  const agentCliTitle = planAgentCliTitle(
    root.get<boolean>(AGENT_CLI_TITLE_SETTING, true),
  );
  if (agentCliTitle) {
    changes.push(agentCliTitle);
  }
  if (tabTitleMode() === 'live') {
    const description = planTabDescription(
      root.get<string>('terminal.integrated.tabs.description'),
    );
    if (description) {
      changes.push(description);
    }
  }

  const applied: SettingChange[] = [];
  for (const change of changes) {
    // `agentCliTitle` is a boolean setting whose plan carries a string; write the real type.
    const value = change.key === AGENT_CLI_TITLE_SETTING ? change.to === 'true' : change.to;
    try {
      await root.update(change.key, value, vscode.ConfigurationTarget.Global);
      log().info(strings.workbench.applied(change.key, settingText(change.from), settingText(value)));
      applied.push(change);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log().warn(strings.workbench.failed(change.key, message));
    }
  }
  if (applied.length === 0) {
    return;
  }

  // Recorded before the operator is told, so the offer to undo is one this can honour even
  // if the notification is dismissed and the command is run days later.
  await services().context.globalState.update(
    OVERRIDE_LEDGER_KEY,
    recordOverrides(readOverrideLedger(), applied),
  );
  // A notification, not a dialog: these settings are required for the tab to work, so this
  // announces a change rather than asking permission for one. It appears only when something
  // actually changed, which after the first window is never.
  const choice = await vscode.window.showInformationMessage(
    strings.workbench.announced(applied.map((change) => change.key).join(', ')),
    strings.workbench.revert(),
    strings.errors.showLog(),
  );
  if (choice === strings.workbench.revert()) {
    await revertWorkbenchPreferences();
  } else if (choice === strings.errors.showLog()) {
    log().show(true);
  }
}

function readOverrideLedger(): OverrideLedger {
  return services().context.globalState.get<OverrideLedger>(OVERRIDE_LEDGER_KEY) ?? {};
}

/**
 * Give back every workbench setting this extension changed.
 *
 * Restores the recorded prior value where the setting still holds what was written, and
 * leaves a setting the operator has since edited alone — except the tab description, where
 * only the appended token is removed so the rest of their template survives.
 */
export async function revertWorkbenchPreferences(): Promise<void> {
  const ledger = readOverrideLedger();
  const records = Object.values(ledger);
  if (records.length === 0) {
    void vscode.window.showInformationMessage(strings.workbench.nothingToRevert());
    return;
  }

  const root = vscode.workspace.getConfiguration();
  const reverted: string[] = [];
  for (const record of records) {
    const current = root.get<unknown>(record.key);
    const restore = planRestore(record, current === undefined ? undefined : String(current));
    if (!restore) {
      log().info(strings.workbench.skippedRevert(record.key));
      continue;
    }
    try {
      // `undefined` removes the global override rather than writing an empty value.
      await root.update(restore.key, restore.to, vscode.ConfigurationTarget.Global);
      log().info(strings.workbench.reverted(restore.key, settingText(restore.to)));
      reverted.push(restore.key);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log().warn(strings.workbench.failed(restore.key, message));
    }
  }

  await services().context.globalState.update(OVERRIDE_LEDGER_KEY, undefined);
  void vscode.window.showInformationMessage(
    reverted.length > 0
      ? strings.workbench.revertedAll(reverted.join(', '))
      : strings.workbench.nothingToRevert(),
  );
}
