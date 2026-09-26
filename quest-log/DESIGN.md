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

## Flavor lives in the renderer only

The store is plain data. `style: rpg | plain` switches the vocabulary and glyphs
in `/quests` and the toasts, and nothing else. Claude never writes flavor text:
it would cost tokens on every call and blur facts the user relies on.

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

Edits are the signal because they are the one kind of work that's cheap to see
from a hook. Bash-driven work (commits, test runs) doesn't trigger the nudge.
That's deliberate for now: most of it is verification rather than progress.

## Toasts: the log talks to the user for free

Each CLI write queues a one-line toast ("✔ Objective complete: …"). The `Stop`
hook flushes the queue as `systemMessage`, which the terminal prints verbatim
and the model never sees. See `/todo`'s DESIGN.md, "Two hook output channels".

Verified for `Stop` too: a headless `claude -p --output-format stream-json`
run emits each line as an `informational` event prefixed `Stop says:`, which is
what the terminal prints.

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
                [--objective O]... [--from-rumor rN]
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
quest.py dispatch --stdin             # /quests
quest.py hook-{session-start,prompt,post-tool,stop}
```

## To verify before 1.0

- **Permission prompts.** Claude calls `quest.py` throughout the session, outside
  any skill, so `allowed-tools` doesn't cover it, and every log write prompts in
  the default permission mode. For 0.1.0 the README recommends auto mode, which
  runs them without asking. A real fix still needs an allow rule that survives
  the install path moving on every plugin update, or a way for the plugin to
  provide one.

Verified end to end with `claude -p --plugin-dir quest-log` on a scratch repo:
the protocol arrives at `SessionStart` and `resume`, asks are recorded verbatim,
Claude accepts, checks, journals, links, notes rumors and turns in without being
prompted, toasts reach the terminal, and `/quests` arrives at `UserPromptSubmit`
as its literal text, so reading the log isn't recorded as an ask.

## Roadmap

- **Mirror TodoWrite into objectives** via `PostToolUse`, so Claude's existing
  checklist costs nothing extra. Blocked on confirming the tool's name and input
  shape. The newer task tools may have replaced it.
- **Status line tracker**: `quest.py statusline` →
  `⚔ Ship quest-log · 3/5 · ▸ Implement hooks`.
- **`/quests chronicle`**: the session as a narrative, for a PR description or a
  handoff.
- **Continue your journey**: surface unfinished quests from earlier sessions in
  the project, and `adopt` them as `/todo` does.
- **Codex**: facts learned about the codebase this session, kept apart from the
  log. Needs a clear line against memory first.
