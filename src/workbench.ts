/**
 * The two workbench settings that decide whether a Codex tab is readable at a glance.
 *
 * `terminal.integrated.confirmOnKill` — `TerminalEditorInput.showConfirm()` returns true
 * when this is `editor` (the default) or `always` and the terminal has child processes,
 * which is what raises "Do you want to terminate the running processes?" on tab close.
 * Only `never` removes it.
 *
 * `terminal.integrated.tabs.allowAgentCliTitle` lets the editor honour the live title that
 * Codex emits through OSC. The extension supplies the Codex `[tui].terminal_title` items.
 * Both settings are plain user settings, so activation enforces the requested values.
 */

export const SEQUENCE_TOKEN = '${sequence}';
export const SEPARATOR_TOKEN = '${separator}';
export const AGENT_CLI_TITLE_SETTING = 'terminal.integrated.tabs.allowAgentCliTitle';
export const CONFIRM_ON_KILL_SETTING = 'terminal.integrated.confirmOnKill';

/** VS Code's own defaults, retained for callers that want reversible setting plans. */
export const DEFAULT_TAB_DESCRIPTION = '${task}${separator}${local}${separator}${cwdFolder}';
export const DEFAULT_CONFIRM_ON_KILL = 'editor';
export const DEFAULT_AGENT_CLI_TITLE = true;

export interface SettingChange {
  key: string;
  from: string | undefined;
  to: string;
}

/**
 * Add `${sequence}` to the tab description template, or report that nothing is needed.
 * An existing template is appended to rather than replaced: a user who has customised it
 * keeps their customisation.
 */
export function planTabDescription(current: string | undefined): SettingChange | undefined {
  const value = current ?? DEFAULT_TAB_DESCRIPTION;
  if (value.includes(SEQUENCE_TOKEN)) {
    return undefined;
  }
  const trimmed = value.trim();
  const next = trimmed ? `${trimmed}${SEPARATOR_TOKEN}${SEQUENCE_TOKEN}` : SEQUENCE_TOKEN;
  return { key: 'terminal.integrated.tabs.description', from: current, to: next };
}

/** Remove the token again, leaving any other customisation in place. */
export function planTabDescriptionRevert(current: string | undefined): SettingChange | undefined {
  if (current === undefined || !current.includes(SEQUENCE_TOKEN)) {
    return undefined;
  }
  const next =
    current
      .split(SEQUENCE_TOKEN)
      .join('')
      .replace(new RegExp(`(?:\\$\\{separator\\})+$`), '')
      .replace(/^(?:\$\{separator\})+/, '')
      .trim() || DEFAULT_TAB_DESCRIPTION;
  return { key: 'terminal.integrated.tabs.description', from: current, to: next };
}

export function planConfirmOnKill(current: string | undefined): SettingChange | undefined {
  if (current === 'never') {
    return undefined;
  }
  return { key: 'terminal.integrated.confirmOnKill', from: current, to: 'never' };
}

export function planConfirmOnKillRevert(current: string | undefined): SettingChange | undefined {
  if (current !== 'never') {
    return undefined;
  }
  return {
    key: 'terminal.integrated.confirmOnKill',
    from: current,
    to: DEFAULT_CONFIRM_ON_KILL,
  };
}

/**
 * What one workbench setting held before this extension first overrode it.
 *
 * Recorded rather than inferred. The extension changes three settings in the operator's
 * *global* configuration — it has to, because a tab cannot show Codex's live title without
 * them — but until now it said nothing and left them changed forever, including after
 * uninstall. Restoring a guessed default is not the same as giving back what was there.
 */
export interface RecordedOverride {
  key: string;
  /** The prior value; `undefined` means the setting was unset and should be unset again. */
  previous: string | undefined;
  /** What the extension wrote, so a later edit by the operator can be recognised. */
  applied: string;
}

export type OverrideLedger = Record<string, RecordedOverride>;

/**
 * Add newly applied changes to the ledger, never overwriting an existing entry.
 *
 * First write wins: the value worth restoring is what the operator had before this extension
 * ever touched the setting, not what it held after the last time it did.
 */
export function recordOverrides(
  ledger: OverrideLedger,
  applied: readonly SettingChange[],
): OverrideLedger {
  const next: OverrideLedger = { ...ledger };
  for (const change of applied) {
    if (!(change.key in next)) {
      next[change.key] = { key: change.key, previous: change.from, applied: change.to };
    }
  }
  return next;
}

export interface SettingRestore {
  key: string;
  /** `undefined` removes the override, which is not the same as writing an empty string. */
  to: string | undefined;
}

/**
 * How to give one setting back.
 *
 * If it still holds exactly what the extension wrote, the prior value is restored verbatim.
 * If the operator has since changed it themselves, their value is left alone — except for the
 * tab description, where the extension *appended* a token to whatever was there and can
 * surgically remove just that token without discarding the edit.
 */
export function planRestore(
  record: RecordedOverride,
  current: string | undefined,
): SettingRestore | undefined {
  if (current === record.applied) {
    return { key: record.key, to: record.previous };
  }
  if (record.key === 'terminal.integrated.tabs.description') {
    const surgical = planTabDescriptionRevert(current);
    return surgical ? { key: surgical.key, to: surgical.to } : undefined;
  }
  return undefined;
}

