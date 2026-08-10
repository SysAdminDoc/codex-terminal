# Codex Terminal

[![Version](https://img.shields.io/badge/version-0.4.0-cba6f7?style=flat-square)](CHANGELOG.md)
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
| Tab identity | Project name plus Codex's live activity title | Usually just `node` or `pwsh` |
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

- **Activity bar** — the `>_` icon opens a **Launch** panel with every action. This is the one
  surface that is always present, so it is the reliable button.
- When Codex tabs are open, the Launch panel also shows a **Running** group with each tab's cwd;
  click a row or use its inline focus/stop actions to manage that session.
- **Status bar** — **✨ Codex**, bottom right. *Invisible if you have
  `"workbench.statusBar.visible": false`* — no extension can render there, and nothing warns
  you. Use the activity bar instead.
- **Editor title bar** — the ✨ button. Needs a focused text editor, so it is absent on an
  empty workspace (`"workbench.startupEditor": "none"`).
- **Terminal `+` dropdown** — pick **Codex**.
- **Terminal tabs** — each launch starts in its resolved working directory and passes Codex a
  native terminal-title configuration. The default title contains the project name and Codex's
  live activity indicator; the activity indicator changes while a turn is running. Open the
  repository as a workspace, or configure `codexTerminal.cwd`, so the working directory is the
  project you want shown. A path pasted only into the chat prompt is not visible to VS Code's
  terminal API and cannot rename an already-created tab.
- **Closing a tab** — the extension enforces `terminal.integrated.confirmOnKill: "never"`, so
  closing a Codex tab immediately terminates its running processes.
- **History** — the **History** view in the Codex Terminal activity-bar container reads Codex's
  local `.jsonl` rollouts, groups them by project, and keeps the first real prompt as a preview.
  **Click a session to resume it** in a terminal, in the directory it was originally written in;
  the inline actions open a readable Markdown transcript or copy its id, and the context menu adds
  the raw rollout. New and changed rollouts refresh the view automatically.
- **Interrupted sessions** — if a window closes without shutting down cleanly, the next window
  offers the Codex sessions it had open under an **Interrupted sessions** group at the top of the
  History view. Restoring one resumes that conversation where it stopped. Sessions that never
  reached a rollout are not offered, because there is nothing to return to.
- **Command Palette** — `Codex Terminal: New Session`, `Resume Last Session`,
  `Resume Session (picker)`, `Fork Last Session`, `Focus Codex Terminal`,
  `New Session with Profile…`, `Send File Reference to Codex`, `Doctor`, `Show Log`.
- **Right-click in the editor** — *Send File Reference to Codex* puts `@src/file.ts#L10-L20`
  on the Codex prompt without submitting it, so you can type the question after it.
- **New Session with Profile…** — lists `~/.codex/<name>.config.toml` profiles, plus a free-text
  entry for profiles that are not stored locally. The selected profile is passed as
  `--profile <name>` and appended to the terminal tab name.
- **Resume Session (picker)** — lists recent local session metadata with timestamp and cwd, then
  launches `codex resume <id>`. If no readable metadata exists, it falls back to Codex's picker.
- **Turn-completion notifications** — enable `codexTerminal.notifyOnCompletion` to install a
  per-launch notify hook in the extension's storage. The setting is opt-in and does not write to
  Codex's user configuration.

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
| `codexTerminal.cwd` | `activeFileWorkspaceFolder` | Also `activeFileFolder`, `firstWorkspaceFolder`, `prompt` (choose in multi-root workspaces). |
| `codexTerminal.env` | `{}` | Extra environment variables. |
| `codexTerminal.terminalName` | `Codex` | Tab label. |
| `codexTerminal.iconColor` | `terminal.ansiMagenta` | Theme color id, or `""` for the default. |
| `codexTerminal.showStatusBarButton` | `true` | The old `showStatusBarItem` key is migrated once per extension version. |
| `codexTerminal.showEditorTitleButton` | `true` | |
| `codexTerminal.notifyOnCompletion` | `false` | Opt in to turn-completion notifications without modifying `~/.codex/config.toml`. |
| `codexTerminal.tabTitle` | `live` | `live` leaves the tab name unset so Codex's own title — including its activity indicator — drives the tab. `static` shows a fixed `project — Codex` label and **cannot animate**; see below. |
| `codexTerminal.titleItems` | `["activity", "project-name", "app-name"]` | Codex title items. The default gives the live activity indicator, the project name, and the constant `Codex` marker used to recognise our tabs after a window reload. |
| `codexTerminal.history.maxSessions` | `200` | Maximum recent sessions shown in the History view. |

### Why `tabTitle: static` cannot animate

Supplying a name to a terminal does more than set a label. VS Code records an extension-supplied
name as the instance's *static title* and, on that path, never subscribes to the title the process
emits — so a named terminal has no live title to show, in either its title or its description.
Codex publishes its activity indicator through exactly that channel. `live` therefore leaves the
name unset and lets Codex own the tab text; `static` trades the animation for a fixed label.

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

## Troubleshooting

The extension supplies the shell, working directory, and Codex arguments; Codex itself still
owns the TUI. If the same symptom appears when you run `codex` in a plain terminal, it is a CLI
issue rather than an extension launch issue. Start with:

```powershell
codex --version
codex
```

- **Raw ANSI escape sequences instead of the TUI** — reported upstream after Codex CLI 0.130.0
  in [openai/codex#23740](https://github.com/openai/codex/issues/23740). Compare the output of
  `codex --version` and `codex` in a plain terminal before changing extension settings.
- **TUI flickers or redraws incorrectly** — tracked upstream in
  [openai/codex#22953](https://github.com/openai/codex/issues/22953). Reproduce with `codex` in
  a plain terminal; identical flicker there is outside this extension.
- **Codex exits back to PowerShell immediately** — tracked upstream in
  [openai/codex#14709](https://github.com/openai/codex/issues/14709). Run `codex --version` and
  then `codex` outside VS Code. This extension keeps the shell open after an exit so the error
  remains readable, but it cannot repair a CLI that exits on its own.
- **No Codex terminal opens** — run `Codex Terminal: Doctor` and inspect the report for the
  resolved command and `--version` output. A missing or misspelled command offers an install link;
  an absolute path in `codexTerminal.command` must point to an existing executable.

## Install

> **Do not double-click the `.vsix`.** It is not an installer — it is an archive the editor
> unpacks. On Windows with Visual Studio installed, `.vsix` is associated with Visual
> Studio's VSIX Installer, which will report *"The install of Codex Terminal was not
> successful for all the selected products. One or more extensions are for Visual Studio
> Code."* That message is the wrong program refusing the file, not a broken package.

**Easiest:** download `install.cmd` next to the `.vsix` and double-click *that*. It finds the
`.vsix` beside it and installs into every VS Code family editor on your `PATH` (VSCodium,
VS Code, Insiders, Cursor).

Command line:

```powershell
codium --install-extension codex-terminal-0.4.0.vsix   # VSCodium
code   --install-extension codex-terminal-0.4.0.vsix   # VS Code
```

Or from inside the editor: **Extensions** view → `...` menu (top of the sidebar) →
**Install from VSIX…** → pick the file.

Either way, reload the window afterwards (**Developer: Reload Window**, or just open a new
window) — a running extension host does not pick up a freshly installed extension. The `>_`
Codex icon then appears in the activity bar.

## Build from source

```powershell
npm install
npm run check     # clean, compile, lint, test, bundle
npm run l10n:export # refresh the default English localization bundle
npm run package   # -> dist/codex-terminal-0.4.0.vsix
```

`npm run check` runs the headless unit suite over shell quoting, command resolution, session
history, and diagnostics. Run
`npm run test:integration` separately to boot the hostile-settings VS Code host suite.

## Unaffiliated

Not affiliated with, endorsed by, or sponsored by OpenAI. "Codex" is used only to name the CLI
this extension launches.

## License

[MIT](LICENSE)
