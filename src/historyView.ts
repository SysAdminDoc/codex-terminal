import * as vscode from 'vscode';

import { activityStatusFromIndexedTurn } from './activity';
import {
  codexHomeDirectory,
  collectChangedFiles,
  discoverSessions,
  indexCheckouts,
  formatBytes,
  codexSessionsDirectory,
  measureStore,
  type CheckoutIndex,
  type StoreProblem,
  groupSessionsByProject,
  sessionProject,
  clearSessionCache,
  type SessionCheckout,
  type SessionGroup,
  type SessionRecord,
} from './sessions';
import type { JournalSession } from './journal';
import type { FileChange } from './transcript';
import { displayName, type SessionNames } from './names';
import { peekServices } from './services';
import { strings } from './strings';

/**
 * Chat history sidebar.
 *
 * Codex already keeps every conversation on disk as a rollout; nothing here writes or
 * mutates that store. The view exists so a session that scrolled out of a closed tab can
 * still be found, read and — the point of it — *resumed*, grouped by project, because the
 * rollout directory is laid out by date and gives no hint which repository a session
 * belonged to.
 *
 * Clicking a session resumes it in a terminal rather than opening its transcript: the
 * transcript is a reading view, and the reason to come back to a conversation is almost
 * always to continue it. Reading it is one inline action away.
 *
 * The recovery group at the top is populated from the session journal, not from the
 * rollout store, because "which of these hundreds of conversations were open when the
 * window died" is precisely the fact the rollouts do not record.
 */

/** Long enough to collapse a burst of appends, short enough to feel immediate. */
/**
 * How stale the store-size readout may be. It costs a full recursive walk plus a `stat` per
 * file — 2.23 GB across 121 files on the development machine — and it is a number that moves
 * in megabytes over minutes, not one worth re-deriving twice a second while a turn runs.
 */
const USAGE_MAX_AGE_MS = 60_000;

const REFRESH_DEBOUNCE_MS = 500;

interface RecoveryGroupNode {
  kind: 'recovery-group';
  sessions: JournalSession[];
}

interface RecoveryNode {
  kind: 'recovery';
  session: JournalSession;
}

interface ArchivedGroupNode {
  kind: 'archived-group';
  sessions: SessionRecord[];
}

interface ProjectNode {
  kind: 'project';
  group: SessionGroup;
}

/** One checkout of a repository. Only rendered where a repository has more than one. */
interface CheckoutNode {
  kind: 'checkout';
  project: string;
  checkout: SessionCheckout;
}

interface SessionNode {
  kind: 'session';
  session: SessionRecord;
  project: string;
}

interface MessageNode {
  kind: 'message';
  text: string;
}

/** One file a session created, edited or removed, read back from its rollout. */
interface ChangedFileNode {
  kind: 'changed-file';
  change: FileChange;
}

/** Disk usage of Codex's session store, which grows without bound and is otherwise unseen. */
interface UsageNode {
  kind: 'usage';
  fileCount: number;
  totalBytes: number;
}

export type HistoryNode =
  | RecoveryGroupNode
  | RecoveryNode
  | ArchivedGroupNode
  | ProjectNode
  | CheckoutNode
  | SessionNode
  | UsageNode
  | ChangedFileNode
  | MessageNode;

export function isSessionNode(node: unknown): node is SessionNode {
  return typeof node === 'object' && node !== null && (node as HistoryNode).kind === 'session';
}

export function isRecoveryNode(node: unknown): node is RecoveryNode {
  return typeof node === 'object' && node !== null && (node as HistoryNode).kind === 'recovery';
}

function formatTimestamp(timestamp: string | number): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? String(timestamp) : date.toLocaleString();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

class RecoveryGroupItem extends vscode.TreeItem {
  constructor(node: RecoveryGroupNode) {
    super(strings.recovery.group(), vscode.TreeItemCollapsibleState.Expanded);
    this.description = strings.recovery.count(node.sessions.length);
    this.tooltip = new vscode.MarkdownString(strings.recovery.tooltip());
    this.iconPath = new vscode.ThemeIcon(
      'warning',
      new vscode.ThemeColor('list.warningForeground'),
    );
    this.contextValue = 'codexTerminal.recoveryGroup';
    this.accessibilityInformation = {
      label: strings.recovery.accessibilityGroup(node.sessions.length),
      role: 'treeitem',
    };
  }
}

