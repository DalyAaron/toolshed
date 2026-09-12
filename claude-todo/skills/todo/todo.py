#!/usr/bin/env python3
"""Session-scoped todo store for the /todo skill.

One JSON file per Claude Code session, keyed by CLAUDE_CODE_SESSION_ID, under
$CLAUDE_CONFIG_DIR/todos/<project-slug>/<session-id>.json

The script is the only writer. The skill body and the hooks are both readers of
the same schema, so nothing has to hand-write JSON.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

REMINDER_MODES = ("turns", "minutes", "session", "off")

SETTINGS: dict[str, tuple[object, str, str]] = {
    # key: (default, accepted values, what it controls)
    "reminder_mode": (
        "turns", " | ".join(REMINDER_MODES),
        "When Claude may raise open todos. 'session' only at session start or "
        "resume; 'off' never, though /todo still works on demand.",
    ),
    "nudge_every_turns": (
        3, "whole number, 0+",
        "Prompts that must pass between reminders, in 'turns' mode.",
    ),
    "nudge_every_minutes": (
        15, "whole number, 0+",
        "Minutes that must pass between reminders, in 'minutes' mode.",
    ),
    "max_surfaces_per_todo": (
        2, "whole number, 0+",
        "Times one todo is raised before it goes quiet until you ask. 0 never raises it.",
    ),
    "max_nudge_items": (
        3, "whole number, 0+",
        "Most todos listed in a single reminder.",
    ),
    "carryover_days": (
        7, "whole number, 0+",
        "How far back a new session looks for unfinished todos in this project.",
    ),
    "dedupe_threshold": (
        0.6, "0.0 - 1.0",
        "Word overlap at which a new todo merges into an existing one instead of "
        "being added. Higher means fewer merges.",
    ),
}

DEFAULTS = {key: spec[0] for key, spec in SETTINGS.items()}

STOPWORDS = {
    "a", "an", "the", "to", "for", "of", "in", "on", "and", "or", "is", "it",
    "we", "i", "that", "this", "should", "need", "needs", "add", "also", "be",
}

# A plan name starts with a letter, so "+1 to this" is never read as a plan.
PLAN_NAME = r"[A-Za-z][\w-]*"
PLAN_PREFIX = re.compile(rf"^\+({PLAN_NAME})(?:\s+|$)")

# Shown once, in the terminal, the first session after an update. Keep each
# entry to a few lines: it interrupts someone who did not ask for it.
UPGRADE_NOTES = {
    "1.1.0": (
        "/todo 1.1.0 — plans: park the steps of a bigger job, then run them together.\n"
        "  /todo +<plan> <idea>    park a step        /todo plans            list plans\n"
        "  /todo plan +<plan>      review the steps   /todo execute +<plan>  run them\n"
        "The Locality line and the [warm: file] marker are gone. Details: /todo help"
    ),
}


# ---------------------------------------------------------------- paths / state

def project_root() -> str:
    """The project a todo belongs to.

    CLAUDE_PROJECT_DIR is deliberately NOT consulted. Claude Code sets it for
    hook processes but not for the environment the skill's capture runs in, so
    honouring it made the writer and the reader disagree whenever a session
    started in a subdirectory or a worktree: capture succeeded, then the hooks
    read a different directory and reminders silently never fired.

    git toplevel is identical from anywhere inside a checkout, so both agree.
    A worktree has its own toplevel and therefore its own parking lot, which is
    intended — a worktree is usually a separate piece of work.
    """
    top = _git("rev-parse", "--show-toplevel").strip()
    if top:
        return top
    return str(Path.cwd().resolve())


def slug(path: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "-", path)


def config_dir() -> Path:
    return Path(os.environ.get("CLAUDE_CONFIG_DIR") or (Path.home() / ".claude"))


def store_base() -> Path:
    """Root of this profile's todo store."""
    override = os.environ.get("CLAUDE_TODO_DIR")
    return Path(override) if override else config_dir() / "todos"


def config_path() -> Path:
    """Config is per profile, alongside the per-project todo directories."""
    return store_base() / "config.json"


def read_config_file() -> dict:
    """Raw config.json, or {} when it is missing or corrupt."""
    path = config_path()
    if path.exists():
        try:
            return json.loads(path.read_text()) or {}
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def write_config_value(key: str, value: object) -> None:
    """Persist one key, leaving the rest of the file alone."""
    stored = read_config_file()
    stored[key] = value
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(stored, indent=2) + "\n")
    os.replace(tmp, path)


def todo_dir(root: str) -> Path:
    """Per-profile store, keyed by project.

    CLAUDE_CONFIG_DIR identifies the profile (.claude, .claude-ag1,
    .claude-me), so todos parked under one profile are not visible from
    another. That separation is intentional: a profile is a distinct working
    context. Set CLAUDE_TODO_DIR to point every profile at one shared store.
    """
    return store_base() / slug(root)


def coerce(key: str, raw: object) -> object:
    """Validate and type a config value, raising ValueError with a usable message."""
    default = DEFAULTS[key]
    if key == "reminder_mode":
        value = str(raw).strip().lower()
        if value not in REMINDER_MODES:
            raise ValueError(f"reminder_mode must be one of: {', '.join(REMINDER_MODES)}")
        return value
    if isinstance(default, float):
        value = float(raw)
        if not 0.0 <= value <= 1.0:
            raise ValueError(f"{key} must be between 0.0 and 1.0")
        return value
    value = int(raw)
    if value < 0:
        raise ValueError(f"{key} must be 0 or greater")
    return value


def load_config() -> tuple[dict, dict]:
    """Effective config plus where each value came from.

    Precedence: environment (CLAUDE_TODO_<KEY>) > config.json > default.
    """
    values = dict(DEFAULTS)
    sources = {k: "default" for k in DEFAULTS}

    for key, raw in read_config_file().items():
        if key in DEFAULTS:  # ignores bookkeeping keys like last_seen_version
            try:
                values[key], sources[key] = coerce(key, raw), "config.json"
            except (ValueError, TypeError):
                pass  # a bad stored value must not break reminders

    for key in DEFAULTS:
        env = os.environ.get("CLAUDE_TODO_" + key.upper())
        if env is not None:
            try:
                values[key], sources[key] = coerce(key, env), "env"
            except (ValueError, TypeError):
                pass

    return values, sources


