import * as vscode from 'vscode';

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

const ACTIONS: Action[] = [
  {
    label: 'New Session',
    description: 'codex',
    command: 'codexTerminal.new',
    icon: 'sparkle',
  },
  {
    label: 'Resume Last Session',
    description: 'codex resume --last',
    command: 'codexTerminal.resumeLast',
    icon: 'history',
  },
  {
    label: 'Resume Session…',
    description: 'codex resume',
    command: 'codexTerminal.resumePicker',
    icon: 'list-selection',
  },
  {
    label: 'Fork Last Session',
    description: 'codex fork --last',
    command: 'codexTerminal.forkLast',
    icon: 'git-branch',
  },
  {
    label: 'Send File Reference',
    description: '@path#L1-L2',
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
    this.tooltip = `${action.label} — ${action.description}`;
    this.accessibilityInformation = {
      label: `${action.label}: ${action.description}. Runs ${action.command}.`,
      role: 'button',
    };
    this.iconPath = new vscode.ThemeIcon(action.icon);
    this.command = { command: action.command, title: action.label };
  }
}

export class ActionsViewProvider implements vscode.TreeDataProvider<Action> {
  getTreeItem(action: Action): vscode.TreeItem {
    return new ActionItem(action);
  }

  getChildren(element?: Action): Action[] {
    return element ? [] : ACTIONS;
  }
}
