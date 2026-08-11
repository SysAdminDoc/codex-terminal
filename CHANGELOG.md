# Changelog

All notable changes to Codex Terminal are documented here.
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.10.0] - 2026-08-10

### Added

- **How much of your plan is left, on the tab you are looking at.** Codex writes `rate_limits`
  into its session file beside the token counts — 55,975 of the 55,977 usage records in the
  local store carry a populated window — and none of it was read. Each session row now ends
  with `73% weekly limit`, the tooltip adds `· resets in 3d 4h`, and the status bar tooltip
  carries the tightest window across every live session, since they all bill one account. On a
  subscription this is the figure that stops the next turn; the dollar estimate is a list-price
  equivalent nobody is billed. A window Codex does not report — the normal state of the second
  slot on a `pro` plan — shows nothing rather than a zero, and the countdown is kept out of the
  accessible name so a focused row is not re-announced every second.

- **`codexTerminal.applyWorkbenchSettings`.** Whether the extension may set the three
  `terminal.integrated.*` settings a Codex tab needs. *Revert Workbench Settings* now turns it
  off, which is what makes a revert survive the configuration-change event the revert itself
  raises. Turning it back on re-applies from scratch.

### Fixed

- **cmd.exe launches now preserve hostile arguments.** Windows cmd profiles use the verbatim
  shell-argument form and protect spaces, metacharacters and percent expansion, so values such
  as `a b&c;d` reach Codex as one unchanged argument.

- **Archive and Delete now report the CLI result.** A failed Codex lifecycle command no longer
  looks successful or refreshes the History view; failures offer the existing Show Log action,
  while successful operations confirm the session id and refresh once.

- **History refreshes no longer get stuck on the loading row.** A refresh that arrived during
  the first session scan could leave the view showing “Reading Codex sessions…” until another
  unrelated event occurred. The completed scan now asks the tree to render its real contents.

- **History search now respects repository worktree boundaries.** Filtering a project with
  multiple checkouts no longer leaves unmatched sessions reachable beneath the project row.

- **A settings migration that hit a scope the editor refuses lost its marker.** Writing at
  workspace-folder scope on a configuration with no resource throws, and the throw escaped
  before the "already migrated" marker was written — so every activation retried the whole
  migration and threw in the same place, and no other scope ever got its turn. Each scope is
  now attempted independently and a refusal is reported rather than fatal.

- **Reverting `terminal.integrated.tabs.allowAgentCliTitle` wrote a string into a boolean.**
  The override ledger stores every previous value as text, and the revert path wrote it back
  verbatim, so the setting ended up holding `"false"` rather than `false`.

- **The packaged bundle was never the one the checks validated.** `vscode:prepublish` re-ran
  `clean` after `npm run check` had already compiled, linted, tested and bundled, so the
  artefact that shipped was a fresh build of the same source rather than the verified one. It
  now bundles without wiping `dist/`, and the bundle inside the VSIX hashes identically to the
  one `check` produced.

- **Editor context could be typed into somebody else's terminal.** *Send File Reference* and
  *Ask Codex about Selection* fell back to `window.activeTerminal` when no Codex session was
  tracked — so with none running they typed the reference, and for the second command pressed
  Enter, into whatever terminal happened to be focused: a running build, an SSH session, a
  REPL. They now use only a terminal this extension owns, and offer to start one otherwise.
  Ownership itself needed tightening too: it is a substring match on
  `codexTerminal.terminalName`, so a one- or two-character name claimed every terminal in the
  window after a reload. Three characters is now the minimum, in the setting's schema and in
  the matcher.

- **A launch that never matched a session retried forever, silently.** Only successful matches
  were logged, so a launch that never bound looked exactly like one that bound instantly — and
  it kept scanning every two seconds for the life of the window, over a directory range that
  grew by one day per calendar day the window stayed open. Matching now gives up after ten
  minutes and logs where it looked, and the directory walk is bounded regardless of uptime.
  Launching with no workspace folder open also says so: the tab works, but live status, the
  badge, the journal and crash recovery all key off the working directory and none of them
  applies.

