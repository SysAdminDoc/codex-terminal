# Changelog

All notable changes to Codex Terminal are documented here.
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/SysAdminDoc/codex-terminal/releases/tag/v0.1.0
