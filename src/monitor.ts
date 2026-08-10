import * as vscode from 'vscode';

import {
  INITIAL_ACTIVITY,
  isStalled,
  isWorking,
  reduceActivity,
  type SessionActivity,
} from './activity';
import { bindRollout, scanRollouts } from './binder';
import {
  JournalStore,
  emptyJournal,
  stampShutdown,
  upsertSession,
  type JournalState,
} from './journal';
import { codexSessionsDirectory } from './sessions';
import { RolloutTailer } from './tail';

/**
 * The link between a terminal tab and the conversation Codex is writing for it.
 *
 * Everything the operator asked for hangs off this one correlation: a tab can only show
 * that Codex is busy if something knows which rollout is *its* rollout, a sidebar entry can
 * only reopen the right conversation if the id was recorded while the tab was alive, and a
 * crash is only recoverable if that record outlived the window.
 *
 * The poll is deliberately dumb — stat, read the appended bytes, fold — because the
 * alternative (watching hundreds of rollout files) costs far more than reading the tail of
 * the handful that belong to open tabs.
 */

/** Fast enough that the spinner tracks Codex, slow enough to stay invisible on CPU. */
const WORKING_POLL_MS = 600;
const IDLE_POLL_MS = 2_000;
/** Journals older than this are pruned; a week of crash history is plenty. */
const JOURNAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface LiveSession {
  key: string;
  terminal: vscode.Terminal;
  cwd: string;
  project: string;
  label: string;
  mode: string;
  profile?: string;
  launchedAt: number;
  sessionId?: string;
  rolloutPath?: string;
  activity: SessionActivity;
  /** False for terminals adopted after a reload, whose rollout cannot be inferred. */
  bindable: boolean;
}

interface Tracked extends LiveSession {
  tailer?: RolloutTailer;
  closed: boolean;
}

export interface SessionMonitorOptions {
  store: JournalStore;
  windowId: string;
  workspaceName?: string;
  codexHome: () => string;
  log: vscode.LogOutputChannel;
}

let keyCounter = 0;

export class SessionMonitor implements vscode.Disposable {
  private readonly tracked: Tracked[] = [];
  private readonly changes = new vscode.EventEmitter<void>();
  private timer: NodeJS.Timeout | undefined;
  private currentInterval = 0;
  private journal: JournalState;
  private writing = false;
  private writeAgain = false;
  /** Set by `shutdown`, so a queued async write cannot land after the sync stamp. */
  private stopped = false;

  readonly onDidChange = this.changes.event;

  constructor(private readonly options: SessionMonitorOptions) {
    this.journal = emptyJournal(options.windowId, options.workspaceName);
  }

  /**
   * Reserve the key a launch will be journalled under.
   *
   * Handed out before the terminal exists because it has to reach the terminal's own
   * environment, which can only be set at creation. That stamp is what lets a reloaded
   * window find this launch again.
   */
  nextLaunchKey(): string {
    keyCounter += 1;
    return `${this.options.windowId}-${keyCounter}`;
  }

  /** Record a launch and start looking for the rollout Codex is about to create. */
  track(
    terminal: vscode.Terminal,
    details: {
      cwd: string;
      project: string;
      label: string;
      mode: string;
      profile?: string;
      /** Known up front only when resuming a specific session. */
      sessionId?: string;
      bindable?: boolean;
      /** Reserved by `nextLaunchKey`; generated here when a caller did not need one. */
      key?: string;
      /**
       * Set only when re-adopting after a reload, where the binding is read back from the
       * journal instead of inferred. Tailing then resumes without any rollout scan.
       */
      rolloutPath?: string;
    },
  ): void {
    const entry: Tracked = {
      key: details.key ?? this.nextLaunchKey(),
      terminal,
      cwd: details.cwd,
      project: details.project,
      label: details.label,
      mode: details.mode,
      profile: details.profile,
      launchedAt: Date.now(),
      // Only the restore path knows the id up front, because there it arrives from the same
      // journal record as the rollout path. On a plain resume `details.sessionId` is the id
      // being resumed *from*, which is not necessarily the id Codex is about to write to —
      // that one is settled by binding, and guessing it here would mislabel the session.
      ...(details.rolloutPath ? { sessionId: details.sessionId } : {}),
      rolloutPath: details.rolloutPath,
      activity: INITIAL_ACTIVITY,
      bindable: details.bindable ?? true,
      closed: false,
    };
    if (details.rolloutPath) {
      // The first poll folds the file from the start, which is exactly what recovering the
      // activity state of a conversation already in progress requires.
      entry.tailer = new RolloutTailer(details.rolloutPath);
    }
    this.tracked.push(entry);
    this.persist(entry);
    this.changes.fire();
    this.reschedule();
  }

  close(terminal: vscode.Terminal): void {
    const entry = this.tracked.find((candidate) => candidate.terminal === terminal);
    if (!entry || entry.closed) {
      return;
    }
    entry.closed = true;
    entry.activity = { ...entry.activity, status: 'idle' };
    this.persist(entry, Date.now());
    this.changes.fire();
    this.reschedule();
  }

  live(): LiveSession[] {
    return this.liveTracked();
  }

  private liveTracked(): Tracked[] {
    return this.tracked.filter((entry) => !entry.closed);
  }

  workingCount(): number {
    return this.live().filter((entry) => isWorking(entry.activity)).length;
  }

