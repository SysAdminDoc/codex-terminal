/**
 * How a session's state turns into an icon, a label and a badge.
 *
 * Kept pure and `vscode`-free so the mapping is unit tested: an icon id is easy to get
 * subtly wrong (a codicon that does not exist renders as a blank square, silently) and the
 * animated variants only work when the `~spin` modifier is spelled correctly.
 */

import {
  contextUsed,
  elapsedSeconds,
  isWorking,
  silentFor,
  type ActivityItem,
  type RateLimitWindow,
  type SessionActivity,
} from './activity';
import { estimateCost, formatCost, type RateTable } from './cost';

/**
 * `~spin` is a codicon *modifier*: the workbench turns `loading~spin` into
 * `codicon codicon-loading codicon-modifier-spin`, and the animation is CSS. It is the
 * only animation primitive the tree, the status bar and quick picks all honour.
 */
export const SPINNER_ICON = 'loading~spin';

/**
 * Every word this module puts on screen, injected rather than imported.
 *
 * `present.ts` stays free of `vscode`, which is the whole reason its mapping is unit tested —
 * so it cannot reach `vscode.l10n.t` itself. These labels used to be English string literals
 * inline, and `announceActivity` is the **accessible name** of a running-session row, so a
 * Spanish editor read English aloud while showing Spanish everywhere else.
 *
 * The defaults below are the English set, so tests and any caller that has not configured the
 * module behave exactly as before.
 */
export interface PresentationLabels {
  working: string;
  interrupted: string;
  stopped: string;
  silent: string;
  idle: string;
  starting: string;

  ranCommand: (subject: string) => string;
  ranSomeCommand: string;
  editedFiles: (subject: string) => string;
  editedSomeFiles: string;
  searched: (subject: string) => string;
  searchedTheWeb: string;
  said: (subject: string) => string;
  replied: string;
  youSaid: (subject: string) => string;
  tookYourPrompt: string;
  thinkingAbout: (subject: string) => string;
  thinking: string;
  compacted: string;

  noOutputFor: (duration: string) => string;
  totalTokens: (count: string) => string;
  contextPercent: (percent: number) => string;
  windowPercent: (percent: number, window: string) => string;

  noRecentOutput: string;
  turnsCompleted: (count: number) => string;

  planLimit: string;
  weeklyLimit: string;
  fiveHourLimit: string;
  dayLimit: (days: number) => string;
  hourLimit: (hours: number) => string;
  minuteLimit: (minutes: number) => string;

  percentOfWindow: (percent: number, window: string) => string;
  resetting: string;
  resetsIn: (countdown: string) => string;
  now: string;
}

const ENGLISH: PresentationLabels = {
  working: 'Working',
  interrupted: 'Interrupted',
  stopped: 'Stopped',
  silent: 'Silent',
  idle: 'Idle',
  starting: 'Starting…',

  ranCommand: (subject) => `ran ${subject}`,
  ranSomeCommand: 'ran a command',
  editedFiles: (subject) => `edited ${subject}`,
  editedSomeFiles: 'edited files',
  searched: (subject) => `searched ${subject}`,
  searchedTheWeb: 'searched the web',
  said: (subject) => `said ${subject}`,
  replied: 'replied',
  youSaid: (subject) => `you said ${subject}`,
  tookYourPrompt: 'took your prompt',
  thinkingAbout: (subject) => `thinking: ${subject}`,
  thinking: 'thinking',
  compacted: 'compacted the context',

  noOutputFor: (duration) => `no output for ${duration}`,
  totalTokens: (count) => `${count} total tokens`,
  contextPercent: (percent) => `${percent}% context`,
  windowPercent: (percent, window) => `${percent}% ${window}`,

  noRecentOutput: 'no recent output',
  turnsCompleted: (count) => (count === 1 ? '1 turn completed' : `${count} turns completed`),

  planLimit: 'plan limit',
  weeklyLimit: 'weekly limit',
  fiveHourLimit: '5-hour limit',
  dayLimit: (days) => `${days}-day limit`,
  hourLimit: (hours) => `${hours}-hour limit`,
  minuteLimit: (minutes) => `${minutes}-minute limit`,

  percentOfWindow: (percent, window) => `${percent}% of the ${window}`,
  resetting: 'resetting',
  resetsIn: (countdown) => `resets in ${countdown}`,
  now: 'now',
};

let labels: PresentationLabels = ENGLISH;

/** Called once during activation with the localised set. */
export function configurePresentation(next: PresentationLabels): void {
  labels = next;
}

