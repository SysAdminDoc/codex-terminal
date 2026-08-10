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
    workingCount: (working: number, total: number): string =>
      vscode.l10n.t('{0} of {1} working', working, total),
    tooltip: (): string => vscode.l10n.t('Live Codex terminal sessions'),
    accessibilityGroup: (count: number): string =>
      count === 1
        ? vscode.l10n.t('Running: 1 live Codex session')
        : vscode.l10n.t('Running: {0} live Codex sessions', count),
    unavailableCwd: (): string => vscode.l10n.t('working directory unavailable'),
    tooltipSession: (name: string, cwd: string): string => vscode.l10n.t('{0} — {1}', name, cwd),
    focusTitle: (): string => vscode.l10n.t('Focus Running Codex Session'),
    runningFor: (duration: string): string => vscode.l10n.t('Working for {0}', duration),
    turns: (count: number): string =>
      count === 1 ? vscode.l10n.t('1 turn completed') : vscode.l10n.t('{0} turns completed', count),
    context: (tokens: string, percent: number): string =>
      vscode.l10n.t('{0} tokens — {1}% of the context window', tokens, percent),
    sessionId: (id: string): string => vscode.l10n.t('Session `{0}`', id),
    silenceCaveat: (): string =>
      vscode.l10n.t(
        'Codex writes nothing to its session file while waiting for an approval, and nothing while stuck. Check the terminal to tell them apart.',
      ),
    notBound: (): string =>
      vscode.l10n.t('Not yet matched to a Codex session; it will bind once Codex starts writing.'),
    accessibilitySession: (name: string, status: string): string =>
      vscode.l10n.t('{0}, {1}. Click to focus the terminal.', name, status),
  },
  recovery: {
    group: (): string => vscode.l10n.t('Interrupted sessions'),
    count: (count: number): string =>
      count === 1 ? vscode.l10n.t('1 to restore') : vscode.l10n.t('{0} to restore', count),
    tooltip: (): string =>
      vscode.l10n.t(
        'These Codex sessions were open when a window closed unexpectedly. Click one to resume it exactly where it stopped.',
      ),
    interruptedAt: (timestamp: string): string =>
      vscode.l10n.t('Last active {0}, then the window closed unexpectedly.', timestamp),
    restore: (): string => vscode.l10n.t('Restore Session'),
    restoreAll: (): string => vscode.l10n.t('Restore All'),
    dismiss: (): string => vscode.l10n.t('Dismiss'),
    review: (): string => vscode.l10n.t('Show Me'),
    prompt: (count: number): string =>
      count === 1
        ? vscode.l10n.t('1 Codex session was interrupted when a window closed unexpectedly.')
        : vscode.l10n.t(
            '{0} Codex sessions were interrupted when a window closed unexpectedly.',
            count,
          ),
    restored: (project: string): string => vscode.l10n.t('Restoring Codex session in {0}…', project),
    accessibility: (project: string, timestamp: string): string =>
      vscode.l10n.t('{0}, interrupted {1}. Click to restore the session.', project, timestamp),
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
  history: {
    empty: (): string => vscode.l10n.t('No Codex sessions recorded yet'),
    noMatches: (filter: string): string => vscode.l10n.t('No sessions match “{0}”', filter),
    noPrompt: (): string => vscode.l10n.t('(no prompt recorded)'),
    sessionCount: (count: number): string =>
      count === 1 ? vscode.l10n.t('1 session') : vscode.l10n.t('{0} sessions', count),
    openTranscript: (): string => vscode.l10n.t('Open Transcript'),
    resume: (): string => vscode.l10n.t('Resume Session'),
    clickToResume: (): string =>
      vscode.l10n.t('Click to resume this conversation in a terminal.'),
    searchPrompt: (): string => vscode.l10n.t('Filter sessions by project, prompt or id'),
    searchPlaceholder: (): string => vscode.l10n.t('e.g. codex-terminal'),
    pickPrompt: (): string => vscode.l10n.t('Choose a Codex session'),
    accessibility: (project: string, timestamp: string, preview: string): string =>
      vscode.l10n.t(
        '{0}, {1}. {2}. Click to open the transcript.',
        project,
        timestamp,
        preview,
      ),
    copied: (id: string): string => vscode.l10n.t('Copied session id {0}', id),
    exported: (entries: number): string =>
      vscode.l10n.t('Exported {0} transcript entries.', entries),
    exportTruncated: (): string =>
      vscode.l10n.t('Transcript was truncated; open the rollout file for the remainder.'),
    exportFailed: (message: string): string =>
      vscode.l10n.t('Could not export the transcript: {0}', message),
  },
  workbench: {
    applied: (key: string, from: string, to: string): string =>
      vscode.l10n.t('Set {0} from {1} to {2}.', key, from, to),
    reverted: (key: string, to: string): string => vscode.l10n.t('Restored {0} to {1}.', key, to),
    nothingToRevert: (): string =>
      vscode.l10n.t('Codex Terminal has not changed any workbench settings.'),
    failed: (key: string, message: string): string =>
      vscode.l10n.t('Could not update {0}: {1}', key, message),
    unset: (): string => vscode.l10n.t('unset'),
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
    workingTooltip: (working: number, total: number): string =>
      vscode.l10n.t('Codex is working in {0} of {1} open sessions. Click to focus.', working, total),
    stalledTooltip: (stalled: number): string =>
      stalled === 1
        ? vscode.l10n.t('1 of them has produced no output for a while.')
        : vscode.l10n.t('{0} of them have produced no output for a while.', stalled),
    liveTooltip: (total: number): string =>
      total === 1
        ? vscode.l10n.t('1 idle Codex session. Click to focus.')
        : vscode.l10n.t('{0} idle Codex sessions. Click to focus.', total),
    accessibilityWorking: (working: number): string =>
      vscode.l10n.t('Codex Terminal: working in {0} sessions', working),
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
    unknownTitleItems: (items: string, known: string): string =>
      vscode.l10n.t(
        'codexTerminal.titleItems contains entries Codex does not know and will drop: {0}. Known items: {1}',
        items,
        known,
      ),
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
    running: (): string =>
      vscode.l10n.t('Running Codex Terminal Doctor — codex doctor scans the session store…'),
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
        ...(report.title
          ? [
              vscode.l10n.t(
                'Codex tab title: {0} (activity indicator: {1}, source: {2})',
                report.title.items.join(', ') || vscode.l10n.t('<none>'),
                String(report.title.activity),
                report.title.source ?? vscode.l10n.t('unknown'),
              ),
              ...(report.title.invalidItems.length > 0
                ? [
                    vscode.l10n.t(
                      'Codex rejected these title items: {0}',
                      report.title.invalidItems.join(', '),
                    ),
                  ]
                : []),
              ...(report.title.source === 'default'
                ? [
                    vscode.l10n.t(
                      'The title override did not reach Codex, so codexTerminal.titleItems had no effect.',
                    ),
                  ]
                : []),
            ]
          : []),
        ...(report.unknownTitleItems.length > 0
          ? [
              vscode.l10n.t(
                'unknown codexTerminal.titleItems entries: {0}',
                report.unknownTitleItems.join(', '),
              ),
            ]
          : []),
        ...(report.codexVersion
          ? [vscode.l10n.t('codex doctor: {0}', report.codexVersion)]
          : []),
        ...(report.codexDoctorNote
          ? [vscode.l10n.t('codex doctor could not be read: {0}', report.codexDoctorNote)]
          : []),
        ...report.codexChecks.map((check) =>
          vscode.l10n.t(
            '  [{0}] {1}: {2}',
            check.status,
            check.id,
            check.summary ?? vscode.l10n.t('(no summary)'),
          ),
        ),
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