class RecoveryItem extends vscode.TreeItem {
  constructor(node: RecoveryNode) {
    const { session } = node;
    super(session.project || session.label, vscode.TreeItemCollapsibleState.None);
    this.description = formatTimestamp(session.lastActiveAt);
    this.iconPath = new vscode.ThemeIcon(
      'debug-restart',
      new vscode.ThemeColor('list.warningForeground'),
    );
    this.contextValue = 'codexTerminal.recoverySession';
    this.tooltip = new vscode.MarkdownString(
      [
        `**${session.project || session.label}**`,
        '',
        strings.recovery.interruptedAt(formatTimestamp(session.lastActiveAt)),
        '',
        `- \`${session.cwd}\``,
        `- Session \`${session.sessionId ?? '—'}\``,
        ...(session.completedTurns > 0
          ? [`- ${strings.running.turns(session.completedTurns)}`]
          : []),
        ...(session.lastMessage
          ? ['', `> ${session.lastMessage.replace(/\s+/g, ' ').slice(0, 300)}`]
          : []),
      ].join('\n'),
    );
    this.command = {
      command: 'codexTerminal.restoreSession',
      title: strings.recovery.restore(),
      arguments: [node],
    };
    this.accessibilityInformation = {
      label: strings.recovery.accessibility(
        session.project || session.label,
        formatTimestamp(session.lastActiveAt),
      ),
      role: 'button',
    };
  }
}

class ArchivedGroupItem extends vscode.TreeItem {
  constructor(node: ArchivedGroupNode) {
    super(strings.history.archivedGroup(), vscode.TreeItemCollapsibleState.Collapsed);
    this.description = strings.history.sessionCount(node.sessions.length);
    this.tooltip = new vscode.MarkdownString(
      strings.history.sessionCount(node.sessions.length),
    );
    this.iconPath = new vscode.ThemeIcon('archive');
    this.contextValue = 'codexTerminal.archivedGroup';
    this.accessibilityInformation = {
      label: strings.history.archivedAccessibility(node.sessions.length),
      role: 'treeitem',
    };
  }
}