/** Restores the English defaults. For tests, so one case cannot leak into the next. */
export function resetPresentation(): void {
  labels = ENGLISH;
}


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
      return { icon: animate ? SPINNER_ICON : 'sync', color: 'charts.blue', label: labels.working };
    case 'aborted':
      return {
        icon: 'circle-slash',
        color: 'charts.yellow',
        label: activity.abortReason === 'interrupted' ? labels.interrupted : labels.stopped,
      };
    case 'silent':
      // `question` is the honest glyph: the session is definitely not working, and what it
      // is instead — waiting on an approval, wedged, or quietly finished — is unknowable
      // from the session file.
      return { icon: 'question', color: 'charts.yellow', label: labels.silent };
    case 'idle':
      return { icon: 'check', color: 'charts.green', label: labels.idle };
    default:
      return { icon: 'terminal', label: labels.starting };
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

/**
 * A countdown, at the resolution the number is worth reading at.
 *
 * `formatDuration` is for a turn and tops out at hours-and-minutes; a plan window can be days
 * away, and "76h 12m" is not a figure anyone converts in their head.
 */
export function formatCountdown(seconds: number): string {
  if (seconds <= 0) {
    return labels.now;
  }
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  return formatDuration(seconds);
}

/**
 * Name a rate-limit window by its length, because Codex sends minutes and nothing else.
 *
 * Only the two lengths Codex actually uses are named; anything else is described by its own
 * duration rather than guessed at, so a new window shape reads as itself instead of being
 * mislabelled as one of these.
 */
export function describeWindowLength(minutes: number | undefined): string {
  if (minutes === undefined) {
    return labels.planLimit;
  }
  if (minutes === 10_080) {
    return labels.weeklyLimit;
  }
  if (minutes === 300) {
    return labels.fiveHourLimit;
  }
  if (minutes % 1440 === 0) {
    return labels.dayLimit(minutes / 1440);
  }
  return minutes % 60 === 0 ? labels.hourLimit(minutes / 60) : labels.minuteLimit(minutes);
}

/**
 * The rate-limit window closest to being spent, which is the one that will stop the next turn.
 *
 * Undefined when no window has been reported. A subscription reports a weekly `primary` and no
 * `secondary` at all, so picking "the primary one" would show nothing on a plan whose binding
 * constraint happens to be the other.
 */
export function tightestWindow(activity: SessionActivity): RateLimitWindow | undefined {
  const windows = [activity.rateLimits?.primary, activity.rateLimits?.secondary].filter(
    (window): window is RateLimitWindow => window !== undefined,
  );
  let tightest: RateLimitWindow | undefined;
  for (const window of windows) {
    if (!tightest || window.usedPercent > tightest.usedPercent) {
      tightest = window;
    }
  }
  return tightest;
}

/**
 * "73% of the weekly limit · resets in 3d 4h", or nothing at all.
 *
 * On a subscription this is the figure that constrains the next turn — a dollar estimate is
 * a list-price equivalent nobody is billed. The reset time is the half that makes it
 * actionable: 73% spent matters very differently three hours and three days from a rollover.
 */
export function describeRateLimit(
  window: RateLimitWindow | undefined,
  now: number,
): string | undefined {
  if (!window) {
    return undefined;
  }
  const parts = [
    labels.percentOfWindow(
      Math.round(window.usedPercent),
      describeWindowLength(window.windowMinutes),
    ),
  ];
  if (window.resetsAt !== undefined) {
    const seconds = Math.round((window.resetsAt - now) / 1000);
    parts.push(seconds <= 0 ? labels.resetting : labels.resetsIn(formatCountdown(seconds)));
  }
  return parts.join(' · ');
}

