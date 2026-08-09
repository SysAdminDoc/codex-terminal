import * as vscode from 'vscode';

export interface TrackedTerminal {
  terminal: vscode.Terminal;
  cwd?: string;
  startedAt: number;
}

/** Owns extension terminals across commands and adopts survivors after a reload. */
export class TerminalRegistry implements vscode.Disposable {
  private readonly entries: TrackedTerminal[] = [];
  private readonly changes = new vscode.EventEmitter<void>();

  readonly onDidChange = this.changes.event;

  track(terminal: vscode.Terminal, cwd?: string): void {
    if (this.entries.some((entry) => entry.terminal === terminal)) {
      return;
    }
    this.entries.push({ terminal, cwd, startedAt: Date.now() });
    this.changes.fire();
  }

  /** Adopt shell-process terminals that VS Code kept alive through window reload. */
  adopt(terminals: readonly vscode.Terminal[], terminalName: string): number {
    let adopted = 0;
    for (const terminal of terminals) {
      if (terminal.name !== terminalName || terminal.exitStatus !== undefined) {
        continue;
      }
      const alreadyTracked = this.entries.some((entry) => entry.terminal === terminal);
      if (!alreadyTracked) {
        this.entries.push({ terminal, startedAt: Date.now() });
        adopted += 1;
      }
    }
    if (adopted > 0) {
      this.changes.fire();
    }
    return adopted;
  }

  remove(terminal: vscode.Terminal): void {
    const index = this.entries.findIndex((entry) => entry.terminal === terminal);
    if (index === -1) {
      return;
    }
    this.entries.splice(index, 1);
    this.changes.fire();
  }

  live(): readonly TrackedTerminal[] {
    return this.entries.filter((entry) => entry.terminal.exitStatus === undefined);
  }

  mostRecentLive(): TrackedTerminal | undefined {
    const live = this.live();
    return live.length > 0 ? live[live.length - 1] : undefined;
  }

  dispose(): void {
    this.changes.dispose();
    this.entries.length = 0;
  }
}
