# quest-log — design notes

**For whoever changes this code, including a future Claude session.** If you
only want to use `/quests`, see [README.md](./README.md).

As with `/todo`'s DESIGN.md, this records what the code can't say: which choices
look wrong but aren't, and what has to be verified before it's trusted. Change a
documented decision, update its section in the same commit.

## The problem is the inverse of /todo's

`/todo` is written by the user, and its hard problem is capturing a thought
without interrupting anyone. quest-log is written by **Claude**, and its hard
problem is getting Claude to write it reliably, as work happens, for very few
tokens. Almost every decision below serves that.

## What goes where

| Quest-log idea | Field | Written by |
| :--- | :--- | :--- |
| Quest giver | `asks`: the user's prompt, verbatim, with its turn | `UserPromptSubmit` hook |
| Why it matters | `why` | Claude, on `accept` |
| Reward | `reward`: what "done" means | Claude, on `accept` |
| Objectives | `objectives[]`, `open / done / failed / parked` | Claude, `objective` / `check` / `fail` |
| Choices and consequences | `journal[]`, and redirects via `link` | Claude |
| Blocked on the user | `status: awaiting` + `awaiting` | Claude, `await` |
| Main story / side content | `kind: main / side` | Claude, defaulted |
| Rumors | `rumors[]` | Claude, `rumor` |
| Loot | `loot[]`: paths, shas, URLs | Claude, `turn-in` |

**Asks come from a hook, not from Claude.** The quest giver's words must be the
user's own. If Claude summarised them, the one field meant to check Claude's
reading of the request would be written by Claude. The hook numbers every
prompt and tells Claude its number (`ask #N`), so linking costs a flag, not a
paraphrase.

**Only the user's words are asks.** Claude Code also starts turns itself: a
subagent handing back its report, a background task finishing. Those arrive
through `UserPromptSubmit` like a prompt, and the first 0.2.0 working session
logged a subagent's report as ask #2 and its task notification as #3. The hook
now skips prompts that open with `<task-notification>`, `<agent-message` or
`[SYSTEM NOTIFICATION`, and they don't advance the turn either.

**New orders reopen a finished quest.** `link` or `objective` on a quest that's
already turned in (or abandoned, or parked) puts it back to active, tracks it,
and journals "Reopened". Found in the first end-to-end run: the user followed a
finished task with "actually, change X". Claude correctly linked the ask to the
old quest, but the objectives went onto a closed quest, the second `turn-in`
was refused, and the log went on showing the first outcome.

