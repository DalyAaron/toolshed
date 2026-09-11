# `/todo` — design notes

**For whoever changes this code — including a future Claude session.** If you
only want to use `/todo`, see [README.md](./README.md) instead.

This is not a description of how the code works; `todo.py` is 1,100 readable
lines and says that better. It records the part the code *cannot* say: which
obvious alternatives were tried and rejected, and which bugs have already been
hit and fixed.

So the sections below are **constraints, not commentary**. Several of them
describe choices that look wrong on first reading — ignoring `CLAUDE_PROJECT_DIR`,
quoting a heredoc that seems over-quoted, a duplicate-looking `set` verb — and
each one has a silent failure waiting behind it. The test for whether something
belongs in this file is *"would a competent person change this back?"* If yes,
the reason has to be written down or it gets undone.

Two habits that follow from that:

- Changing a documented decision means updating its section in the same commit.
  A section that no longer matches the code is worse than no section, because it
  will be trusted.
- Fixing a bug that took real debugging earns a paragraph here. Half of what
  follows exists because the failure was silent — capture kept working while
  reminders quietly stopped, or every todo looked related to every other one.

## Capture happens before Claude runs

The `/todo` skill body contains a shell-expansion block:

````markdown
```!
"${CLAUDE_SKILL_DIR}/todo.py" dispatch --stdin <<'TODO_EOF'
$ARGUMENTS
TODO_EOF
```
````

Claude Code runs `` !`…` `` blocks and substitutes their output into the skill
body *before* sending it to the model. By the time Claude sees anything the write
has already happened, so capture costs zero tool calls and can't be derailed by
whatever Claude decides to do next. That is the whole reason the tool doesn't
interrupt.

The quoted heredoc (`<<'TODO_EOF'`) is what makes arbitrary text safe.
`$ARGUMENTS` is substituted **textually into the markdown** before the shell
runs, so a naive `todo.py add "$ARGUMENTS"` would break — or execute — on input
like:

```
/todo fix the "retry" logic; rm -rf /tmp/nope && echo $(whoami)
```

Inside a quoted heredoc that string is inert data, stored verbatim.

## Two kinds of context, and which one wins

Each todo carries two independent descriptions of itself:

- **Ambient**, from the shell: branch, commit, diff stat, focus files. Free, exact,
  and about *where you were standing*.
- **Conversational**, from Claude: the `why:` sentence and the `about:` subject.
  Costs one call, and is the only thing that knows *what you meant*.
- **Instructed**, from you, when you start the todo: the `detail:` line. Newest
  and most specific, so it outranks the other two for *what to do now*.

They are easy to confuse, and confusing them fails in a specific way: the branch
is frequently unrelated to the parked thought — a todo about the tooling gets
captured on whatever feature branch happens to be checked out. Reasoning from the
branch to guess the subject then produces a confident, wrong answer, and it
overwrites the one field that could have corrected it.

So `SKILL.md` tells Claude to disregard the printed `context:` line when writing
the note, and to resolve an ambiguous referent from the conversation into
`about:`. Where `about:` names a path outside the capture repo, the renderer says
so and `/todo next` suppresses the staleness check, because a repo-file signal
carries no information about a subject that isn't in the repo.

## Resolving `N <text>` by whether the id exists

`/todo 7 <detail>` attaches scope at the moment you start a todo, and it is
genuinely ambiguous: it could equally be an idea that begins with a number, like
`/todo 404 handler needs a test`.

The first attempt resolved this by refusing trailing text after a bare number and
requiring the `next` keyword. That protected the rarer case at the cost of the
common one — reaching for `/todo 3 <detail>` is the natural gesture, and it
silently parked a todo named `"3 what would packaging look like"` instead.

The rule now uses the only evidence available: **is `N` an open todo?** If yes,
start it with the detail; if not, park the whole thing as an idea. `next N` stays
available for when you want no ambiguity. The residual collision — an idea
beginning with a number that happens to match an open id — is rare, visible in
the output, and undone with `/todo edit`.

Detail persists on the todo rather than living in the conversation, so an
interruption doesn't lose it, and repeated details append — the record of how the
scope evolved is more useful than the latest instruction alone.

## Editing is stepped, not a form

`/todo edit <n>` prints the todo's current fields; `SKILL.md` then has Claude run
a single `AskUserQuestion` with one question per field. Each question offers
"keep current" plus a concrete proposal drafted from the conversation, and the
tool's built-in **Other** option carries free text — so a field can be accepted,
replaced with Claude's draft, or typed by hand, in one pass.

The writer is a separate CLI verb (`todo.py set`) rather than the same word, so
the read path and the write path can't be confused: `/todo edit` never mutates.

Text, `detail`, `why`, `about` and `status` are editable; the git context is
not. That
asymmetry is deliberate — the capture context is a record of where an idea
occurred, and rewriting it would destroy the only evidence of that.

## Why a script owns the store

Claude never writes the JSON itself:

1. **Determinism** — hand-written JSON drifts in schema and occasionally corrupts.
2. **Zero tokens** — the script runs in the expansion phase and prints ~2 lines.
3. **Two readers, one schema** — the hooks read the same store, and a hook can't
   ask Claude anything.

Writes go through `os.replace()`, so two fast `/todo` calls can't clobber.

## Focus files, and why there's a time window

"Which files was I working on" can't be answered with "which files are dirty" — a
branch can sit with a dozen modified files for days. Nor with "the N
most-recently-modified dirty files": that always returns N files, so on a
long-lived branch stale paths leak in and *every* todo looks related to every
other one.

So focus = dirty files modified within `focus_window_minutes`, capped at
`focus_file_count`. The window lets the signal return **nothing**, which is what
makes it worth trusting when it returns something.

