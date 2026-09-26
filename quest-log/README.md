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
  ✔ #2 Fix README typo — turned in
```

As the log changes, one-line notices appear in your terminal
(`✔ Objective complete: Implement hooks (#1 3/5)`). They cost Claude nothing.

## How it differs from /todo

`/todo` is **your** parking lot: ideas you want to come back to. `/quests` is
**Claude's** record of what you asked for and how far it has got. They connect
in one place. Anything on the log can be sent to `/todo`, but only when you ask
or agree.

## Install

```bash
claude plugin marketplace add DalyAaron/toolshed
claude plugin install quest-log@toolshed
```

Start a new session so the hooks load. There's nothing else to do: Claude
starts keeping the log on its own.

## Usage

| Command | What it does |
| :--- | :--- |
| `/quests` | The log. |
| `/quests 3` | Quest #3 in full: every ask, why, objectives, journal, outcome, loot. |
| `/quests track 3` | Point Claude at #3 next. |
| `/quests abandon 3 [reason]` | Drop it. |
| `/quests todo 3` · `3.2` · `r1` | Send a quest, objective or rumor to `/todo`. |
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

## Settings

| Key | Default | Effect |
| :--- | :--- | :--- |
| `style` | `rpg` | `plain` drops the emoji and quest vocabulary, which saves tokens when Claude relays the log. |
| `reminders` | `nudge` | `nudge`: after Claude edits files without logging them, it's told on your next prompt. `strict`: it can't end a turn until it logs them. `off`: no hooks, no log keeping. |
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

0.1.0, early. See [DESIGN.md](./DESIGN.md) for how it works and what still needs
verifying, including the permission rule that stops every log write from
prompting in the default permission mode.
