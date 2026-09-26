# /quests

Claude keeps a quest log of your session.

Everything you ask Claude to do goes on the log: your words, quoted; why it
matters; what "done" means; the objectives, checked off as they land; the
decisions Claude made along the way; and anything it's waiting on you for.
Step away, come back, type `/quests`, and you know where things stand.

```
📜 QUEST LOG — toolshed · turn 14

⏸ AWAITING YOU (1)
  #3 Rename CLI verb — "turn-in" or "complete"?

MAIN QUEST
▶ #1 Ship quest-log plugin  [3/5]
    "plan out the implementation of quest-log…" — you, turn 1
    ✔ 1. Study /todo conventions
    ✔ 2. Draft store + CLI
    ▸ 3. Implement hooks   ◀ tracking
    ○ 4. Write SKILL.md
    ○ 5. Marketplace + README
    Reward: /quests renders; hook smoke test passes

RUMORS  (noticed, not acted on)
  r1 todo.py adopt path swallows errors silently

FINISHED
  ✔ #2 Fix README typo (+1 later ask) — fixed 3 typos; also checked CHANGELOG
```

As the log changes, one-line notices appear in your terminal
(`✔ Objective complete: Implement hooks (#1 3/5)`). They cost Claude nothing.

## How it differs from /todo

`/todo` is **your** parking lot: ideas you want to come back to. `/quests` is
**Claude's** record of what you asked for and how far it has got. They connect
in one place. Anything on the log can be sent to `/todo`, but only when you ask
or agree.

### Together: a rumor becomes a todo

From a trial run. While making a small stack module, Claude noticed
`__pycache__/` was untracked. You hadn't asked for that, so it didn't fix it.
It noted it as a rumor instead:

```
📜 QUEST LOG — qtrial · turn 5

RUMORS  (noticed, not acted on)
  r1 __pycache__/ is untracked; a .gitignore would keep it out of commits

FINISHED
  ✔ #1 Stack module with tests (+2 later asks) — pop returns None on empty; 6/6 tests pass; committed; docstrings chec…
  ✔ #2 Add size to Stack (+1 later ask) — size() added returning len(self); 7/7 tests pass; uncommitted
```

Tell Claude "move rumors to todo" (or run `/quests todo r1`) and it goes to
your parking lot. It carries where it came from and the commit it was noticed
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
FINISHED
  ✔ #1 Stack module with tests (+2 later asks) — pop returns None on empty; 6/6 tests pass; committed; docstrings chec…
  ✔ #2 Add size to Stack (+1 later ask) — size() added returning len(self); 7/7 tests pass; uncommitted
  ✔ #3 Ignore __pycache__ — .gitignore added with __pycache__/; no longer untracked; uncommitted
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
| `/quests 3` | Quest #3 in full: every ask, why, objectives, journal, outcome, loot. |
| `/quests track 3` | Point Claude at #3 next. |
| `/quests abandon 3 [reason]` | Drop it. |
| `/quests todo 3` · `3.2` · `r1` | Send a quest, objective or rumor to `/todo`. |
| `/quests adopt [n\|all]` | Continue unfinished quests from earlier sessions of this repo (worktrees included). |
| `/quests chronicle` | The session as markdown, for a PR description or a handoff. |
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

## Status line

Show the tracked quest under the prompt:

```
⚔ Ship quest-log · 3/5 · ▸ Implement hooks · ⏸ 1 awaiting you
```

Plugins can't set the status line themselves, so add it to
`~/.claude/settings.json`. The command finds the newest installed copy, so it
survives updates:

```json
{
  "statusLine": {
    "type": "command",
    "command": "python3 \"$(ls -d ~/.claude/plugins/cache/toolshed/quest-log/*/ | sort -V | tail -1)skills/quests/quest.py\" statusline"
  }
}
```

Use your `CLAUDE_CONFIG_DIR` in place of `~/.claude` if you set one. It prints
nothing when there's no quest, so it combines with an existing status line:
run both and join the output, e.g. `echo "$(your-line) $(quest-line)"` with
the JSON on stdin passed to each (`input=$(cat)` first, then `echo "$input" |`).

## Settings

| Key | Default | Effect |
| :--- | :--- | :--- |
| `style` | `rpg` | `plain` drops the emoji and quest vocabulary, which saves tokens when Claude relays the log. |
| `reminders` | `nudge` | `nudge`: after Claude edits files or commits without logging it, it's told on your next prompt. `strict`: it can't end a turn until it logs them. `off`: no hooks, no log keeping. |
| `toasts` | `on` | Terminal notices when the log changes. |
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

0.2.0, early. Tests: `python3 quest-log/tests/test_quest.py` (Python 3.6+). See [DESIGN.md](./DESIGN.md) for how it works and what's still
open.
