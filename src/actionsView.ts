import * as vscode from 'vscode';

import { contextUsed, elapsedSeconds, isStalled } from './activity';
import type { LiveSession, SessionMonitor } from './monitor';
import {
  DEFAULT_STALL_SECONDS,
  announceActivity,
  describeActivity,
  describeItem,
  describeRateLimit,
  formatDuration,
  formatTokens,
  presentStatus,
  tightestWindow,
} from './present';
import { estimateCost, formatCost, type RateTable } from './cost';
import {
  describeMcpServer,
  describePlugin,
  parseMcpList,
  parsePluginList,
  redactSecrets,
} from './inventory';
import { displayName, type SessionNames } from './names';
import { peekServices } from './services';
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

export interface InventoryGroup {
  kind: 'inventory-group';
  of: 'plugins' | 'mcp';
}

interface InventoryEntry {
  kind: 'inventory-entry';
  label: string;
  description: string;
  tooltip: string;
  icon: string;
  /** Dimmed rows: something is configured but switched off, or nothing could be read. */
  muted?: boolean;
}

type ActionNode = Action | RunningGroup | RunningSession | InventoryGroup | InventoryEntry;

/** Narrow a tree node handed back by a context-menu command. */
export function isRunningSessionNode(node: unknown): node is RunningSession {
  return (
    typeof node === 'object' &&
    node !== null &&
    (node as RunningSession).kind === 'running-session'
  );
}
const RUNNING_GROUP: RunningGroup = { kind: 'running-group' };
const PLUGIN_GROUP: InventoryGroup = { kind: 'inventory-group', of: 'plugins' };
const MCP_GROUP: InventoryGroup = { kind: 'inventory-group', of: 'mcp' };

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
  constructor(count: number, working: number, animate: boolean) {
    super(strings.running.group(), vscode.TreeItemCollapsibleState.Expanded);
    this.description =
      working > 0
        ? strings.running.workingCount(working, count)
        : strings.running.sessionCount(count);
    this.tooltip = strings.running.tooltip();
    this.iconPath = new vscode.ThemeIcon(
      working > 0
        ? presentStatus(
            { status: 'working', ordinal: 0, completedTurns: 0, unknownRecordTypes: [] },
            animate,
          ).icon
        : 'pulse',
    );
    this.accessibilityInformation = {
      label: strings.running.accessibilityGroup(count),
      role: 'treeitem',
    };
  }
}

class RunningSessionItem extends vscode.TreeItem {
  constructor(
    node: RunningSession,
    now: number,
    stallSeconds: number,
    animate: boolean,
    names: SessionNames,
    rates: RateTable | undefined,
  ) {
    const { session } = node;
    super(
      displayName(names, session.sessionId, session.project || session.label),
      vscode.TreeItemCollapsibleState.None,
    );
    const presentation = presentStatus(session.activity, animate);
    this.description = describeActivity(session.activity, now, stallSeconds, rates);
    this.iconPath = new vscode.ThemeIcon(
      presentation.icon,
      presentation.color ? new vscode.ThemeColor(presentation.color) : undefined,
    );
    this.contextValue = session.sessionId
      ? 'codexTerminal.runningSession.bound'
      : 'codexTerminal.runningSession';
    this.tooltip = buildTooltip(session, now, stallSeconds, rates);
    this.command = {
      command: 'codexTerminal.focusSession',
      title: strings.running.focusTitle(),
      arguments: [session.terminal],
    };
    this.accessibilityInformation = {
      // `announceActivity`, not `this.description`: the description ticks, and an accessible
      // name that ticks is re-read aloud every time the row refreshes.
      label: strings.running.accessibilitySession(
        String(this.label),
        announceActivity(session.activity, now, stallSeconds),
      ),
      role: 'button',
    };
  }
}