- **"No Codex sessions recorded yet" was the answer to three different questions.** A store
  that does not exist, one the process may not read, and one that is genuinely empty all
  produced the same row and logged nothing, so the most common "it does nothing" report could
  not be diagnosed from either the view or the log. Each now says which it is, a permission
  error puts what the filesystem reported into the log, and the first scan shows that it is
  reading rather than leaving the view blank. Activation also logs the sessions directory it
  resolved, and warns when `codexTerminal.env` points `CODEX_HOME` somewhere other than the
  store this window watches — which used to make history, live status and recovery all go
  quietly empty at once.

- **The History view re-walked the whole session store twice a second.** Codex appends to its
  rollout several times a second, and every append reached a debounced refresh that dropped the
  loaded flag — which re-ran the directory scan, a `.git` walk per distinct working directory,
  *and* a second full recursive walk with a `stat` per file to measure the store, for the whole
  length of every turn. Against 2.23 GB across 121 files that is a lot of syscalls for a view
  whose contents cannot change that fast. Resolved repository roots are now reused between
  refreshes and dropped only on an explicit one, the store measurement is rate-limited to once
  a minute, and the per-file preview cache is bounded instead of growing for the life of the
  window. (A comment claiming the measurement ran "only on a real reload" was simply wrong: it
  sat inside the block every refresh reached.)

- **A Spanish editor drew Spanish and spoke English.** Every status label, every "last step"
  description, the tokens/context/plan-window readout and — most importantly — the accessible
  name of a running-session row were inline English literals in `present.ts`, which imports no
  `vscode` and so could not reach `vscode.l10n.t`. Thirty-eight strings are now injected at
  activation, translated in both shipped locales, and asserted by the Spanish integration suite
  running in a real editor. The English defaults live in the module, so a caller that has not
  configured it behaves exactly as before.

- **`journal.storeMessages: false` did not remove what was already stored.** It stopped new
  text being written, but the journal update merges over the previous record, so a message
  already on disk survived every later update and stayed for the full seven-day retention — an
  opt-out that opted out of nothing already done. Turning it off now rewrites every journal in
  the extension's storage, this window's and every other window's, keeping the identifiers and
  timestamps recovery needs and dropping the conversation text.

- **An argument could break out of the command line and run something else.** Values were
  quoted only when they matched a metacharacter set, and that set had no `;`, `$` or backtick —
  so `--model=a;calc`, typed into the profile prompt or arriving through `codexTerminal.args`,
  reached PowerShell's `-Command` as two statements and ran `calc`, while `x$HOME` expanded on
  the way through. PowerShell and POSIX values are now quoted unconditionally: both use
  single-quoted literals, in which nothing but the quote itself is special, so a value that did
  not need quoting is unchanged by having been quoted — and there is no list left to miss a
  character from. Verified by running fifteen hostile arguments through real pwsh, Windows
  PowerShell and bash and comparing what the program received byte-for-byte. cmd.exe keeps
  conditional quoting, because `cmd /C` strips the outermost quote pair under rules that depend
  on how many it sees; its set gains the grouping parentheses it was missing.

- **A hosted app-server could crash the extension host, or outlive its own port.** The spawn
  had no `'error'` listener, and an unlistened `'error'` on a child process is *thrown* — out of
  a callback, past the `try` around the call, and into the extension host as an unhandled
  exception, so an `ENOENT` or `EACCES` took the host with it rather than producing a log line.
  It had no `'exit'` listener either, so a server that died left its handle installed and every
  later launch was handed `--remote` pointing at a closed port, silently. Both are now
  observed: a spawn failure comes back as a rejection, an exit is logged with its code and
  clears the handle so the next launch starts a fresh server, and a deliberate dispose is not
  reported as a failure. The app-server's own Node is resolved from `PATH` for the same reason
  the notify hook's is.