**A redirect appends, it doesn't rewrite.** "Actually, do Y" is `link <q> <ask>
"what changed"`. The quest keeps every ask in order and the journal says what
changed. That record is the story part of a quest log, and it is also the most
useful thing when the user asks "why did you do it this way?"

**Rumors are only what Claude did *not* act on.** In auto mode Claude often just
does the thing it noticed. At that point it's work, and it belongs in the log
as an objective or a side quest (`accept --from-rumor r1` if it started as a
rumor). A rumor list full of things already done would be a false record of
what's outstanding.

A question only the user can answer is never a rumor either. In the first e2e
run Claude logged "decide whether multiply() with no args should return 1 or
raise" as one, which files the question where the user won't look. The
protocol now says so: ask it, and `await` if the quest can't go on without it.

**Tracking falls back to an awaiting quest.** When the tracked quest closes,
`retrack` picks the newest open main, else side, among *active* quests first,
then awaiting ones. An awaiting quest is still where the work resumes once the
user answers, and leaving tracking empty dropped it from the per-prompt brief
and the status line. Its status is left alone; only the user's answer (or a
`check`, `link` or `track`) lifts the wait.

## Flavor lives in the renderer only

The store is plain data. `style: rpg | plain` switches the vocabulary and glyphs
in `/quests` and the toasts, and nothing else. Claude never writes flavor text:
it would cost tokens on every call and blur facts the user relies on.

In `rpg` style `/quests` is laid out like a game's quest log: a 76-column
frame (it fits an 80-column terminal), sections for awaiting you, active,
rumors and completed, and a progress bar right-aligned on each quest's row.
Found in a real session with ten quests, where the flat layout listed every
awaiting quest twice, expanded every quest, and repeated one ask's quote on
five quests created from the same prompt. So now: a question waiting on the
user is shown once, as a quote under its quest; only the tracked quest is
expanded; the quoted ask lives in the full entry, not the log; and completed
quests show the latest three with their outcomes, the rest counted
(`/quests done` lists them all). Alignment counts wide characters as two
columns (`cells`); a terminal that draws an emoji at the wrong width will
shift that row's bar, nothing worse. `plain` keeps the flat layout.

The flavor still costs something, because Claude relays the rendered log into
the conversation. So while `style` is at its default, the log's footer carries a
one-line tip that `plain` saves tokens. It disappears once the user sets `style`
either way, since at that point they've made the choice.

The text re-injected for Claude after a compaction (`render_for_claude`) is
always plain and id-dense. It is for Claude, not the user.

## Keeping the log current: brief, then nudge

Three mechanisms, weakest to strongest:

1. **The protocol is injected at `SessionStart`**, not left to a model-invoked
   skill. A skill loads only when Claude decides it's relevant, which is exactly
   the judgment that fails when Claude is heads-down. `SessionStart` also fires
   on `compact` and `resume`, which re-injects the protocol *and* the open
   quests, so neither is lost with the transcript.
2. **Every prompt gets a one-line brief** (`UserPromptSubmit`): the ask id, the
   tracked quest and its next objective, and anything awaiting the user. It's
   about 30 tokens, and the ask id has to arrive anyway.
3. **The nudge.** A `PostToolUse` hook on file edits records every file touched
   since the last CLI write. On the next prompt, if the list isn't empty, Claude
   is told which files it edited without updating the log, and whether the last
   ask was never linked to a quest. Then the list is cleared.

The nudge is meant to *inform* Claude, not nag it. It says what changed and lets
Claude decide whether that was progress. It's shown **once**, and any CLI write
clears it, so a Claude that's keeping the log never sees one. Plain Q&A turns
edit nothing, so they never trigger it. That's why chat doesn't need an explicit
"this wasn't a quest" call.

`reminders: strict` swaps the next-prompt nudge for a `Stop` hook
`decision: block`: Claude can't end the turn until it logs the edits or runs
`ack`. `stop_hook_active` guards it, so it blocks at most once per turn and can't
loop.

Edits are the main signal because they are the one kind of work that's cheap
to see from a hook. Of Bash-driven work, only `git commit` counts: a commit is
a milestone, while test runs and the like are mostly verification. The hook
matches `Bash` but returns before touching the store unless the command
contains a `git … commit` (and isn't a `quest` call). `echo git commit` would
count too; not worth a shell parser.

## Toasts: the log talks to the user for free

Each CLI write queues a toast: its styled line, plus what happened to which
quest. The `Stop` hook flushes the queue as `systemMessage`, which the terminal
prints verbatim and the model never sees. See `/todo`'s DESIGN.md, "Two hook
output channels".

By default (`toasts: summary`) the queue is folded into one line, in the order
things happened:
`📜 #1 updated · ➕2 · ✔2 · 🏆 #1 complete · ✨ #2 created "Add size…" · ⏸ #2 awaiting you · 👂 1 rumor`.
Runs of the same kind on the same quest become a count, and a count names its
quest only when the quest changes. A quest is `updated` at most once and never
on the turn it was `created`. Rumors and handoffs are totalled at the end. The
summary is always emoji, whatever `style` says: the icons are what make one
line readable at a glance. `full` keeps the old one line per change, and `on`,
0.1.0's value, reads as `summary`.

Found in the interactive trial. One busy turn printed seven lines, and the
user preferred the summary.

Verified for `Stop` too: a headless `claude -p --output-format stream-json`
run emits each line as an `informational` event prefixed `Stop says:`, which is
what the terminal prints.

## The `quest` command, and permissions

Claude calls the CLI throughout the session, outside any skill, so the skill's
`allowed-tools` doesn't cover it (that grant ends with the turn the skill ran
in), and in the default permission mode every log write prompted. Plugins can't
contribute permission rules, and the script's path changes with every update,
so no path-based rule survives.

What does survive: a plugin's `bin/` is on the Bash tool's `PATH` while the
plugin is enabled (verified headless: `command -v quest` resolves to
`quest-log/bin/quest`). So `bin/quest` is a two-line wrapper around
`quest.py`, the protocol tells Claude to call `quest <verb>`, and the README
offers one stable rule, `Bash(quest *)`, as the alternative to auto mode. The
protocol still names the full path as a fallback, for hosts that don't install
a plugin's `bin/`.

Hooks keep calling `quest.py` through `${CLAUDE_PLUGIN_ROOT}`; they don't need
the PATH and don't go through permissions.

## Release notes

Copied from `/todo`: `UPGRADE_NOTES` maps a version to a few lines, printed once
as a `SessionStart` `systemMessage` the first session after an update, and
`last_seen_version` in `config.json` records what was seen. A fresh install
gets nothing. 0.1.0 didn't record a version, so an upgrade from it is told apart
from a new install by an existing store. A note that's skipped (reminders
`off`) is still recorded, so it can't come back later.

## Continue your journey

