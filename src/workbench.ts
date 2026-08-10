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
  return ['-c', `tui.terminal_title=[${cleaned.map((item) => `"${item}"`).join(',')}]`];
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
