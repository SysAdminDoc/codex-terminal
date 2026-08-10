import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import type { ActivityStatus } from './activity';

/**
 * Crash-durable record of which Codex sessions a window had open.
 *
 * The editor can die without running `deactivate`, which is exactly the case this exists
 * for: Codex has already written the conversation to its rollout, but nothing said *which*
 * rollouts were the ones on screen, so after a crash the operator is left guessing among
 * hundreds of files. Each window owns one journal file and heartbeats into it; a file
 * whose heartbeat has gone stale without a clean-shutdown stamp belonged to a window that
 * died, and every session still open in it is recoverable.
 *
 * One file per window rather than one shared file: two windows writing the same document
 * would clobber each other's sessions, and a per-window file also makes "is that window
 * still alive" answerable with a timestamp instead of a lock.
 *
 * Node's fs only — no `vscode` — so the staleness rules are unit tested directly.
 */

export const JOURNAL_VERSION = 1;

/** A window is presumed dead once its heartbeat is this old. */
export const STALE_HEARTBEAT_MS = 90_000;

export interface JournalSession {
  /** Stable per-launch key; survives before the Codex session id is known. */
  key: string;
  /** Codex rollout id, once the launch has been bound to a rollout file. */
  sessionId?: string;
  rolloutPath?: string;
  cwd: string;
  project: string;
  label: string;
  mode: string;
  profile?: string;
  launchedAt: number;
  lastActiveAt: number;
  /** Set when the terminal closed normally; absent means it was still open. */
  closedAt?: number;
  status: ActivityStatus;
  lastMessage?: string;
  completedTurns: number;
}

export interface JournalState {
  version: number;
  windowId: string;
  workspaceName?: string;
  heartbeatAt: number;
  /** Stamped by `deactivate`; its absence next to a stale heartbeat means a crash. */
  cleanShutdownAt?: number;
  sessions: JournalSession[];
}

export function emptyJournal(windowId: string, workspaceName?: string): JournalState {
  return {
    version: JOURNAL_VERSION,
    windowId,
    ...(workspaceName ? { workspaceName } : {}),
    heartbeatAt: 0,
    sessions: [],
  };
}

/** Insert or update one session by key, leaving the rest of the journal alone. */
export function upsertSession(
  state: JournalState,
  session: JournalSession,
): JournalState {
  const sessions = [...state.sessions];
  const index = sessions.findIndex((candidate) => candidate.key === session.key);
  if (index === -1) {
    sessions.push(session);
  } else {
    sessions[index] = { ...sessions[index], ...session };
  }
  return { ...state, sessions };
}

/**
 * Sessions worth offering back to the operator.
 *
 * Only rollout-bound sessions qualify: a launch that never produced a rollout has no
 * conversation to return to, and offering it would be offering an empty terminal.
 */
export function recoverableSessions(state: JournalState): JournalSession[] {
  return state.sessions.filter(
    (session) => session.closedAt === undefined && session.sessionId !== undefined,
  );
}

/** True when this journal belonged to a window that died without shutting down. */
export function isCrashed(
  state: JournalState,
  now: number,
  staleMs = STALE_HEARTBEAT_MS,
): boolean {
  if (state.cleanShutdownAt !== undefined) {
    return false;
  }
  return now - state.heartbeatAt > staleMs;
}

/**
 * Collect every session left open by a window that is no longer running.
 *
 * `ownWindowId` is skipped so a window never offers to recover itself, and the newest
 * record wins when the same Codex session appears in more than one journal (a session
 * that was already recovered once and crashed again).
 */
export function interruptedSessions(
  journals: readonly JournalState[],
  now: number,
  ownWindowId: string,
  staleMs = STALE_HEARTBEAT_MS,
): JournalSession[] {
  const byId = new Map<string, JournalSession>();
  for (const journal of journals) {
    if (journal.windowId === ownWindowId || !isCrashed(journal, now, staleMs)) {
      continue;
    }
    for (const session of recoverableSessions(journal)) {
      const previous = byId.get(session.sessionId as string);
      if (!previous || session.lastActiveAt > previous.lastActiveAt) {
        byId.set(session.sessionId as string, session);
      }
    }
  }
  return [...byId.values()].sort((left, right) => right.lastActiveAt - left.lastActiveAt);
}