At `SessionStart` on `startup` or `clear`, Claude is told about open quests from
other sessions of this checkout in the last 7 days, as a passive line to
mention if relevant. `/quests adopt` looks wider, at the repo's worktrees too
(same rule as `/todo`), numbers them, and `adopt <n|all>` moves one here:
closed in its source as `adopted`, reopened here with a new id and tracked. Ask
ids are per session, so the source's asks come along as `inherited_asks`, with
their words and turn, and the journal says where the quest came from.

## Status line

`quest.py statusline` prints the tracked quest, its progress and next
objective, and how many quests await the user, or nothing. It reads the session
and directory from the status-line JSON, since that command runs outside the
session's environment. Plugins can only ship `agent` and `subagentStatusLine`
in their `settings.json`, so `/quests statusline` writes it into the user's
own `settings.json` when they ask (the command is the consent; nothing is
installed on its own). The command it writes picks the newest version under
the plugin cache (`ls -d …/quest-log/*/ | sort -V | tail -1`), so it survives
updates; from a checkout it points at the checkout. An existing status line is
kept: both get the same stdin and their output is joined with ` · `, and the
original entry is saved in quest-log's `config.json` as `replaced_statusline`
so `off` restores it exactly. Every command it writes ends in
`# quest-log statusline`, which is how it recognises its own. The tests run
each generated command through `sh`, including one that installs from three
cached versions and checks the newest one answers.

## Live view

`/quests` can only be read between turns, and `/btw` can't run it: it answers
from the conversation, with no tools, so it would give Claude's recollection
rather than the log. `quest.py watch` is the live view instead. It's read-only,
polls the store twice a second, and redraws when the file changes. Given
`--session` it follows that session; without, it follows whichever session in
the project wrote last.

`/quests live` launches it beside Claude from the skill's expansion, which runs
in Claude Code's own environment, so the terminal's variables are visible. It
tries, in order: `tmux split-window` ($TMUX), an iTerm2 split via AppleScript
($TERM_PROGRAM), `wezterm cli split-pane`, `kitty @ launch` (needs remote
control), and on macOS a new Terminal.app window. A launcher that fails falls
through to the next. JetBrains and VS Code terminals can't be split from a
command, which is why the Terminal window is the macOS fallback, and the
command is always printed for a split the user opens by hand.

The tests fake `tmux` and `osascript` on PATH. The Terminal.app script compiles
with `osacompile`. The iTerm2 script follows iTerm's documented scripting form
but hasn't run against iTerm2, which wasn't installed.

## Chronicle

`/quests chronicle` renders the session as markdown: each quest with the user's
asks quoted, why, what done means, the objectives as a checklist, the journal
as decisions, outcome and loot, then any rumors. It's always plain: it leaves
the terminal, for a PR description or a handoff, and the rpg vocabulary would
only get in the way of whoever reads it next. SKILL.md has Claude relay it as
rendered markdown rather than in a code block.

## Gold, XP and the shop

A purse in `wallet.json`, beside `config.json` in the store root, so it
belongs to the Claude profile (`CLAUDE_CONFIG_DIR`) rather than a session or a
repo. An objective pays 1 gold and 10 xp the first time it's checked, a quest
2 gold and 20 xp the first time it's turned in; each is marked `paid` so
re-checking, reopening and turning in again, or adopting into another session
can't pay twice. Failed objectives and abandoned quests pay nothing. Crossing
a rank is a toast like any other log change.

Gold is spent; XP isn't, so buying never costs a rank. A purse from before XP
existed is credited 10 xp per gold, since nothing had been spent from it yet.

Claude decides what an objective is, so Claude controls how much comes in.
That's why everything for sale is cosmetic: splitting work into more
objectives buys a nicer frame, never a change in how Claude works or what it
spends. The shop commands are the user's alone and SKILL.md says so.

Items are bought once into `owned`, and `equipped` holds one per slot (frame,
bar, trophy, banner). The price-0 items are what everyone starts with and
what unequipping returns to. The renderer reads the look through `look()`,
so a skin reaches the log, the live view and the toasts the same way. The
purse is cached on its mtime so the live view picks up a purchase without a
restart. Plaques are the one thing bought more than once: each is a copy of a
turned-in quest (title, outcome, repo, date), since its session file may be
long gone when the hall is next opened. Skins apply to the rpg style only;
`style plain` stays plain.

## /todo handoff

Anything in the log can go to `/todo` (`to-todo 3`, `3.2`, `r1`), but only when
the user asks or agrees. `todo_handoff: auto` widens that to rumors, copied as
they're noted. That is the one case where a copy can't lose information the
user wanted to decide on.

The script writes `todo.py`'s store directly, using its documented schema,
because plugins can't call one another. That couples quest-log to the
claude-todo store format. Both live in this repo, so a schema change there
must update `cmd_to_todo` in the same commit. Handed-off todos carry
`"source": "quest-log"`, which todo.py ignores.

