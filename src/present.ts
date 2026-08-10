/**
 * How a session's state turns into an icon, a label and a badge.
 *
 * Kept pure and `vscode`-free so the mapping is unit tested: an icon id is easy to get
 * subtly wrong (a codicon that does not exist renders as a blank square, silently) and the
 * animated variants only work when the `~spin` modifier is spelled correctly.
 */

import { contextUsed, elapsedSeconds, silentFor, type SessionActivity } from './activity';

/**
 * `~spin` is a codicon *modifier*: the workbench turns `loading~spin` into
 * `codicon codicon-loading codicon-modifier-spin`, and the animation is CSS. It is the
 * only animation primitive the tree, the status bar and quick picks all honour.
 */
export const SPINNER_ICON = 'loading~spin';

/** Silence beyond this is worth reporting; below it, a quiet moment is just a quiet moment. */
export const DEFAULT_STALL_SECONDS = 45;

export interface StatusPresentation {
  icon: string;
  /** Theme colour id, or undefined to inherit the tree's foreground. */
  color?: string;
  label: string;
}

/**
 * Whether continuous motion is acceptable.
 *
 * `loading~spin` animates forever, which is exactly what a reduced-motion preference exists
 * to suppress. VS Code exposes `workbench.reduceMotion` (`on` / `off` / `auto`, where `auto`
 * follows the OS), so the spinner is a preference to honour rather than a constant.
 */
export function motionAllowed(reduceMotion: string | undefined, systemPrefersReduced = false): boolean {
  if (reduceMotion === 'on') {
    return false;
  }
  if (reduceMotion === 'off') {
    return true;
  }
  return !systemPrefersReduced;
}

export function presentStatus(
  activity: SessionActivity,
  animate = true,
): StatusPresentation {
  switch (activity.status) {
    case 'working':
      // `sync` reads as in-progress without moving; the label still says Working.
      return { icon: animate ? SPINNER_ICON : 'sync', color: 'charts.blue', label: 'Working' };
    case 'aborted':
      return {
        icon: 'circle-slash',
        color: 'charts.yellow',
        label: activity.abortReason === 'interrupted' ? 'Interrupted' : 'Stopped',
      };
    case 'idle':
      return { icon: 'check', color: 'charts.green', label: 'Idle' };
    default:
      return { icon: 'terminal', label: 'Starting…' };
  }
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) {
    return String(tokens);
  }
  if (tokens < 1_000_000) {
    return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  }
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/**
 * The right-hand text on a live session row: what it is doing, for how long, and how much
 * of the context window it has eaten. Absent facts are dropped rather than shown as
 * placeholders, so a session that has just started reads cleanly.
 */
export function describeActivity(
  activity: SessionActivity,
  now: number,
  stallSeconds = DEFAULT_STALL_SECONDS,
): string {
  const parts: string[] = [presentStatus(activity).label];
  const elapsed = elapsedSeconds(activity, now);
  if (elapsed !== undefined) {
    parts.push(formatDuration(elapsed));
  }
  // Say what is observable. Codex is silent both while awaiting an approval and while
  // wedged, and a rollout tail cannot tell those apart — so report the silence, not a
  // state we would be guessing at.
  const silent = silentFor(activity, now);
  if (silent !== undefined && silent >= stallSeconds) {
    parts.push(`no output for ${formatDuration(silent)}`);
  }
  if (activity.totalTokens) {
    parts.push(`${formatTokens(activity.totalTokens)} tokens`);
  }
  const used = contextUsed(activity);
  if (used !== undefined) {
    parts.push(`${Math.round(used * 100)}% context`);
  }
  return parts.join(' · ');
}

/**
 * Highest context usage across sessions, which is the number worth surfacing: the session
 * closest to its limit is the one about to force a compaction. Undefined while no session
 * has reported both a token count and a context window — a zero here would read as "plenty
 * of room left" precisely when nothing is known.
 */
export function peakContextUsed(activities: readonly SessionActivity[]): number | undefined {
  let peak: number | undefined;
  for (const activity of activities) {
    const used = contextUsed(activity);
    if (used !== undefined && (peak === undefined || used > peak)) {
      peak = used;
    }
  }
  return peak;
}

/** Status bar text. `$(id)` is the workbench's inline-icon syntax, spin modifier included. */
export function statusBarText(
  workingCount: number,
  liveCount: number,
  peakContext?: number,
  animate = true,
): string {
  const context = peakContext === undefined ? '' : ` · ${Math.round(peakContext * 100)}%`;
  if (workingCount > 0) {
    return `$(${animate ? SPINNER_ICON : 'sync'}) Codex ${workingCount}/${liveCount}${context}`;
  }
  if (liveCount > 0) {
    return `$(sparkle) Codex ${liveCount}${context}`;
  }
  return '$(sparkle) Codex';
}
