# Codex Terminal

[![Version](https://img.shields.io/badge/version-0.1.0-cba6f7?style=flat-square)](CHANGELOG.md)
[![License](https://img.shields.io/badge/license-MIT-89b4fa?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-a6e3a1?style=flat-square)](#requirements)
[![Editors](https://img.shields.io/badge/editors-VS%20Code%20%7C%20VSCodium-f9e2af?style=flat-square)](#requirements)

One click opens [Codex CLI](https://github.com/openai/codex) in a real terminal tab, in the
shell you chose, in the right directory.

The official Codex extension's toolbar button opens a webview — it has no command that opens
the CLI in a terminal at all. The community launchers that do all call `Terminal.sendText()`
against whatever your default profile happens to be, so they type `codex` into a prompt that
may still be initialising, and they open Git Bash if that is your default. This extension
pins the shell and hands Codex to it as an argument instead.

## What it does differently

| | Codex Terminal | Other launchers |
|---|---|---|
| Shell | Pinned per setting — `pwsh` by default on Windows | Whatever your default profile is |
| Launch | `pwsh -NoLogo -NoExit -Command codex` | `createTerminal()` then `sendText('codex')` |
| Race with shell startup | Impossible — the shell never sees a keystroke | Possible; the command can interleave with a slow profile banner |
| Shell history | Clean | `codex` is left in it |
| Terminal `+` dropdown | Contributes a native **Codex** profile | — |
| Session control | New / Resume last / Resume picker / Fork last | New only |
| Codex exits | `-NoExit` leaves a live prompt so you can read the error | Tab disappears |

## Screenshots

Codex launched into an editor-area tab. Nothing was typed at the prompt — `codex` was the
shell's own argument, and `-NoExit` left a live prompt behind it:

![Codex in an editor tab](https://raw.githubusercontent.com/SysAdminDoc/codex-terminal/main/docs/screenshots/codex-terminal-editor-tab.png)

The real Codex TUI, started in the workspace folder:

![Codex CLI running](https://raw.githubusercontent.com/SysAdminDoc/codex-terminal/main/docs/screenshots/codex-cli-running.png)

**Codex** in the terminal profile dropdown, next to the shells VS Code detected itself:

![Codex in the terminal profile dropdown](https://raw.githubusercontent.com/SysAdminDoc/codex-terminal/main/docs/screenshots/terminal-profile-dropdown.png)

## Usage

- **Status bar** — click **✨ Codex** (bottom right).
- **Editor title bar** — the ✨ button.
- **Terminal `+` dropdown** — pick **Codex**.
- **Command Palette** — `Codex Terminal: New Session`, `Resume Last Session`,
  `Resume Session (picker)`, `Fork Last Session`, `Focus Codex Terminal`,
  `Send File Reference to Codex`, `Show Log`.
- **Right-click in the editor** — *Send File Reference to Codex* puts `@src/file.ts#L10-L20`
  on the Codex prompt without submitting it, so you can type the question after it.

## Settings

| Setting | Default | Notes |
|---|---|---|
| `codexTerminal.shell` | `auto` | `auto`, `pwsh`, `powershell`, `cmd`, `bash`, `zsh`, `custom`, `editorDefault`. `auto` = PowerShell 7 if installed, else Windows PowerShell; the login shell elsewhere. |
| `codexTerminal.customShellPath` | `""` | Used only when `shell` is `custom`. |
| `codexTerminal.command` | `codex` | Bare name or absolute path. Spaces are quoted for you. |
| `codexTerminal.args` | `[]` | Appended to every launch, e.g. `["--model","gpt-5.1-codex"]`. |
| `codexTerminal.keepShellOpen` | `true` | Adds `-NoExit` / `/K` / `exec $SHELL -i`. |
| `codexTerminal.location` | `editor` | `editor`, `editorBeside`, `panel`. |
| `codexTerminal.reuseTerminal` | `false` | `true` focuses the existing Codex tab instead of opening a new one. |
| `codexTerminal.cwd` | `activeFileWorkspaceFolder` | Also `activeFileFolder`, `firstWorkspaceFolder`. |
| `codexTerminal.env` | `{}` | Extra environment variables. |
| `codexTerminal.terminalName` | `Codex` | Tab label. |
| `codexTerminal.iconColor` | `terminal.ansiMagenta` | Theme color id, or `""` for the default. |
| `codexTerminal.showStatusBarItem` | `true` | |
| `codexTerminal.showEditorTitleButton` | `true` | |

### `editorDefault` is the one racy mode

Every mode except `editorDefault` passes Codex as a shell argument. `editorDefault` has no
shell of its own to hand arguments to, so it falls back to typing the command — the behaviour
every other launcher has all the time. It exists for people who have a heavily customised
default profile they want honoured; prefer any other mode.

## Requirements

- VS Code or VSCodium `1.90.0` or newer.
- Codex CLI on `PATH` (`npm install -g @openai/codex`), or an absolute path in
  `codexTerminal.command`. Verify with `codex --version`.
- Codex authentication is interactive: run `codex login` once in a terminal.

## Install

> **Do not double-click the `.vsix`.** It is not an installer — it is an archive the editor
> unpacks. On Windows with Visual Studio installed, `.vsix` is associated with Visual
> Studio's VSIX Installer, which will report *"The install of Codex Terminal was not
> successful for all the selected products. One or more extensions are for Visual Studio
> Code."* That message is the wrong program refusing the file, not a broken package.

Command line:

```powershell
codium --install-extension codex-terminal-0.1.0.vsix   # VSCodium
code   --install-extension codex-terminal-0.1.0.vsix   # VS Code
```

Or from inside the editor: **Extensions** view → `...` menu (top of the sidebar) →
**Install from VSIX…** → pick the file.

Either way, reload the window afterwards (**Developer: Reload Window**) and the ✨ Codex
button appears in the status bar.

## Build from source

```powershell
npm install
npm run check     # clean, compile, lint, test, bundle
npm run package   # -> dist/codex-terminal-0.1.0.vsix
```

`npm run check` runs 21 unit tests over the shell-quoting rules — the part that is easy to get
wrong and impossible to eyeball on Windows.

## Unaffiliated

Not affiliated with, endorsed by, or sponsored by OpenAI. "Codex" is used only to name the CLI
this extension launches.

## License

[MIT](LICENSE)