Two checks keep that honest. At runtime, `cmd_to_todo` refuses to write into a
store that lacks the keys it relies on, and says claude-todo has probably
changed its schema. In `tests/`, a test loads `todo.py` itself, creates a todo
the native way, and fails if todo.py's items have fields quest-log doesn't
write, or if todo.py can't list what quest-log wrote.

The way back is `accept --from-todo <n>`, which the protocol asks for when
Claude starts a /todo item. It records `from_todo` and journals where the item
came from. If this log handed it off in the first place (a rumor, objective or
quest whose `todo` is that id), the journal traces the whole chain, e.g.
"Began as rumor r1 (turn 4), then /todo #1." Found in a trial where
`/todo next` turned a handed-off rumor into quest #3, and only its "why" text
said where it came from.

A handed-off quest becomes `parked` and a handed-off objective stops counting
toward progress. The log shows where each one went (`→ /todo #4`), so nothing
seems to have been silently dropped.

## Inherited from /todo, for the same reasons

- **Store path** `$CLAUDE_CONFIG_DIR/quests/<slug of git toplevel>/<session>.json`,
  ignoring `CLAUDE_PROJECT_DIR`, since hooks and Claude's Bash calls see different
  environments.
- **A script owns the store**, and writes go through `os.replace`.
- **Hooks swallow every exception and exit 0.**
- **Not in the repo, not in `CLAUDE_PLUGIN_DATA`.**
- **`/quests` renders in the expansion phase**, so reading the log costs no tool
  calls, only the tokens to relay it.

## Not TodoWrite, and not memory

TodoWrite is Claude's scratch plan for the task in hand, rewritten as the plan
changes, and shown to the user only as the current checklist. The quest log is
the session-wide record: every ask, why, decisions, what's waiting on the user,
what was produced. They overlap only at objectives.

## CLI

```
quest.py accept --title T [--kind main|side] --ask N [--why W] [--reward R]
                [--objective O]... [--from-rumor rN] [--from-todo N]
quest.py objective <q> "<text>"
quest.py check <q>.<n> [...]          # also: fail <q>.<n>
quest.py journal <q> "<decision>"
quest.py link <q> <ask> ["what changed"]
quest.py await <q> "<question for the user>"
quest.py track <q>
quest.py turn-in <q> [--outcome O] [--loot L]...
quest.py abandon <q> [--reason R]
quest.py rumor "<text>" [--quest q]
quest.py to-todo <q | q.n | rN>
quest.py ack                          # "nothing to log"; clears the nudge
quest.py show [q]                     # plain log for Claude, or one entry
quest.py dispatch --stdin             # /quests, incl. adopt and chronicle
quest.py statusline                   # status-line JSON on stdin
quest.py watch [--session S] [--once] # live, read-only view of the log
quest.py hook-{session-start,prompt,post-tool,stop}
quest <verb> ...                      # bin/ wrapper, on Claude's Bash PATH

## Tests

`python3 quest-log/tests/test_quest.py`: stdlib `unittest`, driving the script
as Claude Code does (subprocesses, hook payloads on stdin) against a scratch
git repo and a scratch `CLAUDE_QUESTS_DIR`. Passes on Python 3.6.15 (a
conda-forge osx-64 build under Rosetta) as well as current Python.
```

## Checked in a real terminal

An interactive trial (stack module, a redirect, a question for the user, a
rumor handed to /todo and picked back up) confirmed: `/quests` and
`/quests chronicle` render as intended, and the per-prompt brief never shows
in the terminal. It also led to the summary toast, to finished quests showing
their outcome and later asks, and to `--from-todo`.

Verified end to end with `claude -p --plugin-dir quest-log` on a scratch repo:
the protocol arrives at `SessionStart` and `resume`, asks are recorded verbatim,
Claude accepts, checks, journals, links, notes rumors and turns in without being
prompted, toasts reach the terminal, and `/quests` arrives at `UserPromptSubmit`
as its literal text, so reading the log isn't recorded as an ask.

## Roadmap

- **Mirror the checklist into objectives** via `PostToolUse`, so Claude's
  existing checklist costs nothing extra. Still blocked on the tool's name and
  input shape. Under Claude Code 2.1.283 no checklist tool was available to
  probe: not headless (with or without `CLAUDE_CODE_ENABLE_TASKS=1`), not in an
  interactive session. The docs point at `TaskCreate` / `TaskUpdate` replacing
  `TodoWrite`, but don't give the input schema. Capture a real payload first.
- **Codex**: facts learned about the codebase this session, kept apart from the
  log. Needs a clear line against memory first.
