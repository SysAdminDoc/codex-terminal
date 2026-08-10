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

export type ActivityStatus = 'working' | 'idle' | 'aborted' | 'unknown';

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

function tokensOf(payload: Record<string, unknown>): Pick<
  SessionActivity,
  'totalTokens' | 'contextWindow'
> {
  const info = payload.info;
  if (typeof info !== 'object' || info === null) {
    return {};
  }
  const record = info as Record<string, unknown>;
  const usage = record.total_token_usage;
  const total =
    typeof usage === 'object' && usage !== null
      ? (usage as Record<string, unknown>).total_tokens
      : undefined;
  return {
    ...(typeof total === 'number' ? { totalTokens: total } : {}),
    ...(typeof record.model_context_window === 'number'
      ? { contextWindow: record.model_context_window }
      : {}),
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
  if (record.type !== 'event_msg' || !record.payload) {
    return state;
  }

  const ordinal = typeof record.ordinal === 'number' ? record.ordinal : state.ordinal + 1;
  if (ordinal <= state.ordinal) {
    return state;
  }

  const payload = record.payload;
  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : state.lastEventAt;
  const base: SessionActivity = { ...state, ordinal, lastEventAt: timestamp };

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
  if (activity.status !== 'working' || !activity.lastEventAt) {
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

/** Whole seconds the running turn has been going, for the tooltip readout. */
export function elapsedSeconds(activity: SessionActivity, now: number): number | undefined {
  if (activity.status !== 'working' || activity.turnStartedAt === undefined) {
    return undefined;
  }
  return Math.max(0, Math.floor((now - activity.turnStartedAt) / 1000));
}

/** Fraction of the model's context window consumed, 0–1, when both numbers are known. */
export function contextUsed(activity: SessionActivity): number | undefined {
  if (!activity.totalTokens || !activity.contextWindow) {
    return undefined;
  }
  return Math.min(1, activity.totalTokens / activity.contextWindow);
}
