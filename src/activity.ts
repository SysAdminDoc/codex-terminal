/**
 * Live session state, folded from the rollout's own event stream.
 *
 * A rollout records explicit turn boundaries — `task_started`, `task_complete` and
 * `turn_aborted`, each carrying a `turn_id` — so "is Codex working right now" is a fact
 * read off disk rather than a guess from file mtime. `token_count` rides along and gives
 * the context gauge for free.
 *
 * Pure and `vscode`-free: the whole state machine is exercised by `node --test` against
 * real rollout lines, and a caller can fold a 100 MB rollout without holding it in memory.
 */

/**
 * `silent` is not a state Codex reports — it is what this extension concludes when a turn
 * has claimed to be working for implausibly long without writing anything. See
 * `settleActivity` for why that conclusion is drawn and why it stops short of `idle`.
 */
export type ActivityStatus = 'working' | 'idle' | 'aborted' | 'silent' | 'unknown';

/**
 * What Codex last finished doing.
 *
 * `item_completed` is overwhelmingly the most common record in a rollout — 55,992 of them
 * against 52 `task_started` across 25 recent sessions here — and it is the only per-step
 * signal Codex writes: there is no `item_started`. So the most recently *completed* item is
 * the best available answer to "what is it doing", and the wording stays in the past tense
 * because that is what the data actually says.
 */
export type ActivityItemKind =
  | 'command'
  | 'fileChange'
  | 'message'
  | 'prompt'
  | 'reasoning'
  | 'search'
  | 'compaction';

export interface ActivityItem {
  kind: ActivityItemKind;
  /** Command line, file names or query. Empty when the item carries nothing worth showing. */
  subject: string;
}

/** One rate-limit window as Codex reports it beside the token counts. */
export interface RateLimitWindow {
  /** 0–100. Codex sends it as a percentage, and it is kept in those units. */
  usedPercent: number;
  /** Length of the window; 10080 is the weekly one this account is on. */
  windowMinutes?: number;
  /** Epoch ms the window rolls over. Codex writes unix seconds. */
  resetsAt?: number;
}

export interface RateLimitWindows {
  primary?: RateLimitWindow;
  secondary?: RateLimitWindow;
}

export interface SessionActivity {
  status: ActivityStatus;
  /** Most recent `item_completed`, or undefined before Codex has finished a step. */
  lastItem?: ActivityItem;
  /** Turn currently running, or the last one to finish. */
  turnId?: string;
  /** Epoch ms the running turn started, used for the elapsed-time readout. */
  turnStartedAt?: number;
  /** Timestamp of the most recent event folded in, ISO 8601. */
  lastEventAt?: string;
  /** Assistant's closing message for the last completed turn. */
  lastMessage?: string;
  /** Why the last turn ended early, e.g. `interrupted`. */
  abortReason?: string;
  totalTokens?: number;
  contextWindow?: number;
  /**
   * Prompt size of the most recent request — what is actually sitting in the model's context.
   *
   * Distinct from `totalTokens`, which is the session-lifetime running total and therefore
   * unbounded: a single session here reached 180,572,005 against a 258,400-token window.
   * Dividing the lifetime total by the window is what made the context readout report 100%
   * for 120 of the 121 rollouts on this machine, so the two numbers are kept apart.
   */
  contextTokens?: number;
  /** Billable input, cached input included — the rollout reports the total, not the remainder. */
  inputTokens?: number;
  cachedInputTokens?: number;
  /** Output including reasoning tokens, which are billed as output. */
  outputTokens?: number;
  /** Model named by the most recent `turn_context`; a session can change model mid-flight. */
  model?: string;
  /**
   * Subscription the turn was billed to, e.g. `pro`. Present means the tokens were not billed
   * per token at all, which is the difference between an estimate and a fiction.
   */
  plan?: string;
  /**
   * How much of the plan's rate-limit windows this account has spent, as Codex last reported
   * it. On a subscription this is the number that actually constrains the next turn — money
   * is not — and Codex writes it into every `token_count` record: 55,975 of the 55,977 in the
   * local store carry a populated `primary`.
   */
  rateLimits?: RateLimitWindows;
  /** Highest `ordinal` folded in; rollout records are strictly ordered by it. */
  ordinal: number;
  /** Turns completed in this rollout. */
  completedTurns: number;
}

export const INITIAL_ACTIVITY: SessionActivity = {
  status: 'unknown',
  ordinal: -1,
  completedTurns: 0,
};

interface RolloutRecord {
  type?: unknown;
  ordinal?: unknown;
  timestamp?: unknown;
  payload?: Record<string, unknown>;
}

/** `started_at`/`completed_at` are unix seconds; everything else here is epoch ms. */
function epochMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value * 1000 : undefined;
}

