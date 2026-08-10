# Changelog

All notable changes to Codex Terminal are documented here.
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A working session that has produced no output for a while now says so, rather than showing
  an unqualified "Working" forever. Codex writes nothing while waiting for an approval and
  nothing while stuck, and the two cannot be distinguished from its session file, so the
  elapsed silence is reported and the tooltip explains the limit. Threshold:
  `codexTerminal.stallSeconds`.
- Live context and token usage per session. Each running session shows tokens used and the
  percentage of the model's context window consumed, and the status bar carries the highest
  usage across sessions — the one about to force a compaction. Controlled by
  `codexTerminal.showContextInStatusBar`. Both are omitted, never shown as zero, until a
  session has reported a token count and a context window.
- Workspace-trust declarations. In an untrusted workspace the settings that name the program,
  its arguments, or its environment are ignored, and the reason is shown; previously the
  extension was silently limited with no explanation. Virtual workspaces are declared
  unsupported, and `extensionKind` keeps the shell spawning where the code is under
  Remote-SSH, WSL and containers.
- Doctor now reports what Codex actually resolved, by running `codex doctor --json` with the
  same title override the extension launches with. Invocation-scoped `-c` overrides are not
  validated by Codex, so this is the only way to confirm one landed rather than assuming it.
  Unknown `codexTerminal.titleItems` entries are also reported at launch.

### Changed

- Compacted sessions now render a visible "Context compacted" boundary in the transcript.
  Codex replaces earlier history when it compacts, and the record was previously dropped, so
  a transcript jumped between unrelated turns with nothing to explain the gap.
- The History view now picks the newest sessions from rollout filenames before opening any
  of them, so a refresh costs what is displayed rather than what is stored. Against a local
  2.01 GB store a bounded refresh went from 70 ms to 12 ms, and the gap widens as the store
  grows. Filesystem-driven refreshes are also debounced — Codex appends to the active rollout
  several times a second, and each append previously re-walked the whole directory.

### Fixed

- `codexTerminal.shell: "cmd"` could not launch at all. The Codex title override was emitted
  as a double-quoted TOML array, and cmd.exe has no escape for a double quote inside a quoted
  argument, so every launch threw. The override now uses TOML literal strings.

## [0.4.0] - 2026-08-10

### Added

- A **History** view that reads Codex's local rollouts, groups them by project, and resumes a
  conversation in its original working directory when clicked.
- Live session activity in the Launch panel, folded from the rollout's own turn events, with an
  animated indicator while Codex is working plus elapsed time and context usage.
- Crash recovery: each window journals the Codex sessions it has open, and a window that closes
  without shutting down cleanly has those sessions offered back under **Interrupted sessions**.
- `codexTerminal.tabTitle`, choosing between Codex's live tab title and a fixed label.
- Markdown transcript export for any recorded session.

### Changed

- `codexTerminal.titleItems` now defaults to `["activity", "project-name", "app-name"]`; the
  constant app name is what identifies our tabs after a window reload.
- Terminals are recognised as ours by an environment marker rather than by their label, so
  ownership survives Codex owning the tab text.

## [0.3.0] - 2026-08-09

### Fixed

- Preflight the configured Codex command and offer direct installation guidance when it is missing.
- Fall back from the unusable WindowsApps `pwsh.exe` execution alias to Windows PowerShell, with
  the fallback reason recorded in the extension log.
- Resolve bare commands through `PATH` and validate absolute paths without rewriting them.

### Added

- A hostile-settings integration suite driven by `@vscode/test-cli`, including a seeded workspace
  with the status bar hidden and startup editor disabled.
- Explicit accessibility labels for the status bar button and every Launch-panel action.
- Reload-safe terminal ownership that adopts live Codex tabs and keeps focus and file-reference
  commands pointed at the surviving session.
- A discoverable `Codex Terminal: Doctor` command that reports shell and CLI resolution, CLI
  version output, cwd, and the visibility of the extension's UI surfaces.
- Upgraded the build toolchain to esbuild 0.28.2 and pinned compatible audit overrides for the
  integration runner; `npm audit` now reports zero vulnerabilities.
- Added troubleshooting guidance for raw ANSI output, TUI flicker, and unexpected CLI exits,
  including upstream issue links and plain-terminal checks.
- Added `New Session with Profile…`, which discovers local Codex profile files, accepts a free-text
  profile name, passes `--profile`, and labels the resulting terminal tab.