- **An unreadable MCP list wrote API tokens to the log file.** The Plugins and MCP sections
  drop each server's `env` from the UI precisely because it carries tokens — and then the
  failure path wrote 4,000 characters of the CLI's raw output to the extension log. That path
  runs mostly when the CLI *succeeded* and printed a payload of an unexpected shape, which for
  `codex mcp list --json` is every server's environment. Output is now redacted before it is
  logged or shown: `env` blocks, values under secret-shaped keys, bearer tokens and
  provider-prefixed keys. Ordinary diagnostics are untouched, so the log still explains the
  failure, and the byte count is reported alongside.

- **Turn-completion notifications never fired.** The notify hook was registered with
  `process.execPath`, which inside the extension host is the editor's own Electron binary — it
  behaves as a script runtime only while `ELECTRON_RUN_AS_NODE` is set, and the editor deletes
  that variable from the environment a terminal runs in. Codex spawns the notify program from
  there, so it was handing a `.cjs` file to an editor. The hook now runs on a real `node`
  resolved from `PATH`, and when there is none no hook is registered and the log says why. A
  `node.cmd` shim is rejected too: Codex spawns the program directly and `CreateProcess` cannot
  run a batch file. The unit test covering this could not previously fail, because it ran under
  `node --test`, where `process.execPath` genuinely is Node.

- **A home directory containing an apostrophe broke every launch.** The notify hook's path went
  into a TOML literal string, which has no escapes, so `C:\Users\O'Brien\…` threw — including
  from the contributed terminal profile, which has no handler, so the profile itself failed.
  Such paths now use TOML's multi-line literal form.

- **A rollout was read into memory whole.** The tailer allocated the entire unread span as one
  buffer, turned it into one string and split it into one array — and the crash-recovery path
  deliberately starts at byte zero, as does any file that has been replaced rather than appended
  to. The largest rollout on the development machine is 134.3 MB, so that was roughly 400 MB of
  simultaneous allocation for one session, and past V8's maximum string length it does not slow
  down, it throws. Reading is now a fold over 1 MiB chunks that never materialises the lines:
  that same 134.3 MB file folds in 408 ms with 0.1 MB of heap and 1.1 MB of external memory
  retained. A line longer than 64 MiB is dropped, counted and logged rather than held, and
  reading resynchronises at the next newline — an invalid byte now costs one record instead of
  the session.

- **A reverted workbench setting could not be kept.** `terminal.integrated.confirmOnKill` was
  re-planned from its current value on every configuration change — and the operator's own edit
  is what fires that change — so setting it back to `editor` was overwritten within
  milliseconds, including the write *Revert Workbench Settings* had just made. The setting was
  unrestorable for as long as the extension was installed, and it governs close confirmation for
  every terminal in the editor, not only Codex's. Each of the three keys is now written once:
  the override ledger, which already recorded what every key held beforehand, now also decides
  what may be written again, and a key that no longer holds what the extension wrote is left
  alone and logged.

- **The context readout was a constant.** It divided the session's *lifetime* token total by the
  model's context window and clamped the result at 100%, and the lifetime total is unbounded —
  one session on the development machine reached 180,572,005 tokens against a 258,400-token
  window. Folding all 121 local rollouts through the old reducer put 120 of them at exactly
  100%; the number could not distinguish a session with room to spare from one about to
  compact. Occupancy now comes from `last_token_usage.input_tokens`, the size of the prompt
  Codex actually last sent. The same 121 rollouts now report a median of 53.4% and a maximum of
  94.7%, with none clamped. A rollout too old to carry `last_token_usage` reports no percentage
  at all rather than falling back to the total, because the fallback is the defect.

## [0.9.0] - 2026-08-10

### Added

- **Plugins and MCP servers, in the Launch panel.** Two collapsed, read-only sections built on
  `codex plugin list --json` and `codex mcp list --json` — no write commands, and nothing runs
  until a section is opened. A disabled plugin or MCP server says so rather than looking
  installed, an unreadable list states why in the row and logs the whole output, and the cache
  is dropped when `codexTerminal.command` changes so a corrected command takes effect at once.
  Deliberately not built on `app-server`: it answers the same questions but is off by default,
  so the sections would be empty for almost everyone.

