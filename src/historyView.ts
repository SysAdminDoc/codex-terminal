import * as vscode from 'vscode';

import {
  codexHomeDirectory,
  discoverSessions,
  formatBytes,
  measureStore,
  groupSessionsByProject,
  sessionProject,
  clearSessionCache,
  type SessionGroup,
  type SessionRecord,
} from './sessions';
import type { JournalSession } from './journal';
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
const REFRESH_DEBOUNCE_MS = 500;

interface RecoveryGroupNode {
  kind: 'recovery-group';
  sessions: JournalSession[];
}

interface RecoveryNode {
  kind: 'recovery';
  session: JournalSession;
}

interface ProjectNode {
  kind: 'project';
  group: SessionGroup;
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

/** Disk usage of Codex's session store, which grows without bound and is otherwise unseen. */
interface UsageNode {
  kind: 'usage';
  fileCount: number;
  totalBytes: number;
}

export type HistoryNode =
  | RecoveryGroupNode
  | RecoveryNode
  | ProjectNode
  | SessionNode
  | UsageNode
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
  }
}

class SessionItem extends vscode.TreeItem {
  constructor(node: SessionNode) {
    super(node.session.preview || strings.history.noPrompt(), vscode.TreeItemCollapsibleState.None);
    const { session } = node;
    this.description = formatTimestamp(session.timestamp);
    this.tooltip = new vscode.MarkdownString(
      [
        `**${node.project}** — ${formatTimestamp(session.timestamp)}`,
        '',
        session.preview ? `> ${session.preview}` : `_${strings.history.noPrompt()}_`,
        '',
        `- Session \`${session.id}\``,
        `- ${formatSize(session.sizeBytes)} on disk`,
        `- \`${session.filePath}\``,
        '',
        `_${strings.history.clickToResume()}_`,
      ].join('\n'),
    );
    this.iconPath = new vscode.ThemeIcon('comment-discussion');
    this.contextValue = 'codexTerminal.historySession';
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
  }
}

class MessageItem extends vscode.TreeItem {
  constructor(node: MessageNode) {
    super(node.text, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('info');
  }
}

export class HistoryViewProvider
  implements vscode.TreeDataProvider<HistoryNode>, vscode.Disposable
{
  private readonly changes = new vscode.EventEmitter<HistoryNode | undefined | null | void>();
  private groups: SessionGroup[] = [];
  private loaded = false;
  private filter = '';
  private recoverable: JournalSession[] = [];
  private usage: { fileCount: number; totalBytes: number } | undefined;
  private pending: NodeJS.Timeout | undefined;
  private pendingHard = false;

  readonly onDidChangeTreeData = this.changes.event;

  constructor(
    private readonly limit: () => number,
    private readonly homeDirectory: () => string = () => codexHomeDirectory(),
  ) {}

  /** Re-read the rollout directory. `hard` also drops the per-file preview cache. */
  refresh(hard = false): void {
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = undefined;
    }
    if (hard) {
      clearSessionCache();
    }
    this.loaded = false;
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

  getTreeItem(node: HistoryNode): vscode.TreeItem {
    switch (node.kind) {
      case 'recovery-group':
        return new RecoveryGroupItem(node);
      case 'recovery':
        return new RecoveryItem(node);
      case 'project':
        return new ProjectItem(node.group);
      case 'session':
        return new SessionItem(node);
      case 'usage':
        return new UsageItem(node);
      default:
        return new MessageItem(node);
    }
  }

  async getChildren(element?: HistoryNode): Promise<HistoryNode[]> {
    if (element) {
      if (element.kind === 'recovery-group') {
        return element.sessions.map((session) => ({ kind: 'recovery' as const, session }));
      }
      return element.kind === 'project'
        ? element.group.sessions.map((session) => ({
            kind: 'session' as const,
            session,
            project: element.group.project,
          }))
        : [];
    }

    if (!this.loaded) {
      const sessions = await discoverSessions({
        homeDirectory: this.homeDirectory(),
        maxResults: this.limit(),
      });
      this.groups = groupSessionsByProject(sessions);
      // stat-only, and only on a real reload, so it never rides the debounced refresh path
      // more often than the listing itself.
      this.usage = await measureStore(this.homeDirectory());
      this.loaded = true;
    }

    const recovery: HistoryNode[] =
      this.recoverable.length > 0
        ? [{ kind: 'recovery-group', sessions: this.recoverable }]
        : [];
    const usage: HistoryNode[] = this.usage
      ? [{ kind: 'usage', ...this.usage }]
      : [];

    const groups = this.filter ? this.applyFilter(this.groups) : this.groups;
    if (groups.length === 0) {
      return [
        ...recovery,
        ...usage,
        {
          kind: 'message',
          text: this.filter ? strings.history.noMatches(this.filter) : strings.history.empty(),
        },
      ];
    }
    return [
      ...recovery,
      ...usage,
      ...groups.map((group) => ({ kind: 'project' as const, group })),
    ];
  }

  private applyFilter(groups: readonly SessionGroup[]): SessionGroup[] {
    const matches = (session: SessionRecord, project: string): boolean =>
      project.toLowerCase().includes(this.filter) ||
      session.cwd.toLowerCase().includes(this.filter) ||
      (session.preview ?? '').toLowerCase().includes(this.filter) ||
      session.id.toLowerCase().includes(this.filter);

    return groups
      .map((group) => ({
        ...group,
        sessions: group.sessions.filter((session) => matches(session, group.project)),
      }))
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
