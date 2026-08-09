import * as vscode from 'vscode';
import type { DoctorReport } from './doctor';
import type { MigrationEvent } from './migrate';

/** All extension-host text goes through vscode.l10n so the default English build stays intact. */
export const strings = {
  actions: {
    newSession: (): string => vscode.l10n.t('New Session'),
    resumeLast: (): string => vscode.l10n.t('Resume Last Session'),
    resumePicker: (): string => vscode.l10n.t('Resume Session…'),
    forkLast: (): string => vscode.l10n.t('Fork Last Session'),
    sendReference: (): string => vscode.l10n.t('Send File Reference'),
    codex: (): string => vscode.l10n.t('codex'),
    resumeLastCommand: (): string => vscode.l10n.t('codex resume --last'),
    resumeCommand: (): string => vscode.l10n.t('codex resume'),
    forkLastCommand: (): string => vscode.l10n.t('codex fork --last'),
    referenceExample: (): string => vscode.l10n.t('@path#L1-L2'),
    tooltip: (label: string, description: string): string =>
      vscode.l10n.t('{0} — {1}', label, description),
    accessibility: (label: string, description: string, command: string): string =>
      vscode.l10n.t('{0}: {1}. Runs {2}.', label, description, command),
  },
  running: {
    group: (): string => vscode.l10n.t('Running'),
    sessionCount: (count: number): string =>
      count === 1 ? vscode.l10n.t('1 session') : vscode.l10n.t('{0} sessions', count),
    tooltip: (): string => vscode.l10n.t('Live Codex terminal sessions'),
    accessibilityGroup: (count: number): string =>
      count === 1
        ? vscode.l10n.t('Running: 1 live Codex session')
        : vscode.l10n.t('Running: {0} live Codex sessions', count),
    unavailableCwd: (): string => vscode.l10n.t('working directory unavailable'),
    tooltipSession: (name: string, cwd: string): string => vscode.l10n.t('{0} — {1}', name, cwd),
    focusTitle: (): string => vscode.l10n.t('Focus Running Codex Session'),
    accessibilitySession: (name: string, cwd: string): string =>
      vscode.l10n.t(
        '{0}, working directory {1}. Click to focus; use the inline actions to focus or stop.',
        name,
        cwd,
      ),
  },
  notifications: {
    turnCompleted: (workspace: string): string =>
      vscode.l10n.t('Codex turn completed in {0}.', workspace),
    notificationsEnabled: (workspace: string): string =>
      vscode.l10n.t('turn-completion notifications enabled for {0}', workspace),
    enableFailed: (message: string): string =>
      vscode.l10n.t('Could not enable turn-completion notifications: {0}', message),
  },
  folders: {
    prompt: (): string => vscode.l10n.t('Choose the workspace folder for Codex'),
  },
  profiles: {
    freeText: (): string => vscode.l10n.t('$(edit) Enter a profile name…'),
    freeTextDescription: (): string =>
      vscode.l10n.t('Use any profile name supported by Codex'),
    prompt: (): string => vscode.l10n.t('Choose a Codex profile'),
    inputPrompt: (): string => vscode.l10n.t('Codex profile name'),
    inputPlaceholder: (): string => vscode.l10n.t('team-default'),
    argument: (name: string): string => vscode.l10n.t('--profile {0}', name),
  },
  sessions: {
    prompt: (): string => vscode.l10n.t('Choose a recent Codex session to resume'),
    resumeLabel: (timestamp: string, id: string): string =>
      vscode.l10n.t('{0} — {1}', timestamp, id),
  },
  warnings: {
    noEditor: (): string => vscode.l10n.t('Codex Terminal: no active editor to reference.'),
    noTerminal: (): string =>
      vscode.l10n.t('Codex Terminal: no terminal to send the reference to.'),
  },
  status: {
    text: (): string => vscode.l10n.t('$(sparkle) Codex'),
    tooltip: (): string => vscode.l10n.t('Open Codex CLI in a terminal'),
    accessibility: (): string =>
      vscode.l10n.t('Codex Terminal: Open Codex CLI in a terminal'),
  },
  errors: {
    missingCommand: (command: string): string =>
      vscode.l10n.t(
        'Codex CLI command {0} was not found. Install @openai/codex or set codexTerminal.command to an executable path.',
        JSON.stringify(command),
      ),
    couldNotStart: (): string => vscode.l10n.t('Could not start Codex'),
    couldNotRunDoctor: (): string => vscode.l10n.t('Could not run Codex Doctor'),
    showLog: (): string => vscode.l10n.t('Show Log'),
    install: (): string => vscode.l10n.t('Install Codex CLI'),
    withDetail: (headline: string, message: string): string =>
      vscode.l10n.t('{0}: {1}', headline, message),
  },
  logs: {
    commandPreflightPassed: (command: string, resolved: string): string =>
      vscode.l10n.t('Codex command preflight passed: {0} → {1}', command, resolved),
    shellResolution: (reason: string): string => vscode.l10n.t('shell resolution: {0}', reason),
    sentReference: (reference: string): string => vscode.l10n.t('sent reference {0}', reference),
    adopted: (count: number): string =>
      count === 1
        ? vscode.l10n.t('adopted 1 surviving Codex terminal')
        : vscode.l10n.t('adopted {0} surviving Codex terminals', count),
    launch: (
      mode: string,
      shell: string,
      args: string,
      cwd: string,
      fallback: string,
    ): string =>
      fallback
        ? vscode.l10n.t(
            'launch mode={0} shell={1} args={2} cwd={3} sendText={4}',
            mode,
            shell,
            args,
            cwd,
            fallback,
          )
        : vscode.l10n.t('launch mode={0} shell={1} args={2} cwd={3}', mode, shell, args, cwd),
    activation: (statusBarVisible: boolean): string =>
      statusBarVisible
        ? vscode.l10n.t('Codex Terminal activated (workbench.statusBar.visible=true)')
        : vscode.l10n.t(
            'Codex Terminal activated (workbench.statusBar.visible=false — status bar button cannot render; use the activity bar)',
        ),
  },
  doctor: {
    report: (report: DoctorReport): string => {
      const shell = report.plan.shellPath ?? vscode.l10n.t('<editor default>');
      const shellExists =
        report.shellExists === undefined ? vscode.l10n.t('n/a') : String(report.shellExists);
      const command = report.commandPath ?? vscode.l10n.t('<not found>');
      const version = report.version || vscode.l10n.t('not run (command not found)');
      const cwd = report.cwd ?? vscode.l10n.t('<none>');
      return [
        vscode.l10n.t('Codex Terminal Doctor'),
        vscode.l10n.t('shell: {0}', shell),
        vscode.l10n.t('shell exists: {0}', shellExists),
        vscode.l10n.t('Codex command: {0}', report.command),
        vscode.l10n.t('resolved Codex command: {0}', command),
        vscode.l10n.t('Codex --version: {0}', version),
        vscode.l10n.t('cwd: {0}', cwd),
        vscode.l10n.t('workbench.statusBar.visible: {0}', String(report.statusBarVisible)),
        vscode.l10n.t(
          'editor-title button can render: {0}',
          String(report.editorTitleButtonCanRender),
        ),
        ...(report.plan.shellResolutionReason
          ? [vscode.l10n.t('shell resolution: {0}', report.plan.shellResolutionReason)]
          : []),
      ].join('\n');
    },
  },
  migration: {
    event: (event: MigrationEvent): string =>
      event.result === 'migrated'
        ? vscode.l10n.t(
            'Migrated codexTerminal.{0} to codexTerminal.{1} at {2} scope.',
            event.from,
            event.to,
            event.target,
          )
        : vscode.l10n.t(
            'Skipped codexTerminal.{0} to codexTerminal.{1} at {2} scope because the new setting is already set.',
            event.from,
            event.to,
            event.target,
          ),
    failed: (message: string): string => vscode.l10n.t('Settings migration failed: {0}', message),
  },
};