- **Spanish.** Both localization surfaces ship — the manifest (`package.nls.es.json`) and every
  runtime string (`l10n/bundle.l10n.es.json`, 172 of them) — and an integration suite runs a
  real editor in Spanish to prove the bundle is actually loaded rather than merely present. Key
  and placeholder parity is asserted in both directions, so an English string added without a
  translation now fails the build instead of silently falling back.

- **Per-session cost estimates**, at prices you supply in `codexTerminal.modelRates` (USD per
  million tokens, prefix-matched so one `gpt-5.6` entry covers every alias). No price list
  ships: Codex records release aliases no public price page carries, and a bundled table would
  go stale without ever looking wrong. An unpriced model shows no cost and names itself in the
  tooltip rather than rendering as `$0.00`. Cache hits are priced as the discount they are —
  the rollout counts them inside the input total, and charging them twice would have turned a
  $41 session into $300. When the session reports a subscription plan the tooltip says the
  tokens were not billed per token at all.

### Fixed

- **Naming a session was unreachable from the UI.** Both context menu entries for
  *Name Codex Session* referenced a command the manifest never declared, so VS Code dropped the
  menu items and logged the reason where nobody was looking. The command was registered and
  working the whole time; only the manifest entry was missing. A manifest test now asserts that
  every command a menu offers is a command the manifest declares.

### Changed

- **A running session no longer re-announces itself to a screen reader on every refresh.** Its
  accessible name had been the same string as the visible row, which carries elapsed time, a
  token total and a context percentage — three values that change constantly. The name now
  carries only the status, whether the session has gone quiet, and the number of completed
  turns, so it is spoken on real transitions instead of once a second. The visible row and the
  tooltip are unchanged.
- The status bar item now says how many sessions are open once none of them are working, so
  the end of the last turn is an audible transition rather than a silent fall back to the
  idle label.

## [0.8.0] - 2026-08-10

### Added

- **Naming a session now tells Codex too**, so `codex resume <name>` finds it from any shell
  and Codex's own `thread-title` tab item can show it. Codex accepts a session name wherever it
  accepts an id, but its CLI cannot set one — 0.147 has no rename subcommand and no flag — so
  the app-server's `thread/name/set` is the only writer. It runs over stdio, needing neither a
  listening socket nor the experimental setting, so it works on every supported editor. The
  local name is stored and shown first; if Codex cannot be reached the name still works here
  and the log says the Codex copy was not written.

  One asymmetry is worth knowing: a Codex thread name can be **replaced but never unset**.
  There is no clear method, an empty name is rejected outright and `null` is refused, so
  clearing a name here clears the local one only. To see names in the tab, add `thread-title`
  to `codexTerminal.titleItems` — it is not a default, because it would lengthen every tab
  including the unnamed ones.
- **Experimental: attach launched terminals to a Codex app-server** — `codexTerminal.appServer.enabled`.
  When on, the window hosts a `codex app-server` and every terminal it launches is handed
  `--remote ws://127.0.0.1:<port>`, so Codex reports its own activity over a supported protocol
  rather than having it inferred from session files.

  The transport was not a free choice. `--listen` offers `stdio://`, `unix://` and `ws://`, and
  a TUI can only attach to a server listening on a *socket*, which rules out stdio; `unix://`
  produced no listener at all on Windows, and `app-server proxy` — the other stdio route — takes
  a Unix socket path too. `ws://127.0.0.1:<port>` is the one transport that works on this
  project's primary platform. Codex binds it to localhost only, the port is chosen per run so
  two windows cannot collide, and readiness is polled on the server's own `/readyz` endpoint
  rather than scraped from a banner whose wording is not a contract.

  Every failure falls back to a plain `codex` launch and logs why: the setting off, no
  WebSocket in the host editor (it became a Node global in 22, and this extension supports
  editors older than that), `codex` not on PATH, or the server failing to come up. The server
  starts on the first launch rather than at activation, so a window that never opens Codex
  never pays for it.

## [0.7.0] - 2026-08-10

### Added

