import * as vscode from 'vscode';

import { LAUNCH_KEY_ENV_VAR, OWNERSHIP_ENV_VAR, isOwnedTerminalName } from './naming';

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
      if (terminal.exitStatus !== undefined || !isOwnedTerminal(terminal, terminalName)) {
        continue;
      }
      const alreadyTracked = this.entries.some((entry) => entry.terminal === terminal);
      if (!alreadyTracked) {
        this.entries.push({
          terminal,
          cwd: terminalCwd(terminal),
          startedAt: Date.now(),
        });
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

/**
 * Recognise a terminal as ours.
 *
 * The environment marker is checked first because it is the only signal that survives
 * `live` tab titles, where Codex owns the label and no name of ours appears anywhere in
 * it. The name checks remain for terminals launched in `static` mode and for anything
 * created before the marker existed.
 */
function isOwnedTerminal(terminal: vscode.Terminal, baseName: string): boolean {
  const creationOptions = terminal.creationOptions;
  if ('env' in creationOptions && creationOptions.env?.[OWNERSHIP_ENV_VAR]) {
    return true;
  }
  if (isOwnedTerminalName(terminal.name, baseName)) {
    return true;
  }
  return 'name' in creationOptions && typeof creationOptions.name === 'string'
    ? isOwnedTerminalName(creationOptions.name, baseName)
    : false;
}

/**
 * The journal key this terminal was launched under, if it carries one.
 *
 * Absent for terminals created before the stamp existed and for anything adopted purely on
 * its name, which is why the caller has to cope with `undefined` rather than assume a match.
 */
export function terminalLaunchKey(terminal: vscode.Terminal): string | undefined {
  const options = terminal.creationOptions;
  if (!('env' in options)) {
    return undefined;
  }
  const key = options.env?.[LAUNCH_KEY_ENV_VAR];
  return typeof key === 'string' && key.length > 0 ? key : undefined;
}

function terminalCwd(terminal: vscode.Terminal): string | undefined {
  const options = terminal.creationOptions;
  if (!('cwd' in options)) {
    return undefined;
  }
  const cwd = options.cwd;
  if (typeof cwd === 'string') {
    return cwd;
  }
  return cwd?.fsPath;
}