function numberAt(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function objectAt(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = record?.[key];
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function tokensOf(payload: Record<string, unknown>): Pick<
  SessionActivity,
  | 'totalTokens'
  | 'contextWindow'
  | 'contextTokens'
  | 'inputTokens'
  | 'cachedInputTokens'
  | 'outputTokens'
  | 'plan'
  | 'rateLimits'
> {
  const limits = rateLimitsOf(objectAt(payload, 'rate_limits'));
  const info = objectAt(payload, 'info');
  if (!info) {
    // A record can carry the limits without the usage, and the limits are the half that
    // still constrains the next turn — so do not discard them along with the missing half.
    return limits ? { rateLimits: limits } : {};
  }
  const usage = objectAt(info, 'total_token_usage');
  const total = numberAt(usage, 'total_tokens');
  const input = numberAt(usage, 'input_tokens');
  const cached = numberAt(usage, 'cached_input_tokens');
  const output = numberAt(usage, 'output_tokens');
  // The prompt Codex last sent, which is the only figure that answers "how full is the
  // context". `last_token_usage.input_tokens` already includes the cached portion, so it is
  // the whole prompt rather than the part that had to be re-sent.
  const context = numberAt(objectAt(info, 'last_token_usage'), 'input_tokens');
  // `plan_type` rides on the rate-limit block beside the usage, not inside it.
  const plan = objectAt(payload, 'rate_limits')?.plan_type;
  return {
    ...(total !== undefined ? { totalTokens: total } : {}),
    ...(context !== undefined ? { contextTokens: context } : {}),
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(numberAt(info, 'model_context_window') !== undefined
      ? { contextWindow: numberAt(info, 'model_context_window') }
      : {}),
    ...(typeof plan === 'string' && plan ? { plan } : {}),
    ...(limits ? { rateLimits: limits } : {}),
  };
}

/**
 * Read the rate-limit block, keeping only windows that carry a usable percentage.
 *
 * `primary` and `secondary` are both present as keys and both frequently `null` — a `pro`
 * account reports a weekly `primary` and no `secondary` at all — so an absent window has to
 * stay absent rather than becoming a zero. A zero here would read as "nothing spent" at
 * exactly the moment nothing is known, which is the same mistake the context gauge made.
 */
function rateLimitsOf(block: Record<string, unknown> | undefined): RateLimitWindows | undefined {
  if (!block) {
    return undefined;
  }
  const primary = rateLimitWindowOf(objectAt(block, 'primary'));
  const secondary = rateLimitWindowOf(objectAt(block, 'secondary'));
  if (!primary && !secondary) {
    return undefined;
  }
  return { ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}) };
}