- **Codex Terminal: Check Codex App Server** — a one-shot connection check against
  `codex app-server`, Codex's own control plane. Adopting it would replace three modules that
  currently reverse-engineer session state from rollout files, so the first question is whether
  a machine can talk to it at all; this answers that in one handshake and leaves nothing
  running. Two things about the wire format were established by probing the installed binary
  rather than assumed, and either would break a textbook client: responses carry **no
  `jsonrpc` field**, so a client that validates it discards every message the server sends; and
  `initialize` advertises **no capabilities**, so support has to be probed by calling rather
  than read from the handshake. On Windows the npm `codex` is a `.cmd` shim that Node refuses
  to spawn (BatBadBut, CVE-2024-27980, reported as a bare `EINVAL`), so the client resolves
  past it to the JS entry point.
- **History groups by repository, and names the worktree.** Running several agents against one
  repository with a worktree each is the case worktrees exist for, and grouping by working
  directory scattered exactly those sessions across unrelated-looking projects. Sessions from
  every checkout of a repository now sit under one entry, with a level naming each worktree —
  added only where a repository actually has more than one checkout, since an extra click that
  disambiguates nothing is worse than no extra click. The detection reads `.git` directly (a
  linked worktree's `.git` is a file whose `gitdir:` line names both the parent repository and
  the worktree), so it needs no `git` on PATH and costs one walk per distinct directory rather
  than one per session. Sessions outside any checkout group by directory exactly as before.

### Changed

- `src/extension.ts` is 361 lines instead of 1,376, and now contains only activation wiring.
  Launching, recovery, the status bar, workbench settings, history commands and editor
  commands each moved to a module of their own. The thing that had kept them stuck together
  was seven file-scoped `let`s that any moved function would have lost; those are now one
  typed record, set once during activation. A new integration test asserts that every command
  the manifest contributes is actually registered — a missed registration compiles fine, passes
  every unit test, and fails only when someone clicks the menu entry.

## [0.6.0] - 2026-08-10

### Added

- **Exported transcripts now contain the commands Codex ran and the patches it applied.** The
  renderer could already do this — the switch existed, defaulted to off, and nothing could
  reach it, so every transcript was prose only. Turning it straight on was not the answer
  either: on a real 23.9 MB rollout the full export came to 3.8 MB against 35 KB of prose,
  because an `apply_patch` call embeds the entire new contents of every file it writes. Tool
  blocks now have their own much tighter cap, which brings the default to 345 KB and keeps the
  commands, the files and the searches while dropping the second copy of the source tree.
  Command invocations and their output are separately controlled by
  `codexTerminal.transcript.includeToolCalls` (on) and `…includeToolOutput` (off).
- **Expanding a History session lists the files it changed**, tagged added, edited or
  deleted, each opening the file — the first thing anyone asks of a finished agent session
  and, until now, unanswerable without reading the raw rollout. Codex records every write it
  makes, so this is read back rather than reconstructed. Repeated edits collapse to the net
  effect: a file the session created reads as added however many times it was then touched,
  and a removal is the last word. Deleted files are listed without a link, because a command
  that reliably fails is worse than none. The scan is lazy, streamed and pre-filtered before
  any JSON parsing, since a rollout embeds the full contents of every file it writes — the
  largest here, 128 MB, lists its 48 files in 429 ms. If a cap is hit the list says so rather
  than passing a prefix off as the whole story.
- Reading your conversations can be declined. The crash journal writes Codex's closing message
  for each turn into extension storage — a second copy of conversation text, outside
  `$CODEX_HOME` — and there was no way to say no. `codexTerminal.journal.storeMessages` keeps
  the journal to identifiers and timestamps, which is all recovery actually needs, and
  `codexTerminal.monitor.enabled` stops rollout reading altogether. The second is honest about
  its cost: with it off there is no live status *and* no interrupted-session recovery, because
  both depend on knowing which conversation a tab belongs to. The README now states plainly
  what is read and what is written.
- **Sessions can be named**, from either sidebar, and the name replaces the row's label in
  both. Six agents running against six repositories are told apart by the thing you called
  them, not by a truncated first prompt. The name is the extension's own: Codex accepts a
  session name wherever it accepts an id — `resume`, `archive`, `delete`, `unarchive` all take
  one — but its CLI has no way to *set* one (0.147 has no rename subcommand and no flag), so
  the only writer is `app-server`'s `thread/name/set`, which this extension does not yet
  speak. Resuming still works, because a name resolves to an id before the command is built.
  Codex's own `thread-title` tab item is the one place a name cannot reach.