- The Launch panel now tracks live Codex tabs in a Running group with cwd, focus, and stop actions;
  the group disappears when no sessions remain.
- Added `codexTerminal.cwd: "prompt"` for multi-root windows; it asks for a workspace folder only
  when the active editor cannot identify one.
- Added a manifest test that guards the machine-overridable trust boundary for command-bearing
  settings.
- Added opt-in turn-completion notifications through an invocation-scoped Codex `notify` hook;
  the hook is stored under extension storage and never edits `~/.codex/config.toml`.
- The resume picker now reads recent session metadata locally, shows timestamp/cwd, and resumes a
  selected UUID directly while retaining Codex's picker as the empty-store fallback.
- Externalized extension-host strings through `vscode.l10n`, added the generated English bundle,
  and localized manifest labels and settings descriptions through `package.nls.json`.
- Renamed the status-bar visibility setting to `codexTerminal.showStatusBarButton` with a one-time,
  per-version migration from the deprecated `showStatusBarItem` key.
- Removed the unconditional `onStartupFinished` activation trigger; contribution-driven activation
  now starts the extension when a Codex command, view, or terminal profile is used.

## [0.2.0] - 2026-08-09

### Added

- **Activity bar entry** with a *Launch* panel listing every action (new, resume last, resume
  picker, fork last, send file reference). The status bar item is not a reliable button:
  `"workbench.statusBar.visible": false` hides every extension's status bar contribution with
  no error, and the editor title button needs a focused text editor, which a workspace opened
  with `"workbench.startupEditor": "none"` does not have. The activity bar is always present.
- Activation now logs the value of `workbench.statusBar.visible`, so a missing status bar
  button is diagnosable from *Codex Terminal: Show Log* instead of looking like a dead
  extension.
- `install.cmd` shipped as a release asset — double-clicking a `.vsix` on Windows hands it to
  Visual Studio's VSIX Installer, which refuses VS Code extensions.

## [0.1.0] - 2026-08-09

Initial release.

### Added

- Launch Codex CLI from the status bar, the editor title bar, the terminal `+` dropdown, or
  the Command Palette.
- Shell pinning: `auto`, `pwsh`, `powershell`, `cmd`, `bash`, `zsh`, `custom`, `editorDefault`.
  `auto` resolves PowerShell 7 when it is installed and falls back to Windows PowerShell.
- Argument-based launch (`pwsh -NoLogo -NoExit -Command codex`) instead of typing into a live
  prompt, so the launch cannot race shell startup and leaves nothing in shell history.
- A contributed terminal profile, so **Codex** appears natively in the terminal dropdown.
- Session commands mapped to real Codex subcommands: new, `resume --last`, `resume`,
  `fork --last`.
- *Send File Reference to Codex* — puts `@path#L10-L20` on the prompt without submitting it.
- `keepShellOpen` (`-NoExit` / `/K` / `exec $SHELL -i`), so a Codex crash leaves a readable
  prompt instead of a vanishing tab.
- Configurable working directory, terminal name, icon color, environment variables, and tab
  location (editor / beside / panel).
- Errors surface as a notification with a *Show Log* action, backed by a `Codex Terminal`
  log output channel.

[0.3.0]: https://github.com/SysAdminDoc/codex-terminal/releases/tag/v0.3.0
[0.2.0]: https://github.com/SysAdminDoc/codex-terminal/releases/tag/v0.2.0
[0.1.0]: https://github.com/SysAdminDoc/codex-terminal/releases/tag/v0.1.0

## Roadmap archive — 2026-08-10 — ROADMAP.md

<details>
<summary>Original roadmap snapshot</summary>

```markdown
# Roadmap — Codex Terminal

Open work only. Item ids are `CT-<n>`, assigned sequentially and never reused.

## Research-Driven Additions

### P0

### P1

### P2

### P3

### Consciously excluded

Mobile (desktop editor extension only), offline resilience (the extension performs no network
I/O — CT-07 asserts this rather than adding work), and multi-user/collaboration (no shared
state exists). A plugin ecosystem for the extension itself is excluded: Codex already has one at
the CLI layer (plugins bundling skills and MCP servers, launched 2026-03-26), so an extension-level
plugin API would duplicate it one abstraction too high. Distribution CI is excluded by the
repository's own no-CI-artifacts rule; builds stay local.
```

</details>