  /** Working sessions whose rollout has been silent past the threshold. */
  stalledCount(thresholdSeconds: number, now = Date.now()): number {
    return this.live().filter((entry) => isStalled(entry.activity, now, thresholdSeconds)).length;
  }

  forTerminal(terminal: vscode.Terminal): LiveSession | undefined {
    return this.tracked.find((entry) => entry.terminal === terminal && !entry.closed);
  }

  /** Sessions this window already knows about, so recovery never offers a duplicate. */
  activeSessionIds(): Set<string> {
    return new Set(
      this.live()
        .map((entry) => entry.sessionId)
        .filter((id): id is string => typeof id === 'string'),
    );
  }

  private reschedule(): void {
    const live = this.live();
    const wanted =
      live.length === 0 ? 0 : live.some((entry) => isWorking(entry.activity)) ? WORKING_POLL_MS : IDLE_POLL_MS;
    if (wanted === this.currentInterval) {
      return;
    }
    this.currentInterval = wanted;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (wanted > 0) {
      this.timer = setInterval(() => void this.poll(), wanted);
    }
  }

  private async poll(): Promise<void> {
    const live = this.liveTracked();
    if (live.length === 0) {
      this.reschedule();
      return;
    }

    let changed = false;
    for (const entry of live) {
      try {
        changed = (await this.pollOne(entry)) || changed;
      } catch (error) {
        this.options.log.warn(
          `session poll failed for ${entry.label}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // The heartbeat has to keep ticking even on a quiet poll, or a live window starts
    // looking crashed to the next one that opens.
    void this.writeJournal();
    if (changed) {
      this.changes.fire();
    }
    this.reschedule();
  }

  private async pollOne(entry: Tracked): Promise<boolean> {
    if (!entry.tailer) {
      return entry.bindable ? this.tryBind(entry) : false;
    }
    const lines = await entry.tailer.poll();
    if (lines.length === 0) {
      return false;
    }
    const next = reduceActivity(entry.activity, lines);
    if (next === entry.activity) {
      return false;
    }
    entry.activity = next;
    this.persist(entry);
    return true;
  }

  private async tryBind(entry: Tracked): Promise<boolean> {
    const root = codexSessionsDirectory(this.options.codexHome());
    const candidates = await scanRollouts(root, entry.cwd, entry.launchedAt, Date.now());
    const claimed = new Set(
      this.tracked
        .map((tracked) => tracked.rolloutPath)
        .filter((rolloutPath): rolloutPath is string => typeof rolloutPath === 'string'),
    );
    const match = bindRollout(candidates, entry, claimed);
    if (!match) {
      return false;
    }

    entry.rolloutPath = match.filePath;
    entry.sessionId = match.sessionId;
    entry.tailer = new RolloutTailer(match.filePath);
    this.options.log.info(`bound ${entry.label} to session ${match.sessionId}`);
    // Fold the whole file, not just the tail: a rollout bound a few seconds late already
    // holds the opening turn, and skipping it would report an idle session that is busy.
    const lines = await entry.tailer.poll();
    entry.activity = reduceActivity(entry.activity, lines);
    this.persist(entry);
    return true;
  }

  private persist(entry: Tracked, closedAt?: number): void {
    this.journal = upsertSession(this.journal, {
      key: entry.key,
      sessionId: entry.sessionId,
      rolloutPath: entry.rolloutPath,
      cwd: entry.cwd,
      project: entry.project,
      label: entry.label,
      mode: entry.mode,
      profile: entry.profile,
      launchedAt: entry.launchedAt,
      lastActiveAt: Date.now(),
      ...(closedAt ? { closedAt } : {}),
      status: entry.activity.status,
      lastMessage: entry.activity.lastMessage,
      completedTurns: entry.activity.completedTurns,
    });
    void this.writeJournal();
  }

  /** Serialise writers so a burst of activity cannot interleave two renames. */
  private async writeJournal(): Promise<void> {
    if (this.stopped || this.writing) {
      this.writeAgain = !this.stopped;
      return;
    }
    this.writing = true;
    try {
      do {
        this.writeAgain = false;
        // Re-checked each pass: `shutdown` may have stamped the file while the previous
        // iteration was awaiting, and writing again would erase the stamp.
        if (this.stopped) {
          return;
        }
        this.journal = { ...this.journal, heartbeatAt: Date.now() };
        await this.options.store.write(this.journal);
      } while (this.writeAgain);
    } catch (error) {
      this.options.log.warn(
        `could not write the session journal: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.writing = false;
    }
  }

  /** Drop journals from windows that closed cleanly or died long ago. */
  async pruneJournals(): Promise<void> {
    try {
      const removed = await this.options.store.prune(Date.now(), JOURNAL_MAX_AGE_MS);
      if (removed > 0) {
        this.options.log.info(`pruned ${removed} stale session journal(s)`);
      }
    } catch {
      // Pruning is housekeeping; failing it must never block activation.
    }
  }

  /**
   * Stamp a clean shutdown so the next window does not offer to recover these sessions.
   *
   * Synchronous throughout, and that is the point: `deactivate` is called while the host is
   * tearing down and nothing waits for a promise returned from it, so an awaited write here
   * frequently never lands. `stopped` is set first so a write already queued behind this one
   * cannot come back and overwrite the stamp with an un-stamped journal.
   */
  shutdown(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.journal = stampShutdown(this.journal, Date.now());
    try {
      this.options.store.writeSync(this.journal);
    } catch {
      // Nothing useful to do while the host is tearing down.
    }
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.changes.dispose();
  }
}
