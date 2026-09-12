# /todo

Park an idea mid-task without derailing what you're doing.

A [Claude Code](https://claude.com/claude-code) skill for the moment you're deep
in an implementation and think *"we should also fix the retry path"* — and don't
want to spend the next three turns talking about it.

```
> /todo the retry path is still sync
  Parked as #1.
```

That's the whole interaction. The idea is saved, Claude carries on with what it
was doing, and the todo finds its way back to you later.

Parked todos are scoped to **the session, in this project, under this Claude Code
profile**. They remember the branch and the commit you were on when the thought
struck, so picking one up an hour later doesn't mean reconstructing why you
cared. Each git worktree counts as its own project —
`/todo adopt` is how you pull a worktree's ideas into your main checkout.

## Requirements

- Claude Code (plugin support)
- Python 3.9+ (standard library only — no pip install)
- `git` optional; without it you lose the branch/commit context, nothing else

## Install

```bash
claude plugin marketplace add DalyAaron/toolshed
claude plugin install claude-todo@toolshed
```

Then start a new Claude Code session — the reminder hooks load at startup — and
park something:

```bash
/todo something I want to come back to
```

`claude plugin update claude-todo` picks up later releases.

<details>
<summary>Running from a local checkout instead</summary>

```bash
git clone https://github.com/DalyAaron/toolshed ~/code/toolshed
claude plugin marketplace add ~/code/toolshed
claude plugin install claude-todo@toolshed
```

`marketplace add` takes a path as happily as a GitHub repo, so your edits to the
checkout take effect on the next session.
</details>

## Usage

| | Command | What it does |
| :--- | :--- | :--- |
| **Park** | `/todo <idea>` | Save it. One-line ack, no discussion. |
| **Review** | `/todo` or `/todo list` | Open todos, with the context each was captured in. |
| | `/todo sessions` | Other sessions of this repo holding open todos. |
| **Do** | `/todo next` | Start one — the most-raised first, oldest on a tie. |
| | `/todo 4` | Start that specific todo. |
| | `/todo 4 <detail>` | Start it *and* say what you want from it this time. |
| | `/todo done 4` / `drop 4` | Complete or discard it. |
| **Plan** | `/todo +docs <idea>` | Park it as the next step of plan `docs`. |
| | `/todo tag 2 3 +docs` / `untag 2` | Put existing todos into a plan, or take them out. |
| | `/todo plans` | List the plans in this session. |
| | `/todo plan +docs` | Review one plan's steps, in order. |
| | `/todo execute +docs` | Work through the plan's open steps, marking each done. |
| **Change** | `/todo edit 4` | Change its fields, step by step. |
| **Merge** | `/todo adopt` | Bring another session's todos into this one. |
| **Quiet** | `/todo mute` / `unmute` | Silence or restore reminders for this session. |
| **Settings** | `/todo config` | Every setting: value, what it controls, what it accepts. |
| **Reference** | `/todo help` | Every command and its behavior, in detail. |

Anything that isn't one of those exact forms becomes a new todo — so
`/todo next steps: add tests` parks an idea instead of running `next`.

`/todo help` prints the detailed version of this table: what each form does,
how it orders things, and where it can surprise you.

A listing looks like this:

```
2 open todo(s) in this session:
  #1 the retry backoff is still sync, push it through run_blocking
      why: we were converting the client to async and noticed the retry path
           still blocks the event loop
      captured on: fix/DENG-3584 862c8bf at 2026-09-09T15:35:37
      diff then: 5 files changed, 53 insertions(+), 5 deletions(-)
  #2 +docs update the readme (raised 2x)
      about: ~/code/other-project/README.md   (outside the repo this was captured in)
      detail: cover the new commands and the outside-repo marker
      why: the session added help and next-with-detail, neither of which the
           readme mentions
      captured on: fix/DENG-3584 862c8bf at 2026-09-09T15:36:04
```

Each line answers a different question. `about:` is *what* the todo concerns,
`detail:` is *what you asked for* when you started it, `why:` is how it came up,
and the `captured on` line is *where you were standing*. A leading `+name` means
the todo is a step of that plan, and `(raised 2x)` means the same idea was
parked twice.

When a todo names something ambiguous — "the readme", "the tests" — Claude
resolves it from the conversation and records the concrete answer as `about:`.
That matters because the branch you're on is often unrelated to the thought you
just parked: a todo about your tooling gets captured on whatever feature branch
happens to be checked out.

When `about:` points somewhere outside the repo it was captured in, both the
listing and `/todo next` say so — the branch and commit describe where you were
standing, and say nothing about a subject that isn't in the repo.

Near-duplicates merge instead of piling up: park the same idea twice and it
marks the existing todo *raised 2x* rather than adding a second entry.

## Adding detail as you start

A parked idea is short by design, and by the time you come back you usually know
more than you did. So you can say what you want as you start it:

```
/todo 7 update it with what changed this session, and mention the help command
```

That detail is attached to the todo, not just spoken into the conversation — it
survives an interruption, and a second one appends rather than replacing the
first. When Claude picks the todo up it treats `detail:` as the brief for this
run: where it narrows or contradicts the original text, the detail wins.

`/todo 7 <detail>` and `/todo next 7 <detail>` do the same thing. A bare number
followed by text is read as "start that todo" **only when the number is an open
todo**, so `/todo 404 handler needs a test` still parks an idea — #404 doesn't
exist. Use the explicit `next N` form when you want no ambiguity at all.

## Plans: park the steps, then run them

Sometimes the ideas you're parking aren't separate — they're the steps of one
bigger piece of work. Give them a plan name as you park them:

```
/todo +docs add a changelog to the readme
/todo +docs write a user guide and link it from the readme
/todo +docs document the plan commands
```

Or group todos you've already parked: `/todo tag 2 3 +docs`.

When you're ready, review it and hand it over:

```
/todo plans           # the plans in this session
/todo plan +docs      # its open steps, in order, with the context of each
/todo execute +docs   # Claude works through them, marking each done as it lands
```

Steps run in the order you parked them. Claude only moves one when it plainly
depends on a later step, and says so when it does. Each step is marked done the
moment it's finished rather than all at the end, so if the run is interrupted,
`/todo execute +docs` again picks up where it stopped.

A few details:

- **A plan is always written `+name`.** That one rule is what keeps your ideas
  safe: `/todo plan docs for next meeting` parks an idea, because nothing in it
  names a plan. Only `/todo plan +docs` asks for the plan.
- A name starts with a letter, and only a *leading* `+name` tags a new todo — so
  `/todo support the +x flag` and `/todo +1 to this` are plain ideas too.
- A todo belongs to one plan: tagging it into another moves it, and
  `/todo untag 2` takes it out of all of them.
- A plan step is an ordinary todo carrying a tag, so `/todo edit 4`, `/todo 4`,
  `done` and `drop` all work on it exactly as they do on anything else.
- Near-duplicates never merge across plans: *write the tests* in `+auth` and in
  `+billing` stay two steps.
- A plan spans sessions the same way any todo does: `/todo adopt +docs` pulls
  every open step of `docs` in from other sessions of the repo.

## Editing a todo

`/todo edit 4` walks you through it a field at a time — the text, the `detail`,
the `why`, the subject, the plan, the status — proposing a value for each so you
can accept it in one click or type your own. `/todo edit` on its own asks which todo first.
An empty answer clears a field; the text can't be emptied.

Editing keeps the todo's id and its captured git context, which is the reason to
edit rather than drop and re-park: re-parking would record today's branch and
commit instead of the ones the idea actually came from.

`captured on` is deliberately not editable.

## Merging todos from another session

Todos belong to the session that parked them, so a new session can't act on an
older one's list. `/todo sessions` shows what's out there and `/todo adopt`
brings it over:

```
/todo sessions        # what other sessions of this repo still have open
/todo adopt           # the same todos, numbered individually
/todo adopt 3         # move one in
/todo adopt s2        # move all of source #2 in — "merge that session"
/todo adopt all       # move everything in
/todo adopt +docs     # move every step of plan "docs" in
```

Adopting moves a todo: it closes at the source so it won't be offered twice, and
anything that duplicates a todo already parked here merges instead of arriving as
a twin.

This also reaches **other worktrees of the same repo**, which is the usual reason
to want it — when a worktree's branch lands, `/todo adopt s<n>` pulls its parked
ideas into your main checkout. Automatic reminders never cross that line; only
these explicit commands do.

## Reminders

Claude brings open todos up on its own, as a passive mention at a natural break —
never as a new instruction, and never mid-thought.

They also **survive a compaction or a resume**, which is the point: a long
session would otherwise lose them along with the conversation that produced them.
And starting a fresh session in the same project surfaces anything still open
from the last week.

Four cadences, set with `/todo config reminder_mode <mode>`:

| Mode | Behavior |
| :--- | :--- |
| `turns` *(default)* | Every few prompts. |
| `minutes` | At most once every N minutes. |
| `session` | Only when a session starts or resumes. The quietest setting that still won't lose a todo. |
| `off` | Never. `/todo` still works on demand. |

## Configuration

`/todo config` lists every setting with its current value, where that value came
from, the values it accepts, and a line on what it controls.
`/todo config <key>` shows just one; `/todo config <key> <value>` changes one,
effective on your next prompt.

| Key | Default | Effect |
| :--- | :--- | :--- |
| `reminder_mode` | `turns` | Cadence — see above. |
| `nudge_every_turns` | `3` | Prompts between reminders in `turns` mode. |
| `nudge_every_minutes` | `15` | Minutes between reminders in `minutes` mode. |
| `max_surfaces_per_todo` | `2` | Times a todo is raised before it goes quiet. |
| `max_nudge_items` | `3` | Todos shown per reminder. |
| `carryover_days` | `7` | How far back a new session looks for unfinished todos. |
| `dedupe_threshold` | `0.6` | Word overlap (0–1) that counts as a duplicate. |

Any key can also be set for one session with an environment variable —
`CLAUDE_TODO_REMINDER_MODE=off`, and so on. Precedence is **env > config file >
default**. A corrupt or nonsensical config falls back to defaults rather than
breaking reminders.

## Where things live

```
~/.claude/todos/<project>/<session>.json  your parked todos
~/.claude/todos/config.json               settings, once you change one
```

The skill itself lives wherever Claude Code installed the plugin, which moves
when the plugin updates — your todos deliberately do not. `/todo help` prints
both paths resolved, which is worth using if you run a non-default
`CLAUDE_CONFIG_DIR`.

Everything is local files. Nothing leaves your machine, and nothing is written
inside your repo. Each Claude Code profile keeps its own separate todos; set
`CLAUDE_TODO_DIR` to point every profile at one shared store instead.

## Uninstall

```bash
claude plugin uninstall claude-todo
```

That removes the skill and its hooks. Your parked todos are stored outside the
plugin and are left alone — delete `<profile>/todos/` if you want them gone too
(`/todo help` prints the exact path).

## Changelog

### 1.1.0

- **Introduced plans** — tag todos under a single plan and execute them all at
  once: `/todo +<plan> <idea>`, `/todo plans`, `/todo execute +<plan>`.
- **Release notes on update** — the first session after an update prints a few
  lines on what changed, once, straight to your terminal.
- **Removed the `Locality:` line and the `[warm: <file>]` marker.** Todos parked
  while the same file was open are not thereby related. `/todo next` now offers
  the most-raised todo first, and the `focus_file_count` and
  `focus_window_minutes` settings are gone.

### 1.0.0

- First release: park an idea without derailing the session, list, start one
  with `/todo next` (optionally with a detail for that run), edit, complete or
  drop, adopt todos from other sessions and worktrees, reminders at four
  cadences that survive a compaction, and `/todo help`.

## How it works

See [DESIGN.md](./DESIGN.md) — why capture doesn't cost a tool call, why a script
owns the store rather than Claude, how plans are grouped and ordered, and what
this deliberately isn't.