/** Journal files that are finished with: cleanly closed, or old enough to be noise. */
export function isDisposable(
  state: JournalState,
  now: number,
  ownWindowId: string,
  maxAgeMs: number,
  staleMs = STALE_HEARTBEAT_MS,
): boolean {
  if (state.windowId === ownWindowId) {
    return false;
  }
  if (now - state.heartbeatAt <= staleMs) {
    return false;
  }
  return state.cleanShutdownAt !== undefined || now - state.heartbeatAt > maxAgeMs;
}

export function parseJournal(text: string): JournalState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const state = parsed as Partial<JournalState>;
  if (
    state.version !== JOURNAL_VERSION ||
    typeof state.windowId !== 'string' ||
    typeof state.heartbeatAt !== 'number' ||
    !Array.isArray(state.sessions)
  ) {
    return undefined;
  }
  return {
    version: state.version,
    windowId: state.windowId,
    workspaceName: state.workspaceName,
    heartbeatAt: state.heartbeatAt,
    cleanShutdownAt: state.cleanShutdownAt,
    sessions: state.sessions.filter(
      (session): session is JournalSession =>
        typeof session === 'object' &&
        session !== null &&
        typeof (session as JournalSession).key === 'string' &&
        typeof (session as JournalSession).cwd === 'string',
    ),
  };
}

/** Filesystem wrapper. Writes are tmp-then-rename so a crash cannot leave torn JSON. */
export class JournalStore {
  private readonly filePath: string;

  constructor(
    private readonly directory: string,
    private readonly windowId: string,
  ) {
    // The window id reaches the filename. Separators and dots are both dropped rather
    // than escaped, so no id can walk out of the directory or name a parent.
    this.filePath = path.join(
      directory,
      `window-${windowId.replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown'}.json`,
    );
  }

  async write(state: JournalState): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, JSON.stringify(state), 'utf8');
    await rename(temporary, this.filePath);
  }

  /** Every journal in the directory, this window's included, skipping unreadable files. */
  async readAll(): Promise<JournalState[]> {
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch {
      return [];
    }
    const journals: JournalState[] = [];
    for (const entry of entries) {
      if (!entry.startsWith('window-') || !entry.endsWith('.json')) {
        continue;
      }
      try {
        const state = parseJournal(await readFile(path.join(this.directory, entry), 'utf8'));
        if (state) {
          journals.push(state);
        }
      } catch {
        // A journal being rewritten right now is simply skipped this pass.
      }
    }
    return journals;
  }

  /**
   * Stamp a clean shutdown onto crashed journals that have now been offered to the
   * operator, so the next window to open does not offer the same sessions again. The
   * records are left in place — only the "this window died" signal is cleared.
   */
  async markHandled(windowIds: readonly string[]): Promise<void> {
    const wanted = new Set(windowIds);
    if (wanted.size === 0) {
      return;
    }
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.startsWith('window-') || !entry.endsWith('.json')) {
        continue;
      }
      const target = path.join(this.directory, entry);
      try {
        const state = parseJournal(await readFile(target, 'utf8'));
        if (!state || !wanted.has(state.windowId)) {
          continue;
        }
        const temporary = `${target}.tmp`;
        await writeFile(
          temporary,
          JSON.stringify({ ...state, cleanShutdownAt: Date.now() }),
          'utf8',
        );
        await rename(temporary, target);
      } catch {
        // Best effort: failing to stamp only risks offering the session once more.
      }
    }
  }

  /** Delete journals that are cleanly closed or too old to matter. */
  async prune(now: number, maxAgeMs: number): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.startsWith('window-') || !entry.endsWith('.json')) {
        continue;
      }
      const target = path.join(this.directory, entry);
      try {
        const state = parseJournal(await readFile(target, 'utf8'));
        if (state && isDisposable(state, now, this.windowId, maxAgeMs)) {
          await unlink(target);
          removed += 1;
        }
      } catch {
        // Leave anything unreadable in place rather than deleting blind.
      }
    }
    return removed;
  }
}