_CFG: tuple[dict, dict] | None = None


def cfg() -> dict:
    global _CFG
    if _CFG is None:
        _CFG = load_config()
    return _CFG[0]


def cfg_sources() -> dict:
    cfg()
    return _CFG[1]


def session_id(explicit: str | None = None) -> str:
    return explicit or os.environ.get("CLAUDE_CODE_SESSION_ID") or "no-session"


def state_path(sid: str, root: str) -> Path:
    return todo_dir(root) / f"{sid}.json"


def load(path: Path, sid: str, root: str) -> dict:
    if path.exists():
        try:
            return json.loads(path.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {
        "session_id": sid,
        "project": root,
        "created": now(),
        "muted": False,
        "turns": 0,
        "last_nudge_turn": 0,
        "last_nudge_at": time.time(),
        "next_id": 1,
        "todos": [],
    }


def save(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, indent=2))
    os.replace(tmp, path)  # atomic; a fast double-/todo can't clobber


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


# ------------------------------------------------------------- ambient context

def _git(*args: str) -> str:
    try:
        out = subprocess.run(
            ("git",) + args, capture_output=True, text=True, timeout=5
        )
        # rstrip newlines only: `git status --porcelain` encodes status in the
        # first two columns, so a leading space is significant data.
        return out.stdout.rstrip("\n") if out.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def dirty_files() -> list[str]:
    """Dirty paths, most recently modified first."""
    porcelain = _git("status", "--porcelain")
    files = []
    for line in porcelain.splitlines():
        if len(line) > 3:
            files.append(line[3:].strip().split(" -> ")[-1])

    root = Path(project_root())

    def mtime(path: str) -> float:
        try:
            return (root / path).stat().st_mtime
        except OSError:
            return 0.0

    return sorted(files, key=mtime, reverse=True)[:8]


def capture_context() -> dict:
    return {
        "branch": _git("rev-parse", "--abbrev-ref", "HEAD").strip(),
        "sha": _git("rev-parse", "--short", "HEAD").strip(),
        "diff_stat": _git("diff", "--shortstat").strip(),
        "dirty_files": dirty_files(),
        "cwd": str(Path.cwd()),
    }


# ----------------------------------------------------------------------- dedupe

def tokens(text: str) -> set[str]:
    words = re.findall(r"[a-z0-9_]+", text.lower())
    return {w for w in words if w not in STOPWORDS} or set(words)


