# /quests

Claude keeps a quest log of your session.

Everything you ask Claude to do goes on the log: your words, quoted; why it
matters; what "done" means; the objectives, checked off as they land; the
decisions Claude made along the way; and anything it's waiting on you for.
Step away, come back, type `/quests`, and you know where things stand.

```
╭─ 📜 QUEST LOG ────────────────────────────────────── toolshed · turn 14 ─╮

 ❓ AWAITING YOU
   #3  Rename CLI verb                                          ▱▱▱▱▱▱▱▱ 0/1
       “"turn-in" or "complete"?”

 ⚔ ACTIVE
 ▶ #1  Ship quest-log plugin                                    ▰▰▰▱▱▱▱▱ 2/5
       ✔ 1. Study /todo conventions
       ✔ 2. Draft store + CLI
       ▸ 3. Implement hooks
       ○ 4. Write SKILL.md
       ○ 5. Marketplace + README
       🎁 /quests renders; hook smoke test passes

 👂 RUMORS
   r1  todo.py adopt path swallows errors silently

 🏆 COMPLETED (1)
   ✔ #2 Fix README typo — fixed 3 typos; also checked CHANGELOG

╰─ /quests 1 full entry · /quests help ────────────────────────────────────╯
```

At the end of each turn, one line in your terminal sums up what changed in
the log. It costs Claude nothing:

```
📜 #1 updated · ➕2 · ✔2 · 🏆 #1 complete · ✨ #2 created "Add size to Stack" · ⏸ #2 awaiting you · 👂 1 rumor
```

## How it differs from /todo

`/todo` is **your** todo list: ideas you want to come back to. `/quests` is
**Claude's** record of what you asked for and how far it has got. They connect
in one place. Anything on the log can be sent to `/todo`, but only when you ask
or agree.

### Together: a rumor becomes a todo

From a trial run. While making a small stack module, Claude noticed
`__pycache__/` was untracked. You hadn't asked for that, so it didn't fix it.
It noted it as a rumor instead:

```
╭─ 📜 QUEST LOG ───────────────────────────────────────── qtrial · turn 5 ─╮

 👂 RUMORS
   r1  __pycache__/ is untracked; a .gitignore would keep it out of commits

 🏆 COMPLETED (2)
   ✔ #2 Add size to Stack (+1 later ask) — size() added returning len(self)…
   ✔ #1 Stack module with tests (+2 later asks) — pop returns None on empty…

╰─ /quests help ───────────────────────────────────────────────────────────╯
```

Tell Claude "move rumors to todo" (or run `/quests todo r1`) and it goes to
your /todo list. It carries where it came from and the commit it was noticed
on:

```
❯ /todo list

1 open todo in this session:
- #1 __pycache__/ is untracked; a .gitignore would keep it out of commits
  - why: Noticed by Claude (quest-log, turn 4) and not acted on.
  - captured on: main f4e6557 at 2026-09-26T12:24:03
```

The rumor leaves the log, so it isn't listed twice. It's yours now, for
whenever you want it. Quests and single objectives move the same way
(`/quests todo 2`, `/quests todo 2.3`).

When you pick it up with `/todo next`, it comes back as a quest. Claude does
the work, the todo is marked done, and the log shows how it ended:

```
 🏆 COMPLETED (3)
   ✔ #3 Ignore __pycache__ — .gitignore added with __pycache__/; no longer…
   ✔ #2 Add size to Stack (+1 later ask) — size() added returning len(self)…
   ✔ #1 Stack module with tests (+2 later asks) — pop returns None on empty…
```

`/quests 3` traces it the whole way back: *Began as rumor r1 (turn 4), then
/todo #1.* Noticed, parked, picked up and done, and neither list ends up with
a stale copy.

## Install

```bash
claude plugin marketplace add DalyAaron/toolshed
claude plugin install quest-log@toolshed
```

Start a new session so the hooks load. There's nothing else to do: Claude
starts keeping the log on its own.

**Let Claude write the log without asking.** Claude updates the log with a
small `quest` command as it works, several times a turn. In the default
permission mode each of those asks for your approval, which defeats the point
of a log that keeps itself. Either:

- allow the command once, in `~/.claude/settings.json`:

  ```json
  { "permissions": { "allow": ["Bash(quest *)"] } }
  ```

  The plugin puts `quest` on Claude's PATH, so the rule keeps working when an
  update moves the install; or
- use auto mode (shift+tab to cycle modes, or `claude --permission-mode auto`),
  which runs them without asking.

## Usage

| Command | What it does |
| :--- | :--- |
| `/quests` | The log. |
| `/quests done` | Every completed quest; the log shows the latest three. |
| `/quests 3` | Quest #3 in full: every ask, why, objectives, journal, outcome, loot. |
| `/quests track 3` | Point Claude at #3 next. |
| `/quests abandon 3 [reason]` | Drop it. |
| `/quests todo 3` · `3.2` · `r1` | Send a quest, objective or rumor to `/todo`. |
| `/quests adopt [n\|all]` | Continue unfinished quests from earlier sessions of this repo (worktrees included). |
| `/quests chronicle` | The session as markdown, for a PR description or a handoff. |
| `/quests live` | The log in a pane beside Claude, redrawn as it works. |
| `/quests statusline [off]` | Put the tracked quest in your status line, or take it out. |
| `/quests config` | Settings. |
| `/quests help` | The full reference. |

## What Claude logs

- **Quest**: a request that needs edits or more than one step. Chat and quick
  questions aren't quests. **Main** is the session's main goal; **side** covers
  detours you asked for.