class ProjectItem extends vscode.TreeItem {
  constructor(group: SessionGroup) {
    super(group.project, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = strings.history.sessionCount(group.sessions.length);
    this.tooltip = new vscode.MarkdownString(
      `**${group.project}**\n\n\`${group.cwd}\`\n\n${strings.history.sessionCount(
        group.sessions.length,
      )}`,
    );
    this.iconPath = new vscode.ThemeIcon('folder');
    this.contextValue = 'codexTerminal.historyProject';
    this.resourceUri = group.cwd ? vscode.Uri.file(group.cwd) : undefined;
    this.accessibilityInformation = {
      label: strings.history.projectAccessibility(group.project, group.sessions.length),
      role: 'treeitem',
    };
  }
}

class CheckoutItem extends vscode.TreeItem {
  constructor(node: CheckoutNode) {
    const { checkout } = node;
    super(
      checkout.worktree ?? strings.history.mainCheckout(),
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.description = strings.history.sessionCount(checkout.sessions.length);
    this.tooltip = new vscode.MarkdownString(
      `**${node.project}** — ${checkout.worktree ?? strings.history.mainCheckout()}

\`${checkout.cwd}\``,
    );
    // `git-branch` for a worktree, `folder-opened` for the checkout the repository lives in.
    this.iconPath = new vscode.ThemeIcon(checkout.worktree ? 'git-branch' : 'folder-opened');
    this.contextValue = 'codexTerminal.historyCheckout';
    this.resourceUri = checkout.cwd ? vscode.Uri.file(checkout.cwd) : undefined;
    this.accessibilityInformation = {
      label: strings.history.checkoutAccessibility(
        node.project,
        checkout.worktree ?? strings.history.mainCheckout(),
        checkout.sessions.length,
      ),
      role: 'treeitem',
    };
  }
}

class SessionItem extends vscode.TreeItem {
  constructor(node: SessionNode, names: SessionNames = {}) {
    // Collapsed, not None: expanding lists the files the session changed, which is read from
    // the rollout on demand rather than during the listing scan.
    // A name, where one was given, replaces the prompt preview: it is what the operator chose
    // to identify this conversation by.
    super(
      displayName(names, node.session.id, node.session.preview || strings.history.noPrompt()),
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    const { session } = node;
    const turnStatus = session.thread?.lastTurn?.status;
    const statusText =
      turnStatus === 'inProgress'
        ? strings.history.turnInProgress()
        : turnStatus === 'interrupted'
          ? strings.history.turnInterrupted()
          : turnStatus === 'failed'
            ? session.thread?.lastTurn?.usageResetText
              ? strings.history.turnFailedWithReset(session.thread.lastTurn.usageResetText)
              : strings.history.turnFailed()
            : undefined;
    this.description = [formatTimestamp(session.timestamp), statusText]
      .filter((part): part is string => part !== undefined)
      .join(' · ');
    this.tooltip = new vscode.MarkdownString(
      [
        `**${node.project}** — ${formatTimestamp(session.timestamp)}`,
        '',
        session.preview ? `> ${session.preview}` : `_${strings.history.noPrompt()}_`,
        '',
        `- Session \`${session.id}\``,
        ...(statusText ? [`- ${statusText}`] : []),
        `- ${formatSize(session.sizeBytes)} on disk`,
        `- \`${session.filePath}\``,
        '',
        `_${strings.history.clickToResume()}_`,
      ].join('\n'),
    );
    const activityStatus = activityStatusFromIndexedTurn(turnStatus);
    this.iconPath =
      activityStatus === 'aborted'
        ? new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'))
        : activityStatus === 'working'
          ? new vscode.ThemeIcon('sync~spin')
          : new vscode.ThemeIcon('comment-discussion');
    this.contextValue = session.thread?.archived
      ? 'codexTerminal.archivedSession'
      : 'codexTerminal.historySession';
    this.command = {
      command: 'codexTerminal.resumeHistorySession',
      title: strings.history.resume(),
      arguments: [node],
    };
    this.accessibilityInformation = {
      label: strings.history.accessibility(
        node.project,
        formatTimestamp(session.timestamp),
        session.preview ?? strings.history.noPrompt(),
      ),
      role: 'button',
    };
  }
}

class UsageItem extends vscode.TreeItem {
  constructor(node: UsageNode) {
    super(strings.history.storeUsage(node.fileCount, formatBytes(node.totalBytes)));
    this.iconPath = new vscode.ThemeIcon('database');
    this.tooltip = new vscode.MarkdownString(
      strings.history.storeTooltip(formatBytes(node.totalBytes)),
    );
    this.contextValue = 'codexTerminal.storeUsage';
    this.accessibilityInformation = {
      label: strings.history.storeUsageAccessibility(node.fileCount, formatBytes(node.totalBytes)),
      role: 'text',
    };
  }
}

const CHANGE_ICON: Record<FileChange['kind'], string> = {
  add: 'diff-added',
  update: 'diff-modified',
  delete: 'diff-removed',
};

class ChangedFileItem extends vscode.TreeItem {
  constructor(node: ChangedFileNode) {
    const { change } = node;
    // Either separator: rollouts are written on Windows and on POSIX.
    const name = change.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? change.path;
    super(name, vscode.TreeItemCollapsibleState.None);
    // The full path is the disambiguator: a session touches same-named files in different
    // directories often enough that the basename alone is not an answer.
    this.description = change.path;
    this.tooltip = new vscode.MarkdownString(
      `${strings.history.changeKind(change.kind)}

- \`${change.path}\``,
    );
    this.iconPath = new vscode.ThemeIcon(CHANGE_ICON[change.kind]);
    this.contextValue = `codexTerminal.changedFile.${change.kind}`;
    this.accessibilityInformation = {
      label: strings.history.changedFileAccessibility(name, strings.history.changeKind(change.kind)),
      role: change.kind === 'delete' ? 'text' : 'button',
    };
    if (change.kind !== 'delete') {
      // A deleted file has nothing to open, and a command that reliably fails is worse than
      // no command at all.
      this.resourceUri = vscode.Uri.file(change.path);
      this.command = {
        command: 'vscode.open',
        title: strings.history.openChangedFile(),
        arguments: [vscode.Uri.file(change.path)],
      };
    }
  }
}

class MessageItem extends vscode.TreeItem {
  constructor(node: MessageNode) {
    super(node.text, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('info');
    this.accessibilityInformation = {
      label: strings.history.messageAccessibility(node.text),
      role: 'text',
    };
  }
}

export class HistoryViewProvider
  implements vscode.TreeDataProvider<HistoryNode>, vscode.Disposable
{
  private readonly changes = new vscode.EventEmitter<HistoryNode | undefined | null | void>();
  private groups: SessionGroup[] = [];
  private archived: SessionRecord[] = [];
  private loaded = false;
  private filter = '';
  private recoverable: JournalSession[] = [];
  private usage: { fileCount: number; totalBytes: number } | undefined;
  /** When `usage` was measured, so a debounced refresh does not re-walk the whole store. */
  private usageMeasuredAt = 0;
  /** Resolved repository roots, reused across refreshes and dropped on an explicit one. */
  private checkoutIndex: CheckoutIndex | undefined;
  /** Why the last scan found nothing, so an empty list can say which kind of empty it is. */
  private storeProblem: StoreProblem | undefined;
  /** A present-but-unsupported SQLite projection should produce one diagnostic, not a flood. */
  private threadStoreWarning: string | undefined;
  /** True while the first scan of a refresh is in flight, so the view is not silently blank. */
  private loading = false;
  /** A tree refresh arrived while the scan was in flight and needs a second render afterward. */
  private refreshPendingWhileLoading = false;
  /** Keyed by rollout path, cleared on a real reload; see `changedFiles`. */
  private readonly changedFileCache = new Map<string, HistoryNode[]>();
  private pending: NodeJS.Timeout | undefined;
  private pendingHard = false;

  readonly onDidChangeTreeData = this.changes.event;

  constructor(
    private readonly limit: () => number,
    private readonly homeDirectory: () => string = () => codexHomeDirectory(),
    private readonly names: () => SessionNames = () => ({}),
  ) {}

  /** Re-read the rollout directory. `hard` also drops the per-file preview cache. */
  refresh(hard = false): void {
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = undefined;
    }
    if (hard) {
      clearSessionCache();
      // Only here: a repository does not move while a turn is running, and re-resolving one
      // per directory per refresh is the most expensive thing this view does.
      this.checkoutIndex = undefined;
      this.usageMeasuredAt = 0;
      // A live session keeps appending, so its file list is only as current as the last
      // scan. An explicit refresh is the operator asking for it to be re-read.
      this.changedFileCache.clear();
    }
    this.loaded = false;
    if (this.loading) {
      this.refreshPendingWhileLoading = true;
    }
    this.changes.fire();
  }

