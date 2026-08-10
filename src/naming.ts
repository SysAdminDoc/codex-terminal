import * as path from 'node:path';

/**
 * Terminal tab naming, and why the tab can animate at all.
 *
 * Supplying `name` to `createTerminal` does far more than set a label. In the workbench,
 * `name && !titleTemplate` takes the branch that records a *static title* and **never
 * attaches the xterm `onTitleChange` listener**; the alternative branch is the only one
 * that subscribes. With no listener the instance's `${sequence}` is never populated, so a
 * named terminal cannot show a process-driven title in either its title or its
 * description — the label computer additionally short-circuits `title` outright whenever a
 * static title exists.
 *
 * That is the whole reason a Codex tab used to sit motionless while Codex worked: Codex
 * emits a live OSC title (its `[tui].terminal_title` items, `activity` first, which is an
 * animated spinner), and a static `name` threw every one of those updates away.
 *
 * Hence two modes:
 *
 * - `live` — no `name`, so the listener attaches and Codex's own animated title drives the
 *   tab. The project stays visible because Codex's `project-name` title item puts it
 *   there, and `app-name` keeps the constant "Codex" marker used for adoption.
 * - `static` — the previous behaviour, for anyone who wants a fixed label more than a
 *   live one.
 *
 * Ownership therefore cannot rely on the tab text in `live` mode, where Codex owns it.
 * `OWNERSHIP_ENV_VAR` is stamped into the terminal's environment instead and read back
 * from `creationOptions`.
 */

export interface TerminalNameContext {
  /** `codexTerminal.terminalName`, the constant part of the label. */
  name: string;
  /** Working directory the session will start in, if one was resolved. */
  cwd?: string;
  /** Workspace folder name, preferred over the cwd basename when they differ. */
  workspaceFolder?: string;
  mode: 'new' | 'resumeLast' | 'resumePicker' | 'forkLast' | 'forkPicker';
  profile?: string;
  sessionId?: string;
}

export const DEFAULT_TERMINAL_NAME_TEMPLATE = '${project} — ${name}${mode}';

/**
 * `activity` is the animated item — Codex redraws it as it works, which is what makes the
 * tab move. `app-name` is not decoration: it is the constant substring that lets a
 * surviving tab be recognised as ours after a window reload, when the environment marker
 * is the primary check and the label is the fallback.
 */
export const DEFAULT_TITLE_ITEMS = ['activity', 'project-name', 'app-name'] as const;

/** Stamped into every terminal we launch; read back from `creationOptions.env`. */
export const OWNERSHIP_ENV_VAR = 'CODEX_TERMINAL_OWNED';

export type TabTitleMode = 'live' | 'static';

const MODE_SUFFIX: Record<TerminalNameContext['mode'], string> = {
  new: '',
  resumeLast: ' (resumed)',
  resumePicker: ' (resumed)',
  forkLast: ' (fork)',
  forkPicker: ' (fork)',
};

/** Basename of a path, tolerating either separator regardless of the host platform. */
export function projectName(context: TerminalNameContext): string {
  if (context.workspaceFolder?.trim()) {
    return context.workspaceFolder.trim();
  }
  const cwd = context.cwd?.trim();
  if (!cwd) {
    return '';
  }
  const normalised = cwd.replace(/[\\/]+$/, '');
  const leaf = normalised.split(/[\\/]/).pop() ?? '';
  // A drive root ("C:") has no leaf worth showing.
  return leaf && !/^[a-zA-Z]:$/.test(leaf) ? leaf : path.win32.parse(normalised).root || leaf;
}

/**
 * Collapse the separators left behind by variables that resolved to nothing, so a
 * template written for the full case still reads correctly when half of it is empty.
 */
function tidy(value: string): string {
  return value
    .replace(/[ \t]+/g, ' ')
    .replace(/(?:\s*[—–|·:]\s*)+/g, (match) => (match.trim() ? ' — ' : ' '))
    .replace(/^\s*[—–|·:]\s*/, '')
    .replace(/\s*[—–|·:]\s*$/, '')
    .trim();
}

/**
 * Render the tab title. Unknown variables are left untouched rather than blanked, so a
 * typo in a user template is visible instead of silently eating part of the name.
 */
export function renderTerminalName(template: string, context: TerminalNameContext): string {
  const values: Record<string, string> = {
    name: context.name.trim(),
    project: projectName(context),
    folder: context.cwd ?? '',
    mode: MODE_SUFFIX[context.mode],
    profile: context.profile?.trim() ?? '',
    session: context.sessionId ? context.sessionId.slice(0, 8) : '',
  };

  const rendered = template.replace(/\$\{(\w+)\}/g, (match, key: string) =>
    key in values ? values[key] : match,
  );
  // `${mode}` carries its own leading space, so tidy the parenthesised suffix back on.
  const collapsed = tidy(rendered).replace(/\s+\(/g, ' (');
  return collapsed || values.name || 'Codex';
}

/**
 * Recognise our own terminals after a window reload, when the registry is empty but the
 * shell processes survived. Names are templated now, so an equality test against
 * `terminalName` would adopt nothing; the constant part of the template is the marker.
 */
export function isOwnedTerminalName(terminalName: string, baseName: string): boolean {
  const base = baseName.trim();
  return base.length > 0 && terminalName.includes(base);
}
