import { existsSync } from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { findLaunch, interruptedSessions, type JournalSession, type JournalStore } from './journal';
import { isRecoveryNode } from './historyView';
import { launch } from './launch';
import { config, log, services } from './services';
import { strings } from './strings';
import { terminalLaunchKey } from './terminals';

/**
 * Offering back the sessions a window was holding when it died.
 *
 * The reason the journal exists. Kept out of activation so the rules stay readable: a session
 * is offered once, from a window that is demonstrably gone, and never twice.
 */

function restoreJournalSession(session: JournalSession): void {
  if (!session.sessionId) {
    return;
  }
  void vscode.window.showInformationMessage(
    strings.recovery.restored(session.project || session.label),
  );
  services().history.clearRecoverable(session.sessionId);
  void launch({
    mode: 'resumePicker',
    sessionId: session.sessionId,
    cwd: session.cwd || undefined,
  });
}

export function restoreSession(node: unknown): void {
  if (isRecoveryNode(node)) {
    restoreJournalSession(node.session);
  }
}

export function restoreAllSessions(): void {
  for (const session of [...(services().history.getRecoverable() ?? [])]) {
    restoreJournalSession(session);
  }
}

export function dismissRecovery(): void {
  services().history.clearRecoverable();
}

/**
 * Offer back the sessions a window was holding when it died.
 *
 * Presented once: the crashed journals are stamped as handled straight after, so opening
 * a second window does not raise the same prompt again. The sidebar group stays until it
 * is used or dismissed.
 */
export async function offerRecovery(store: JournalStore, windowId: string): Promise<void> {
  try {
    const journals = await store.readAll();
    const now = Date.now();
    const active = services().monitor.activeSessionIds() ?? new Set<string>();
    const candidates = interruptedSessions(journals, now, windowId).filter(
      (session) => session.sessionId && !active.has(session.sessionId),
    );
    if (candidates.length === 0) {
      return;
    }

    const handled = journals
      .filter((journal) =>
        candidates.some((candidate) =>
          journal.sessions.some((session) => session.key === candidate.key),
        ),
      )
      .map((journal) => journal.windowId);

    services().history.setRecoverable(candidates);
    log().info(`found ${candidates.length} interrupted Codex session(s) from a previous window`);
    await store.markHandled(handled);

    const choice = await vscode.window.showWarningMessage(
      strings.recovery.prompt(candidates.length),
      strings.recovery.restoreAll(),
      strings.recovery.review(),
      strings.recovery.dismiss(),
    );
    if (choice === strings.recovery.restoreAll()) {
      restoreAllSessions();
    } else if (choice === strings.recovery.review()) {
      await vscode.commands.executeCommand('codexTerminal.history.focus');
    } else if (choice === strings.recovery.dismiss()) {
      dismissRecovery();
    }
  } catch (error) {
    log().warn(
      `could not check for interrupted sessions: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Re-adopt the terminals a window reload left running, and match each back to its session.
 *
 * A reload keeps the shell processes but restarts the extension host, so without this the
 * tabs come back anonymous: no session id, no activity, no transcript link. The journal key
 * stamped into each terminal's environment is what survives, and it is looked up here.
 */
export async function adoptSurvivingTerminals(store: JournalStore): Promise<void> {
  const { monitor, registry } = services();
  const adopted = registry.adopt(
    vscode.window.terminals,
    config().get<string>('terminalName', 'Codex'),
  );
  if (adopted === 0) {
    return;
  }
  log().info(strings.logs.adopted(adopted));

  // Read before anything is tracked. A reload can reuse the previous window's id, in which
  // case this window's first journal write lands on the very file being read here.
  const journals = await store.readAll();
  let rebound = 0;
  for (const tracked of registry.live()) {
    const key = terminalLaunchKey(tracked.terminal);
    const record = key ? findLaunch(journals, key) : undefined;
    // The rollout has to still be on disk: it can have been archived or deleted between the
    // two windows, and binding to a missing file would show a session that never moves.
    if (record?.sessionId && record.rolloutPath && existsSync(record.rolloutPath)) {
      monitor.track(tracked.terminal, {
        cwd: record.cwd || tracked.cwd || '',
        project: record.project,
        label: record.label,
        mode: record.mode,
        profile: record.profile,
        key: record.key,
        sessionId: record.sessionId,
        rolloutPath: record.rolloutPath,
      });
      rebound += 1;
      continue;
    }

    // No stamp, or a launch that never reached a rollout: the tab still works and can be
    // focused, but nothing can say which conversation it holds.
    log().info(
      strings.logs.rebindUnavailable(
        tracked.terminal.name,
        !key ? 'no launch key' : !record ? 'no journal record' : 'rollout file is gone',
      ),
    );
    monitor.track(tracked.terminal, {
      cwd: tracked.cwd ?? '',
      project: tracked.cwd ? path.basename(tracked.cwd) : tracked.terminal.name,
      label: tracked.terminal.name,
      mode: 'adopted',
      bindable: false,
    });
  }
  log().info(strings.logs.rebound(rebound, adopted));
}
