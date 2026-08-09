import * as vscode from 'vscode';

import { TerminalRegistry, type TrackedTerminal } from './terminals';
import { strings } from './strings';

/**
 * Activity bar entry listing the launch actions.
 *
 * The status bar item cannot be relied on: `workbench.statusBar.visible: false` is a
 * perfectly ordinary setting and hides every extension's status bar contribution with no
 * error anywhere. The editor title button needs a focused text editor, which a workspace
 * opened with `workbench.startupEditor: none` does not have. The activity bar is the only
 * surface that is present regardless.
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
  tracked: TrackedTerminal;
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
  constructor(count: number) {
    super(strings.running.group(), vscode.TreeItemCollapsibleState.Expanded);
    this.description = strings.running.sessionCount(count);
    this.tooltip = strings.running.tooltip();
    this.iconPath = new vscode.ThemeIcon('pulse');
    this.accessibilityInformation = {
      label: strings.running.accessibilityGroup(count),
      role: 'treeitem',
    };
  }
}

class RunningSessionItem extends vscode.TreeItem {
  constructor(readonly session: RunningSession) {
    super(session.tracked.terminal.name, vscode.TreeItemCollapsibleState.None);
    const cwd = session.tracked.cwd ?? strings.running.unavailableCwd();
    this.description = cwd;
    this.tooltip = strings.running.tooltipSession(session.tracked.terminal.name, cwd);
    this.iconPath = new vscode.ThemeIcon('terminal');
    this.contextValue = 'codexTerminal.runningSession';
    this.command = {
      command: 'codexTerminal.focusSession',
      title: strings.running.focusTitle(),
      arguments: [session.tracked.terminal],
    };
    this.accessibilityInformation = {
      label: strings.running.accessibilitySession(session.tracked.terminal.name, cwd),
      role: 'button',
    };
  }
}

export class ActionsViewProvider implements vscode.TreeDataProvider<ActionNode>, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<ActionNode | undefined | null | void>();
  private readonly registrySubscription: vscode.Disposable;

  readonly onDidChangeTreeData = this.changes.event;

  constructor(private readonly registry: TerminalRegistry) {
    this.registrySubscription = registry.onDidChange(() => this.changes.fire());
  }

  getTreeItem(node: ActionNode): vscode.TreeItem {
    if ('kind' in node && node.kind === 'running-group') {
      return new RunningGroupItem(this.registry.live().length);
    }
    if ('kind' in node && node.kind === 'running-session') {
      return new RunningSessionItem(node);
    }
    return new ActionItem(node);
  }

  getChildren(element?: ActionNode): ActionNode[] {
    if (!element) {
      const live = this.registry.live();
      return live.length > 0 ? [...ACTIONS, RUNNING_GROUP] : [...ACTIONS];
    }
    if ('kind' in element && element.kind === 'running-group') {
      return this.registry.live().map((tracked) => ({ kind: 'running-session', tracked }));
    }
    return [];
  }

  dispose(): void {
    this.registrySubscription.dispose();
    this.changes.dispose();
  }
}
