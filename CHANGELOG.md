# Changelog

All notable changes to Codex Terminal are documented here.
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[0.2.0]: https://github.com/SysAdminDoc/codex-terminal/releases/tag/v0.2.0
[0.1.0]: https://github.com/SysAdminDoc/codex-terminal/releases/tag/v0.1.0
