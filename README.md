# Codex Terminal

[![Version](https://img.shields.io/badge/version-0.8.0-cba6f7?style=flat-square)](CHANGELOG.md)
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
- **Workbench settings it changes** — three global settings are required for a Codex tab to show
  its live title (`terminal.integrated.confirmOnKill`, `terminal.integrated.tabs.description`,
  `terminal.integrated.tabs.allowAgentCliTitle`). The extension says once what it changed and
  records what each held beforehand; **Codex Terminal: Revert Workbench Settings** puts them
  back. A setting you have since changed yourself is left alone.
- **History** — the **History** view in the Codex Terminal activity-bar container reads Codex's
  local `.jsonl` rollouts, groups them by **repository** — every git worktree of a repository
  sits under one entry, with a level naming each worktree when there is more than one — and keeps the first real prompt as a preview.
  **Click a session to resume it** in a terminal, in the directory it was originally written in;
  the inline actions open a readable Markdown transcript or copy its id, and the context menu adds
  resume, fork, the raw rollout, and archive/delete. New and changed rollouts refresh the view
  automatically. A row at the top reports how much disk Codex's session store is using — it grows
  without bound, and archive/delete hand the work to `codex archive` / `codex delete` so Codex's
  own state database stays in step. **Expand a session** to list the files it changed — added,
  edited or deleted — read back from the rollout; click one to open it. Deleted files are shown
  without a link. The scan runs when you expand the row, not during the listing.
- **Naming a session** — *Name Session…* on a row in either sidebar. The name replaces that
  row's label everywhere the extension draws it. It is stored by this extension, not by Codex:
  the name is stored here and also written to Codex through the app server's `thread/name/set`,
  which is the only writer — the CLI has no rename command — so `codex resume <name>` finds it
  from any shell. Add `thread-title` to `codexTerminal.titleItems` to show it in the tab. A
  Codex thread name can be replaced but never unset, so clearing a name here clears only the
  local one.
- **Interrupted sessions** — if a window closes without shutting down cleanly, the next window
  offers the Codex sessions it had open under an **Interrupted sessions** group at the top of the
  History view. Restoring one resumes that conversation where it stopped. Sessions that never
  reached a rollout are not offered, because there is nothing to return to.
- **Command Palette** — `Codex Terminal: New Session`, `Resume Last Session`,
  `Resume Session (picker)`, `Fork Last Session`, `Focus Codex Terminal`,
  `New Session with Profile…`, `Send File Reference to Codex`, `Ask Codex About Selection…`,
  `Revert Workbench Settings`, `Check Codex App Server`, `Doctor`, `Show Log`.
- **Right-click in the editor** — *Send File Reference to Codex* puts `@src/file.ts#L10-L20`
  on the Codex prompt without submitting it, so you can type the question after it.
  *Ask Codex About Selection…* takes the question in an input box and submits reference and
  question together, for when you already know what you want to ask.
- **New Session with Profile…** — lists `~/.codex/<name>.config.toml` profiles, plus a free-text
  entry for profiles that are not stored locally. The selected profile is passed as
  `--profile <name>` and appended to the terminal tab name.
- **Resume Session (picker)** — lists recent local session metadata with timestamp and cwd, then
  launches `codex resume <id>`. If no readable metadata exists, it falls back to Codex's picker.
- **Turn-completion notifications** — enable `codexTerminal.notifyOnCompletion` to install a
  per-launch notify hook in the extension's storage. The setting is opt-in and does not write to
  Codex's user configuration.

## What it reads and writes

Everything stays on your machine; the extension makes no network requests and collects no
telemetry. It **reads** Codex's own session files under `$CODEX_HOME/sessions` to show live
activity, list history and export transcripts. It **writes** a small crash-recovery journal
into its own extension storage — which sessions a window had open, their ids and timestamps,
and by default Codex's closing message for each turn so an interrupted session is recognisable.
Both are switchable: see `codexTerminal.monitor.enabled` and
`codexTerminal.journal.storeMessages`. It also changes three workbench settings, which it
announces and can revert.

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
| `codexTerminal.showContextInStatusBar` | `true` | Append the highest context usage across live sessions to the status bar — the session nearest its limit is the one about to compact. |
| `codexTerminal.stallSeconds` | `45` | Seconds of silence after which a working session is reported as producing no output. Codex writes nothing both while awaiting an approval and while stuck, and the two are indistinguishable from its session file. |
| `codexTerminal.notifyOnCompletion` | `false` | Opt in to turn-completion notifications without modifying `~/.codex/config.toml`. |
| `codexTerminal.tabTitle` | `live` | `live` leaves the tab name unset so Codex's own title — including its activity indicator — drives the tab. `static` shows a fixed `project — Codex` label and **cannot animate**; see below. |
| `codexTerminal.titleItems` | `["activity", "project-name", "app-name"]` | Codex title items. The default gives the live activity indicator, the project name, and the constant `Codex` marker used to recognise our tabs after a window reload. |
| `codexTerminal.history.maxSessions` | `200` | Maximum recent sessions shown in the History view. |
| `codexTerminal.appServer.enabled` | `false` | **Experimental.** Host a `codex app-server` for this window and attach launched terminals to it with `--remote ws://127.0.0.1:<port>`, so Codex reports activity over its own protocol instead of it being inferred from session files. Needs an editor built on Node 22 or newer; every failure falls back to a plain `codex` launch and logs why. |
| `codexTerminal.monitor.enabled` | `true` | Read Codex's session files for live activity and crash recovery. Off stops all reading of your conversations — and with it both the live status and interrupted-session recovery, since each needs to know which conversation a tab belongs to. Launching, resuming and history are unaffected. |
| `codexTerminal.journal.storeMessages` | `true` | Keep Codex's closing message per turn in the crash journal. Off keeps conversation text out of it; identifiers and timestamps, which is all recovery needs, are still recorded. |
| `codexTerminal.transcript.includeToolCalls` | `true` | Include the commands Codex ran and the patches it applied in an exported transcript. Each block is capped: an `apply_patch` call carries the entire new contents of every file it writes. |
| `codexTerminal.transcript.includeToolOutput` | `false` | Also include what those commands printed back. Off by default — tool output is the bulk of a session and is rarely what you came back to read. |

### Where the activity indicator actually appears

While Codex is working you get a spinner in the **Launch panel**, a count on the **activity-bar
badge**, and a spinner in the **status bar** — plus Codex's own live indicator in the **tab
title** under `tabTitle: live`.

The one place it cannot appear is the tab's **icon**. No stable VS Code API changes a terminal
icon after the terminal is created, and the command that changes it takes no icon argument, so
it can only open a picker. Animation is therefore in the tab's *text* and in the sidebar, not
on the icon. If you set `workbench.reduceMotion`, every spinner becomes a still icon and the
wording carries the state instead.

Each running session also says what Codex last finished doing — `Working · ran npm run check`,
`Working · edited monitor.ts`, `Working · searched vscode terminal api`. The wording is past
tense because Codex records a step only once it completes; there is no "started" event to read.

### The `Silent` state

Codex does not always record the end of a turn — across 25 recent sessions on the machine this
was measured on there were 52 turn starts against 40 completions, and no abort events at all. A
turn interrupted with Ctrl-C therefore leaves its session claiming to be working forever, which
is the one thing a status indicator must not do.

A session that has written nothing for far longer than any real turn goes quiet for is marked
**Silent**: it stops spinning, stops counting toward the badge, and reports how long it has been
quiet. It is deliberately not called *Idle* — Codex writes nothing while waiting for an approval
and nothing while wedged, so "finished" would be a guess. The threshold is 10 minutes, or twice
`codexTerminal.stallSeconds` if you have raised it; the largest gap measured *inside* a genuinely
working turn was 269 seconds across 80,779 samples. Any new output puts the session straight back
to working.

### What a screen reader hears

A spinner that helps a sighted operator is a text label that changes several times a minute, and
a label that changes is a label that gets read out. Two things keep that from turning into noise:

- **The status bar does not announce itself.** VS Code builds a status bar entry as a plain
  `<a role="button">` with no `aria-live` region anywhere around it, and re-applies its
  `aria-label` only when the string actually differs. Nothing there is announced unless you focus
  the status bar (*Focus Status Bar*), so the spinner is silent by construction.
- **Nothing that merely ticks is part of an accessible name.** A tree row *is* re-read when its
  name changes while it has focus, so the accessible name of a running session carries only the
  status, whether it has gone quiet, and how many turns have finished. Elapsed time, token totals
  and context percentage stay in the visible row and the tooltip, where a number that moves every
  second belongs. In practice a session announces itself when it starts working, when it goes
  quiet, and when a turn ends — not once per refresh.

The status bar item announces the transition that matters most, too: finishing the last turn
changes it from *working in N sessions* to *N sessions open, none working*, rather than falling
back to the same label it uses when nothing is running at all.

Measured on Windows with VSCodium 1.126 running under `--force-renderer-accessibility` (the mode
that puts the editor into *Screen Reader Optimized*), reading the UI Automation tree directly: the
entry's accessible name is the extension's own label, not its ticking text, and the platform
exposes no live-region setting on it.

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
codium --install-extension codex-terminal-0.8.0.vsix   # VSCodium
code   --install-extension codex-terminal-0.8.0.vsix   # VS Code
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
npm run package   # -> dist/codex-terminal-0.8.0.vsix
```

`npm run check` runs the headless unit suite over shell quoting, command resolution, session
history, and diagnostics. Run
`npm run test:integration` separately to boot the hostile-settings VS Code host suite.

## Verifying the download

Releases are unsigned — this project does not use code signing — so the check is a
reproducible build instead. `npm run package` stamps the archive with the commit's timestamp
via `SOURCE_DATE_EPOCH`, which makes the `.vsix` byte-identical for a given commit, and writes
`dist/SHA256SUMS.txt`.

To confirm a downloaded `.vsix` is what this repository builds:

```powershell
git checkout v0.8.0
npm ci
npm run package
Get-FileHash -Algorithm SHA256 dist\codex-terminal-0.8.0.vsix
```

The hash must match `SHA256SUMS.txt` on the release. A mismatch means the file you downloaded
is not the file this source produces.

## Unaffiliated

Not affiliated with, endorsed by, or sponsored by OpenAI. "Codex" is used only to name the CLI
this extension launches.

## License

[MIT](LICENSE)
