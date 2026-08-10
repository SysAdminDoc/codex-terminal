import * as vscode from 'vscode';

import { contextUsed, elapsedSeconds, isStalled } from './activity';
import type { LiveSession, SessionMonitor } from './monitor';
import {
  DEFAULT_STALL_SECONDS,
  describeActivity,
  formatDuration,
  formatTokens,
  presentStatus,
} from './present';
import { strings } from './strings';

/**
 * Activity bar entry listing the launch actions and every live session.
 *
 * The status bar item cannot be relied on: `workbench.statusBar.visible: false` is a
 * perfectly ordinary setting and hides every extension's status bar contribution with no
 * error anywhere. The editor title button needs a focused text editor, which a workspace
 * opened with `workbench.startupEditor: none` does not have. The activity bar is the only
 * surface that is present regardless — which is also why the live spinner lives here.
 */

export interface Action {
  label: string;
  description: string;
  command: string;
  icon: string;
}

interface RunningGroup {
  kind: 'running-group';
}

interface RunningSession {
  kind: 'running-session';
  session: LiveSession;
}

type ActionNode = Action | RunningGroup | RunningSession;
const RUNNING_GROUP: RunningGroup = { kind: 'running-group' };

const ACTIONS: Action[] = [
  {
    label: strings.actions.newSession(),
    description: strings.actions.codex(),
    command: 'codexTerminal.new',
    icon: 'sparkle',
  },
  {
    label: strings.actions.resumeLast(),
    description: strings.actions.resumeLastCommand(),
    command: 'codexTerminal.resumeLast',
    icon: 'history',
  },
  {
    label: strings.actions.resumePicker(),
    description: strings.actions.resumeCommand(),
    command: 'codexTerminal.resumePicker',
    icon: 'list-selection',
  },
  {
    label: strings.actions.forkLast(),
    description: strings.actions.forkLastCommand(),
    command: 'codexTerminal.forkLast',
    icon: 'git-branch',
  },
  {
    label: strings.actions.sendReference(),
    description: strings.actions.referenceExample(),
    command: 'codexTerminal.sendFileReference',
    icon: 'file-code',
  },
];

export function getActions(): readonly Action[] {
  return ACTIONS;
}

class ActionItem extends vscode.TreeItem {
  constructor(action: Action) {
    super(action.label, vscode.TreeItemCollapsibleState.None);
    this.description = action.description;
    this.tooltip = strings.actions.tooltip(action.label, action.description);
    this.accessibilityInformation = {
      label: strings.actions.accessibility(action.label, action.description, action.command),
      role: 'button',
    };
    this.iconPath = new vscode.ThemeIcon(action.icon);
    this.command = { command: action.command, title: action.label };
  }
}

class RunningGroupItem extends vscode.TreeItem {
  constructor(count: number, working: number) {
    super(strings.running.group(), vscode.TreeItemCollapsibleState.Expanded);
    this.description =
      working > 0
        ? strings.running.workingCount(working, count)
        : strings.running.sessionCount(count);
    this.tooltip = strings.running.tooltip();
    this.iconPath = new vscode.ThemeIcon(working > 0 ? presentStatus({
      status: 'working',
      ordinal: 0,
      completedTurns: 0,
    }).icon : 'pulse');
    this.accessibilityInformation = {
      label: strings.running.accessibilityGroup(count),
      role: 'treeitem',
    };
  }
}

class RunningSessionItem extends vscode.TreeItem {
  constructor(node: RunningSession, now: number, stallSeconds: number) {
    const { session } = node;
    super(session.project || session.label, vscode.TreeItemCollapsibleState.None);
    const presentation = presentStatus(session.activity);
    this.description = describeActivity(session.activity, now, stallSeconds);
    this.iconPath = new vscode.ThemeIcon(
      presentation.icon,
      presentation.color ? new vscode.ThemeColor(presentation.color) : undefined,
    );
    this.contextValue = session.sessionId
      ? 'codexTerminal.runningSession.bound'
      : 'codexTerminal.runningSession';
    this.tooltip = buildTooltip(session, now, stallSeconds);
    this.command = {
      command: 'codexTerminal.focusSession',
      title: strings.running.focusTitle(),
      arguments: [session.terminal],
    };
    this.accessibilityInformation = {
      label: strings.running.accessibilitySession(
        session.project || session.label,
        this.description,
      ),
      role: 'button',
    };
  }
}

function buildTooltip(
  session: LiveSession,
  now: number,
  stallSeconds: number,
): vscode.MarkdownString {
  const presentation = presentStatus(session.activity);
  const lines = [
    `**${session.project || session.label}** — ${presentation.label}`,
    '',
    `- \`${session.cwd}\``,
  ];
  const elapsed = elapsedSeconds(session.activity, now);
  if (elapsed !== undefined) {
    lines.push(`- ${strings.running.runningFor(formatDuration(elapsed))}`);
  }
  if (session.activity.completedTurns > 0) {
    lines.push(`- ${strings.running.turns(session.activity.completedTurns)}`);
  }
  const used = contextUsed(session.activity);
  if (used !== undefined && session.activity.totalTokens) {
    lines.push(
      `- ${strings.running.context(
        formatTokens(session.activity.totalTokens),
        Math.round(used * 100),
      )}`,
    );
  }
  lines.push(
    session.sessionId
      ? `- ${strings.running.sessionId(session.sessionId)}`
      : `- _${strings.running.notBound()}_`,
  );
  if (isStalled(session.activity, now, stallSeconds)) {
    // Be explicit about the limit of what a rollout tail can see, rather than letting a
    // silent session read as a stuck one.
    lines.push('', `_${strings.running.silenceCaveat()}_`);
  }
  if (session.activity.lastMessage) {
    lines.push('', `> ${session.activity.lastMessage.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  return new vscode.MarkdownString(lines.join('\n'));
}

export class ActionsViewProvider implements vscode.TreeDataProvider<ActionNode>, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<ActionNode | undefined | null | void>();
  private readonly monitorSubscription: vscode.Disposable;

  readonly onDidChangeTreeData = this.changes.event;

  constructor(
    private readonly monitor: SessionMonitor,
    private readonly stallSeconds: () => number = () => DEFAULT_STALL_SECONDS,
  ) {
    this.monitorSubscription = monitor.onDidChange(() => this.changes.fire());
  }

  getTreeItem(node: ActionNode): vscode.TreeItem {
    if ('kind' in node && node.kind === 'running-group') {
      return new RunningGroupItem(this.monitor.live().length, this.monitor.workingCount());
    }
    if ('kind' in node && node.kind === 'running-session') {
      return new RunningSessionItem(node, Date.now(), this.stallSeconds());
    }
    return new ActionItem(node);
  }

  getChildren(element?: ActionNode): ActionNode[] {
    if (!element) {
      const live = this.monitor.live();
      return live.length > 0 ? [...ACTIONS, RUNNING_GROUP] : [...ACTIONS];
    }
    if ('kind' in element && element.kind === 'running-group') {
      return this.monitor
        .live()
        .map((session) => ({ kind: 'running-session' as const, session }));
    }
    return [];
  }

  dispose(): void {
    this.monitorSubscription.dispose();
    this.changes.dispose();
  }
}