def similarity(a: str, b: str) -> float:
    ta, tb = tokens(a), tokens(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def duplicates(new: dict, existing: dict) -> bool:
    """True when `new` should merge into `existing` rather than be added.

    Steps of different plans never merge: "write the tests" in +auth and in
    +billing are two pieces of work, and merging would drop one plan's step.
    """
    a, b = new.get("plan"), existing.get("plan")
    if a and b and a != b:
        return False
    return similarity(new["text"], existing["text"]) >= cfg()["dedupe_threshold"]


def subject_outside_repo(todo: dict) -> bool:
    """True when the todo's recorded subject is a path outside its capture repo.

    The git context describes the repo you were in. When the subject lives
    elsewhere, it describes where you were standing, not what the todo is about,
    so it must not be presented as evidence about it.
    """
    subject = todo.get("about") or ""
    if not subject.startswith(("/", "~")):
        return False
    project = todo.get("cwd") or ""
    return bool(project) and not str(Path(subject).expanduser()).startswith(project)


def open_todos(state: dict) -> list[dict]:
    return [t for t in state["todos"] if t["status"] == "open"]


# --------------------------------------------------------------------- plans

def split_plan(text: str) -> tuple[str | None, str]:
    """Peel a leading `+name` off captured text: "+docs add a changelog".

    Only a leading token counts, so "support the +x flag" stays plain text.
    """
    match = PLAN_PREFIX.match(text)
    if not match:
        return None, text
    return match.group(1).lower(), text[match.end():]


def label(todo: dict) -> str:
    """A todo's text as it was typed, plan prefix included."""
    return f"+{todo['plan']} {todo['text']}" if todo.get("plan") else todo["text"]


def plan_steps(state: dict, name: str) -> list[dict]:
    """A plan's steps in capture order, which is the order they run in."""
    return sorted((t for t in state["todos"] if t.get("plan") == name),
                  key=lambda t: t["id"])


def plan_names(state: dict) -> list[str]:
    """Plans in this session, ordered by their earliest step."""
    names: list[str] = []
    for todo in sorted(state["todos"], key=lambda t: t["id"]):
        if todo.get("plan") and todo["plan"] not in names:
            names.append(todo["plan"])
    return names


def parse_ids(raw: str) -> list[int]:
    ids: list[int] = []
    for part in re.split(r"[\s,]+", raw.strip()):
        if part and int(part) not in ids:
            ids.append(int(part))
    return ids


# ----------------------------------------------------------------- rendering

def render(todo: dict, verbose: bool = False,
           lead: str = "  ", show_plan: bool = True) -> str:
    text = label(todo) if show_plan else todo["text"]
    line = f"{lead}#{todo['id']} {text}"
    if todo.get("mentions", 1) > 1:
        line += f" (raised {todo['mentions']}x)"
    if not verbose:
        return line
    bits = []
    if todo.get("about"):
        marker = "   (outside the repo this was captured in)" if subject_outside_repo(todo) else ""
        bits.append(f"      about: {todo['about']}{marker}")
    if todo.get("detail"):
        bits.append(f"      detail: {todo['detail']}")
    if todo.get("note"):
        bits.append(f"      why: {todo['note']}")
    where = " ".join(x for x in [todo.get("branch"), todo.get("sha")] if x)
    if where:
        bits.append(f"      captured on: {where} at {todo.get('created', '?')}")
    if todo.get("diff_stat"):
        bits.append(f"      diff then: {todo['diff_stat']}")
    return "\n".join([line] + bits)


# ------------------------------------------------------------------- commands

def cmd_add(state: dict, text: str) -> str:
    plan, text = split_plan(" ".join(text.split()))
    current = open_todos(state)
    for existing in current:
        if duplicates({"text": text, "plan": plan}, existing):
            existing["mentions"] = existing.get("mentions", 1) + 1
            existing.update(capture_context())
            if plan and not existing.get("plan"):
                existing["plan"] = plan
            return (
                f"MERGED into existing todo #{existing['id']}: {label(existing)}\n"
                f"(raised {existing['mentions']}x — context refreshed, no duplicate created)"
            )

    todo = {
        "id": state["next_id"],
        "text": text,
        "status": "open",
        "created": now(),
        "mentions": 1,
        "surfaced": 0,
        "note": None,
        "plan": plan,
        "done_at": None,
    }
    todo.update(capture_context())
    state["todos"].append(todo)
    state["next_id"] += 1

    n = len(open_todos(state))
    lines = [f"SAVED todo #{todo['id']}: {label(todo)}"]
    if plan:
        left = sum(t["status"] == "open" for t in plan_steps(state, plan))
        lines.append(f"plan +{plan}: now {left} open step(s)")
    if todo["branch"] or todo["dirty_files"]:
        # omitted entirely outside a git repo, rather than printing "context:  @  "
        where = " @ ".join(x for x in (todo["branch"], todo["sha"]) if x)
        dirty = ", ".join(todo["dirty_files"]) or "none"
        lines.append(f"context: {where} | dirty: {dirty}")
    lines.append(f"{n} open todo(s) in this session.")
    return "\n".join(lines)


def cmd_list(state: dict) -> str:
    items = open_todos(state)
    if not items:
        return "No open todos in this session."
    out = [f"{len(items)} open todo(s) in this session:"]
    out += [render(t, verbose=True) for t in items]
    if state.get("muted"):
        out.append("\n(reminders are muted for this session)")
    return "\n".join(out)


def cmd_next(state: dict, target: str | None = None,
             detail: str | None = None) -> str:
    items = open_todos(state)
    if not items:
        return "No open todos in this session."

    if target is not None:
        tid = int(target)
        picked = [t for t in items if t["id"] == tid]
        if not picked:
            # record nothing when the lookup failed
            ids = ", ".join(f"#{t['id']}" for t in items)
            return f"No open todo #{tid}. Open: {ids}."
        pick = picked[0]
        if detail:
            extra = " ".join(detail.split())
            pick["detail"] = f"{pick['detail']}; {extra}" if pick.get("detail") else extra
    else:
        # most-raised first; ties break toward older ids
        items.sort(key=lambda t: (-t.get("mentions", 1), t["id"]))
        pick = items[0]
    note = ""
    if subject_outside_repo(pick):
        note = (
            "\nNOTE: this todo's subject is outside the repo it was captured in, so the "
            "branch and commit above describe where the idea occurred, not what it "
            "is about. Work from `about:` and `why:`."
        )
    return f"NEXT todo:\n{render(pick, verbose=True)}{note}"


def no_plans_hint() -> str:
    return (
        "No plans in this session. Park a step with `/todo +<name> <idea>`, "
        "or group open todos with `/todo tag <ids> +<name>`."
    )


def cmd_plans(state: dict) -> str:
    names = plan_names(state)
    if not names:
        return no_plans_hint()
    lines = [f"{len(names)} plan(s) in this session:"]
    for name in names:
        steps = plan_steps(state, name)
        left = sum(t["status"] == "open" for t in steps)
        done = sum(t["status"] == "done" for t in steps)
        status = "complete" if not left else f"{left} open, {done} done"
        lines.append(f"  +{name}  {status}")
    lines += ["", "`/todo plan +<name>` shows one; `/todo execute +<name>` works through it."]
    return "\n".join(lines)


def cmd_execute_which(state: dict) -> str:
    """`/todo execute` with no plan named."""
    names = plan_names(state)
    if not names:
        return no_plans_hint()
    listed = ", ".join(f"+{n}" for n in names)
    return f"EXECUTE: which plan? {listed}\n\nStart one with `/todo execute +<name>`."


def cmd_plan(state: dict, name: str, execute: bool = False) -> str:
    """Show a plan's open steps in order, or hand them over to be executed."""
    name = name.lower()
    steps = plan_steps(state, name)
    if not steps:
        names = ", ".join(f"+{n}" for n in plan_names(state))
        return f"No plan +{name}. " + (f"Plans: {names}." if names else "No plans yet.")

    pending = [t for t in steps if t["status"] == "open"]
    done = [t for t in steps if t["status"] == "done"]
    if not pending:
        return f"Plan +{name} has no open steps — all {len(done)} done."

    head = (
        f"EXECUTE plan +{name} — {len(pending)} step(s), in capture order:" if execute else
        f"PLAN +{name} — {len(pending)} open step(s), {len(done)} done:"
    )
    out = [head]
    out += [render(t, verbose=True, lead=f"  {i}. ", show_plan=False)
            for i, t in enumerate(pending, 1)]
    if done:
        out.append("\nalready done: " + ", ".join(f"#{t['id']} {t['text']}" for t in done))
    if not execute:
        out.append(f"\n`/todo execute +{name}` works through these in this order.")
    return "\n".join(out)


def cmd_tag(state: dict, ids: list[int], name: str | None) -> str:
    """Put open todos into a plan, or take them out of one (name=None)."""
    items = {t["id"]: t for t in open_todos(state)}
    missing = [i for i in ids if i not in items]
    if missing:
        wanted = ", ".join(f"#{i}" for i in missing)
        have = ", ".join(f"#{i}" for i in items) or "none"
        return f"No open todo {wanted}. Open: {have}."
    for i in ids:
        items[i]["plan"] = name.lower() if name else None
    which = ", ".join(f"#{i}" for i in ids)
    if not name:
        return f"Untagged {which} — no longer part of a plan."
    left = sum(t["status"] == "open" for t in plan_steps(state, name.lower()))
    return f"Tagged {which} into plan +{name.lower()} ({left} open step(s))."


def cmd_resolve(state: dict, ident: str, status: str) -> str:
    try:
        tid = int(ident)
    except ValueError:
        return f"'{ident}' is not a todo id."
    for todo in state["todos"]:
        if todo["id"] == tid and todo["status"] == "open":
            todo["status"] = status
            todo["done_at"] = now()
            verb = "Completed" if status == "done" else "Dropped"
            n = len(open_todos(state))
            return f"{verb} #{tid}: {todo['text']}\n{n} open todo(s) left."
    return f"No open todo #{tid}."


def cmd_help() -> str:
    """The full usage reference. Paths are resolved, not illustrative."""
    skill = Path(__file__).resolve().parent
    store = store_base()
    try:
        # list what is actually installed, not what a full checkout would have
        present = ", ".join(sorted(
            f.name for f in skill.iterdir() if f.is_file() and not f.name.startswith(".")
        ))
    except OSError:
        present = "todo.py"
    return f"""HELP: /todo — park an idea without losing your place

CAPTURE
  /todo <idea>          Park it. The write happens before Claude reads anything,
                        so it cannot derail what you were doing. Records the
                        branch, commit and diff stat. A near-duplicate of an
                        existing todo merges into it (marked "raised Nx")
                        instead of adding a second.

REVIEW
  /todo                 This session's open todos, with the context each was
                        captured in.
  /todo list            Same as bare /todo.
  /todo sessions        Other sessions of this repo holding open todos,
                        including sibling worktrees. Grouped as s1, s2, … for
                        `adopt`.

DO
  /todo next            Start the top todo: the one raised most often, with
                        ties breaking toward older ids.
  /todo 4               Start #4 specifically. `/todo next 4` is identical.
  /todo 4 <detail>      Start #4 and attach scope for this run — e.g.
  /todo next 4 <detail> "/todo 7 update it with what changed this session".
                        The detail is kept on the todo, so it survives an
                        interruption; a second one appends rather than replaces.
                        A bare number followed by text starts that todo only if
                        it is open, so "/todo 404 handler needs a test" still
                        parks an idea. `next 4 <detail>` is always explicit.
  /todo done 4          Mark #4 complete.
  /todo drop 4          Discard #4.

PLANS
  /todo +docs <idea>    Park it as the next step of plan "docs". Park a bigger
                        piece of work step by step, then run it in one go.
  /todo tag 2 3 +docs   Put open todos into a plan after the fact. Tagging a
                        todo that is already in another plan moves it.
  /todo untag 2         Take it back out.
  /todo plans           Plans in this session, with open / done counts.
  /todo plan +docs      Review one: its open steps in order, with the context
  /todo +docs           each was captured in.
  /todo execute +docs   Work through its open steps, in capture order, marking
                        each done as it lands.
                        A plan is always written "+name", which is what keeps
                        ideas safe: "/todo plan docs for next meeting" parks,
                        because no "+" names a plan.
                        Steps in different plans never merge as duplicates.

EDIT
  /todo edit 4          Change #4 a field at a time — text, why, subject, plan,
                        status — each step offering a proposed value you can
                        accept or overtype. `/todo edit` alone asks which todo.
                        Editing keeps the id and the captured git context; that
                        context is deliberately not editable, because it records
                        where the idea occurred rather than what it is about.

MERGE
  /todo adopt           Numbered list of todos held by other sessions.
  /todo adopt 3         Move that one into this session.
  /todo adopt s2        Move everything from source s2 (see /todo sessions).
  /todo adopt all       Move every adoptable todo in.
  /todo adopt +docs     Move every step of plan "docs" in.
                        Adopting *moves* a todo, so it can never be resolved in
                        two places, and anything duplicating a todo already here
                        merges rather than arriving as a twin.

REMINDERS
  /todo mute            Stop reminders for this session.
  /todo unmute          Resume them.
  /todo config          Every setting: current value, where it came from, the
                        values it accepts, and what it controls.
  /todo config <k>      Just that one, with its description.
  /todo config <k> <v>  Change one. Takes effect on your next prompt.
                        reminder_mode: turns | minutes | session | off
                        Open todos survive a compaction or resume, and a new
                        session surfaces anything still open from the last week.

HELP
  /todo help            This reference.

ANYTHING ELSE becomes a new todo. A subcommand has to match the whole argument,
which is what keeps these as ideas rather than commands:
  /todo next steps: add tests for the helpers
  /todo edit the retry logic
  /todo 404 handler needs a test
  /todo plan docs for next meeting
An id that does not exist reports the open ids instead of parking itself.

FILES
  {skill}/
      {present}
  {store}/
      <project>/<session>.json   your todos, one file per session
      config.json                settings, once you change one"""


def cmd_edit(state: dict, target: str | None = None) -> str:
    """Read a todo out for editing. The writer is `todo.py set`."""
    items = [t for t in state["todos"] if t["status"] == "open"]
    if not items:
        return "No open todos in this session to edit."

    if target is None:
        lines = ["EDIT: which todo? Open todos:"]
        lines += [f"  #{t['id']} {t['text']}" for t in items]
        lines += ["", "Ask which one, then run `/todo edit <n>`."]
        return "\n".join(lines)

    tid = int(target)
    picked = [t for t in items if t["id"] == tid]
    if not picked:
        ids = ", ".join(f"#{t['id']}" for t in items)
        return f"No open todo #{tid}. Open: {ids}."

    todo = picked[0]
    where = " ".join(x for x in (todo.get("branch"), todo.get("sha")) if x)
    return "\n".join([
        f"EDIT todo #{tid} — current values:",
        f"  text   {todo['text']}",
        f"  detail {todo.get('detail') or '(empty)'}",
        f"  why    {todo.get('note') or '(empty)'}",
        f"  about  {todo.get('about') or '(empty)'}",
        f"  plan   {'+' + todo['plan'] if todo.get('plan') else '(empty)'}",
        f"  status {todo['status']}",
        "",
        f"Captured on {where or 'no git context'} at {todo.get('created', '?')} — "
        "not editable; it records where the idea occurred, not what it is about.",
    ])


def cmd_set(state: dict, ident: str, fields: dict[str, str]) -> str:
    """Apply edits gathered from the user. An empty value clears a field."""
    try:
        tid = int(ident)
    except ValueError:
        return f"'{ident}' is not a todo id."

    for todo in state["todos"]:
        if todo["id"] != tid:
            continue
        changed = []
        if "text" in fields:
            value = " ".join(fields["text"].split())
            if not value:
                return "text cannot be empty — use `/todo drop` to discard a todo."
            if value != todo["text"]:
                todo["text"] = value
                changed.append("text")
        for flag, key in (("why", "note"), ("about", "about"), ("detail", "detail")):
            if flag in fields:
                value = " ".join(fields[flag].split()) or None
                if value != todo.get(key):
                    todo[key] = value
                    changed.append(flag if value else f"{flag} (cleared)")
        if "plan" in fields:
            # "+docs" and "docs" both mean the same plan; empty clears it
            raw = fields["plan"].strip().lstrip("+")
            if raw and not re.fullmatch(PLAN_NAME, raw):
                return f"a plan name must start with a letter (got {fields['plan']!r})."
            value = raw.lower() or None
            if value != todo.get("plan"):
                todo["plan"] = value
                changed.append(f"plan -> +{value}" if value else "plan (cleared)")
        if "status" in fields:
            value = fields["status"].strip().lower()
            value = "dropped" if value == "drop" else value
            if value not in ("open", "done", "dropped"):
                return f"status must be open, done or dropped (got {fields['status']!r})."
            if value != todo["status"]:
                todo["status"] = value
                todo["done_at"] = None if value == "open" else now()
                changed.append(f"status -> {value}")
        if not changed:
            return f"Nothing changed on #{tid}."
        return f"Updated #{tid} ({', '.join(changed)}):\n  {todo['text']}"
    return f"No todo #{tid}."


def parse_flags(argv: list[str], names: set[str]) -> dict[str, str]:
    """Collect `--flag value...` pairs, tolerating unquoted multi-word values."""
    found: dict[str, str] = {}
    i = 0
    while i < len(argv):
        token = argv[i]
        if token.startswith("--") and token[2:] in names:
            key = token[2:]
            i += 1
            parts = []
            while i < len(argv) and not (argv[i].startswith("--") and argv[i][2:] in names):
                parts.append(argv[i])
                i += 1
            found[key] = " ".join(parts)
        else:
            i += 1
    return found


def cmd_mute(state: dict, muted: bool) -> str:
    state["muted"] = muted
    return "Reminders muted for this session." if muted else "Reminders re-enabled."


def cmd_annotate(state: dict, ident: str, note: str,
                 about: str | None = None) -> str:
    """Attach conversational context, and optionally the concrete thing meant.

    `about` exists because prose hedges. When the conversation makes the
    referent unambiguous ("the readme" -> a specific file), recording it as a
    field means `/todo next` doesn't have to re-derive it from a sentence.
    """
    try:
        tid = int(ident)
    except ValueError:
        return f"'{ident}' is not a todo id."
    for todo in state["todos"]:
        if todo["id"] == tid:
            if note:
                todo["note"] = " ".join(note.split())
            if about:
                todo["about"] = " ".join(about.split())
            what = " and subject" if about and note else " subject" if about else " context"
            return f"Noted{what} on #{tid}."
    return f"No todo #{tid}."


_MAIN_SLUG: dict[str, str] = {}


def main_repo_slug(root: str) -> str:
    """Slug of this repo's main checkout — the same for every worktree of it."""
    if root not in _MAIN_SLUG:
        common = _git("rev-parse", "--git-common-dir").strip()
        if common:
            path = Path(common)
            main = (path if path.is_absolute() else Path(root) / path).resolve().parent
            _MAIN_SLUG[root] = slug(str(main))
        else:
            _MAIN_SLUG[root] = ""
    return _MAIN_SLUG[root]


def store_label(directory: Path, root: str) -> str:
    """Short human name for a store dir, relative to the repo's main checkout."""
    base = main_repo_slug(root)
    if not base:
        return directory.name
    if directory.name == base:
        return "main checkout"
    if directory.name.startswith(base):
        tail = directory.name[len(base):].lstrip("-")
        for junk in ("claude-worktrees-", "worktrees-"):
            if tail.startswith(junk):
                tail = tail[len(junk):]
        return f"worktree {tail}" if tail else directory.name
    return directory.name


def sibling_stores(root: str) -> list[Path]:
    """Store dirs for other checkouts of the same repo (i.e. its worktrees).

    Each worktree keys to its own project, which is intended for automatic
    reminders. But when a worktree's work lands you usually want its parked
    ideas in the main checkout, so explicit merge commands look here too.
    """
    own = todo_dir(root)
    prefix = main_repo_slug(root)
    if not prefix:
        return [own]
    base = store_base()
    if not base.is_dir():
        return [own]
    try:
        others = sorted(d for d in base.iterdir()
                        if d.is_dir() and d.name.startswith(prefix) and d != own)
    except OSError:
        others = []
    return [own] + others


def carryover_candidates(root: str, sid: str,
                         include_siblings: bool = False) -> list[tuple[Path, dict]]:
    """Open todos from other recent sessions, newest file first then by id.

    The ordering is deterministic so the numbering `/todo adopt` prints stays
    stable between listing it and acting on it.
    """
    directories = sibling_stores(root) if include_siblings else [todo_dir(root)]
    cutoff = time.time() - cfg()["carryover_days"] * 86400

    files: list[Path] = []
    for directory in directories:
        if not directory.is_dir():
            continue
        try:
            files += [f for f in directory.glob("*.json")
                      if f.stem != sid and f.stat().st_mtime >= cutoff]
        except OSError:
            continue
    files.sort(key=lambda p: (-p.stat().st_mtime, p.name))

    found: list[tuple[Path, dict]] = []
    for f in files:
        try:
            other = json.loads(f.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        if other.get("muted"):
            continue
        for todo in sorted(open_todos(other), key=lambda t: t["id"]):
            found.append((f, todo))
    return found


def source_label(path: Path, root: str) -> str:
    """How a source session is described: id, plus its project when elsewhere."""
    label = f"session {path.stem[:8]}"
    if path.parent != todo_dir(root):
        label += f" ({store_label(path.parent, root)})"
    return label


def _move_one(state: dict, path: Path, todo: dict) -> str | None:
    """Close a todo in its source session and bring it into this one.

    Returns a description of what happened, or None if it was already gone.
    """
    try:
        source = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return None
    for entry in source.get("todos", []):
        if entry["id"] == todo["id"] and entry["status"] == "open":
            entry["status"] = "adopted"
            entry["done_at"] = now()
            entry["adopted_by"] = state["session_id"]
            break
    else:
        return None
    save(path, source)

    # merging shouldn't create twins of something already parked here
    for existing in open_todos(state):
        if duplicates(todo, existing):
            existing["mentions"] = existing.get("mentions", 1) + todo.get("mentions", 1)
            if todo.get("plan") and not existing.get("plan"):
                existing["plan"] = todo["plan"]
            return f"merged into #{existing['id']}: {label(existing)}"

    moved = dict(todo)
    moved.update({
        "id": state["next_id"],
        "status": "open",
        "surfaced": 0,
        "adopted_from": path.stem,
    })
    state["todos"].append(moved)
    state["next_id"] += 1
    return f"#{moved['id']}: {label(moved)}"


def _sources(candidates: list[tuple[Path, dict]]) -> list[Path]:
    """Distinct source files, in the order they appear in candidates."""
    order: list[Path] = []
    for path, _ in candidates:
        if path not in order:
            order.append(path)
    return order


def cmd_sessions(state: dict) -> str:
    root, sid = project_root(), state["session_id"]
    candidates = carryover_candidates(root, sid, include_siblings=True)
    if not candidates:
        return "No other sessions hold open todos for this repo."

    lines = ["Other sessions with open todos:"]
    for i, path in enumerate(_sources(candidates), 1):
        items = [t for p, t in candidates if p == path]
        lines.append(f"  s{i}  {source_label(path, root)} — {len(items)} open")
        for todo in items:
            lines.append(f"        {label(todo)}")
    lines += [
        "",
        "`/todo adopt s<n>` merges one session's todos into this one;",
        "`/todo adopt` numbers them individually; `/todo adopt all` takes everything;",
        "`/todo adopt +<plan>` takes every step of one plan.",
    ]
    return "\n".join(lines)


def cmd_adopt(state: dict, target: str | None = None) -> str:
    root, sid = project_root(), state["session_id"]
    candidates = carryover_candidates(root, sid, include_siblings=True)
    if not candidates:
        return "Nothing to adopt — no open todos in other recent sessions of this repo."

    if target is None:
        lines = ["Adoptable todos from other sessions:"]
        for i, (path, todo) in enumerate(candidates, 1):
            lines.append(f"  {i}. {label(todo)}  ({source_label(path, root)})")
        lines += [
            "",
            "`/todo adopt <n>` moves one in, `/todo adopt all` moves all,",
            "`/todo adopt +<plan>` moves one plan's steps,",
            "`/todo sessions` groups them by session for `/todo adopt s<n>`.",
        ]
        return "\n".join(lines)

    target = target.lower()
    if target == "all":
        chosen, what = candidates, f"all {len(candidates)} todo(s)"
    elif target.startswith("+"):
        name = target[1:]
        chosen = [(p, t) for p, t in candidates if t.get("plan") == name]
        if not chosen:
            return f"No open steps of plan +{name} in other sessions of this repo."
        what = f"{len(chosen)} step(s) of plan +{name}"
    elif target.startswith("s"):
        order = _sources(candidates)
        index = int(target[1:])
        if not 1 <= index <= len(order):
            return f"No source s{index}. `/todo sessions` lists {len(order)}."
        picked = order[index - 1]
        chosen = [(p, t) for p, t in candidates if p == picked]
        what = f"{len(chosen)} todo(s) from {source_label(picked, root)}"
    else:
        index = int(target)
        if not 1 <= index <= len(candidates):
            return f"No candidate {index}. `/todo adopt` lists {len(candidates)}."
        chosen, what = [candidates[index - 1]], None

    results = [r for r in (_move_one(state, p, t) for p, t in chosen) if r]
    if not results:
        return "Those todos are no longer open in their source sessions — run `/todo adopt` again."
    if what is None:
        return f"Adopted {results[0]}"
    lines = [f"Adopted {what}:"] + [f"  {r}" for r in results]
    if len(results) < len(chosen):
        lines.append(f"  ({len(chosen) - len(results)} skipped — no longer open at the source)")
    return "\n".join(lines)


def wrap_doc(doc: str, indent: int, width: int = 74) -> list[str]:
    """Wrap a setting's description under its aligned column."""
    pad = " " * (indent + 4)
    out, line = [], pad
    for word in doc.split():
        if len(line) + len(word) + 1 > width and line != pad:
            out.append(line)
            line = pad + word
        else:
            line = f"{line} {word}" if line != pad else pad + word
    if line != pad:
        out.append(line)
    return out


def cmd_config(key: str | None = None, raw: str | None = None) -> str:
    values, sources = cfg(), cfg_sources()

    if key and raw is not None:
        try:
            value = coerce(key, raw)
        except (ValueError, TypeError) as exc:
            return f"Invalid value for {key}: {exc}"
        write_config_value(key, value)
        path = config_path()
        note = ""
        if sources.get(key) == "env":
            note = f"\nNOTE: CLAUDE_TODO_{key.upper()} is set and still overrides this."
        return (
            f"Set {key} = {value} in {path}\n"
            f"Takes effect on the next prompt — each hook run reloads the config."
            f"{note}"
        )

    if key:
        _, accepts, doc = SETTINGS[key]
        return "\n".join([
            f"CONFIG: {key} = {values[key]!r}  (from {sources[key]})",
            f"  accepts: {accepts}",
            f"  {doc}",
            f"  set with: /todo config {key} <value>",
        ])

    width = max(len(k) for k in SETTINGS)
    lines = [f"CONFIG: {len(SETTINGS)} settings for /todo, this profile", ""]
    for name, (_, accepts, doc) in SETTINGS.items():
        marker = "" if sources[name] == "default" else f"   <- {sources[name]}"
        lines.append(f"  {name:<{width}}  {values[name]!r}{marker}")
        lines.append(f"  {'':<{width}}  accepts {accepts}")
        for line in wrap_doc(doc, width):
            lines.append(line)
        lines.append("")
    path = config_path()
    lines += [
        f"file: {path} ({'exists' if path.exists() else 'not created yet'})",
        "set:  /todo config <key> <value>       one key: /todo config <key>",
        "env:  CLAUDE_TODO_<KEY> overrides the file for one session",
    ]
    return "\n".join(lines)


# ----------------------------------------------------------------- hook paths

def emit(event: str, context: str | None = None, system: str | None = None) -> None:
    """Hook output, on two channels that reach different readers.

    `context` is injected into Claude's context and never shown to the user;
    `system` is printed in the user's terminal and never shown to Claude. Both
    can travel in one payload. See DESIGN.md, "Two hook output channels".
    """
    out: dict = {}
    if context is not None:
        out["hookSpecificOutput"] = {
            "hookEventName": event,
            "additionalContext": context,
        }
    if system:
        out["systemMessage"] = system
    if out:
        print(json.dumps(out))


def plugin_version() -> str | None:
    """The version this copy declares, read from its own plugin manifest.

    Derived from __file__ rather than CLAUDE_PLUGIN_ROOT, which is expanded in
    the hook command but not guaranteed in the process environment.
    """
    try:
        manifest = Path(__file__).resolve().parents[2] / ".claude-plugin" / "plugin.json"
        return str(json.loads(manifest.read_text())["version"]) or None
    except (OSError, ValueError, KeyError, IndexError):
        return None


def upgrade_note() -> str | None:
    """Release notes to print once, the first run after the version changes.

    Always records the version it saw, so notes can never pile up or repeat.
    Returns nothing on a fresh install: someone who has never run an older
    version has nothing to be told about.
    """
    version = plugin_version()
    if not version:
        return None  # a checkout without a manifest: nothing to announce
    seen = read_config_file().get("last_seen_version")
    if seen == version:
        return None
    write_config_value("last_seen_version", version)
    return UPGRADE_NOTES.get(version) if seen else None


REMINDER_FRAME = (
    "Open /todo items the user parked earlier in this session. This is a passive "
    "reminder: mention them in one short line only if the current work has reached "
    "a natural stopping point, and do NOT start working on them unless the user asks."
)


def hook_nudge(payload: dict) -> None:
    """UserPromptSubmit: throttled nudge, cadence set by reminder_mode."""
    conf = cfg()
    if conf["reminder_mode"] in ("off", "session"):
        return  # no mid-session nudges in these modes

    root = project_root()
    sid = session_id(payload.get("session_id"))
    path = state_path(sid, root)
    if not path.exists():
        return  # fast path: this session never used /todo

    state = load(path, sid, root)
    state["turns"] = state.get("turns", 0) + 1
    now_ts = time.time()
    # seed the clock so a fresh store doesn't fire immediately in minutes mode
    state.setdefault("last_nudge_at", now_ts)
    items = open_todos(state)

    def bail() -> None:
        save(path, state)

    if state.get("muted") or not items:
        return bail()

    if conf["reminder_mode"] == "minutes":
        if now_ts - state["last_nudge_at"] < conf["nudge_every_minutes"] * 60:
            return bail()
    else:
        if state["turns"] - state.get("last_nudge_turn", 0) < conf["nudge_every_turns"]:
            return bail()

    eligible = [t for t in items if t.get("surfaced", 0) < conf["max_surfaces_per_todo"]]
    if not eligible:
        return bail()

    shown = eligible[:conf["max_nudge_items"]]
    for todo in shown:
        todo["surfaced"] = todo.get("surfaced", 0) + 1
    state["last_nudge_turn"] = state["turns"]
    state["last_nudge_at"] = now_ts
    save(path, state)

    body = "\n".join(render(t) for t in shown)
    emit("UserPromptSubmit", f"{REMINDER_FRAME}\n\n{body}\n\n(`/todo` lists them, `/todo next` starts one.)")


def resurface_context(payload: dict) -> str | None:
    """The reminder Claude should get at session start, if there is one."""
    root = project_root()
    sid = session_id(payload.get("session_id"))
    source = payload.get("source", "startup")
    path = state_path(sid, root)

    if path.exists():
        state = load(path, sid, root)
        items = open_todos(state)
        if items and not state.get("muted"):
            body = "\n".join(render(t, verbose=True) for t in items)
            return (
                f"{REMINDER_FRAME} They survived a `{source}`, so the conversation "
                f"detail around them may be gone.\n\n{body}\n\n"
                "(`/todo` lists them, `/todo next` starts one.)"
            )

    if source not in ("startup", "clear"):
        return None

    # automatic carry-over stays within this project; `/todo adopt` looks wider
    carried = carryover_candidates(root, sid)
    if not carried:
        return None

    lines = [
        f"  {label(todo)} — parked {todo.get('created', '?')} on "
        f"{todo.get('branch') or 'unknown branch'} ({source_label(p, root)})"
        for p, todo in carried[:5]
    ]
    return (
        f"The user left {len(carried)} unfinished /todo item(s) from earlier sessions in "
        f"this project. Passive reminder only — surface them in one short line if "
        f"relevant, and do not act on them unless asked. `/todo adopt` moves one into "
        f"this session so it can be acted on.\n\n" + "\n".join(lines)
    )


def hook_resurface(payload: dict) -> None:
    """SessionStart: release notes after an update, plus any open todos.

    The notes go out as `systemMessage`, which Claude Code prints in the
    terminal verbatim and does not show the model. That is the right channel:
    release notes are for the person, and a paraphrase of them is worse than
    the real thing.
    """
    note = upgrade_note()  # always records, so a skipped note can't come back
    if cfg()["reminder_mode"] == "off":
        emit("SessionStart")  # "off" means silent, release notes included
        return
    emit("SessionStart", resurface_context(payload), system=note)


# ------------------------------------------------------------------- dispatch

_CFG_KEYS = "|".join(sorted(DEFAULTS, key=len, reverse=True))
_IDS = r"\d+ (?: (?: \s*,\s* | \s+ ) \d+ )*"

SUBCOMMANDS = re.compile(
    rf"""^(?:
        (?P<list>list)
      | (?P<plans>plans?)
      | (?P<plan_verb>plans?|execute) \s+ \+ (?P<plan_name>{PLAN_NAME})
      | (?P<execute>execute)
      | \+ (?P<bare_plan>{PLAN_NAME})
      | (?P<tag>tag) \s+ (?P<tag_ids>{_IDS}) \s+ \+? (?P<tag_name>{PLAN_NAME})
      | (?P<untag>untag) \s+ (?P<untag_ids>{_IDS})
      | next \s+ (?P<next_id>\d+) (?: \s+ (?P<next_detail>.+) )?
      | (?P<next>next)
      | (?P<pick>\d+) (?: \s+ (?P<pick_detail>.+) )?
      | (?P<mute>mute)
      | (?P<unmute>unmute)
      | (?P<resolve>done|drop) \s+ (?P<resolve_id>\d+)
      | (?P<config>config) (?: \s+ (?P<cfg_key>{_CFG_KEYS}) (?: \s+ (?P<cfg_val>\S+) )? )?
      | (?P<help>help)
      | (?P<edit>edit) (?: \s+ (?P<edit_id>\d+) )?
      | (?P<sessions>sessions)
      | (?P<adopt>adopt) (?: \s+ (?P<adopt_id>\d+|all|s\d+|\+{PLAN_NAME}) )?
    )$""",
    re.IGNORECASE | re.VERBOSE,
)


def dispatch(raw: str) -> str:
    root = project_root()
    sid = session_id()
    path = state_path(sid, root)
    state = load(path, sid, root)

    text = raw.strip()
    match = SUBCOMMANDS.match(text)

    if not text:
        result = cmd_list(state)
    elif match:
        g = match.groupdict()
        if g["list"]:
            result = cmd_list(state)
        elif g["plans"]:
            result = cmd_plans(state)
        elif g["plan_verb"]:
            result = cmd_plan(state, g["plan_name"],
                              execute=g["plan_verb"].lower() == "execute")
        elif g["execute"]:
            result = cmd_execute_which(state)
        elif g["bare_plan"]:
            result = cmd_plan(state, g["bare_plan"])
        elif g["tag"]:
            result = cmd_tag(state, parse_ids(g["tag_ids"]), g["tag_name"])
        elif g["untag"]:
            result = cmd_tag(state, parse_ids(g["untag_ids"]), None)
        elif g["pick"] and g["pick_detail"]:
            # "N <text>" is genuinely ambiguous: starting #N with a brief, or
            # parking an idea that happens to begin with a number. Resolve it on
            # the only evidence available — whether #N is an open todo. So
            # "/todo 3 what would packaging look like" starts #3, while
            # "/todo 404 handler needs a test" parks, because #404 isn't open.
            if any(t["id"] == int(g["pick"]) for t in open_todos(state)):
                result = cmd_next(state, g["pick"], g["pick_detail"])
            else:
                result = cmd_add(state, text)
        elif g["next_id"] or g["pick"]:
            # "/todo next 4" and the bare "/todo 4" both mean: start #4
            result = cmd_next(state, g["next_id"] or g["pick"], g["next_detail"])
        elif g["next"]:
            result = cmd_next(state)
        elif g["mute"]:
            result = cmd_mute(state, True)
        elif g["unmute"]:
            result = cmd_mute(state, False)
        elif g["config"]:
            result = cmd_config(g["cfg_key"], g["cfg_val"])
        elif g["help"]:
            result = cmd_help()
        elif g["edit"]:
            result = cmd_edit(state, g["edit_id"])
        elif g["sessions"]:
            result = cmd_sessions(state)
        elif g["adopt"]:
            result = cmd_adopt(state, g["adopt_id"])
        else:
            result = cmd_resolve(state, g["resolve_id"], g["resolve"].lower())
    else:
        result = cmd_add(state, text)

    save(path, state)
    return result


def main() -> int:
    argv = sys.argv[1:]
    if not argv:
        print("usage: todo.py {dispatch|annotate|set|hook-nudge|hook-resurface}", file=sys.stderr)
        return 1

    cmd = argv[0]

    if cmd in ("hook-nudge", "hook-resurface"):
        try:
            payload = json.load(sys.stdin)
        except (json.JSONDecodeError, ValueError):
            payload = {}
        try:
            if cmd == "hook-nudge":
                hook_nudge(payload)
            else:
                hook_resurface(payload)
        except Exception:
            pass  # a reminder must never break the session
        return 0

    if cmd == "dispatch":
        raw = sys.stdin.read() if "--stdin" in argv else " ".join(argv[1:])
        print(dispatch(raw))
        return 0

    if cmd == "set":
        root, sid = project_root(), session_id()
        path = state_path(sid, root)
        state = load(path, sid, root)
        fields = parse_flags(argv[2:], {"text", "why", "about", "detail", "plan", "status"})
        print(cmd_set(state, argv[1], fields))
        save(path, state)
        return 0

    if cmd == "annotate":
        root, sid = project_root(), session_id()
        path = state_path(sid, root)
        state = load(path, sid, root)
        rest = argv[2:]
        about = None
        if "--about" in rest:
            i = rest.index("--about")
            about = " ".join(rest[i + 1:])
            rest = rest[:i]
        print(cmd_annotate(state, argv[1], " ".join(rest), about))
        save(path, state)
        return 0

    print(f"unknown command: {cmd}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