/** Highest rate-limit pressure across sessions; they share one account, so they share it. */
export function peakRateLimit(
  activities: readonly SessionActivity[],
): RateLimitWindow | undefined {
  let peak: RateLimitWindow | undefined;
  for (const activity of activities) {
    const window = tightestWindow(activity);
    if (window && (!peak || window.usedPercent > peak.usedPercent)) {
      peak = window;
    }
  }
  return peak;
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
 * The last completed step, in words.
 *
 * Past tense throughout, because that is what the record says: Codex writes `item_completed`
 * and nothing at all when a step begins, so "Ran" is true where "Running" would be a guess.
 * A step with no subject still names its kind — knowing Codex is thinking beats a blank.
 */
export function describeItem(item: ActivityItem | undefined): string | undefined {
  if (!item) {
    return undefined;
  }
  switch (item.kind) {
    case 'command':
      return item.subject ? labels.ranCommand(item.subject) : labels.ranSomeCommand;
    case 'fileChange':
      return item.subject ? labels.editedFiles(item.subject) : labels.editedSomeFiles;
    case 'search':
      return item.subject ? labels.searched(item.subject) : labels.searchedTheWeb;
    case 'message':
      return item.subject ? labels.said(item.subject) : labels.replied;
    case 'prompt':
      return item.subject ? labels.youSaid(item.subject) : labels.tookYourPrompt;
    case 'reasoning':
      return item.subject ? labels.thinkingAbout(item.subject) : labels.thinking;
    case 'compaction':
      return labels.compacted;
    default:
      return undefined;
  }
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
  rates?: RateTable,
): string {
  const parts: string[] = [presentStatus(activity).label];
  // Only while working or silent. On an idle session the last step is history, and repeating
  // it beside "Idle" reads as though something is still happening — but on a silent one it is
  // the best clue to where the session stopped.
  const step =
    activity.status === 'working' || activity.status === 'silent'
      ? describeItem(activity.lastItem)
      : undefined;
  if (step) {
    parts.push(step);
  }
  const elapsed = elapsedSeconds(activity, now);
  if (elapsed !== undefined) {
    parts.push(formatDuration(elapsed));
  }
  // Say what is observable. Codex is silent both while awaiting an approval and while
  // wedged, and a rollout tail cannot tell those apart — so report the silence, not a
  // state we would be guessing at.
  const silent = silentFor(activity, now);
  if (silent !== undefined && silent >= stallSeconds) {
    parts.push(labels.noOutputFor(formatDuration(silent)));
  }
  if (activity.totalTokens) {
    parts.push(labels.totalTokens(formatTokens(activity.totalTokens)));
  }
  const used = contextUsed(activity);
  if (used !== undefined) {
    parts.push(labels.contextPercent(Math.round(used * 100)));
  }
  // On a subscription this, not the cost estimate, is what actually stops the next turn.
  const window = tightestWindow(activity);
  if (window) {
    parts.push(
      labels.windowPercent(
        Math.round(window.usedPercent),
        describeWindowLength(window.windowMinutes),
      ),
    );
  }
  // Only when the operator has priced the model. An unpriced session says so in the tooltip,
  // where there is room to name the model, rather than putting a hole in the row.
  const estimate = estimateCost(activity, rates);
  if (estimate?.usd !== undefined) {
    parts.push(formatCost(estimate.usd));
  }
  return parts.join(' · ');
}

/**
 * The same row, said out loud.
 *
 * Deliberately narrower than `describeActivity`, and the difference is the whole point. A
 * tree row's accessible name is re-announced whenever it changes while the row has focus, and
 * `describeActivity` carries elapsed time, a token total and a context percentage — three
 * values that differ on nearly every refresh. Announcing those is not extra detail, it is the
 * row talking over the rest of the screen every second or two for the length of a turn.
 *
 * What is left changes only when something actually happened: the status, whether the session
 * has gone quiet, and how many turns have finished. Everything dropped is still on screen and
 * still in the tooltip, which is where a value that ticks belongs.
 */
export function announceActivity(
  activity: SessionActivity,
  now: number,
  stallSeconds = DEFAULT_STALL_SECONDS,
): string {
  const parts: string[] = [presentStatus(activity).label];
  const silent = silentFor(activity, now);
  // The threshold crossing is the event; the duration is the thing that would repeat.
  if (silent !== undefined && silent >= stallSeconds) {
    parts.push(labels.noRecentOutput);
  }
  if (activity.completedTurns > 0) {
    parts.push(labels.turnsCompleted(activity.completedTurns));
  }
  return parts.join(', ');
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

/**
 * Order sessions for the jump-to picker: working first, then most recently launched.
 *
 * Working first because that is what the operator is looking for — the status bar counts
 * working sessions, so a click on it should land near them rather than in launch order.
 * `isWorking` is deliberately the only grouping: `silent` and `idle` are both "not busy", and
 * ranking them against each other would imply a distinction the session file cannot support.
 */
export function pickerOrder<T extends { activity: SessionActivity; launchedAt: number }>(
  sessions: readonly T[],
): T[] {
  return [...sessions].sort((left, right) => {
    const busy = Number(isWorking(right.activity)) - Number(isWorking(left.activity));
    return busy !== 0 ? busy : right.launchedAt - left.launchedAt;
  });
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
