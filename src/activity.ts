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

export interface SessionActivity {
  status: ActivityStatus;
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