/** What the workbench currently holds, as the planner needs to see it. */
export interface WorkbenchState {
  confirmOnKill: string | undefined;
  agentCliTitle: boolean | undefined;
  tabDescription: string | undefined;
  /** `tabTitle: live` is the only mode that needs `${sequence}` in the description. */
  liveTabTitle: boolean;
}

export interface WorkbenchPlan {
  changes: SettingChange[];
  /** Keys left alone because the operator has since set them themselves. */
  declined: string[];
}

/**
 * Decide which workbench settings to write, honouring edits the operator has already made.
 *
 * The ledger is what makes this possible, and using it here is the whole fix. Activation and
 * the configuration-change listener both call this, and the listener fires on the operator's
 * own edit — so re-planning from the current value alone meant every attempt to set
 * `confirmOnKill` back to `editor` was overwritten within milliseconds, including the write
 * the extension's own revert command had just made. The setting could not be kept.
 *
 * A key the extension has written before is now only rewritten while it still holds exactly
 * what was written. Once it holds anything else, that is a decision, and decisions are kept.
 */
export function planWorkbenchChanges(state: WorkbenchState, ledger: OverrideLedger): WorkbenchPlan {
  const candidates: Array<SettingChange | undefined> = [
    planConfirmOnKill(state.confirmOnKill),
    planAgentCliTitle(state.agentCliTitle),
    state.liveTabTitle ? planTabDescription(state.tabDescription) : undefined,
  ];

  const changes: SettingChange[] = [];
  const declined: string[] = [];
  for (const change of candidates) {
    if (!change) {
      continue;
    }
    // A candidate exists only when the setting does *not* already hold what this extension
    // wants. So a ledger entry here means the key was written once and has since moved — by
    // the operator, by a settings sync, or by the revert command. Whichever it was, the
    // current value is not ours to overwrite a second time. Re-arming is deliberate and
    // explicit: `revertWorkbenchSettings` clears the ledger, and turning
    // `codexTerminal.applyWorkbenchSettings` back on plans from scratch.
    if (ledger[change.key]) {
      declined.push(change.key);
      continue;
    }
    changes.push(change);
  }
  return { changes, declined };
}

export function planAgentCliTitle(current: boolean | undefined): SettingChange | undefined {
  if (current === DEFAULT_AGENT_CLI_TITLE) {
    return undefined;
  }
  return {
    key: AGENT_CLI_TITLE_SETTING,
    from: current === undefined ? undefined : String(current),
    to: 'true',
  };
}

/**
 * Codex renders the tab's live half itself, from `[tui].terminal_title`. The extension
 * only overrides it when the user asks for specific items, so a `config.toml` that
 * already tunes the title is left alone.
 */
export function titleItemsArgs(items: readonly string[]): string[] {
  const cleaned = items.map((item) => item.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return [];
  }
  // TOML array of strings; the identifiers are a closed vocabulary of `[a-z-]+`.
  const invalid = cleaned.find((item) => !/^[a-z][a-z0-9-]*$/.test(item));
  if (invalid) {
    throw new Error(`Invalid codexTerminal.titleItems entry: ${JSON.stringify(invalid)}`);
  }
  // TOML *literal* strings, single-quoted. A double-quoted array is equally valid TOML but
  // unrepresentable through cmd.exe, which has no escape for `"` inside a quoted argument:
  // it made `codexTerminal.shell: "cmd"` throw on every launch, and blocked passing the
  // same override to `codex doctor` through the `codex.cmd` npm shim. The vocabulary is
  // `[a-z][a-z0-9-]*`, so a literal string can never need escaping.
  return ['-c', `tui.terminal_title=[${cleaned.map((item) => `'${item}'`).join(',')}]`];
}

/**
 * Split configured title items into the ones Codex knows and the ones it will refuse.
 *
 * Codex drops unknown identifiers silently and keeps the rest, so a typo costs the user a
 * title item with no error anywhere. `titleItemsArgs` only rejects identifiers that are
 * malformed; this catches well-formed ones that simply do not exist.
 */
export function partitionTitleItems(items: readonly string[]): {
  known: string[];
  unknown: string[];
} {
  const vocabulary = new Set<string>(KNOWN_TITLE_ITEMS);
  const known: string[] = [];
  const unknown: string[] = [];
  for (const item of items.map((entry) => entry.trim()).filter(Boolean)) {
    (vocabulary.has(item) ? known : unknown).push(item);
  }
  return { known, unknown };
}

/** The identifiers Codex 0.147 accepts in `[tui].terminal_title`. */
export const KNOWN_TITLE_ITEMS = [
  'activity',
  'project-name',
  'app-name',
  'current-dir',
  'run-state',
  'thread-title',
  'git-branch',
  'context-remaining',
  'context-used',
  'five-hour-limit',
  'weekly-limit',
  'codex-version',
  'used-tokens',
  'total-input-tokens',
  'total-output-tokens',
  'thread-id',
  'fast-mode',
  'model-with-reasoning',
  'task-progress',
] as const;
