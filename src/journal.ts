import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
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
/** Keep recovery identifiers bounded without dropping sessions still open in a window. */
export const MAX_CLOSED_JOURNAL_SESSIONS = 200;

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
  /** Set when the terminal went away, for any reason; absent means it was still open. */
  closedAt?: number;
  /**
   * Set when the terminal went away without the operator asking — the shell died under it.
   *
   * Recorded alongside `closedAt` rather than instead of it, because the two answer
   * different questions: `closedAt` is "is this tab still on screen", which the history
   * view needs, and `lostAt` is "did anyone mean for that to happen", which is the only
   * thing that decides whether the session is worth offering back.
   */
  lostAt?: number;
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

function capSessions(sessions: readonly JournalSession[]): JournalSession[] {
  const closed = sessions
    .filter((session) => session.closedAt !== undefined)
    .sort((left, right) => right.lastActiveAt - left.lastActiveAt)
    .slice(0, MAX_CLOSED_JOURNAL_SESSIONS);
  const retainedClosed = new Set(closed);
  return sessions.filter(
    (session) => session.closedAt === undefined || retainedClosed.has(session),
  );
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
  return { ...state, sessions: capSessions(sessions) };
}

/**
 * The same journal with every scrap of conversation text removed.
 *
 * `journal.storeMessages: false` used to only stop *new* text being written. `upsertSession`
 * merges over the previous record, so a message already on disk survived every later update
 * and sat there for the full retention window — the setting read as an opt-out and behaved as
 * a tap. Turning it off now rewrites what is already there.
 */
export function stripMessages(state: JournalState): JournalState {
  let changed = false;
  const sessions = state.sessions.map((session) => {
    if (session.lastMessage === undefined) {
      return session;
    }
    changed = true;
    const rest = { ...session };
    delete rest.lastMessage;
    return rest;
  });
  return changed ? { ...state, sessions } : state;
}

/**
 * Sessions worth offering back to the operator.
 *
 * Only rollout-bound sessions qualify: a launch that never produced a rollout has no
 * conversation to return to, and offering it would be offering an empty terminal.
 *
 * Still-open sessions and lost ones both count. A session that died under a window which
 * then closed in good order is closed *and* worth offering back, and keying only off
 * `closedAt` used to drop exactly that case on the floor.
 */
export function recoverableSessions(state: JournalState): JournalSession[] {
  return state.sessions.filter(
    (session) =>
      session.sessionId !== undefined &&
      (session.closedAt === undefined || session.lostAt !== undefined),
  );
}

/**
 * Sessions whose shell died under them.
 *
 * The pty host going down takes every terminal with it while the window carries on and
 * shuts down normally, so a clean shutdown is no evidence that the operator was finished
 * with these.
 */
export function lostSessions(state: JournalState): JournalSession[] {
  return state.sessions.filter(
    (session) => session.sessionId !== undefined && session.lostAt !== undefined,
  );
}

/**
 * Close every open session and mark the window as having shut down deliberately.
 *
 * Separated from the monitor so the rule is testable: it is the single thing standing
 * between a normal window close and the next window offering to "recover" the terminals
 * that were closed on purpose.
 */
export function stampShutdown(state: JournalState, now: number): JournalState {
  return {
    ...state,
    heartbeatAt: now,
    cleanShutdownAt: now,
    sessions: capSessions(
      state.sessions.map((session) => ({
        ...session,
        closedAt: session.closedAt ?? now,
      })),
    ),
  };
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
 * Collect every session a window that is no longer running failed to hand back.
 *
 * `ownWindowId` is skipped so a window never offers to recover itself, and the newest
 * record wins when the same Codex session appears in more than one journal (a session
 * that was already recovered once and crashed again).
 *
 * Two shapes qualify, and only the first used to. A window that *died* owes back every
 * session it still held. A window that shut down in good order owes back only the ones
 * that had already been lost under it — which is the overnight case that started this:
 * the pty host went down at 08:47, taking thirteen live sessions with it, and the window
 * then closed normally thirty-seven seconds later. Keying the whole decision off
 * `isCrashed` read that as thirteen deliberate closes and offered nothing.
 *
 * The staleness check stays in front of both: a window whose heartbeat is current may
 * still be alive, and its sessions are its own to offer.
 */
export function interruptedSessions(
  journals: readonly JournalState[],
  now: number,
  ownWindowId: string,
  staleMs = STALE_HEARTBEAT_MS,
): JournalSession[] {
  const byId = new Map<string, JournalSession>();
  for (const journal of journals) {
    if (journal.windowId === ownWindowId || now - journal.heartbeatAt <= staleMs) {
      continue;
    }
    const owed = isCrashed(journal, now, staleMs)
      ? recoverableSessions(journal)
      : lostSessions(journal);
    for (const session of owed) {
      const previous = byId.get(session.sessionId as string);
      if (!previous || session.lastActiveAt > previous.lastActiveAt) {
        byId.set(session.sessionId as string, session);
      }
    }
  }
  return [...byId.values()].sort((left, right) => right.lastActiveAt - left.lastActiveAt);
}

/**
 * Find one launch across every journal, by the key stamped into its terminal environment.
 *
 * Deliberately ignores `closedAt` and the crashed/clean distinction, both of which are about
 * *offering* a session back. This answers a different question — "which conversation was this
 * surviving tab" — and a reload stamps the outgoing journal as cleanly shut down on its way
 * out, so honouring those flags would reject every record it is meant to find.
 *
 * The newest record wins: a session recovered once and then reloaded again appears twice.
 */
export function findLaunch(
  journals: readonly JournalState[],
  key: string,
): JournalSession | undefined {
  let best: JournalSession | undefined;
  for (const journal of journals) {
    for (const session of journal.sessions) {
      if (session.key === key && (!best || session.lastActiveAt > best.lastActiveAt)) {
        best = session;
      }
    }
  }
  return best;
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
    sessions: capSessions(
      state.sessions.filter(
        (session): session is JournalSession =>
        typeof session === 'object' &&
        session !== null &&
        typeof (session as JournalSession).key === 'string' &&
        typeof (session as JournalSession).cwd === 'string',
      ),
    ),
  };
}