- **Ask Codex About Selection…** takes your question in an input box and submits it together
  with the `@path#L10-L20` reference. The existing reference-only command is unchanged — it
  stops at the prompt on purpose, which is the better path when the question is easier to type
  in the terminal with Codex's own history and completion.
- Clicking the status bar with several sessions open asks which one to focus, showing each
  session's project, what it last did, how long it has been going and how much context it has
  used, working sessions first. It previously advertised a count and then focused whichever
  session happened to be most recent — a coin flip exactly when several agents are running,
  which is when the button is worth having. With one session it focuses it directly, as before.
- Sessions now report what Codex last did, not just that it is busy. "Working" for eleven
  minutes is indistinguishable from stuck; "Working · ran npm run check" or "Working · edited
  monitor.ts" is a progress report. Codex describes every step it finishes in its session
  file — commands, file edits, web searches, compactions — and the extension had been
  discarding all of it: 16,062 such records across ten recent sessions here, none of them
  read. Shell wrappers are stripped so the row shows the script rather than a repeated
  40-character path to `pwsh.exe`, and multi-file edits collapse to two names and a count.
  The wording stays in the past tense on purpose: Codex records a step only once it has
  finished, so "ran" is true where "running" would be a guess. Unrecognised step types leave
  the previous one in place, so a future Codex release cannot blank the row.

- Reloading the window no longer costs you the live view of the sessions that survived it.
  Reloads are routine — every extension update asks for one — and the tabs came back with the
  spinner stopped, the context gauge empty and no transcript link, for the rest of that
  window's life. Each launch now stamps its journal key into the terminal's own environment,
  which is the one thing a reload preserves, so the new window reads the key back and looks
  the conversation up instead of trying to re-derive a binding from a launch instant that no
  longer exists. A terminal with no stamp, or whose rollout has since been archived or
  deleted, still opens and focuses as before, and the log says which of those it was.

### Changed

- The workbench settings this extension changes are now announced and reversible. Three global
  settings have to be changed for a Codex tab to show its live title, and the extension changed
  them silently, kept no record, and left them that way after uninstall. It now records what
  each held beforehand, says once what it changed, and contributes **Codex Terminal: Revert
  Workbench Settings**, which restores the recorded values exactly. A setting you have since
  changed yourself is left alone — except the tab description, where only the token this
  extension appended is removed, so the rest of your template survives.
- Transcripts open as read-only virtual documents instead of untitled buffers. Every open used
  to create a dirty buffer that asked to be saved on close — a file you never wrote — and the
  same session opened twice produced two unrelated documents. They now open on a
  `codex-transcript:` URI keyed by session id: read-only, re-opening lands on the tab already
  there, and re-reading in place is possible for a session still being written. A truncated
  export says so in a footer at the end of the text rather than in a notification that has
  since disappeared.
- Crash recovery is now offered without being asked for. The extension previously did not run
  until you opened its view or invoked a command, so after the crash this feature exists for,
  the editor reopened and said nothing. It now activates on `onStartupFinished` — the slot
  that fires *after* the workbench has started, not the eager one that delays it — and
  activation is asserted to stay inside a budget rather than merely intended to: measured at
  25 ms against a 2.0 GB session store, budget 250 ms, checked by the integration suite.
  Everything that can wait (workbench preferences, the notification bridge, journal pruning,
  the recovery scan) is started without being awaited.

### Performance

- A bound session now reads its rollout when the file actually changes, instead of being
  stat-ed and read every 600 ms along with every other live session. Cost scales with output
  rather than with the number of agents you have open, which is the direction the rest of this
  release pushes. The interval survives as a backstop — giving up on a silent turn is a
  decision about elapsed time, and no file event will ever announce it — and a rollout that
  cannot be watched (network shares, some filesystems) logs the reason and falls back to
  polling rather than going quietly blind.