function buildTooltip(
  session: LiveSession,
  now: number,
  stallSeconds: number,
  rates: RateTable | undefined,
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
  if (session.activity.totalTokens) {
    lines.push(`- ${strings.running.totalTokens(formatTokens(session.activity.totalTokens))}`);
  }
  if (used !== undefined && session.activity.contextTokens && session.activity.contextWindow) {
    lines.push(
      `- ${strings.running.context(
        formatTokens(session.activity.contextTokens),
        formatTokens(session.activity.contextWindow),
        Math.round(used * 100),
      )}`,
    );
  }
  // Above the cost line on purpose: on a subscription the plan window is the real budget and
  // the dollar figure is a list-price equivalent nobody is billed.
  const limit = describeRateLimit(tightestWindow(session.activity), now);
  if (limit) {
    lines.push(`- ${strings.running.rateLimit(limit)}`);
  }
  const estimate = estimateCost(session.activity, rates);
  if (estimate) {
    if (estimate.usd === undefined) {
      lines.push(`- ${strings.running.costUnpriced(estimate.model)}`);
    } else {
      lines.push(`- ${strings.running.cost(formatCost(estimate.usd), estimate.model)}`);
      if (estimate.plan) {
        // A subscription session is not billed per token at all, so presenting the figure as
        // spend would be inventing a charge that nobody is making.
        lines.push(`- ${strings.running.costOnPlan(estimate.plan)}`);
      }
    }
  }
  // Shown whatever the status, unlike the row: on an idle session the last step is the
  // answer to "what did it just do", which is the question a finished session raises.
  const step = describeItem(session.activity.lastItem);
  if (step) {
    lines.push(`- ${strings.running.lastStep(step)}`);
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

class InventoryGroupItem extends vscode.TreeItem {
  constructor(group: InventoryGroup) {
    super(
      group.of === 'plugins' ? strings.inventory.plugins() : strings.inventory.mcp(),
      // Collapsed: the CLI behind it is only run when someone opens the section, so a panel
      // nobody expands costs nothing.
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.tooltip =
      group.of === 'plugins' ? strings.inventory.pluginsTooltip() : strings.inventory.mcpTooltip();
    this.iconPath = new vscode.ThemeIcon(group.of === 'plugins' ? 'extensions' : 'server-process');
    this.contextValue = `codexTerminal.inventory.${group.of}`;
    this.accessibilityInformation = {
      label: group.of === 'plugins' ? strings.inventory.plugins() : strings.inventory.mcp(),
      role: 'treeitem',
    };
  }
}

class InventoryEntryItem extends vscode.TreeItem {
  constructor(node: InventoryEntry) {
    super(node.label, vscode.TreeItemCollapsibleState.None);
    this.description = node.description;
    this.tooltip = node.tooltip;
    this.iconPath = new vscode.ThemeIcon(
      node.icon,
      node.muted ? new vscode.ThemeColor('disabledForeground') : undefined,
    );
    this.accessibilityInformation = { label: `${node.label}. ${node.tooltip}`, role: 'treeitem' };
  }
}

/**
 * Cached view of what Codex has plugged in.
 *
 * The tree refreshes on every monitor change — several times a minute while a turn runs — and
 * a process spawn per refresh would be absurd for data that changes when the operator installs
 * something. Read on expansion, then held until it goes stale.
 */
class Inventory {
  private plugins?: { at: number; rows: InventoryEntry[] };
  private mcp?: { at: number; rows: InventoryEntry[] };

  constructor(
    private readonly run: (args: readonly string[]) => Promise<string>,
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Drop everything read so far — the command that produces it has changed. */
  forget(): void {
    this.plugins = undefined;
    this.mcp = undefined;
  }

  async rows(of: 'plugins' | 'mcp'): Promise<InventoryEntry[]> {
    const cached = of === 'plugins' ? this.plugins : this.mcp;
    if (cached && this.now() - cached.at < this.ttlMs) {
      return cached.rows;
    }
    const rows = of === 'plugins' ? await this.readPlugins() : await this.readMcp();
    const entry = { at: this.now(), rows };
    if (of === 'plugins') {
      this.plugins = entry;
    } else {
      this.mcp = entry;
    }
    return rows;
  }

  private async readPlugins(): Promise<InventoryEntry[]> {
    const output = await this.run(['plugin', 'list', '--json']);
    const parsed = parsePluginList(output);
    if (!parsed) {
      return [unreadable(strings.inventory.unreadablePlugins(firstLine(output, 'plugin list')))];
    }
    if (parsed.length === 0) {
      return [note(strings.inventory.noPlugins())];
    }
    return parsed.map((entry) => ({
      kind: 'inventory-entry' as const,
      label: entry.name,
      description: describePlugin(entry),
      tooltip: strings.inventory.pluginTooltip(entry.id, entry.enabled),
      icon: 'plug',
      ...(entry.enabled ? {} : { muted: true }),
    }));
  }

  private async readMcp(): Promise<InventoryEntry[]> {
    const output = await this.run(['mcp', 'list', '--json']);
    const parsed = parseMcpList(output);
    if (!parsed) {
      return [unreadable(strings.inventory.unreadableMcp(firstLine(output, 'mcp list')))];
    }
    if (parsed.length === 0) {
      return [note(strings.inventory.noMcp())];
    }
    return parsed.map((entry) => ({
      kind: 'inventory-entry' as const,
      label: entry.name,
      description: describeMcpServer(entry),
      tooltip: entry.enabled
        ? strings.inventory.mcpTooltipEnabled(entry.transport ?? '')
        : strings.inventory.mcpTooltipDisabled(entry.disabledReason ?? ''),
      icon: entry.enabled ? 'server-process' : 'circle-slash',
      ...(entry.enabled ? {} : { muted: true }),
    }));
  }
}

/**
 * First line only: a failed CLI call can print a paragraph, and this goes in a tree row.
 *
 * The rest is not thrown away — it goes to the log, because the first line of a failure is
 * routinely the least informative one (a stack frame, a shim's banner), and a row that says
 * "could not read" with no way to find out why is a dead end. It goes there **redacted**: the
 * usual reason this path runs at all is that the CLI succeeded and printed a payload of an
 * unexpected shape, and for `codex mcp list` that payload is every server's environment —
 * which the UI drops on purpose because it carries API tokens. Writing it verbatim to a file
 * on disk undid that.
 */
function firstLine(output: string, what: string): string {
  const safe = redactSecrets(output);
  peekServices()?.log.warn(
    `codex ${what} could not be read (${output.length} bytes):\n${safe.slice(0, 4000)}`,
  );
  const line = safe
    .split('\n')
    .map((entry) => entry.trim())
    .find(Boolean);
  return (line ?? '').slice(0, 200);
}

function note(label: string): InventoryEntry {
  return { kind: 'inventory-entry', label, description: '', tooltip: label, icon: 'info', muted: true };
}

function unreadable(label: string): InventoryEntry {
  return { kind: 'inventory-entry', label, description: '', tooltip: label, icon: 'warning', muted: true };
}

export class ActionsViewProvider implements vscode.TreeDataProvider<ActionNode>, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<ActionNode | undefined | null | void>();
  private readonly monitorSubscription: vscode.Disposable;
  private readonly inventory: Inventory;

  readonly onDidChangeTreeData = this.changes.event;

  constructor(
    private readonly monitor: SessionMonitor,
    private readonly stallSeconds: () => number = () => DEFAULT_STALL_SECONDS,
    private readonly animate: () => boolean = () => true,
    private readonly names: () => SessionNames = () => ({}),
    private readonly rates: () => RateTable | undefined = () => undefined,
    runCodex: (args: readonly string[]) => Promise<string> = () => Promise.resolve(''),
  ) {
    this.monitorSubscription = monitor.onDidChange(() => this.changes.fire());
    this.inventory = new Inventory(runCodex);
  }

  /**
   * Forget what Codex reported and redraw.
   *
   * Called when `codexTerminal.command` changes: the cached answer was produced by a different
   * program, and an operator who has just fixed a wrong command should not have to wait out a
   * cache to see it take effect.
   */
  refreshInventory(): void {
    this.inventory.forget();
    this.changes.fire();
  }

  getTreeItem(node: ActionNode): vscode.TreeItem {
    if ('kind' in node && node.kind === 'inventory-group') {
      return new InventoryGroupItem(node);
    }
    if ('kind' in node && node.kind === 'inventory-entry') {
      return new InventoryEntryItem(node);
    }
    if ('kind' in node && node.kind === 'running-group') {
      return new RunningGroupItem(
        this.monitor.live().length,
        this.monitor.workingCount(),
        this.animate(),
      );
    }
    if ('kind' in node && node.kind === 'running-session') {
      return new RunningSessionItem(
        node,
        Date.now(),
        this.stallSeconds(),
        this.animate(),
        this.names(),
        this.rates(),
      );
    }
    return new ActionItem(node);
  }

  getChildren(element?: ActionNode): ActionNode[] | Thenable<ActionNode[]> {
    if (!element) {
      const live = this.monitor.live();
      return [
        ...ACTIONS,
        ...(live.length > 0 ? [RUNNING_GROUP] : []),
        PLUGIN_GROUP,
        MCP_GROUP,
      ];
    }
    if ('kind' in element && element.kind === 'running-group') {
      return this.monitor
        .live()
        .map((session) => ({ kind: 'running-session' as const, session }));
    }
    if ('kind' in element && element.kind === 'inventory-group') {
      return this.inventory.rows(element.of);
    }
    return [];
  }

  dispose(): void {
    this.monitorSubscription.dispose();
    this.changes.dispose();
  }
}