Three behaviors build on it:

- **`[warm: <file>]`** — captured while editing a file you're still editing.
- **`Locality:`** — several todos captured against the same file; doing them
  together beats reloading that context twice.
- **`STALENESS CHECK`** — on `/todo next`, when you're no longer editing what the
  todo was captured against, so it may already be done.

## Why the hooks live in `settings.json`

Skill frontmatter supports a `hooks:` block, registered on first invocation and
live for the rest of the session — tempting, since it costs nothing in sessions
that never use `/todo`. But it registers nothing in a *fresh* session, so
cross-session carry-over wouldn't work, and hooks in both places would
double-fire every nudge.

`SessionStart` stdout is one of only three hook outputs Claude Code injects as
context (with `UserPromptSubmit` and `PostModelSwitch`), which is what makes
surviving a compaction possible at all.

The nudge hook's fast path — a session that has never used `/todo` — is a single
`stat` and costs about 45 ms.

## What this deliberately is not

- **Not `TodoWrite`.** That's Claude's plan state for the task in flight; it gets
  rewritten and cleared as plans change, so a parked idea would silently vanish.
  `/todo next` *pushes into* `TodoWrite` — at the moment you commit to the work.
- **Not persistent memory.** That's for durable facts. Parked ideas are meant to
  be disposable; mixing them pollutes recall.
- **Not in the repo.** A store under `.claude/todos/` would show up in
  `git status`.

## Three partition keys

A todo lives at exactly one leaf of `profile / project / session`:

```
$CLAUDE_CONFIG_DIR/todos/<slug of project root>/<session-id>.json
```

`config.json` sits at the profile level, so settings are shared across projects.

The project key is `git rev-parse --show-toplevel`, and `CLAUDE_PROJECT_DIR` is
deliberately ignored — see `project_root()`. Claude Code sets that variable for
hook processes but not for the environment the skill's capture runs in, so
honouring it made the writer and reader disagree whenever a session started in a
subdirectory or a worktree: capture succeeded and reminders then silently never
fired, because the hooks were reading a different directory.

Nothing links todos across leaves automatically except the `SessionStart`
carry-over scan, which stays inside one project. `/todo adopt` is the explicit
way across, and it reaches sibling worktrees of the same repo too. It *moves* a
todo — marking it `adopted` at the source — so it can't be offered twice or
resolved in two places.

## Per-profile store

`CLAUDE_CONFIG_DIR` identifies the profile, so todos parked under one profile
aren't visible from another even in the same repo. A profile is a distinct
working context and its parking lot should be too. `CLAUDE_TODO_DIR` overrides
the base for anyone who wants one shared store.

## Store schema

```jsonc
{
  "session_id": "0ea628f8-…",
  "project": "/path/to/repo",
  "created": "2026-09-03T15:41:52",
  "muted": false,
  "turns": 7,                  // UserPromptSubmit count, for turn throttling
  "last_nudge_turn": 6,
  "last_nudge_at": 1757000000, // epoch, for minutes throttling
  "next_id": 2,
  "todos": [
    {
      "id": 1,
      "text": "the retry backoff is still sync",
      "status": "open",        // open | done | dropped | adopted
      "created": "2026-09-03T15:41:52",
      "mentions": 1,           // bumped when a duplicate merges in
      "surfaced": 0,           // reminder count, capped by max_surfaces_per_todo
      "note": null,            // the one sentence Claude adds ("why:")
      "about": null,           // the concrete subject Claude resolved
      "detail": null,          // scope you typed via `next <n> <detail>`
      "done_at": null,
      "adopted_from": null,    // set on the copy, when moved between sessions
      "adopted_by": null,      // set on the source, pointing at the new session
      "focus_files": ["src/clients/omni_client.py"],
      "dirty_files": ["…"],
      "branch": "fix/DENG-3584",
      "sha": "66f3d00",
      "diff_stat": "2 files changed, 257 insertions(+), 16 deletions(-)",
      "cwd": "/path/to/repo"
    }
  ]
}
```

## CLI

What the skill and hooks call. You never type these directly.

```
todo.py dispatch --stdin           # routes the subcommands, else adds a todo
todo.py annotate <id> "<s>" [--about <x>]
                                   # attach the why, and the resolved subject
todo.py set <id> --text/--detail/--why/--about/--status <v>
                                   # apply an edit; the write half of /todo edit
todo.py hook-nudge                 # UserPromptSubmit; hook JSON on stdin
todo.py hook-resurface             # SessionStart; hook JSON on stdin
```

Both hook paths swallow every exception and always exit 0 — a reminder must
never be able to break a session.

## Packaged as a plugin, but the store is not

The plugin declares its own hooks in `hooks/hooks.json`, which is the whole
reason there is no install script: Claude Code registers them, so there is
nothing to patch into `settings.json` by hand and nothing to unpatch on removal.

Those hook commands use `${CLAUDE_PLUGIN_ROOT}`, and the skill body uses
`${CLAUDE_SKILL_DIR}` — both resolve to the installed plugin, wherever Claude
Code put it.

The **store** stays at `$CLAUDE_CONFIG_DIR/todos/` and deliberately does not use
`${CLAUDE_PLUGIN_DATA}`. `CLAUDE_PLUGIN_ROOT` moves on every plugin update, and
plugin data is tied to the plugin's lifecycle; parked todos belong to the user's
profile and should survive an update, a reinstall, or removing the plugin
entirely.

## Roadmap

- **Decay** — a todo untouched for N days gets a one-time *still want this?*
  prompt, so the store never becomes a graveyard you stop reading.
