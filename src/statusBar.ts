import * as vscode from 'vscode';

import type { SessionMonitor } from './monitor';
import { DEFAULT_STALL_SECONDS, peakContextUsed, statusBarText } from './present';
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
    item.tooltip = stalled > 0 ? `${base} ${strings.status.stalledTooltip(stalled)}` : base;
    item.accessibilityInformation = {
      label:
        working > 0
          ? strings.status.accessibilityWorking(working)
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