  /**
   * Coalesce filesystem-driven refreshes.
   *
   * Codex appends to the active rollout several times a second, and every append raises a
   * change event. Refreshing on each one re-walks the whole rollout directory while a turn
   * is running, for a view whose contents cannot meaningfully change that fast.
   */
  scheduleRefresh(hard = false): void {
    this.pendingHard = this.pendingHard || hard;
    if (this.pending) {
      return;
    }
    this.pending = setTimeout(() => {
      this.pending = undefined;
      const wasHard = this.pendingHard;
      this.pendingHard = false;
      this.refresh(wasHard);
    }, REFRESH_DEBOUNCE_MS);
  }

  /** Publish the sessions a dead window left behind, newest first. */
  setRecoverable(sessions: readonly JournalSession[]): void {
    this.recoverable = [...sessions];
    this.changes.fire();
  }

  getRecoverable(): readonly JournalSession[] {
    return this.recoverable;
  }

  /** Drop one entry once it has been restored or dismissed. */
  clearRecoverable(sessionId?: string): void {
    this.recoverable = sessionId
      ? this.recoverable.filter((session) => session.sessionId !== sessionId)
      : [];
    this.changes.fire();
  }

  setFilter(filter: string): void {
    this.filter = filter.trim().toLowerCase();
    this.changes.fire();
  }