function rateLimitWindowOf(
  window: Record<string, unknown> | undefined,
): RateLimitWindow | undefined {
  const usedPercent = numberAt(window, 'used_percent');
  if (usedPercent === undefined) {
    return undefined;
  }
  const windowMinutes = numberAt(window, 'window_minutes');
  const resetsAt = epochMs(window?.resets_at);
  return {
    usedPercent,
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

/** Longest subject kept. Long enough to identify a step, short enough for a tree row. */
export const MAX_SUBJECT_LENGTH = 80;

const SHELLS = new Set(['pwsh', 'powershell', 'cmd', 'bash', 'sh', 'zsh', 'fish']);
/** The flag after which a shell's real argument is the script, not another option. */
const SCRIPT_FLAGS = new Set(['-command', '-c', '/c', '/k', '-file']);

function tidySubject(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_SUBJECT_LENGTH
    ? `${collapsed.slice(0, MAX_SUBJECT_LENGTH - 1)}…`
    : collapsed;
}

/** Basename tolerating either separator, because rollouts are written on every platform. */
function baseName(value: string): string {
  return value.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? value;
}

/**
 * Reduce an argv array to the part worth reading.
 *
 * Codex runs almost everything through a shell, so argv[0] is a 40-character absolute path
 * to pwsh and the interesting text is the script two arguments later. Showing the raw join
 * would fill the row with the same prefix on every single command.
 */
function describeCommand(command: readonly unknown[]): string {
  const parts = command.filter((part): part is string => typeof part === 'string');
  if (parts.length === 0) {
    return '';
  }
  const executable = baseName(parts[0]).replace(/\.(exe|cmd|bat)$/i, '');
  if (SHELLS.has(executable.toLowerCase())) {
    const flag = parts.findIndex((part) => SCRIPT_FLAGS.has(part.toLowerCase()));
    if (flag !== -1 && parts[flag + 1]) {
      return tidySubject(parts[flag + 1]);
    }
  }
  return tidySubject([executable, ...parts.slice(1)].join(' '));
}

/** First text out of a `content` array, whose entries differ in case between item kinds. */
function firstText(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }
  for (const entry of content) {
    if (typeof entry === 'object' && entry !== null) {
      const text = (entry as Record<string, unknown>).text;
      if (typeof text === 'string' && text.trim()) {
        return tidySubject(text);
      }
    }
  }
  return '';
}

function describeFileChange(changes: unknown): string {
  if (typeof changes !== 'object' || changes === null) {
    return '';
  }
  const paths = Object.keys(changes as Record<string, unknown>);
  if (paths.length === 0) {
    return '';
  }
  if (paths.length === 1) {
    return tidySubject(baseName(paths[0]));
  }
  // Two names plus a count beats a list that overflows the row and identifies nothing.
  return tidySubject(`${baseName(paths[0])}, ${baseName(paths[1])} +${paths.length - 2} more`);
}

/**
 * Turn one completed item into a kind and a subject.
 *
 * Returns undefined for shapes this does not recognise, and the caller keeps the previous
 * item rather than blanking the row — a Codex release adding an item type should cost the
 * display nothing.
 */
export function describeItem(item: unknown): ActivityItem | undefined {
  if (typeof item !== 'object' || item === null) {
    return undefined;
  }
  const record = item as Record<string, unknown>;
  switch (record.type) {
    case 'CommandExecution':
      return { kind: 'command', subject: describeCommand(record.command as unknown[] ?? []) };
    case 'FileChange':
      return { kind: 'fileChange', subject: describeFileChange(record.changes) };
    case 'AgentMessage':
      return { kind: 'message', subject: firstText(record.content) };
    case 'UserMessage':
      return { kind: 'prompt', subject: firstText(record.content) };
    case 'Reasoning':
      return { kind: 'reasoning', subject: firstText(record.summary_text) };
    case 'Extension':
      return {
        kind: 'search',
        subject: typeof record.query === 'string' ? tidySubject(record.query) : '',
      };
    case 'ContextCompaction':
      return { kind: 'compaction', subject: '' };
    default:
      return undefined;
  }
}

/**
 * Fold one rollout line into the activity state.
 *
 * Unparseable lines and unrelated record types return the state untouched, so a caller
 * can hand over every line of the file without filtering. A tailer may re-read a line it
 * has already folded after a partial write, so records at or below the current ordinal
 * are ignored rather than double-counted.
 */
export function reduceActivityLine(state: SessionActivity, line: string): SessionActivity {
  if (!line.trim()) {
    return state;
  }
  let record: RolloutRecord;
  try {
    record = JSON.parse(line) as RolloutRecord;
  } catch {
    return state;
  }
  if (!record.payload) {
    return state;
  }

  const ordinal = typeof record.ordinal === 'number' ? record.ordinal : state.ordinal + 1;
  if (ordinal <= state.ordinal) {
    return state;
  }

  // `turn_context` is a top-level record type rather than an `event_msg`, and it is the only
  // place the model appears — `session_meta` names the provider but never the model. Ordinals
  // are a single sequence across every record type, so folding it advances the same counter.
  if (record.type === 'turn_context') {
    const model = record.payload.model;
    return typeof model === 'string' && model
      ? { ...state, ordinal, model }
      : { ...state, ordinal };
  }
  if (record.type !== 'event_msg') {
    return state;
  }

  const payload = record.payload;
  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : state.lastEventAt;
  const base: SessionActivity = {
    ...state,
    ordinal,
    lastEventAt: timestamp,
    // `silent` is a conclusion drawn purely from records *not* arriving. One arriving
    // disproves it, so the session goes back to working unless this very record says
    // otherwise below — an answered approval prompt resumes without a fresh `task_started`.
    ...(state.status === 'silent' ? { status: 'working' as const } : {}),
  };

  switch (payload.type) {
    case 'task_started':
      return {
        ...base,
        status: 'working',
        turnId: typeof payload.turn_id === 'string' ? payload.turn_id : undefined,
        turnStartedAt: epochMs(payload.started_at),
        abortReason: undefined,
        ...(typeof payload.model_context_window === 'number'
          ? { contextWindow: payload.model_context_window }
          : {}),
      };
    case 'task_complete':
      return {
        ...base,
        status: 'idle',
        turnId: typeof payload.turn_id === 'string' ? payload.turn_id : base.turnId,
        turnStartedAt: undefined,
        abortReason: undefined,
        completedTurns: base.completedTurns + 1,
        ...(typeof payload.last_agent_message === 'string'
          ? { lastMessage: payload.last_agent_message }
          : {}),
      };
    case 'turn_aborted':
      return {
        ...base,
        status: 'aborted',
        turnId: typeof payload.turn_id === 'string' ? payload.turn_id : base.turnId,
        turnStartedAt: undefined,
        abortReason: typeof payload.reason === 'string' ? payload.reason : undefined,
      };
    case 'token_count':
      return { ...base, ...tokensOf(payload) };
    case 'item_completed': {
      const item = describeItem(payload.item);
      return item ? { ...base, lastItem: item } : base;
    }
    default:
      return base;
  }
}

/** Fold a batch of lines, newest state out. */
export function reduceActivity(
  state: SessionActivity,
  lines: readonly string[],
): SessionActivity {
  return lines.reduce(reduceActivityLine, state);
}

/** `working` is the only state that should animate; everything else is at rest. */
export function isWorking(activity: SessionActivity): boolean {
  return activity.status === 'working';
}

/**
 * How long the rollout has been silent while the session still claims to be working.
 *
 * A rollout tail cannot see everything. Codex writes nothing while it waits for the
 * operator to answer an approval prompt, and nothing while it is genuinely wedged, so both
 * look identical to a turn that simply started and never finished. Reporting elapsed
 * silence is the honest middle ground: it says what is observable — no output for N
 * seconds — instead of asserting a state that cannot be distinguished from here.
 */
export function silentFor(activity: SessionActivity, now: number): number | undefined {
  // `silent` is included deliberately: the elapsed silence is the single most useful thing
  // to say about a session in that state, and gating it on `working` alone would hide it at
  // exactly the point it became worth reporting.
  if ((activity.status !== 'working' && activity.status !== 'silent') || !activity.lastEventAt) {
    return undefined;
  }
  const last = Date.parse(activity.lastEventAt);
  if (Number.isNaN(last)) {
    return undefined;
  }
  return Math.max(0, Math.floor((now - last) / 1000));
}

/** True once a working session has produced no output for `thresholdSeconds`. */
export function isStalled(
  activity: SessionActivity,
  now: number,
  thresholdSeconds: number,
): boolean {
  const silent = silentFor(activity, now);
  return silent !== undefined && silent >= thresholdSeconds;
}

/**
 * How long a working turn may go quiet before its own claim stops being believable.
 *
 * Measured rather than chosen. Across 80,779 gaps between consecutive events *inside* real
 * turns (25 sessions on this machine, 2026-08-10): median 1.8s, p99 30s, p99.9 128s, and
 * the largest gap observed while genuinely working was 269s. Nothing exceeded 300s, so 600s
 * keeps better than a 2x margin over the worst real case.
 */
export const SILENT_AFTER_SECONDS = 600;

/**
 * Stop believing a turn that has been silent far past anything a real turn does.
 *
 * Codex does not always record the end of a turn: across 25 recent sessions there were 52
 * `task_started` against 40 `task_complete`. `turn_aborted` is emitted but rare — 29 across
 * the 121 rollouts on this machine — and 61 turns have no terminal record of any kind, so an
 * interrupted
 * turn leaves the session pinned at `working` for the life of the window — spinner running,
 * badge counting it, status bar calling it busy, while the operator sits at an idle prompt.
 *
 * The demotion stops at `silent` rather than `idle` on purpose. Codex writes nothing while
 * waiting for an approval and nothing while wedged, and a rollout tail cannot tell those from
 * a finished turn; calling it `idle` would swap one confident wrong answer for another. What
 * *is* certain is that it is not working, so the count, the spinner and the badge become
 * correct while the label stays honest about the uncertainty.
 *
 * `stallSeconds * 2` is a floor: an operator who raises the stall threshold is saying their
 * sessions go quiet for longer, and the give-up point has to move with it.
 */
export function settleActivity(
  activity: SessionActivity,
  now: number,
  stallSeconds: number,
  silentAfterSeconds = SILENT_AFTER_SECONDS,
): SessionActivity {
  if (activity.status !== 'working') {
    return activity;
  }
  const silent = silentFor(activity, now);
  if (silent === undefined || silent < Math.max(silentAfterSeconds, stallSeconds * 2)) {
    return activity;
  }
  return { ...activity, status: 'silent' };
}

/** Whole seconds the running turn has been going, for the tooltip readout. */
export function elapsedSeconds(activity: SessionActivity, now: number): number | undefined {
  if (activity.status !== 'working' || activity.turnStartedAt === undefined) {
    return undefined;
  }
  return Math.max(0, Math.floor((now - activity.turnStartedAt) / 1000));
}

/**
 * Fraction of the model's context window occupied, 0–1, when both numbers are known.
 *
 * Deliberately built on `contextTokens` alone. Falling back to the lifetime total would put
 * the old defect back: it clamps to 1 on any session of length, so the readout would look
 * populated while saying nothing. A rollout too old to carry `last_token_usage` reports
 * nothing here instead, and the row drops the percentage the way it drops every absent fact.
 */
export function contextUsed(activity: SessionActivity): number | undefined {
  if (!activity.contextTokens || !activity.contextWindow) {
    return undefined;
  }
  return Math.min(1, activity.contextTokens / activity.contextWindow);
}