/** Filesystem wrapper. Writes are tmp-then-rename so a crash cannot leave torn JSON. */
export class JournalStore {
  private readonly filePath: string;
  /**
   * Set by `writeSync`, after which nothing else may have the last word.
   *
   * The monitor already refuses to *start* a write once it has shut down, but that is not
   * enough on its own: a write suspended between its `writeFile` and its `rename` resumes
   * after the synchronous stamp has landed and renames an un-stamped journal over the top.
   * Holding the sealed state here lets an in-flight write put it back, which makes the
   * outcome independent of who finishes first.
   */
  private sealed: JournalState | undefined;

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
    if (this.sealed) {
      return;
    }
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.filePath}.async.tmp`;
    await writeFile(temporary, JSON.stringify(state), 'utf8');
    await rename(temporary, this.filePath);
    if (this.sealed) {
      // A shutdown stamp landed while this write was in flight, and this rename has just
      // buried it. Put it back, synchronously, so the file agrees with the seal.
      this.writeFileSync(this.sealed);
    }
  }

  /**
   * Synchronous twin of `write`, for the shutdown stamp only.
   *
   * `deactivate` is the last chance to say this window closed on purpose, and the host does
   * not wait around for promises returned from it. An awaited write there is a race the
   * extension loses often enough to matter: with no stamp the next window reads a stale
   * heartbeat, concludes the window crashed, and offers to recover terminals the operator
   * closed deliberately. False recovery prompts are worse than none — they teach the
   * operator to dismiss the prompt that counts.
   *
   * Same tmp-then-rename as the async path, so a kill mid-write still cannot tear the JSON.
   */
  writeSync(state: JournalState): void {
    this.sealed = state;
    this.writeFileSync(state);
  }

  /** Separate tmp name from the async path, so the two can never trample each other. */
  private writeFileSync(state: JournalState): void {
    mkdirSync(this.directory, { recursive: true });
    const temporary = `${this.filePath}.sync.tmp`;
    writeFileSync(temporary, JSON.stringify(state), 'utf8');
    renameSync(temporary, this.filePath);
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
  /**
   * Remove conversation text from every journal in the directory, this window's included.
   *
   * Every window's journal, not just this one's: they share a directory, and a setting that
   * says text is not stored has to be true of what is on disk rather than of what this
   * process happens to write next.
   */
  async stripMessagesEverywhere(): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch {
      return 0;
    }
    let rewritten = 0;
    for (const entry of entries) {
      if (!entry.startsWith('window-') || !entry.endsWith('.json')) {
        continue;
      }
      const target = path.join(this.directory, entry);
      try {
        const state = parseJournal(await readFile(target, 'utf8'));
        if (!state) {
          continue;
        }
        const stripped = stripMessages(state);
        if (stripped === state) {
          continue;
        }
        const temporary = `${target}.strip.tmp`;
        await writeFile(temporary, JSON.stringify(stripped), 'utf8');
        await rename(temporary, target);
        rewritten += 1;
      } catch {
        // Leave anything unreadable in place rather than truncating it blind.
      }
    }
    return rewritten;
  }

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
        // Never remove the active window's file solely because a transient read saw invalid
        // contents. A valid active journal is not disposable either, but this guard also keeps
        // an invalid file from being treated as abandoned while the window is still running.
        if (path.resolve(target) === path.resolve(this.filePath)) {
          continue;
        }
        const state = parseJournal(await readFile(target, 'utf8'));
        if (state && isDisposable(state, now, this.windowId, maxAgeMs)) {
          await unlink(target);
          removed += 1;
        } else if (!state && now - (await stat(target)).mtimeMs > maxAgeMs) {
          // Invalid journals cannot be recovered or marked handled. Their mtime is the only
          // retention signal left, and the monitor reports the aggregate removal once.
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
