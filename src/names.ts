/**
 * Operator-assigned names for Codex sessions.
 *
 * Codex consumes session names — `resume`, `archive`, `delete` and `unarchive` all accept
 * "session id or session name" — but the CLI exposes nothing that *sets* one (verified
 * against 0.147: no rename subcommand, no flag). Setting a thread's name is only reachable
 * through `codex app-server`'s `thread/name/set`, which this extension does not yet speak.
 *
 * So these names are the extension's own, stored beside the session id and used wherever it
 * draws a session. That is enough for the thing names are actually for — telling six running
 * agents apart — and resuming still works, because a name resolves to an id here before the
 * command is built. The one place a name cannot reach is Codex's own `thread-title` tab item,
 * which Codex renders from a title this extension has no way to set.
 *
 * Pure and `vscode`-free so the naming rules are unit tested.
 */

export type SessionNames = Record<string, string>;

/** Long enough to be descriptive, short enough for a tree row and a tab. */
export const MAX_NAME_LENGTH = 60;

/**
 * Collapse a typed name to what will be stored.
 *
 * Whitespace is collapsed rather than preserved because a name is rendered inline next to a
 * status and a duration, where a stray newline would break the row.
 */
export function normaliseName(raw: string): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_NAME_LENGTH ? collapsed.slice(0, MAX_NAME_LENGTH).trim() : collapsed;
}

/** Set or, given an empty name, clear. Clearing is how a name is removed — there is no delete. */
export function setSessionName(names: SessionNames, id: string, raw: string): SessionNames {
  const next = { ...names };
  const name = normaliseName(raw);
  if (name) {
    next[id] = name;
  } else {
    delete next[id];
  }
  return next;
}

export function sessionName(names: SessionNames, id: string | undefined): string | undefined {
  return id ? names[id] : undefined;
}

/**
 * What to show for a session: its name if it has one, otherwise the fallback.
 *
 * Deliberately not "name — project": a named session is named precisely so the operator does
 * not have to read the project to identify it, and appending it back defeats that.
 */
export function displayName(
  names: SessionNames,
  id: string | undefined,
  fallback: string,
): string {
  return sessionName(names, id) ?? fallback;
}

/** Resolve a typed name back to a session id, so resuming by name works. */
export function idForName(names: SessionNames, raw: string): string | undefined {
  const wanted = normaliseName(raw).toLowerCase();
  if (!wanted) {
    return undefined;
  }
  return Object.keys(names).find((id) => names[id].toLowerCase() === wanted);
}