### Fixed

- A session interrupted mid-turn no longer spins forever. Codex does not reliably record the
  end of a turn — 52 turn starts against 40 completions across 25 recent sessions here, and no
  abort events at all — so a turn stopped with Ctrl-C left its session claiming to be working
  for the life of the window: tab spinning, badge counting it, status bar calling it busy,
  while the operator sat at an idle prompt. A session that has written nothing for far longer
  than any real turn goes quiet for is now marked **Silent** and stops counting as working.
  Deliberately not *Idle*: Codex writes nothing while awaiting an approval and nothing while
  wedged, so "finished" would swap one confident wrong answer for another. The threshold is
  measured, not picked — the largest gap inside a genuinely working turn was 269 seconds
  across 80,779 samples, so 10 minutes leaves better than a 2× margin. Any new output returns
  the session to working immediately. Applied to the 25 most recent real sessions, this
  correctly demoted 10 abandoned ones and left the 2 genuinely running untouched.
- `terminal.integrated.tabs.allowAgentCliTitle` is written as a boolean. It was being set to
  the *string* `"true"`, which happened to behave correctly while showing up as an invalid
  value in the settings editor.
- The clean-shutdown stamp can no longer be buried by a journal write that was already in
  flight. Refusing to *start* a write after shutdown was not enough: one suspended between its
  temporary file and its rename resumed afterwards and renamed an un-stamped journal over the
  top. The store now seals on the synchronous write, and a write that finishes late puts the
  seal back. Found by the new monitor tests, not in the field.
- Closing a window normally is no longer reported as a crash. The stamp that records a
  deliberate shutdown was written asynchronously from `deactivate`, which the editor does not
  wait for, so it often never landed — and the next window then offered to recover terminals
  that had been closed on purpose. False recovery prompts are worse than none, because they
  teach you to dismiss the prompt that matters. The stamp is now written synchronously, and a
  journal write already queued behind it can no longer overwrite it.

## [0.5.0] - 2026-08-10

### Added

- A History session can be forked from its context menu, starting a new session from that
  conversation in the directory it was written in.
- Releases are now reproducible and checksummed. `npm run package` stamps the archive with the
  commit timestamp, so a given commit builds a byte-identical `.vsix`, and writes
  `dist/SHA256SUMS.txt`; `install.cmd` verifies the hash before installing and refuses on a
  mismatch. This is the integrity check that replaces code signing, which this project does
  not use. The packaged extension also dropped from 15 files to 11 — scripts, test config and
  agent notes no longer ship.
- The History view shows how much disk Codex's session store is using, and sessions can be
  archived or deleted from their context menu. Both delegate to `codex archive` / `codex
  delete` rather than unlinking files, because Codex keeps a state database beside the
  rollouts and removing a file behind its back leaves the two disagreeing.
- The animated indicators honour `workbench.reduceMotion`. With reduced motion the spinner
  becomes a still icon and the wording is unchanged, so no information is lost — only the
  continuous motion a reduced-motion preference exists to suppress.
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

### Performance

- A bound session now reads its rollout when the file actually changes, instead of being
  stat-ed and read every 600 ms along with every other live session. Cost scales with output
  rather than with the number of agents you have open, which is the direction the rest of this
  release pushes. The interval survives as a backstop — giving up on a silent turn is a
  decision about elapsed time, and no file event will ever announce it — and a rollout that
  cannot be watched (network shares, some filesystems) logs the reason and falls back to
  polling rather than going quietly blind.

### Fixed

- A file handle in the rollout tailer is now closed through the read promise rather than a
  mutable binding whose initial value was never read — found by the ESLint upgrade.
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

### Performance

- A bound session now reads its rollout when the file actually changes, instead of being
  stat-ed and read every 600 ms along with every other live session. Cost scales with output
  rather than with the number of agents you have open, which is the direction the rest of this
  release pushes. The interval survives as a backstop — giving up on a silent turn is a
  decision about elapsed time, and no file event will ever announce it — and a rollout that
  cannot be watched (network shares, some filesystems) logs the reason and falls back to
  polling rather than going quietly blind.

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
