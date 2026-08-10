import * as vscode from 'vscode';

import type { SessionMonitor } from './monitor';
import {
  DEFAULT_STALL_SECONDS,
  describeRateLimit,
  peakContextUsed,
  peakRateLimit,
  statusBarText,
} from './present';
import { animationAllowed, config } from './services';
import { strings } from './strings';

/**
 * Status bar item, driven by live session state.
 *
 * `$(loading~spin)` is the workbench's animated-codicon syntax: the `~spin` modifier
 * becomes `codicon-modifier-spin` and the animation is CSS, so this costs one label
 * update per state change rather than a timer.
 */
export function createStatusBarItem(context: vscode.ExtensionContext, monitor: SessionMonitor): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = 'codexTerminal.focus';
  context.subscriptions.push(item);

  const render = (): void => {
    const sessions = monitor.live();
    const live = sessions.length;
    const working = monitor.workingCount();
    const peak = config().get<boolean>('showContextInStatusBar', true)
      ? peakContextUsed(sessions.map((session) => session.activity))
      : undefined;
    item.text = statusBarText(working, live, peak, animationAllowed());
    const stalled = monitor.stalledCount(config().get<number>('stallSeconds', DEFAULT_STALL_SECONDS));
    const base =
      working > 0
        ? strings.status.workingTooltip(working, live)
        : live > 0
          ? strings.status.liveTooltip(live)
          : strings.status.tooltip();
    const parts = [stalled > 0 ? `${base} ${strings.status.stalledTooltip(stalled)}` : base];
    // Every session bills the same account, so the tightest window across all of them is the
    // one that will stop the next turn, whichever tab it is started from.
    const limit = describeRateLimit(
      peakRateLimit(sessions.map((session) => session.activity)),
      Date.now(),
    );
    if (limit) {
      parts.push(strings.running.rateLimit(limit));
    }
    item.tooltip = parts.join(' ');
    // Counts only. `item.text` carries the context percentage, which moves constantly, and
    // VS Code falls back to the text when no accessible label is set — so leaving this off
    // would make the item re-announce itself on every render to anyone focused on it.
    item.accessibilityInformation = {
      label:
        working > 0
          ? strings.status.accessibilityWorking(working)
          : live > 0
            ? strings.status.accessibilityLive(live)
            : strings.status.accessibility(),
      role: 'button',
    };
    if (config().get<boolean>('showStatusBarButton', true)) {
      item.show();
    } else {
      item.hide();
    }
  };

  render();
  context.subscriptions.push(
    monitor.onDidChange(render),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('codexTerminal.showStatusBarButton') ||
        event.affectsConfiguration('codexTerminal.showContextInStatusBar') ||
        event.affectsConfiguration('workbench.reduceMotion')
      ) {
        render();
      }
    }),
  );
}