  getFilter(): string {
    return this.filter;
  }

  /**
   * Files a session changed, scanned from its rollout the first time it is expanded.
   *
   * Cached per session because the scan reads the whole file and a rollout that has been
   * closed never changes again. A live one may still grow, but re-scanning on every collapse
   * and re-expand would cost far more than the staleness is worth — the refresh button and
   * the file watcher both clear this.
   */
  private async changedFiles(node: SessionNode): Promise<HistoryNode[]> {
    const cached = this.changedFileCache.get(node.session.filePath);
    if (cached) {
      return cached;
    }
    try {
      const { files, truncated } = await collectChangedFiles(node.session.filePath);
      const children: HistoryNode[] =
        files.length === 0
          ? [{ kind: 'message', text: strings.history.noChangedFiles() }]
          : files.map((change) => ({ kind: 'changed-file' as const, change }));
      // Say so rather than letting a capped list read as the whole story.
      if (truncated) {
        children.push({ kind: 'message', text: strings.history.changedFilesTruncated() });
      }
      this.changedFileCache.set(node.session.filePath, children);
      return children;
    } catch (error) {
      return [
        {
          kind: 'message',
          text: strings.history.changedFilesFailed(
            error instanceof Error ? error.message : String(error),
          ),
        },
      ];
    }
  }

  getTreeItem(node: HistoryNode): vscode.TreeItem {
    switch (node.kind) {
      case 'recovery-group':
        return new RecoveryGroupItem(node);
      case 'recovery':
        return new RecoveryItem(node);
      case 'archived-group':
        return new ArchivedGroupItem(node);
      case 'project':
        return new ProjectItem(node.group);
      case 'checkout':
        return new CheckoutItem(node);
      case 'session':
        return new SessionItem(node, this.names());
      case 'usage':
        return new UsageItem(node);
      case 'changed-file':
        return new ChangedFileItem(node);
      default:
        return new MessageItem(node);
    }
  }

