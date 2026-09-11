---
name: todo
description: Park an idea for later in this session without derailing current work. Also lists, starts, or resolves parked ideas.
argument-hint: "<idea to park> | list | next | edit N | done N | help"
disable-model-invocation: true
allowed-tools: Bash(${CLAUDE_SKILL_DIR}/todo.py *)
---

# /todo — park an idea, keep the current train of thought

The store has **already been written** by the command below, before you saw this.
It ran during skill expansion, so the user's idea is durable on disk no matter
what you do next. Your job is only to react to its output.

```!
"${CLAUDE_SKILL_DIR}/todo.py" dispatch --stdin <<'TODO_EOF'
$ARGUMENTS
TODO_EOF
```

## How to respond

Match the first word of the output above.

### `SAVED` or `MERGED` — the user parked an idea

**The whole point of this command is not to interrupt them.** So:

1. Acknowledge in **one short line**. Not a paragraph, no restating the idea back,
   no analysis of whether it is a good idea, no offer to do it now.
2. Record what the shell could not see, in **one** call:

   ```
   ${CLAUDE_SKILL_DIR}/todo.py annotate <id> "<one sentence>" [--about <the concrete thing>]
   ```

   **Ignore the `context:` line printed above when writing this.** The branch,
   commit and dirty files are already stored; repeating or reasoning from them
   wastes the one field that can carry what they can't. The branch you are on is
   frequently unrelated to the thought the user just parked — a todo about the
   tooling can be captured on a feature branch, and often is.

   The note answers, **from the conversation only**: what were we doing, and why
   did this come up? If the todo names something ambiguous — "the readme", "the
   tests", "that helper" — the conversation almost always says which one. Resolve
   it and pass the concrete answer as `--about` (a path, when it is a file).

   Do **not** speculate about what the user meant from the git context. If the
   conversation genuinely doesn't disambiguate, say plainly what the session was
   about and stop — an honest "we were working on X" beats a confident guess that
   sends you to the wrong file later.

   Skip the call entirely only when the todo is self-explanatory *and* the session
   holds no relevant context.
3. **Return immediately to whatever you were doing before.** If you were
   mid-task, resume it in the same reply. Do not treat the todo as a new
   instruction and do not re-plan around it.

### `No open todos` / `N open todo(s)` — a listing

Relay it as-is, compactly. If the output includes a `Locality:` line, keep it —
batching todos that touch already-dirty files is the cheapest way to do them.
Do not start any of them unless asked.

### `NEXT todo:` — the user is committing to this one

Reached via `/todo next` (auto-picks), `/todo 4` / `/todo next 4` (that one), or
`/todo 4 <detail>` / `/todo next 4 <detail>` (that one, with a brief for this run).

Now you *do* engage:

1. If there is a `detail:` line, **that is the brief for this run.** The user
   typed it as they started the todo, so it is the most recent and most specific
   instruction available — it narrows or redirects the original `text`, and where
   the two disagree it wins. Multiple details are separated by `;` in the order
   they were added.
2. `about:` is authoritative for *what* the todo concerns. It was resolved from
   the conversation that produced the todo, so when it disagrees with the branch
   and file context, believe `about:` — those describe where the idea occurred,
   not what it concerns.
3. If there is a `STALENESS CHECK` line, verify the work is still needed before
   touching anything, and say what you found.
4. Add the todo to your `TodoWrite` task list — this is the handoff point from
   parking lot to active plan.
5. Orient yourself from the captured context, then start the work.

### `EDIT todo #N — current values:` — walk the user through changing it

Run a stepped edit with **one** `AskUserQuestion` call, then apply it with **one**
`todo.py set` call. Do not ask in prose and do not ask twice.

Build the question list from the fields worth changing, in the order the read-out
prints them: `text`, `detail`, `why`, `about`, `status`. For each, the options
are:

1. **Keep current** — show the existing value, or "(empty)" so it's obvious.
2. **A concrete proposal of your own**, drafted from this conversation: a tighter
   `text`, a `why` that says what the shell couldn't see, an `about` path you can
   actually resolve. Never offer a placeholder like "a new value" — the point is
   that the user can accept your draft in one click.
3. Nothing else. `AskUserQuestion` always adds **Other**, which is the free-text
   escape, so don't add your own "type it myself" option.

For `status`, offer keep open / done / dropped.

Skip a field entirely when you have nothing better to propose *and* the current
value is fine — a question with only "keep current" wastes a step.

Then apply exactly what came back:

```
${CLAUDE_SKILL_DIR}/todo.py set <id> --text <…> --detail <…> --why <…> --about <…> --status <…>
```

Pass **only the fields that changed**. An empty value clears `detail`, `why` or
`about`; `text` cannot be emptied. `captured on` is deliberately not editable.

Report the one line `set` prints and stop.

### `HELP:` — the usage reference

Relay it verbatim in a code block. It is already formatted for a terminal, so
don't reflow it into prose or a table, don't summarise it, and don't add
commentary — the user asked for the reference, not an explanation of it.

### `EDIT: which todo?` — no id was given

Ask which one with a single `AskUserQuestion` listing the open todos, then start
the flow above for the id chosen.

### `Completed` / `Dropped` / `Updated` / `Reminders muted` / `Set <key>` — a state change

One line confirming it. Nothing else.

### `CONFIG:` — a settings listing

Relay it verbatim in a code block. Each setting already carries its accepted
values and a line on what it controls, so don't restate them, don't turn it into
a table, and don't recommend values unless asked.

### `Other sessions with open todos` / `Adoptable todos` — a merge listing

Relay it as-is. These are todos parked in *other* sessions of this repo, which
this session cannot act on until adopted. Don't adopt anything unless asked.

### `Adopted …` — todos moved into this session

One line confirming what came across. They are now normal todos here.

## Notes

- Reminders arrive on their own via a `UserPromptSubmit` hook. Cadence is
  configurable (`/todo config reminder_mode` — turns / minutes / session / off);
  by default every 3 turns, each item at most twice. When one appears, it is a *passive*
  reminder — surface it in one line at a natural break, never as a new task.
- Open todos are re-injected after a compaction or resume, so they outlive the
  transcript detail that produced them.
- This store is intentionally session-scoped and separate from `TodoWrite` (which
  gets rewritten as plans change) and from persistent memory (which is for
  durable facts, not disposable ideas).