- **Objective**: a step of a quest, checked off as it lands.
- **Journal**: a decision and why it was made, or a change of direction you
  gave. Your original ask is always kept; later asks are added to it.
- **Awaiting you**: a quest blocked on something only you can answer. Listed
  first.
- **Rumor**: something Claude thought was worth doing but *didn't* act on. If
  it did act (say, in auto mode), that goes on the log as real work instead.

When a session starts, Claude hears about quests left unfinished in this
project over the last week, and mentions them if they're relevant.

## Watch it live

`/quests` shows the log between turns. To watch it while Claude works, run
`/quests live`: the log opens beside Claude and redraws as it changes. Close it
with ctrl-c.

Where it opens depends on your terminal:

| Terminal | `/quests live` opens |
| :--- | :--- |
| tmux (inside any terminal) | a split pane |
| iTerm2, WezTerm, kitty (with remote control on) | a split pane |
| IDE terminals, Terminal.app, anything else on macOS | a new Terminal window |

It also prints the command it ran, so you can paste it into a split you open
yourself instead (⌘⇧D in a JetBrains terminal, for example). The first time,
macOS may ask whether Claude Code can control Terminal or iTerm.

## Status line

Show the tracked quest under the prompt:

```
⚔ Ship quest-log · 3/5 · ▸ Implement hooks · ⏸ 1 awaiting you
```

Run `/quests statusline` once. Plugins can't set a status line themselves, so
this adds it to your own `settings.json` (in your `CLAUDE_CONFIG_DIR` if you
set one, backing the file up first). It points at whichever quest-log version
is newest, so it keeps working after updates. If you already have a status
line, it's kept: both run and their output is joined with ` · `.
`/quests statusline off` puts back exactly what you had.

<details>
<summary>Setting it up by hand instead</summary>

```json
{
  "statusLine": {
    "type": "command",
    "command": "python3 \"$(ls -d ~/.claude/plugins/cache/toolshed/quest-log/*/ | sort -V | tail -1)skills/quests/quest.py\" statusline"
  }
}
```

It prints nothing when there's no quest.

</details>

## Config Settings

| Key | Default | Effect |
| :--- | :--- | :--- |
| `style` | `rpg` | `plain` drops the emoji and quest vocabulary, which saves tokens when Claude relays the log. |
| `reminders` | `nudge` | `nudge`: after Claude edits files or commits without logging it, it's told on your next prompt. `strict`: it can't end a turn until it logs them. `off`: no hooks, no log keeping. |
| `toasts` | `summary` | Terminal notices when the log changes. `summary`: one line per turn, always with emoji. `full`: one line per change. `off`: none. |
| `todo_handoff` | `ask` | `auto` also copies every rumor to `/todo` as it's noted. |

Set with `/quests config <key> <value>`, or for one session with
`CLAUDE_QUESTS_<KEY>=…`.

## Where things live

```
~/.claude/quests/<project>/<session>.json   the log
~/.claude/quests/config.json                settings
```

Local files only, nothing inside your repo. Uninstalling leaves the logs alone.

## Status

1.0.0. Tests: `python3 quest-log/tests/test_quest.py` (Python 3.6+). See [DESIGN.md](./DESIGN.md) for how it works and what's still
open.

## Changelog

### Unreleased

- **`/quests live`**: the log in a pane beside Claude, redrawn as it works.
- **A proper quest log.** A frame, progress bars, and sections: awaiting you,
  active, rumors, completed. A question waiting on you is shown once, only the
  tracked quest is expanded, and completed quests show the latest three with
  their outcomes (`/quests done` for all of them). `style plain` is unchanged.
- **`/quests statusline`** sets up the status line for you, alongside any you
  already have, and `off` undoes it.

### 1.0.0

First stable release. 0.2.0 was published briefly before it with the same
changes, so they are listed here.

- **One summary line per turn.** Log changes now print as a single line, always
  with emoji: `📜 #1 updated · ✔2 · 🏆 #1 complete · ✨ #2 created "…"`.
  `toasts: full` brings back one line per change, and `on` means `summary`.
- **No more permission prompt on every log write.** Claude now calls a `quest`
  command the plugin puts on its PATH, so one allow rule, `Bash(quest *)`,
  covers every write and survives updates. Auto mode still works too.
- **`/quests chronicle`**: the session as markdown, for a PR description or a
  handoff.
- **`/quests adopt`**: continue unfinished quests from earlier sessions of the
  repo, worktrees included. A new session also mentions them at the start.
- **Status line**: `⚔ Ship quest-log · 3/5 · ▸ Implement hooks`. See
  [Status line](#status-line) for the setup.
- **Finished quests show their outcome** and how many later asks were folded
  in, so nothing you asked disappears into a closed quest.
- **`/todo` round trip**: a quest started from a todo traces where it came from,
  e.g. *Began as rumor r1 (turn 4), then /todo #1.*
- **Commits count.** A `git commit` Claude didn't log now triggers the reminder,
  like an unlogged edit does.
- **Fixed**: subagent reports and background-task notices were recorded as your
  asks. A question for you is never filed as a rumor, and when the tracked quest
  finishes, tracking falls back to one that's waiting on you.
- **Release notes on update**, printed once in your terminal at the start of a
  session, as `/todo` does.
- **Tests**: `quest-log/tests/test_quest.py`, passing on Python 3.6 and later.

### 0.1.0

- First release: Claude keeps a quest log of the session (asks, quests,
  objectives, journal, what's awaiting you, rumors), with `/quests` to read and
  steer it, terminal notices as it changes, and handoff to `/todo`.