  async getChildren(element?: HistoryNode): Promise<HistoryNode[]> {
    if (element) {
      if (element.kind === 'recovery-group') {
        return element.sessions.map((session) => ({ kind: 'recovery' as const, session }));
      }
      if (element.kind === 'archived-group') {
        return element.sessions.map((session) => ({
          kind: 'session' as const,
          session,
          project: sessionProject(session) || session.cwd,
        }));
      }
      if (element.kind === 'project') {
        // The worktree level appears only where there is something to disambiguate; a
        // repository used from one directory would gain nothing but an extra click.
        return element.group.checkouts
          ? element.group.checkouts.map((checkout) => ({
              kind: 'checkout' as const,
              project: element.group.project,
              checkout,
            }))
          : element.group.sessions.map((session) => ({
              kind: 'session' as const,
              session,
              project: element.group.project,
            }));
      }
      if (element.kind === 'checkout') {
        return element.checkout.sessions.map((session) => ({
          kind: 'session' as const,
          session,
          project: element.checkout.worktree
            ? `${element.project} (${element.checkout.worktree})`
            : element.project,
        }));
      }
      return element.kind === 'session' ? this.changedFiles(element) : [];
    }

    if (!this.loaded) {
      // The first scan can open up to `history.maxSessions` files. Saying so beats a view
      // that is simply blank for as long as it takes.
      if (this.loading) {
        this.refreshPendingWhileLoading = true;
        return [{ kind: 'message', text: strings.history.loading() }];
      }
      this.loading = true;
      let sessions;
      try {
        sessions = await discoverSessions({
          homeDirectory: this.homeDirectory(),
          maxResults: this.limit(),
          onScan: (scan) => {
            this.storeProblem = scan.problem;
            if (scan.threadStoreWarning && scan.threadStoreWarning !== this.threadStoreWarning) {
              peekServices()?.log.warn(scan.threadStoreWarning);
              this.threadStoreWarning = scan.threadStoreWarning;
            }
            if (scan.problem === 'unreadable') {
              peekServices()?.log.warn(
                strings.store.unreadable(this.homeDirectory(), scan.detail ?? 'unknown error'),
              );
            }
          },
        });
      } finally {
        this.loading = false;
      }
      const active = sessions.filter((session) => !session.thread?.archived);
      this.archived = sessions.filter((session) => session.thread?.archived === true);
      // One `.git` walk per distinct directory, not per session: a project with forty
      // sessions has one working directory — and the previous index is reused, so a
      // directory already resolved is not walked again on the next append.
      this.checkoutIndex = await indexCheckouts(active, this.checkoutIndex);
      this.groups = groupSessionsByProject(active, this.checkoutIndex);
      // A second full walk of the store, so it is rate-limited rather than run per refresh.
      // The comment that used to sit here claimed it ran "only on a real reload"; it sat
      // inside this block, which every debounced refresh reaches.
      if (Date.now() - this.usageMeasuredAt >= USAGE_MAX_AGE_MS) {
        this.usage = await measureStore(this.homeDirectory());
        this.usageMeasuredAt = Date.now();
      }
      this.loaded = true;
      if (this.refreshPendingWhileLoading) {
        this.refreshPendingWhileLoading = false;
        this.changes.fire();
      }
    }

    const recovery: HistoryNode[] =
      this.recoverable.length > 0
        ? [{ kind: 'recovery-group', sessions: this.recoverable }]
        : [];
    const usage: HistoryNode[] = this.usage
      ? [{ kind: 'usage', ...this.usage }]
      : [];

    const groups = this.filter ? this.applyFilter(this.groups) : this.groups;
    const archived = this.filter
      ? this.archived.filter((session) => this.matches(session, sessionProject(session) || session.cwd))
      : this.archived;
    if (groups.length === 0 && archived.length === 0) {
      return [
        ...recovery,
        ...usage,
        {
          kind: 'message',
          // A missing store, an unreadable one and a genuinely empty one used to render the
          // same row and log nothing at all.
          text: this.filter
            ? strings.history.noMatches(this.filter)
            : this.storeProblem === 'missing'
              ? strings.history.storeMissing(codexSessionsDirectory(this.homeDirectory()))
              : this.storeProblem === 'unreadable'
                ? strings.history.storeUnreadable(codexSessionsDirectory(this.homeDirectory()))
                : strings.history.empty(),
        },
      ];
    }
    return [
      ...recovery,
      ...usage,
      ...groups.map((group) => ({ kind: 'project' as const, group })),
      ...(archived.length > 0 ? [{ kind: 'archived-group' as const, sessions: archived }] : []),
    ];
  }

  private matches(session: SessionRecord, project: string): boolean {
    return (
      project.toLowerCase().includes(this.filter) ||
      session.cwd.toLowerCase().includes(this.filter) ||
      (session.preview ?? '').toLowerCase().includes(this.filter) ||
      session.id.toLowerCase().includes(this.filter)
    );
  }

  private applyFilter(groups: readonly SessionGroup[]): SessionGroup[] {
    return groups
      .map((group) => {
        const sessions = group.sessions.filter((session) => this.matches(session, group.project));
        const checkouts = group.checkouts
          ?.map((checkout) => ({
            ...checkout,
            sessions: checkout.sessions.filter((session) => this.matches(session, group.project)),
          }))
          .filter((checkout) => checkout.sessions.length > 0);
        const filteredGroup = {
          ...group,
          sessions,
        };
        // A single surviving checkout no longer needs an extra level. Keeping the filtered
        // sessions on the project also ensures expansion cannot reveal non-matching rows.
        if (checkouts && checkouts.length > 1) {
          filteredGroup.checkouts = checkouts;
        } else {
          delete filteredGroup.checkouts;
        }
        return filteredGroup;
      })
      .filter((group) => group.sessions.length > 0);
  }

  /** Flat, newest-first list for the quick-pick search. */
  async allSessions(): Promise<Array<{ session: SessionRecord; project: string }>> {
    const sessions = await discoverSessions({
      homeDirectory: this.homeDirectory(),
      maxResults: this.limit(),
    });
    return sessions.map((session) => ({
      session,
      project: sessionProject(session) || session.cwd,
    }));
  }

  dispose(): void {
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = undefined;
    }
    this.changes.dispose();
  }
}
