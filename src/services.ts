import * as vscode from 'vscode';

import type { HistoryViewProvider } from './historyView';
import type { SessionMonitor } from './monitor';
import type { TabTitleMode } from './naming';
import type { NotifyBridge } from './notify';
import { motionAllowed } from './present';
import { strings } from './strings';
import type { TerminalRegistry } from './terminals';
import type { TranscriptContentProvider } from './transcriptDocument';

/**
 * The handles every command needs, in one place.
 *
 * These were seven module-level `let`s in `extension.ts`, which is the reason that file could
 * not be split: any function moved out of it lost the log channel, the monitor and the views
 * at once. Naming them as a record, set once during activation, is what makes the command
 * implementations movable — and makes it obvious what activation actually owns.
 *
 * Deliberately not a dependency-injection framework. It is the smallest thing that turns an
 * implicit set of file-scoped globals into an explicit, typed contract.
 */
export interface ExtensionServices {
  log: vscode.LogOutputChannel;
  context: vscode.ExtensionContext;
  monitor: SessionMonitor;
  registry: TerminalRegistry;
  history: HistoryViewProvider;
  transcript: TranscriptContentProvider;
  /** Created lazily, and torn down again whenever the setting is turned off. */
  notify?: NotifyBridge;
}

let current: ExtensionServices | undefined;

export function setServices(next: ExtensionServices): void {
  current = next;
}

/**
 * Cleared by `deactivate`. Callers use `services()` and are entitled to assume activation has
 * happened, because every one of them is reachable only from a contributed command.
 */
export function clearServices(): void {
  current = undefined;
}

/** The services if activation completed, else undefined. For teardown paths only. */
export function peekServices(): ExtensionServices | undefined {
  return current;
}

export function services(): ExtensionServices {
  if (!current) {
    throw new Error('Codex Terminal is not activated');
  }
  return current;
}

/** Available before `setServices`, so activation can log while it is still wiring up. */
export function log(): vscode.LogOutputChannel {
  return services().log;
}

export function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('codexTerminal');
}

/** Honour the editor's reduced-motion preference for the animated indicators. */
export function animationAllowed(): boolean {
  return motionAllowed(
    vscode.workspace.getConfiguration('workbench').get<string>('reduceMotion', 'auto'),
  );
}

export function tabTitleMode(): TabTitleMode {
  return config().get<TabTitleMode>('tabTitle', 'live') === 'static' ? 'static' : 'live';
}

/** `globalState` key holding what the workbench settings looked like before we touched them. */
export const OVERRIDE_LEDGER_KEY = 'codexTerminal.workbenchOverrides';
/** `globalState` key for the operator's own names, keyed by Codex session id. */
export const SESSION_NAMES_KEY = 'codexTerminal.sessionNames';

export function reportError(error: unknown, headline: string): void {
  const message = error instanceof Error ? error.message : String(error);
  const report = strings.errors.withDetail(headline, message);
  log().error(report);
  void vscode.window.showErrorMessage(report, strings.errors.showLog()).then((choice) => {
    if (choice === strings.errors.showLog()) {
      log().show(true);
    }
  });
}
