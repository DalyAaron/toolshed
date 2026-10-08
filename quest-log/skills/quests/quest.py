#!/usr/bin/env python3
"""Session quest log for the quest-log plugin.

Claude keeps it and the user reads it. One JSON file per Claude Code session:
$CLAUDE_CONFIG_DIR/quests/<project-slug>/<session-id>.json

The script is the only writer. Claude calls the CLI verbs as it works, the
hooks feed in the user's prompts and the files Claude edits, and `/quests`
renders the result. See DESIGN.md for why it is shaped this way.
"""

import json
import os
import random
import re
import shlex
import subprocess
import sys
import time
import unicodedata
from pathlib import Path

SETTINGS: "dict[str, tuple[object, tuple, str]]" = {
    # key: (default, accepted values, what it controls)
    "style": (
        "rpg", ("rpg", "plain"),
        "How /quests and the terminal notices read. 'plain' drops the emoji and "
        "quest vocabulary, which trims the tokens Claude spends relaying the log.",
    ),
    "reminders": (
        "nudge", ("nudge", "strict", "off"),
        "How hard Claude is pushed to keep the log current. 'nudge' tells it, on "
        "your next prompt, about edits it never logged; 'strict' won't let it end "
        "a turn until it logs them; 'off' leaves it to Claude.",
    ),
    "toasts": (
        "summary", ("summary", "full", "off"),
        "Notices in your terminal when the log changes during a turn. They cost "
        "Claude no tokens. 'summary' is one line per turn, always with emoji "
        "(📜 #1 updated · ✔2 · 🏆 #1 complete); 'full' is one line per change.",
    ),
    "overlay": (
        "off", ("off", "on"),
        "Draw the log inside Claude Code: a quest pane (/quest-pane), a toast "
        "for each change as it lands, and a band above the prompt while a quest "
        "waits on you. Takes over from the end-of-turn toast line. Needs Claude "
        "Code 2.1.294 or newer.",
    ),
    "todo_handoff": (
        "ask", ("ask", "auto"),
        "Whether Claude may copy entries into /todo. 'ask' only when you ask or "
        "agree; 'auto' also copies every rumor there as it is noted.",
    ),
}

DEFAULTS = {key: spec[0] for key, spec in SETTINGS.items()}

GLYPHS = {
    "rpg": {
        "head": "📜 QUEST LOG", "main": "MAIN QUEST", "side": "SIDE QUESTS",
        "rumors": "RUMORS  (noticed, not acted on)", "finished": "FINISHED",
        "waiting": "⏸ AWAITING YOU",
        "done": "✔", "open": "○", "now": "▸", "failed": "✗", "parked": "→",
        "tracked": "▶", "paused": "⏸", "tracking": "◀ tracking",
        "turned_in": "turned in", "abandoned": "abandoned", "reward": "Reward",
        "t_accept": "📜 Quest accepted", "t_check": "✔ Objective complete",
        "t_objective": "➕ New objective", "t_fail": "✗ Objective failed",
        "t_link": "📜 Quest updated", "t_await": "⏸ Awaiting you",
        "t_turn_in": "🏆 Quest complete", "t_abandon": "✗ Quest abandoned",
        "t_rumor": "👂 Rumor noted", "t_todo": "→ Sent to /todo",
        "t_adopt": "📜 Quest resumed", "adopted": "continued in another session",
    },
    "plain": {
        "head": "Session log", "main": "Main task", "side": "Other tasks",
        "rumors": "Noticed, not acted on", "finished": "Finished",
        "waiting": "Waiting on you",
        "done": "[x]", "open": "[ ]", "now": "[>]", "failed": "[-]", "parked": "[~]",
        "tracked": ">", "paused": "!", "tracking": "<- current",
        "turned_in": "done", "abandoned": "abandoned", "reward": "Done when",
        "t_accept": "Started", "t_check": "Done", "t_objective": "New step",
        "t_fail": "Failed", "t_link": "Updated", "t_await": "Waiting on you",
        "t_turn_in": "Finished", "t_abandon": "Abandoned", "t_rumor": "Noted",
        "t_todo": "Sent to /todo",
        "t_adopt": "Resumed", "adopted": "continued in another session",
    },
}

# Shown once, in the terminal, the first session after an update. Keep each
# entry to a few lines: it interrupts someone who did not ask for it.
UPGRADE_NOTES = {
    "1.3.0": (
        # Kept under ~70 columns a line: the terminal indents hook output
        # by five, and an 80-column window wraps anything longer mid-line.
        "/quests 1.3.0 — new, off by default: the overlay.\n"
        "`/quests config overlay on` draws the log inside Claude Code:\n"
        "a quest pane with the shop and your inventory (/quest-pane),\n"
        "a toast as each change lands, and a band when a quest waits on you."
    ),
    "1.2.0": (
        "/quests 1.2.0 — finished work now earns gold 💰 and XP, across every repo.\n"
        "Spend gold at `/quests shop` on frames, bars, trophies and banners, and\n"
        "hang finished quests in `/quests trophies`. Your rank tops the log."
    ),
    "1.1.0": (
        "/quests 1.1.0 — the log is laid out like a game's quest log now. New:\n"
        "`/quests live` (the log beside Claude as it works), `/quests statusline`\n"
        "(the tracked quest under your prompt, set up for you) and `/quests done`."
    ),
    "1.0.0": (
        "/quests 1.0.0 — log changes now print as one summary line per turn. New:\n"
        "`/quests chronicle` (the session as markdown, for a PR or handoff), `/quests\n"
        "adopt` (unfinished quests from earlier sessions), and a status line (see the\n"
        "README). Allow `Bash(quest *)` to stop log writes asking. Details: /quests help"
    ),
}

ASK_CAP = 4000  # a pasted log shouldn't bloat the store; the quote shows 70 chars


# ---------------------------------------------------------------- paths / state

def _git(*args: str) -> str:
    try:
        out = subprocess.run(
            ("git",) + args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            universal_newlines=True, timeout=5
        )
        return out.stdout.rstrip("\n") if out.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def project_root() -> str:
    """git toplevel, deliberately ignoring CLAUDE_PROJECT_DIR.

    Hooks get that variable but Claude's own Bash calls don't, so honouring it
    splits the writer from the reader. Same bug, same fix, as /todo.
    """
    return _git("rev-parse", "--show-toplevel").strip() or str(Path.cwd().resolve())


def slug(path: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "-", path)


def config_dir() -> Path:
    return Path(os.environ.get("CLAUDE_CONFIG_DIR") or (Path.home() / ".claude"))


def store_base() -> Path:
    override = os.environ.get("CLAUDE_QUESTS_DIR")
    return Path(override) if override else config_dir() / "quests"


def config_path() -> Path:
    return store_base() / "config.json"


def read_config_file() -> dict:
    path = config_path()
    if path.exists():
        try:
            return json.loads(path.read_text()) or {}
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n")
    os.replace(tmp, path)  # atomic; a hook and a CLI call can't clobber


# Gold and XP are the profile's, not the session's: one purse across every repo
# and session, next to config.json. Paid once per objective and once per quest,
# however often a quest is reopened, turned in again or adopted. Gold is spent
# in the shop; XP is never spent, and sets the rank.
GOLD = "💰"
GOLD_OBJECTIVE, GOLD_QUEST = 1, 2
XP_OBJECTIVE, XP_QUEST = 10, 20
RANKS = (("Apprentice", 0), ("Journeyman", 301), ("Artificer", 1001), ("Archmage", 2001))
PLAQUE_PRICE = 3
BANNER_CELLS = 24  # a custom banner has to share the header with the project

# Bought once, then equipped or not from the inventory. Price 0 is the look
# everyone starts with, and what unequipping falls back to.
SHOP = {
    "rounded": {"slot": "frame", "name": "Rounded frame", "price": 0, "look": ("╭", "╮", "╰", "╯", "─")},
    "double": {"slot": "frame", "name": "Double frame", "price": 10, "look": ("╔", "╗", "╚", "╝", "═")},
    "heavy": {"slot": "frame", "name": "Heavy frame", "price": 10, "look": ("┏", "┓", "┗", "┛", "━")},
    "ascii": {"slot": "frame", "name": "ASCII frame", "note": "for any terminal", "price": 5, "look": ("+", "+", "+", "+", "-")},
    "classic": {"slot": "bar", "name": "Classic bar", "price": 0, "look": ("▰", "▱")},
    "blocks": {"slot": "bar", "name": "Blocks bar", "price": 5, "look": ("■", "□")},
    "beads": {"slot": "bar", "name": "Beads bar", "price": 5, "look": ("●", "○")},
    "hearts": {"slot": "bar", "name": "Hearts bar", "price": 8, "look": ("♥", "♡")},
    "cup": {"slot": "trophy", "name": "Cup trophy", "note": "marks completed quests", "price": 0, "look": "🏆"},
    "crown": {"slot": "trophy", "name": "Crown trophy", "note": "marks completed quests", "price": 15, "look": "👑"},
    "gem": {"slot": "trophy", "name": "Gem trophy", "note": "marks completed quests", "price": 25, "look": "💎"},
    "refactorer": {"slot": "banner", "name": "Refactorer banner", "price": 8, "look": "the Refactorer"},
    "bugslayer": {"slot": "banner", "name": "Bug Slayer banner", "price": 8, "look": "Bug Slayer"},
    "buildkeeper": {"slot": "banner", "name": "Keeper banner", "price": 8, "look": "Keeper of the Build"},
    "custom": {"slot": "banner", "name": "Custom banner", "note": "your own words", "price": 20, "look": None},
}
SLOTS = {"frame": "rounded", "bar": "classic", "trophy": "cup", "banner": None}


def wallet_path() -> Path:
    return store_base() / "wallet.json"


def read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def count(value: object) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


_WALLET: "tuple[int, dict] | None" = None


def wallet() -> dict:
    """The purse, re-read when the file changes so the live view keeps up."""
    global _WALLET
    path = wallet_path()
    try:
        stamp = path.stat().st_mtime_ns
    except OSError:
        stamp = 0
    if _WALLET is None or _WALLET[0] != stamp:
        purse = read_json(path)
        purse["gold"] = count(purse.get("gold"))
        if "xp" not in purse:  # a purse from before XP: nothing had been spent, so gold is what was earned
            purse["xp"] = purse["gold"] * XP_OBJECTIVE // GOLD_OBJECTIVE
        purse["xp"] = count(purse["xp"])
        for key, empty in (("owned", []), ("equipped", {}), ("plaques", [])):
            if not isinstance(purse.get(key), type(empty)):
                purse[key] = empty
        _WALLET = (stamp, purse)
    return _WALLET[1]


def save_wallet(purse: dict) -> None:
    global _WALLET
    purse["updated"] = now()
    write_json(wallet_path(), purse)
    _WALLET = (wallet_path().stat().st_mtime_ns, purse)


def gold() -> int:
    return wallet()["gold"]


def rank(xp: int) -> "tuple[str, int, tuple[str, int] | None]":
    """The rank for `xp`, where it starts, and the next one, if any."""
    i = max(n for n, (_, floor) in enumerate(RANKS) if xp >= floor)
    return RANKS[i][0], RANKS[i][1], RANKS[i + 1] if i + 1 < len(RANKS) else None


def earn(state: dict, quest: dict, coins: int, xp: int) -> None:
    purse = wallet()
    before = rank(purse["xp"])[0]
    purse["gold"] += coins
    purse["xp"] += xp
    save_wallet(purse)
    after = rank(purse["xp"])[0]
    if after != before:
        logged(state, f"🏅 Rank up: {after}", "rank", quest)


def owns(item: str) -> bool:
    return SHOP[item]["price"] == 0 or item in wallet()["owned"]


def equipped(slot: str) -> "str | None":
    item = wallet()["equipped"].get(slot, SLOTS[slot])
    return item if item in SHOP and SHOP[item]["slot"] == slot and owns(item) else SLOTS[slot]


def look(slot: str):
    item = equipped(slot)
    if item == "custom":
        return wallet().get("banner_text") or None
    return SHOP[item]["look"] if item else None


def write_config_value(key: str, value: object) -> None:
    stored = read_config_file()
    stored[key] = value
    write_json(config_path(), stored)


ALIASES = {("toasts", "on"): "summary"}  # 0.1.0's value


def coerce(key: str, raw: object) -> str:
    value = str(raw).strip().lower()
    value = ALIASES.get((key, value), value)
    accepted = SETTINGS[key][1]
    if value not in accepted:
        raise ValueError(f"{key} must be one of: {', '.join(accepted)}")
    return value


def load_config() -> "tuple[dict, dict]":
    """Effective config plus where each value came from: env > config.json > default."""
    values = dict(DEFAULTS)
    sources = {k: "default" for k in DEFAULTS}
    for key, raw in read_config_file().items():
        if key in DEFAULTS:
            try:
                values[key], sources[key] = coerce(key, raw), "config.json"
            except ValueError:
                pass  # a bad stored value must not break the hooks
    for key in DEFAULTS:
        env = os.environ.get("CLAUDE_QUESTS_" + key.upper())
        if env is not None:
            try:
                values[key], sources[key] = coerce(key, env), "env"
            except ValueError:
                pass
    return values, sources


_CFG: "tuple[dict, dict] | None" = None


def cfg() -> dict:
    global _CFG
    if _CFG is None:
        _CFG = load_config()
    return _CFG[0]


def cfg_sources() -> dict:
    cfg()
    return _CFG[1]


def glyphs() -> dict:
    return GLYPHS[cfg()["style"]]


def session_id(explicit: "str | None" = None) -> str:
    return explicit or os.environ.get("CLAUDE_CODE_SESSION_ID") or "no-session"


def state_path(sid: str, root: str) -> Path:
    return store_base() / slug(root) / f"{sid}.json"


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


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
        "turn": 0,
        "tracked": None,
        "next_id": 1,
        "next_rumor": 1,
        "asks": [],
        "quests": [],
        "rumors": [],
        "unlogged_files": [],  # edited since the last log write; see hook_post_tool
        "toasts": [],          # flushed to the terminal by the Stop hook
    }


# ------------------------------------------------------------------- helpers

def one_line(text: "str | None") -> str:
    return " ".join((text or "").split())


def clip(text: str, width: int = 70) -> str:
    text = one_line(text)
    return text if len(text) <= width else text[:width - 1].rstrip() + "…"


def is_open(quest: dict) -> bool:
    return quest["status"] in ("active", "awaiting")


def find_quest(state: dict, ident: "str | int") -> "dict | None":
    try:
        qid = int(str(ident).lstrip("#"))
    except ValueError:
        return None
    return next((q for q in state["quests"] if q["id"] == qid), None)


def find_ask(state: dict, aid: int) -> "dict | None":
    return next((a for a in state["asks"] if a["id"] == aid), None)


def progress(quest: dict) -> "tuple[int, int]":
    counted = [o for o in quest["objectives"] if o["state"] != "parked"]
    return sum(o["state"] == "done" for o in counted), len(counted)


def current_objective(quest: dict) -> "tuple[int, dict] | None":
    for n, obj in enumerate(quest["objectives"], 1):
        if obj["state"] == "open":
            return n, obj
    return None


def retrack(state: dict) -> None:
    """After the tracked quest closes, follow the newest open main, else side.

    Active quests win, but an awaiting one is still better than nothing: it's
    where the work resumes once the user answers. Its status is left alone.
    """
    open_quests = [q for q in state["quests"] if is_open(q)]
    open_quests.sort(key=lambda q: (q["status"] != "active", q["kind"] != "main", -q["id"]))
    state["tracked"] = open_quests[0]["id"] if open_quests else None


def reopen(state: dict, quest: dict, why: str) -> None:
    """New work on a finished quest puts it back in play, rather than hanging
    objectives off something the log says is done. The journal keeps why."""
    if is_open(quest):
        return
    quest["journal"].append({"turn": state["turn"], "text": f"Reopened ({quest['status']}): {why}"})
    quest["status"], quest["done_at"], quest["awaiting"] = "active", None, None
    state["tracked"] = quest["id"]


def logged(state: dict, toast: "str | None" = None, kind: "str | None" = None,
           quest: "dict | None" = None) -> None:
    """Every write through the CLI counts as Claude keeping the log current.

    A toast keeps its styled line (for `toasts: full`) and what happened to
    which quest (for the one-line summary the Stop hook prints by default).
    """
    state["unlogged_files"] = []
    state["unlogged_commits"] = 0
    state["last_log_turn"] = state.get("turn", 0)
    if toast:
        state.setdefault("toasts", []).append({
            "text": toast, "kind": kind,
            "quest": quest["id"] if quest else None,
            "title": quest["title"] if quest else None,
        })


def git_context() -> dict:
    return {
        "branch": _git("rev-parse", "--abbrev-ref", "HEAD").strip() or None,
        "sha": _git("rev-parse", "--short", "HEAD").strip() or None,
    }


def parse_flags(argv: "list[str]", names: "set[str]") -> "tuple[list[str], dict[str, list[str]]]":
    """Positional words plus `--flag value...` pairs; flags may repeat.

    Multi-word values are accepted unquoted, as in /todo, since Claude
    sometimes forgets the quotes and a lost word is worse than a lenient parser.
    """
    positional: "list[str]" = []
    found: "dict[str, list[str]]" = {}
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
            found.setdefault(key, []).append(" ".join(parts))
        else:
            positional.append(token)
            i += 1
    return positional, found


def first(flags: "dict[str, list[str]]", key: str) -> str:
    return one_line(flags.get(key, [""])[-1])


def parse_ids(raw: "list[str]") -> "list[int]":
    ids: "list[int]" = []
    for chunk in raw:
        for part in re.split(r"[\s,]+", chunk.strip()):
            part = part.lstrip("#")
            if part.isdigit() and int(part) not in ids:
                ids.append(int(part))
    return ids


# ----------------------------------------------------------------- rendering

def ask_quote(state: dict, quest: dict) -> "str | None":
    inherited = quest.get("inherited_asks") or []
    if inherited:
        ask, where = inherited[0], ", earlier session"
    elif quest["asks"] and find_ask(state, quest["asks"][0]):
        ask, where = find_ask(state, quest["asks"][0]), ""
    else:
        return None
    line = f'"{clip(ask["text"])}" — you, turn {ask["turn"]}{where}'
    later = len(inherited) + len(quest["asks"]) - 1
    if later:
        line += f"  (+{later} later)"
    return line


def objective_lines(quest: dict, g: dict, lead: str, tracked: bool) -> "list[str]":
    cur = current_objective(quest)
    lines = []
    for n, obj in enumerate(quest["objectives"], 1):
        if obj["state"] == "open":
            mark = g["now"] if cur and cur[0] == n else g["open"]
        else:
            mark = g[obj["state"]]
        line = f"{lead}{mark} {n}. {obj['text']}"
        if obj["state"] == "parked" and obj.get("todo"):
            line += f"  (/todo #{obj['todo']})"
        if tracked and cur and cur[0] == n:
            line += f"   {g['tracking']}"
        lines.append(line)
    return lines


def quest_block(state: dict, quest: dict, g: dict) -> "list[str]":
    tracked = state.get("tracked") == quest["id"]
    mark = g["paused"] if quest["status"] == "awaiting" else g["tracked"] if tracked else " "
    done, total = progress(quest)
    head = f"{mark} #{quest['id']} {quest['title']}"
    if total:
        head += f"  [{done}/{total}]"
    lines = [head]
    quote = ask_quote(state, quest)
    if quote:
        lines.append(f"    {quote}")
    if quest["status"] == "awaiting":
        lines.append(f"    Needs from you: {quest['awaiting']}")
    lines += objective_lines(quest, g, "    ", tracked)
    if quest.get("reward"):
        lines.append(f"    {g['reward']}: {quest['reward']}")
    return lines


# ------------------------------------------------------------ rpg quest log

WIDTH = 76      # the frame; fits an 80-column terminal
BAR = 8         # progress bar cells
RECENT_DONE = 3  # completed quests shown with their outcome; the rest are counted


def cells(text: str) -> int:
    """Terminal columns `text` takes: wide characters (most emoji) count two."""
    width = 0
    for ch in text:
        if unicodedata.combining(ch) or ch == "\ufe0f":
            continue
        width += 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
    return width


def fit(text: str, width: int) -> str:
    """Clip to `width` columns, with an ellipsis when anything was cut."""
    text = one_line(text)
    if cells(text) <= width:
        return text
    out = ""
    for ch in text:
        if cells(out + ch) > width - 1:
            break
        out += ch
    return out.rstrip() + "…"


def wrap(text: str, width: int) -> "list[str]":
    lines, line = [], ""
    for word in one_line(text).split(" "):
        if line and cells(line) + 1 + cells(word) > width:
            lines.append(line)
            line = word
        else:
            line = f"{line} {word}" if line else word
    return lines + ([line] if line else [])


def meter(fraction: float, size: int = BAR) -> str:
    """A bar in the equipped skin."""
    full, empty = look("bar")
    filled = round(size * min(1.0, max(0.0, fraction)))
    return full * filled + empty * (size - filled)


def bar(quest: dict) -> str:
    done, total = progress(quest)
    if not total:
        return ""
    return meter(done / total) + f" {done}/{total}"


def rule(left: str, right: str, top: bool = True) -> str:
    """`╭─ left ──────── right ─╮` in the equipped frame, exactly WIDTH columns."""
    tl, tr, bl, br, line = look("frame")
    corner_l, corner_r = (tl, tr) if top else (bl, br)
    left = f"{corner_l}{line} {left} "
    right = f" {right} {line}{corner_r}" if right else f"{line}{corner_r}"
    return left + line * max(2, WIDTH - cells(left) - cells(right)) + right


def spread(left: str, right: str) -> str:
    """`left` and `right` at either end of a WIDTH-column row."""
    return left + " " * max(1, WIDTH - cells(left) - cells(right)) + right


def rank_row() -> str:
    """` 🏅 JOURNEYMAN · 150 xp ........ ▰▰▰▱▱▱▱▱ 151 to Artificer`"""
    xp = wallet()["xp"]
    name, floor, up = rank(xp)
    if up:
        right = meter((xp - floor) / (up[1] - floor)) + f" {up[1] - xp} to {up[0]}"
    else:
        right = meter(1) + " max rank"
    return spread(f" 🏅 {name.upper()} · {xp} xp", right)


def title_banner(head: str) -> str:
    banner = look("banner")
    return f"{head} · ⚔ {fit(banner, BANNER_CELLS)}" if banner else head


def quest_row(quest: dict, lead: str) -> str:
    """`lead#id  title .......... ▰▰▱▱ 1/2`, the bar right-aligned in the frame."""
    ident = f"#{quest['id']}".ljust(3)
    progress_text = bar(quest)
    room = WIDTH - cells(lead) - len(ident) - 1 - (cells(progress_text) + 1 if progress_text else 0)
    title = fit(quest["title"], room)
    row = f"{lead}{ident} {title}"
    if progress_text:
        row += " " * (WIDTH - cells(row) - cells(progress_text)) + progress_text
    return row


def expanded(state: dict, quest: dict) -> "list[str]":
    """The tracked quest's objectives and reward, under its row."""
    lines = []
    cur = current_objective(quest)
    for n, obj in enumerate(quest["objectives"], 1):
        if obj["state"] == "open":
            mark = "▸" if cur and cur[0] == n else "○"
        else:
            mark = {"done": "✔", "failed": "✗", "parked": "→"}[obj["state"]]
        text = f"{n}. {obj['text']}"
        if obj["state"] == "parked" and obj.get("todo"):
            text += f"  (/todo #{obj['todo']})"
        lines.append(f"       {mark} " + fit(text, WIDTH - 9))
    if quest.get("reward"):
        lines.append("       🎁 " + fit(quest["reward"], WIDTH - 10))
    return lines


def closed_row(quest: dict) -> str:
    later = len(quest.get("inherited_asks") or []) + len(quest["asks"]) - 1
    title = fit(quest["title"], 30) + (f" (+{later} later ask{'s' * (later > 1)})" if later > 0 else "")
    if quest["status"] == "done":
        mark, tail = "✔", quest.get("outcome") or "turned in"
    elif quest["status"] == "parked":
        mark, tail = "→", f"sent to /todo #{quest.get('todo')}"
    elif quest["status"] == "adopted":
        mark, tail = "→", "continued in another session"
    else:
        mark, tail = "✗", "abandoned" + (": " + quest["outcome"][11:] if (quest.get("outcome") or "").startswith("Abandoned: ") else "")
    row = f"   {mark} #{quest['id']} {title}"
    room = WIDTH - cells(row) - 3
    return row + (" — " + fit(tail, room) if room >= 12 else "")


def tips(state: dict) -> "list[str]":
    """The /quests commands that would do something right now, for the log's
    foot, so the argument hint can stay short."""
    open_quests = any(is_open(q) for q in state["quests"])
    rumors = any(not r.get("quest") and not r.get("todo") for r in state["rumors"])
    out = []
    if open_quests:
        out += ["track <n>", "abandon <n> [reason]"]
    if open_quests or rumors:
        out.append("todo " + "|".join((["<n>", "<n.m>"] if open_quests else []) + (["r<n>"] if rumors else [])))
    if carryover(state.get("project") or project_root(), state["session_id"], siblings=True):
        out.append("adopt")
    return out


def render_rpg(state: dict, live: "str | None" = None, all_done: bool = False) -> str:
    quests = state["quests"]
    tracked = state.get("tracked")
    rumors = [r for r in state["rumors"] if not r.get("quest") and not r.get("todo")]
    project = Path(state.get("project") or project_root()).name
    out = [rule(title_banner("📜 QUEST LOG"), f"{project} · turn {state.get('turn', 0)}"), rank_row(), ""]

    waiting = [q for q in quests if q["status"] == "awaiting"]
    active = sorted((q for q in quests if q["status"] == "active"),
                    key=lambda q: (q["id"] != tracked, q["kind"] != "main", q["id"]))
    closed = sorted((q for q in quests if not is_open(q)),
                    key=lambda q: (q.get("done_at") or "", q["id"]), reverse=True)

    if not quests and not rumors:
        out.append("   Nothing logged yet this session.")
    if waiting:
        out.append(" ❓ AWAITING YOU")
        for quest in waiting:
            out.append(quest_row(quest, " ▶ " if quest["id"] == tracked else "   "))
            question = wrap(quest["awaiting"] or "", WIDTH - 9)
            for i, line in enumerate(question):
                out.append("       " + ("“" if i == 0 else " ") + line + ("”" if i == len(question) - 1 else ""))
            if quest["id"] == tracked:
                out += expanded(state, quest)
        out.append("")
    if active:
        out.append(" ⚔ ACTIVE")
        for quest in active:
            out.append(quest_row(quest, " ▶ " if quest["id"] == tracked else "   "))
            if quest["id"] == tracked:
                out += expanded(state, quest)
        out.append("")
    if rumors:
        out.append(" 👂 RUMORS")
        out += [f"   r{r['id']}  " + fit(r["text"], WIDTH - 6 - len(str(r["id"]))) for r in rumors]
        out.append("")
    if closed:
        out.append(f" {look('trophy')} COMPLETED ({len(closed)})")
        shown = closed if all_done else closed[:RECENT_DONE]
        out += [closed_row(q) for q in shown]
        if len(closed) > len(shown):
            out.append(f"     + {len(closed) - len(shown)} more · /quests done lists them all")
        out.append("")

    purse = f"{gold()} {GOLD}"
    if live:
        out.append(rule(live, purse, top=False))
    else:
        hints = tips(state)
        if hints:
            if out[-1]:
                out.append("")
            out.append(" 💡 " + fit("/quests " + " · ".join(hints), WIDTH - 4))
        focus = f"/quests {tracked} full entry · " if tracked else ""
        out.append(rule(focus + "/quests help", purse, top=False))
        if cfg_sources()["style"] == "default":
            out.append("tip: `/quests config style plain` drops the flavor and saves tokens")
    return "\n".join(out)


def render_log(state: dict, live: "str | None" = None, all_done: bool = False) -> str:
    if cfg()["style"] == "rpg":
        return render_rpg(state, live, all_done)
    g = glyphs()
    quests = state["quests"]
    rumors = [r for r in state["rumors"] if not r.get("quest") and not r.get("todo")]
    project = Path(state.get("project") or project_root()).name
    head = f"{g['head']} — {project} · turn {state.get('turn', 0)}"
    if not quests and not rumors:
        return f"{head}\n\nNothing logged yet this session."

    out = [head]
    waiting = [q for q in quests if q["status"] == "awaiting"]
    if waiting:
        out += ["", f"{g['waiting']} ({len(waiting)})"]
        out += [f"  #{q['id']} {q['title']} — {q['awaiting']}" for q in waiting]

    for kind in ("main", "side"):
        group = [q for q in quests if q["kind"] == kind and is_open(q)]
        if group:
            out += ["", g[kind]]
            for quest in group:
                out += quest_block(state, quest, g)

    if rumors:
        out += ["", g["rumors"]]
        out += [f"  r{r['id']} {r['text']}" for r in rumors]

    closed = [q for q in quests if not is_open(q)]
    if closed:
        out += ["", g["finished"]]
        for quest in closed:
            later = len(quest.get("inherited_asks") or []) + len(quest["asks"]) - 1
            title = quest["title"] + (f" (+{later} later ask{'s' * (later > 1)})" if later > 0 else "")
            if quest["status"] == "done":
                # The outcome, not just "turned in": asks folded into a quest
                # that then finished were otherwise invisible from the log.
                out.append(f"  {g['done']} #{quest['id']} {title} — "
                           + (clip(quest["outcome"]) if quest.get("outcome") else g["turned_in"]))
            elif quest["status"] == "parked":
                out.append(f"  {g['parked']} #{quest['id']} {title} — /todo #{quest.get('todo')}")
            elif quest["status"] == "adopted":
                out.append(f"  {g['parked']} #{quest['id']} {title} — {g['adopted']}")
            else:
                out.append(f"  {g['failed']} #{quest['id']} {title} — {g['abandoned']}")

    if live:
        out += ["", live]
    else:
        out += ["", "`/quests <n>` shows a full entry · `/quests help` for everything else"]
        hints = tips(state)
        if hints:
            out.append("Also: /quests " + " · ".join(hints))
    return "\n".join(out)


def render_entry(state: dict, quest: dict) -> str:
    g = glyphs()
    status = {
        "active": "in progress", "awaiting": "waiting on you", "done": g["turned_in"],
        "abandoned": g["abandoned"], "parked": f"sent to /todo #{quest.get('todo')}",
        "adopted": f"{g['adopted']} ({str(quest.get('adopted_by'))[:8]})",
    }[quest["status"]]
    done, total = progress(quest)
    out = [f"QUEST #{quest['id']} — {quest['title']}",
           f"  {quest['kind']} · {status}" + (f" · {done}/{total} objectives" if total else "")]
    for ask in quest.get("inherited_asks") or []:
        out.append(f"  asked, turn {ask['turn']} of session {ask['session'][:8]}: \"{clip(ask['text'], 300)}\"")
    for aid in quest["asks"]:
        ask = find_ask(state, aid)
        if ask:
            out.append(f"  asked, turn {ask['turn']}: \"{clip(ask['text'], 300)}\"")
    if quest.get("why"):
        out.append(f"  why: {quest['why']}")
    if quest.get("reward"):
        out.append(f"  {g['reward'].lower()}: {quest['reward']}")
    if quest["status"] == "awaiting":
        out.append(f"  needs from you: {quest['awaiting']}")
    if quest["objectives"]:
        out += ["", "  objectives"]
        out += objective_lines(quest, g, "    ", state.get("tracked") == quest["id"])
    if quest["journal"]:
        out += ["", "  journal"]
        out += [f"    turn {j['turn']}: {j['text']}" for j in quest["journal"]]
    if quest.get("outcome"):
        out += ["", f"  outcome: {quest['outcome']}"]
    if quest.get("loot"):
        out.append("  loot: " + ", ".join(quest["loot"]))
    where = " ".join(x for x in (quest.get("branch"), quest.get("sha")) if x)
    if where:
        out.append(f"  accepted on {where} at {quest['created']}")
    return "\n".join(out)


def render_chronicle(state: dict) -> str:
    """The session as markdown, for a PR description or a handoff.

    Always plain: it leaves the terminal, so the rpg vocabulary would only get
    in the way of whoever reads it next.
    """
    project = Path(state.get("project") or project_root()).name
    quests = [q for q in state["quests"] if q["status"] != "adopted"]
    out = [f"# Chronicle — {project}", ""]
    if not quests:
        return "\n".join(out + ["Nothing logged yet this session."])
    finished = sum(q["status"] == "done" for q in quests)
    out += [f"{len(quests)} task(s) over {state.get('turn', 0)} turn(s); {finished} finished.", ""]
    status = {"active": "in progress", "awaiting": "waiting on you", "done": "done",
              "abandoned": "abandoned", "parked": "sent to /todo"}
    marks = {"done": "x", "open": " ", "failed": " ", "parked": " "}
    for quest in quests:
        out.append(f"## {quest['title']} — {status.get(quest['status'], quest['status'])}")
        out.append("")
        asks = [a["text"] for a in quest.get("inherited_asks") or []]
        asks += [a["text"] for a in (find_ask(state, i) for i in quest["asks"]) if a]
        for n, text in enumerate(asks):
            lead = "Asked" if n == 0 else "Then"
            out.append(f"> **{lead}:** {clip(text, 400)}")
            out.append(">")
        if asks:
            out.pop()
            out.append("")
        if quest.get("why"):
            out.append(f"**Why:** {quest['why']}  ")
        if quest.get("reward"):
            out.append(f"**Done means:** {quest['reward']}")
        if quest.get("why") or quest.get("reward"):
            out.append("")
        for obj in quest["objectives"]:
            note = {"failed": " _(failed)_", "parked": " _(sent to /todo)_"}.get(obj["state"], "")
            out.append(f"- [{marks.get(obj['state'], ' ')}] {obj['text']}{note}")
        if quest["objectives"]:
            out.append("")
        if quest["journal"]:
            out.append("**Decisions**")
            out += [f"- {j['text']}" for j in quest["journal"]]
            out.append("")
        if quest["status"] == "awaiting":
            out += [f"**Waiting on:** {quest['awaiting']}", ""]
        if quest.get("outcome"):
            out.append(f"**Outcome:** {quest['outcome']}  " if quest.get("loot") else f"**Outcome:** {quest['outcome']}")
        if quest.get("loot"):
            out.append("**Produced:** " + ", ".join(f"`{x}`" for x in quest["loot"]))
        if quest.get("outcome") or quest.get("loot"):
            out.append("")
    rumors = [r for r in state["rumors"] if not r.get("quest") and not r.get("todo")]
    if rumors:
        out += ["## Noticed, not acted on", ""] + [f"- {r['text']}" for r in rumors] + [""]
    return "\n".join(out).rstrip()


def render_for_claude(state: dict) -> str:
    """Plain, id-dense summary for re-injection. Never styled: it's for Claude."""
    lines = []
    for quest in state["quests"]:
        if not is_open(quest):
            continue
        done, total = progress(quest)
        status = " AWAITING USER: " + quest["awaiting"] if quest["status"] == "awaiting" else ""
        lines.append(f"#{quest['id']} [{quest['kind']}] {quest['title']} ({done}/{total}){status}")
        for n, obj in enumerate(quest["objectives"], 1):
            lines.append(f"   {quest['id']}.{n} [{obj['state']}] {obj['text']}")
    rumors = [r for r in state["rumors"] if not r.get("quest") and not r.get("todo")]
    if rumors:
        lines.append("rumors: " + "; ".join(f"r{r['id']} {r['text']}" for r in rumors))
    return "\n".join(lines) or "(no open quests)"


# ------------------------------------------------------ commands (Claude-facing)

def todo_origin(state: dict, tid: int) -> str:
    """Journal line for a quest started from /todo #tid, tracing it back to
    the rumor, objective or quest this log handed off, when it was one."""
    for rumor in state["rumors"]:
        if rumor.get("todo") == tid:
            return f"Began as rumor r{rumor['id']} (turn {rumor['turn']}), then /todo #{tid}."
    for other in state["quests"]:
        if other.get("todo") == tid:
            return f"Began as quest #{other['id']} ({other['title']}), then /todo #{tid}."
        for n, obj in enumerate(other["objectives"], 1):
            if obj.get("todo") == tid:
                return f"Began as objective {other['id']}.{n} of #{other['id']}, then /todo #{tid}."
    return f"Began as /todo #{tid}."


def cmd_accept(state: dict, flags: "dict[str, list[str]]") -> str:
    title = first(flags, "title")
    if not title:
        return "accept needs --title."
    kind = first(flags, "kind").lower()
    if not kind:
        has_main = any(q["kind"] == "main" and is_open(q) for q in state["quests"])
        kind = "side" if has_main else "main"
    if kind not in ("main", "side"):
        return f"--kind must be main or side (got {kind!r})."

    asks = parse_ids(flags.get("ask", []))
    missing = [a for a in asks if not find_ask(state, a)]
    if missing:
        recent = ", ".join(f"#{a['id']}" for a in state["asks"][-5:]) or "none"
        return f"No ask {', '.join(f'#{a}' for a in missing)}. Recent asks: {recent}."

    quest = {
        "id": state["next_id"],
        "kind": kind,
        "status": "active",
        "title": title,
        "why": first(flags, "why") or None,
        "reward": first(flags, "reward") or None,
        "asks": asks,
        "objectives": [
            {"text": one_line(o), "state": "open", "turn": state["turn"]}
            for o in flags.get("objective", []) if one_line(o)
        ],
        "journal": [],
        "awaiting": None,
        "outcome": None,
        "loot": [],
        "created": now(),
        "done_at": None,
    }
    quest.update(git_context())
    for aid in asks:
        find_ask(state, aid)["quest"] = quest["id"]

    rumor_ref = first(flags, "from-rumor").lstrip("r")
    if rumor_ref.isdigit():
        for rumor in state["rumors"]:
            if rumor["id"] == int(rumor_ref):
                rumor["quest"] = quest["id"]
                quest["journal"].append({"turn": state["turn"], "text": f"Began as rumor r{rumor['id']}."})

    todo_ref = first(flags, "from-todo").lstrip("#")
    if todo_ref.isdigit():
        quest["from_todo"] = int(todo_ref)
        quest["journal"].append({"turn": state["turn"], "text": todo_origin(state, int(todo_ref))})

    state["quests"].append(quest)
    state["next_id"] += 1
    state["tracked"] = quest["id"]
    logged(state, f"{glyphs()['t_accept']}: #{quest['id']} {title}", "accept", quest)
    n = len(quest["objectives"])
    return f"QUEST #{quest['id']} accepted ({kind}, tracked" + (f", objectives {quest['id']}.1-{quest['id']}.{n})" if n else ")")


def resolve_objective(state: dict, ref: str) -> "tuple[dict, int, dict] | str":
    match = re.fullmatch(r"#?(\d+)\.(\d+)", ref.strip())
    if not match:
        return f"'{ref}' is not an objective ref — write it as <quest>.<n>, like 2.3."
    quest = find_quest(state, match.group(1))
    if not quest:
        return f"No quest #{match.group(1)}."
    n = int(match.group(2))
    if not 1 <= n <= len(quest["objectives"]):
        return f"Quest #{quest['id']} has {len(quest['objectives'])} objective(s); no {n}."
    return quest, n, quest["objectives"][n - 1]


def cmd_mark(state: dict, refs: "list[str]", new_state: str) -> str:
    g = glyphs()
    results = []
    for ref in " ".join(refs).replace(",", " ").split():
        found = resolve_objective(state, ref)
        if isinstance(found, str):
            results.append(found)
            continue
        quest, n, obj = found
        obj["state"] = new_state
        obj["done_turn"] = state["turn"]
        if quest["status"] == "awaiting":
            quest["status"] = "active"  # progress means the block lifted
            quest["awaiting"] = None
        done, total = progress(quest)
        toast = g["t_check"] if new_state == "done" else g["t_fail"]
        logged(state, f"{toast}: {obj['text']} (#{quest['id']} {done}/{total})",
               "check" if new_state == "done" else "fail", quest)
        if new_state == "done" and not obj.get("paid"):
            obj["paid"] = True
            earn(state, quest, GOLD_OBJECTIVE, XP_OBJECTIVE)
        line = f"{quest['id']}.{n} {new_state} — #{quest['id']} {done}/{total}"
        if new_state == "done" and done == total:
            line += " — every objective done; turn it in once the reward is verified"
        results.append(line)
    return "\n".join(results) or "check needs an objective ref, like 2.3."


def cmd_objective(state: dict, pos: "list[str]") -> str:
    if len(pos) < 2:
        return 'usage: objective <quest> "<text>"'
    quest = find_quest(state, pos[0])
    if not quest:
        return f"No quest #{pos[0]}."
    text = one_line(" ".join(pos[1:]))
    reopen(state, quest, f"new objective: {text}")
    quest["objectives"].append({"text": text, "state": "open", "turn": state["turn"]})
    n = len(quest["objectives"])
    logged(state, f"{glyphs()['t_objective']}: {text} (#{quest['id']})", "objective", quest)
    return f"Objective {quest['id']}.{n} added."


def cmd_journal(state: dict, pos: "list[str]") -> str:
    if len(pos) < 2:
        return 'usage: journal <quest> "<decision and why>"'
    quest = find_quest(state, pos[0])
    if not quest:
        return f"No quest #{pos[0]}."
    quest["journal"].append({"turn": state["turn"], "text": one_line(" ".join(pos[1:]))})
    logged(state)  # journal lines are detail, not news; no toast
    return f"Journaled on #{quest['id']}."


def cmd_link(state: dict, pos: "list[str]") -> str:
    """A later ask that extends or redirects a quest. The original ask is kept."""
    if len(pos) < 2:
        return 'usage: link <quest> <ask> ["what changed"]'
    quest = find_quest(state, pos[0])
    if not quest:
        return f"No quest #{pos[0]}."
    ids = parse_ids([pos[1]])
    ask = find_ask(state, ids[0]) if ids else None
    if not ask:
        return f"No ask {pos[1]}."
    if ask["id"] not in quest["asks"]:
        quest["asks"].append(ask["id"])
    ask["quest"] = quest["id"]
    note = one_line(" ".join(pos[2:]))
    was_open = is_open(quest)
    reopen(state, quest, f"ask #{ask['id']}")
    if note:
        quest["journal"].append({"turn": state["turn"], "text": f"New orders (ask #{ask['id']}): {note}"})
    if quest["status"] == "awaiting":
        quest["status"], quest["awaiting"] = "active", None
    logged(state, f"{glyphs()['t_link']}: #{quest['id']} {quest['title']}", "link", quest)
    return f"Linked ask #{ask['id']} to #{quest['id']}" + ("." if was_open else " and reopened it.")


def cmd_await(state: dict, pos: "list[str]") -> str:
    if len(pos) < 2:
        return 'usage: await <quest> "<what you need from the user>"'
    quest = find_quest(state, pos[0])
    if not quest or not is_open(quest):
        return f"No open quest #{pos[0]}."
    quest["status"] = "awaiting"
    quest["awaiting"] = one_line(" ".join(pos[1:]))
    logged(state, f"{glyphs()['t_await']}: #{quest['id']} — {quest['awaiting']}", "await", quest)
    return f"#{quest['id']} is awaiting the user."


def cmd_track(state: dict, ident: str) -> str:
    quest = find_quest(state, ident)
    if not quest or not is_open(quest):
        return f"No open quest #{ident}."
    state["tracked"] = quest["id"]
    if quest["status"] == "awaiting":
        quest["status"], quest["awaiting"] = "active", None
    logged(state)
    return f"Tracking #{quest['id']} {quest['title']}."


def cmd_close(state: dict, pos: "list[str]", flags: "dict[str, list[str]]", status: str) -> str:
    if not pos:
        return f"usage: {'turn-in' if status == 'done' else 'abandon'} <quest> ..."
    quest = find_quest(state, pos[0])
    if not quest or not is_open(quest):
        return f"No open quest #{pos[0]}."
    g = glyphs()
    quest["status"] = status
    quest["done_at"] = now()
    quest["awaiting"] = None
    if status == "done":
        quest["outcome"] = first(flags, "outcome") or None
        quest["loot"] += [one_line(x) for x in flags.get("loot", []) if one_line(x)]
        toast = f"{g['t_turn_in']}: #{quest['id']} {quest['title']}"
    else:
        reason = first(flags, "reason") or one_line(" ".join(pos[1:]))
        quest["outcome"] = f"Abandoned: {reason}" if reason else "Abandoned."
        toast = f"{g['t_abandon']}: #{quest['id']} {quest['title']}"
    if state.get("tracked") == quest["id"]:
        retrack(state)
    logged(state, toast, "turn_in" if status == "done" else "abandon", quest)
    if status == "done" and not quest.get("paid"):
        quest["paid"] = True
        earn(state, quest, GOLD_QUEST, XP_QUEST)
    left = sum(o["state"] == "open" for o in quest["objectives"])
    note = f" ({left} objective(s) were still open)" if left else ""
    verb = "turned in" if status == "done" else "abandoned"
    return f"#{quest['id']} {verb}{note}."


def cmd_rumor(state: dict, pos: "list[str]", flags: "dict[str, list[str]]") -> str:
    text = one_line(" ".join(pos))
    if not text:
        return 'usage: rumor "<something worth doing that you did not act on>"'
    rumor = {"id": state["next_rumor"], "text": text, "turn": state["turn"], "created": now()}
    near = first(flags, "quest")
    if near and find_quest(state, near):
        rumor["near"] = find_quest(state, near)["id"]
    state["rumors"].append(rumor)
    state["next_rumor"] += 1
    logged(state, f"{glyphs()['t_rumor']}: {text}", "rumor")
    result = f"Rumor r{rumor['id']} noted."
    if cfg()["todo_handoff"] == "auto":
        result += "\n" + cmd_to_todo(state, f"r{rumor['id']}")
    return result


# ------------------------------------------------------------ /todo handoff

def todo_store_path(root: str, sid: str) -> Path:
    """Where claude-todo keeps this session's todos. Mirrors todo.py's rules."""
    override = os.environ.get("CLAUDE_TODO_DIR")
    base = Path(override) if override else config_dir() / "todos"
    return base / slug(root) / f"{sid}.json"


# The part of todo.py's store this script reads or relies on. tests/ checks it
# against todo.py itself, so a schema change there fails loudly here.
TODO_STATE_KEYS = {"session_id", "project", "next_id", "todos"}
TODO_ITEM_KEYS = {"id", "text", "status", "created", "mentions", "surfaced", "note",
                  "about", "detail", "plan", "done_at", "dirty_files", "diff_stat",
                  "cwd", "branch", "sha"}


def todo_schema_ok(todos: dict) -> bool:
    if not isinstance(todos, dict) or not TODO_STATE_KEYS <= set(todos):
        return False
    return all(isinstance(t, dict) and {"id", "text", "status"} <= set(t) for t in todos["todos"])


def cmd_to_todo(state: dict, ref: str) -> str:
    """Copy a rumor, objective or quest into /todo's store for this session.

    Writes todo.py's documented schema directly, since plugins can't call each
    other. Permission is enforced by the protocol, not here: Claude only calls
    this when the user asked or agreed, or for rumors under todo_handoff=auto.
    """
    ref = ref.strip().lstrip("#")
    note = None
    if re.fullmatch(r"r\d+", ref, re.IGNORECASE):
        entry = next((r for r in state["rumors"] if r["id"] == int(ref[1:])), None)
        if not entry:
            return f"No rumor {ref}."
        text, what = entry["text"], f"rumor {ref}"
        note = f"Noticed by Claude (quest-log, turn {entry['turn']}) and not acted on."
    elif "." in ref:
        found = resolve_objective(state, ref)
        if isinstance(found, str):
            return found
        quest, n, entry = found
        text, what = entry["text"], f"objective {ref}"
        note = f"Objective of quest #{quest['id']}: {quest['title']}."
    else:
        entry = find_quest(state, ref)
        if not entry:
            return f"No quest #{ref}."
        text, what = entry["title"], f"quest #{entry['id']}"
        note = " ".join(x for x in (entry.get("why"), entry.get("reward") and f"Done means: {entry['reward']}") if x) or None
    if entry.get("todo"):
        return f"{what} is already /todo #{entry['todo']}."

    root, sid = state.get("project") or project_root(), state["session_id"]
    path = todo_store_path(root, sid)
    fresh_store = not path.parent.parent.exists()
    try:
        todos = json.loads(path.read_text()) if path.exists() else None
    except (json.JSONDecodeError, OSError):
        return f"/todo's store at {path} is unreadable; nothing sent."
    if todos is not None and not todo_schema_ok(todos):
        return (f"/todo's store at {path} isn't in the format quest-log knows; nothing sent. "
                "claude-todo has probably changed its schema: update quest-log.")
    if todos is None:
        todos = {"session_id": sid, "project": root, "created": now(), "muted": False,
                 "turns": 0, "last_nudge_turn": 0, "last_nudge_at": time.time(),
                 "next_id": 1, "todos": []}
    todo = {
        "id": todos["next_id"], "text": text, "status": "open", "created": now(),
        "mentions": 1, "surfaced": 0, "note": note, "about": None, "detail": None,
        "plan": None, "done_at": None, "dirty_files": [], "diff_stat": "",
        "cwd": str(Path.cwd()), "source": "quest-log",
    }
    todo.update({k: v or "" for k, v in git_context().items()})
    todos["todos"].append(todo)
    todos["next_id"] += 1
    write_json(path, todos)

    entry["todo"] = todo["id"]
    if what.startswith("objective"):
        entry["state"] = "parked"
    elif what.startswith("quest"):
        entry["status"] = "parked"
        entry["done_at"] = now()
        if state.get("tracked") == entry["id"]:
            retrack(state)
    logged(state, f"{glyphs()['t_todo']}: {text} (#{todo['id']})", "todo")
    hint = " (no /todo store existed yet — install claude-todo to see it)" if fresh_store else ""
    return f"Sent {what} to /todo #{todo['id']}{hint}."


# ------------------------------------------------------------- carry-over

CARRYOVER_DAYS = 7  # how far back a new session looks for unfinished quests

_MAIN_SLUG: "dict[str, str]" = {}


# ------------------------------------------------------------------ the shop

SHOP_SECTIONS = (("frame", "⚒ FRAMES"), ("bar", "⚗ PROGRESS BARS"), ("trophy", "✦ TROPHIES"), ("banner", "⚑ BANNERS"))
MERCHANT = r"""
                           (   )
                          (    )
                           (    )
                          (    )
                            )  )
                           (  (                  /\
                            (_)                 /  \  /\
                    ________[_]________      /\/    \/  \
           /\      /\        ______    \    /   /\/\  /\/\
          /  \    //_\       \    /\    \  /\/\/    \/    \
   /\    / /\/\  //___\       \__/  \    \/
  /  \  /\/    \//_____\       \ |[]|     \
 /\/\/\/       //_______\       \|__|      \
/      \      /XXXXXXXXXX\                  \
        \    /_I_II  I__I_\__________________\
               I_I|  I__I_____[]_|_[]_____I
               I_II  I__I_____[]_|_[]_____I
               I II__I  I     XXXXXXX     I
            ~~~~~"   "~~~~~~~~~~~~~~~~~~~~~~~~
""".strip("\n").splitlines()

SAYINGS = (
    "Coin for comfort, traveller.",
    "Finest skins this side of the repo.",
    "No refunds. No merge conflicts.",
    "Back again? I kept the good stuff aside.",
    "Every frame hand-drawn, every bar hand-filled.",
    "Gold spends. XP stays. Choose wisely.",
    "A crown for the one who ships on Fridays.",
    "Mind the smoke, it's only the build.",
    "Looking is free. Mostly.",
    "They say an Archmage once bought the lot.",
)


def preview(item: str) -> str:
    """What an item looks like, for the shop and inventory rows."""
    spec = SHOP[item]
    if spec["slot"] == "frame":
        tl, tr, _, _, line = spec["look"]
        return tl + line * 2 + tr
    if spec["slot"] == "bar":
        return spec["look"][0] * 3 + spec["look"][1] * 2
    if spec["slot"] == "trophy":
        return spec["look"]
    return "⚑"


def ware_name(item: str) -> str:
    spec = SHOP[item]
    if item == "custom" and wallet().get("banner_text"):
        return f"{spec['name']} · ⚔ {wallet()['banner_text']}"
    if spec["slot"] == "banner" and spec["look"]:
        return f"{spec['name']} · ⚔ {spec['look']}"
    return spec["name"] + (f" · {spec['note']}" if spec.get("note") else "")


def ware_row(mark: str, item: str, name: str, status: str) -> str:
    art = preview(item) if item in SHOP else "▭"
    lead = f"   {mark}{item.ljust(12)} {art}" + " " * max(1, 11 - cells(art))
    return spread(lead + fit(name, WIDTH - cells(lead) - cells(status) - 2), status)


def render_shop() -> str:
    purse = wallet()
    out = [rule("TRINKETS AND TRONKETS 🏆", f"purse {purse['gold']} {GOLD}"), ""]
    out += list(MERCHANT)
    out += ["", f'           "{random.choice(SAYINGS)}"', ""]
    for slot, head in SHOP_SECTIONS:
        out.append(f" {head}")
        for item, spec in SHOP.items():
            if spec["slot"] != slot or not spec["price"]:
                continue
            if equipped(slot) == item:
                status = "◆ equipped"
            elif owns(item):
                status = "◇ owned"
            else:
                status = f"{spec['price']} {GOLD}"
            out.append(ware_row("", item, ware_name(item), status))
        out.append("")
    out.append(" ⚜ PLAQUES")
    out.append(ware_row("", "engrave", "A finished quest, hung in the hall",
                        f"{PLAQUE_PRICE} {GOLD} each"))
    out.append("")
    out.append(rule("/quests buy <item> · /quests inventory", "", top=False))
    return "\n".join(out)


def render_inventory() -> str:
    purse = wallet()
    out = [rule("🎒 INVENTORY", f"{purse['gold']} {GOLD}"), rank_row(), ""]
    for slot, head in SHOP_SECTIONS:
        items = [i for i, spec in SHOP.items() if spec["slot"] == slot and owns(i)]
        if not items:
            continue
        out.append(f" {head}")
        for item in items:
            on = equipped(slot) == item
            name = ware_name(item)
            if item == "custom" and not purse.get("banner_text"):
                name += " · /quests banner <text>"
            out.append(ware_row("◆ " if on else "◇ ", item, name, "equipped" if on else ""))
        out.append("")
    plaques = purse["plaques"]
    if plaques:
        out.append(f" ⚜ PLAQUES ({len(plaques)})")
        for p in plaques:
            out.append(spread(f"   {'◆' if p.get('shown', True) else '◇'} p{p['id']}".ljust(12)
                              + fit(p["title"], WIDTH - 30),
                              "on display" if p.get("shown", True) else "in storage"))
        out.append("")
    if len(out) == 3:
        out += ["   Only the clothes on your back. `/quests shop` has wares.", ""]
    out.append(rule("/quests equip <item> · /quests unequip <item>", "", top=False))
    return "\n".join(out)


def render_trophies() -> str:
    plaques = wallet()["plaques"]
    shown = [p for p in plaques if p.get("shown", True)]
    out = [rule(f"{look('trophy')} HALL OF TROPHIES", f"{len(shown)} on display"), ""]
    inner = WIDTH - 10
    for p in shown:
        body = [f"✦ {fit(p['title'], inner - 4)}", f"  {p.get('project', '')} · {p.get('date', '')} · p{p['id']}"]
        body += ["  " + line for line in wrap(p.get("outcome") or "", inner - 4)[:2]]
        out.append("    ┌" + "─" * inner + "┐")
        out += ["    │ " + line + " " * (inner - 1 - cells(line)) + "│" for line in body]
        out.append("    └" + "─" * inner + "┘")
    if not plaques:
        out.append(f"   The walls are bare. Turn in a quest, then /quests engrave <n> ({PLAQUE_PRICE} {GOLD}).")
    elif len(plaques) > len(shown):
        out.append(f"   + {len(plaques) - len(shown)} in storage · /quests inventory")
    out.append("")
    out.append(" 💡 /quests done lists this session's finished quests, to engrave")
    out.append(rule(f"/quests engrave <n> · /quests unequip p<n> stores one", "", top=False))
    return "\n".join(out)


def find_plaque(ref: str) -> "dict | None":
    match = re.fullmatch(r"p(\d+)", ref)
    return next((p for p in wallet()["plaques"] if match and p["id"] == int(match.group(1))), None)


def cmd_buy(item: str) -> str:
    item = item.lower()
    if item in ("engrave", "plaque"):
        return f"Plaques are engraved, not bought off the shelf: /quests engrave <quest> ({PLAQUE_PRICE} {GOLD})."
    spec = SHOP.get(item)
    if not spec:
        return f"No '{item}' in the shop. `/quests shop` lists the wares."
    if owns(item):
        return f"You already own the {spec['name']}. `/quests equip {item}` puts it on."
    purse = wallet()
    if purse["gold"] < spec["price"]:
        return f"Not enough gold: the {spec['name']} costs {spec['price']} {GOLD} and you have {purse['gold']}."
    purse["gold"] -= spec["price"]
    purse["owned"].append(item)
    purse["equipped"][spec["slot"]] = item
    save_wallet(purse)
    note = " Give it words with `/quests banner <text>`." if item == "custom" and not purse.get("banner_text") else ""
    return f"Bought the {spec['name']} for {spec['price']} {GOLD} and equipped it. {purse['gold']} {GOLD} left.{note}"


def cmd_equip(item: str) -> str:
    item = item.lower()
    plaque = find_plaque(item)
    if plaque:
        plaque["shown"] = True
        save_wallet(wallet())
        return f"Equipped p{plaque['id']}: it's on display in /quests trophies."
    spec = SHOP.get(item)
    if not spec:
        return f"No '{item}' to equip. `/quests inventory` lists what you own."
    if not owns(item):
        return f"You don't own the {spec['name']} yet: {spec['price']} {GOLD} at /quests shop."
    purse = wallet()
    purse["equipped"][spec["slot"]] = item
    save_wallet(purse)
    return f"Equipped the {spec['name']}."


def cmd_unequip(item: str) -> str:
    item = item.lower()
    plaque = find_plaque(item)
    if plaque:
        plaque["shown"] = False
        save_wallet(wallet())
        return f"Unequipped p{plaque['id']}: it's in storage, off the hall's walls."
    slot = item if item in SLOTS else SHOP.get(item, {}).get("slot")
    if not slot:
        return f"No '{item}' to unequip. `/quests inventory` lists what you own."
    current = equipped(slot)
    if item in SHOP and current != item:
        return f"The {SHOP[item]['name']} isn't equipped."
    if current == SLOTS[slot]:
        if not current:
            return "No banner to take off."
        return f"The {SHOP[current]['name']} is the one you started with; equip another instead."
    purse = wallet()
    purse["equipped"][slot] = SLOTS[slot]
    save_wallet(purse)
    back = f"back to the {SHOP[SLOTS[slot]]['name']}" if SLOTS[slot] else "no banner"
    return f"Unequipped the {SHOP[current]['name']}; {back}."


def cmd_banner(text: str) -> str:
    if not owns("custom"):
        return f"Your own banner needs the custom banner: {SHOP['custom']['price']} {GOLD}, `/quests buy custom`."
    purse = wallet()
    purse["banner_text"] = fit(text.strip().strip('"'), BANNER_CELLS)
    purse["equipped"]["banner"] = "custom"
    save_wallet(purse)
    return f"Banner set: ⚔ {purse['banner_text']}"


def cmd_engrave(state: dict, ident: str) -> str:
    quest = find_quest(state, ident)
    if not quest or quest["status"] != "done":
        return f"No quest #{ident} turned in this session to engrave."
    purse = wallet()
    if any(p.get("session") == state["session_id"] and p.get("quest") == quest["id"] for p in purse["plaques"]):
        return f"#{quest['id']} is already hanging in the hall."
    if purse["gold"] < PLAQUE_PRICE:
        return f"Not enough gold: a plaque costs {PLAQUE_PRICE} {GOLD} and you have {purse['gold']}."
    pid = max([p["id"] for p in purse["plaques"]] + [0]) + 1
    purse["gold"] -= PLAQUE_PRICE
    purse["plaques"].append({
        "id": pid, "title": quest["title"], "outcome": quest.get("outcome"),
        "project": Path(state.get("project") or project_root()).name,
        "date": (quest.get("done_at") or now())[:10],
        "session": state["session_id"], "quest": quest["id"], "shown": True,
    })
    save_wallet(purse)
    return f"Engraved #{quest['id']} as plaque p{pid} for {PLAQUE_PRICE} {GOLD}; it's up in /quests trophies."


def armory() -> dict:
    """The purse, the wares and the hall as data, for the overlay's shop,
    inventory and trophies (hooks/overlay.tsx). Prices, looks and what's
    owned stay defined here; the overlay only draws them and presses
    buy / equip / unequip / engrave / banner through `dispatch`."""
    purse = wallet()
    name, floor, up = rank(purse["xp"])
    wares = []
    for slot, head in SHOP_SECTIONS:
        for item, spec in SHOP.items():
            if spec["slot"] == slot:
                wares.append({
                    "id": item, "slot": slot, "section": head, "name": ware_name(item),
                    "price": spec["price"], "preview": preview(item),
                    "owned": owns(item), "equipped": equipped(slot) == item,
                })
    bar = look("bar")
    return {
        "gold": purse["gold"], "xp": purse["xp"],
        "rank": {"name": name, "floor": floor,
                 "next": {"name": up[0], "floor": up[1]} if up else None},
        "look": {"bar": list(bar), "trophy": look("trophy"), "banner": look("banner")},
        "wares": wares,
        "plaque_price": PLAQUE_PRICE,
        "plaques": [dict({k: p.get(k) for k in ("id", "title", "outcome", "project", "date", "session", "quest")},
                         shown=p.get("shown", True)) for p in purse["plaques"]],
    }


def main_repo_slug(root: str) -> str:
    """Slug of this repo's main checkout, the same for every worktree of it."""
    if root not in _MAIN_SLUG:
        common = _git("-C", root, "rev-parse", "--git-common-dir").strip()
        if common:
            path = Path(common)
            main = (path if path.is_absolute() else Path(root) / path).resolve().parent
            _MAIN_SLUG[root] = slug(str(main))
        else:
            _MAIN_SLUG[root] = ""
    return _MAIN_SLUG[root]


def project_stores(root: str, siblings: bool) -> "list[Path]":
    """This project's store dir, plus its worktrees' when `siblings`. Same rules
    as /todo: automatic carry-over stays in the project, `adopt` looks wider."""
    own = store_base() / slug(root)
    prefix = main_repo_slug(root) if siblings else ""
    if not prefix or not store_base().is_dir():
        return [own]
    try:
        others = sorted(d for d in store_base().iterdir()
                        if d.is_dir() and d.name.startswith(prefix) and d != own)
    except OSError:
        others = []
    return [own] + others


def carryover(root: str, sid: str, siblings: bool = False) -> "list[tuple[Path, dict, dict]]":
    """Open quests in other recent sessions: (file, that session's state, quest).

    Newest file first, then by quest id, so the numbers `/quests adopt` prints
    stay stable between listing and acting.
    """
    cutoff = time.time() - CARRYOVER_DAYS * 86400
    files: "list[Path]" = []
    for directory in project_stores(root, siblings):
        try:
            files += [f for f in directory.glob("*.json")
                      if f.stem != sid and f.stat().st_mtime >= cutoff]
        except OSError:
            continue
    files.sort(key=lambda p: (-p.stat().st_mtime, p.name))
    found = []
    for f in files:
        try:
            other = json.loads(f.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        for quest in sorted(other.get("quests", []), key=lambda q: q["id"]):
            if is_open(quest):
                found.append((f, other, quest))
    return found


def source_label(path: Path, root: str) -> str:
    label = f"session {path.stem[:8]}"
    if path.parent != store_base() / slug(root):
        label += f", {path.parent.name}"
    return label


def adopt_one(state: dict, path: Path, quest: dict) -> "dict | None":
    """Close a quest in its source session and continue it in this one."""
    try:
        source = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return None
    original = next((q for q in source.get("quests", []) if q["id"] == quest["id"]), None)
    if not original or not is_open(original):
        return None
    original.update(status="adopted", done_at=now(), adopted_by=state["session_id"])
    if source.get("tracked") == original["id"]:
        retrack(source)
    write_json(path, source)

    # The source's asks are numbered in its own session; carry their words.
    inherited = list(quest.get("inherited_asks", []))
    for aid in quest["asks"]:
        ask = find_ask(source, aid)
        if ask:
            inherited.append({"text": ask["text"], "turn": ask["turn"], "session": path.stem})
    moved = json.loads(json.dumps(quest))
    moved.update(id=state["next_id"], asks=[], inherited_asks=inherited,
                 status="active", awaiting=None)
    moved["journal"].append({"turn": state["turn"],
                             "text": f"Adopted from session {path.stem[:8]} (was #{quest['id']})."})
    if quest["status"] == "awaiting":
        moved["journal"].append({"turn": state["turn"],
                                 "text": f"Was awaiting the user there: {quest['awaiting']}"})
    state["quests"].append(moved)
    state["next_id"] += 1
    state["tracked"] = moved["id"]
    return moved


def cmd_adopt(state: dict, target: "str | None") -> str:
    root = state.get("project") or project_root()
    candidates = carryover(root, state["session_id"], siblings=True)
    if not candidates:
        return "Nothing to adopt — no open quests in other recent sessions of this repo."
    if not target:
        lines = ["Unfinished quests from other sessions:"]
        for i, (path, _, quest) in enumerate(candidates, 1):
            done, total = progress(quest)
            waiting = "  (was awaiting you)" if quest["status"] == "awaiting" else ""
            lines.append(f"  {i}. {quest['title']}  [{done}/{total}]  ({source_label(path, root)}){waiting}")
        lines += ["", "`/quests adopt <n>` continues one here, `/quests adopt all` takes them all."]
        return "\n".join(lines)
    if target.lower() == "all":
        chosen = candidates
    else:
        index = int(target)
        if not 1 <= index <= len(candidates):
            return f"No candidate {index}. `/quests adopt` lists {len(candidates)}."
        chosen = [candidates[index - 1]]
    moved = [m for m in (adopt_one(state, p, q) for p, _, q in chosen) if m]
    if not moved:
        return "Those quests are no longer open in their sessions — run `/quests adopt` again."
    for m in moved:
        logged(state, f"{glyphs()['t_adopt']}: #{m['id']} {m['title']}", "adopt", m)
    return "Adopted " + ", ".join(f"#{m['id']} {m['title']}" for m in moved) + "."


# ------------------------------------------------------------------ live view

def latest_session(root: str) -> "Path | None":
    """The most recently written log in this project: the session being worked."""
    try:
        logs = [f for f in (store_base() / slug(root)).glob("*.json")]
    except OSError:
        return None
    return max(logs, key=lambda f: f.stat().st_mtime) if logs else None


def watch(sid: "str | None", once: bool = False) -> int:
    """Redraw the log whenever it changes, until ctrl-c. Read-only.

    With a session id it follows that session; without one, whichever session
    in this project wrote last, so a new session is picked up by itself.
    """
    root = project_root()
    seen: object = ()  # never a real stamp, so the first pass always draws
    try:
        while True:
            path = state_path(sid, root) if sid else latest_session(root)
            try:
                stamp = (path, path.stat().st_mtime) if path else None
            except OSError:
                stamp = None
            if stamp != seen:
                seen = stamp
                if stamp:
                    body = render_log(load(path, path.stem, root),
                                      live=f"live · session {path.stem[:8]} · ctrl-c to close")
                else:
                    body = f"{glyphs()['head']} — {Path(root).name}\n\nNo log yet; waiting for Claude to start one."
                if not once:
                    sys.stdout.write("\033[H\033[2J")
                sys.stdout.write(f"{body}\n")
                sys.stdout.flush()
            if once:
                return 0
            time.sleep(0.5)
    except KeyboardInterrupt:
        return 0


def launch_live(sid: str, root: str) -> str:
    """Open `quest watch` beside Claude, in whatever the terminal allows.

    Splits where a terminal can be scripted to: tmux, iTerm2, WezTerm, kitty.
    Elsewhere on macOS it opens a Terminal window, since IDE terminals (and
    Terminal.app itself) can't be split from a command. The command is always
    printed too, to paste into a split you open yourself.
    """
    cmd = f"{shlex.quote(sys.executable)} {shlex.quote(cli())} watch --session {shlex.quote(sid)}"
    shell_cmd = f"cd {shlex.quote(root)} && {cmd}"
    env = os.environ
    tries = []
    if env.get("TMUX"):
        tries.append(("a tmux pane", ["tmux", "split-window", "-h", "-c", root, cmd]))
    if env.get("TERM_PROGRAM") == "iTerm.app":
        script = ('tell application "iTerm2"\n'
                  '  tell current session of current window\n'
                  '    set pane to (split vertically with default profile)\n'
                  '  end tell\n'
                  '  tell pane to write text ' + json.dumps(shell_cmd) + '\n'
                  'end tell')
        tries.append(("an iTerm2 pane", ["osascript", "-e", script]))
    if env.get("WEZTERM_PANE"):
        tries.append(("a WezTerm pane", ["wezterm", "cli", "split-pane", "--right", "--cwd", root,
                                         "--", "sh", "-c", cmd]))
    if env.get("KITTY_WINDOW_ID"):
        tries.append(("a kitty split", ["kitty", "@", "launch", "--location=vsplit", "--cwd", root,
                                        "sh", "-c", cmd]))
    if sys.platform == "darwin":
        script = 'tell application "Terminal" to do script ' + json.dumps(shell_cmd)
        tries.append(("a new Terminal window", ["osascript", "-e", script]))
    for where, argv in tries:
        try:
            ok = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=10).returncode == 0
        except (OSError, subprocess.SubprocessError):
            ok = False
        if ok:
            return f"LIVE: opened the log in {where}; it redraws as Claude works.\nOr, in a split of your own: {shell_cmd}"
    return f"LIVE: couldn't open a pane from here. Open a split and run:\n{shell_cmd}"


# ------------------------------------------------------ status line install

STATUS_MARK = "quest-log statusline"  # in every command we write, so we can find it again


def statusline_command() -> str:
    """The command for settings.json, pointing at whichever copy is newest.

    Installed from a marketplace, this file lives at
    .../quest-log/<version>/skills/quests/quest.py and the version directory
    changes on every update, so the command picks the newest one each time it
    runs. From a checkout, it points at the checkout.
    """
    here = Path(__file__).resolve()
    version_dir, plugin_dir = here.parents[2], here.parents[3]
    if plugin_dir.name == "quest-log" and re.fullmatch(r"\d+(\.\d+)*", version_dir.name):
        script = (f'"$(ls -d {shlex.quote(str(plugin_dir))}/*/ | sort -V | tail -1)'
                  'skills/quests/quest.py"')
    else:
        script = shlex.quote(str(here))
    return f"python3 {script} statusline  # {STATUS_MARK}"


def settings_path() -> Path:
    return config_dir() / "settings.json"


def cmd_statusline_install(on: bool) -> str:
    """`/quests statusline [on|off]`: the user asking us to edit their settings.

    Plugins can't contribute a statusLine, so this writes the user's own
    settings.json. An existing status line is kept: both run on the same input
    and their output is joined. `off` puts back exactly what was there.
    """
    path = settings_path()
    try:
        settings = json.loads(path.read_text()) if path.exists() else {}
    except (json.JSONDecodeError, OSError):
        return f"STATUS LINE: couldn't read {path} as JSON; nothing changed."
    if not isinstance(settings, dict):
        return f"STATUS LINE: {path} isn't a JSON object; nothing changed."
    current = settings.get("statusLine")
    current_cmd = current.get("command", "") if isinstance(current, dict) else ""
    ours = STATUS_MARK in current_cmd
    stored = read_config_file()

    if not on:
        if not ours:
            return "STATUS LINE: quest-log isn't in your status line; nothing changed."
        previous = stored.get("replaced_statusline")
        if previous:
            settings["statusLine"] = previous
        else:
            settings.pop("statusLine", None)
        write_json(path, settings)
        write_config_value("replaced_statusline", None)
        what = "your previous status line is back" if previous else "removed"
        return f"STATUS LINE: quest-log {what} in {path}. Takes effect on the next refresh."

    command = statusline_command()
    if ours:
        return f"STATUS LINE: already on in {path}."
    if current_cmd:
        write_config_value("replaced_statusline", current)
        other = current_cmd.rstrip().rstrip(";")
        command = (
            "input=$(cat); "
            f"a=$(printf '%s' \"$input\" | {{ {other}\n}}); "
            f"b=$(printf '%s' \"$input\" | {command.split('  #')[0]}); "
            "printf '%s' \"$a\"; [ -n \"$a\" ] && [ -n \"$b\" ] && printf ' · '; printf '%s' \"$b\""
            f"  # {STATUS_MARK}"
        )
        note = " after your existing one"
    elif current is not None:
        write_config_value("replaced_statusline", current)
        note = ""
    else:
        note = ""
    entry = dict(current) if isinstance(current, dict) else {}
    entry.update(type="command", command=command)
    settings["statusLine"] = entry
    if path.exists():
        backup = path.with_name(path.name + ".quest-log.bak")
        backup.write_text(path.read_text())
    write_json(path, settings)
    return (f"STATUS LINE: on{note}, in {path}. It survives plugin updates; "
            "`/quests statusline off` takes it out again.")


# --------------------------------------------------------- commands (user-facing)

def cmd_help() -> str:
    here = Path(__file__).resolve().parent
    return f"""HELP: /quests — what Claude has been asked, and where it's up to

READ
  /quests               The log: quests waiting on you, the main quest, side
                        quests, rumors, and what's finished. The tracked quest
                        is marked, with its next objective.
  /quests 3             Quest #3 in full: every ask quoted verbatim, why it
                        matters, what done means, objectives, the journal of
                        decisions, and what it produced.

STEER
  /quests track 3       Point Claude at #3 next.
  /quests abandon 3     Drop #3. Anything after it is kept as the reason.
  /quests todo 3        Send quest #3 to /todo for later. Also 3.2 for one
  /quests todo r1       objective, r1 for a rumor. This is how you give
                        permission; Claude never sends anything on its own
                        unless todo_handoff is 'auto'.
  /quests adopt         Unfinished quests from other recent sessions of this
                        repo, including its worktrees, numbered.
  /quests adopt 2       Continue #2 in this session (or `adopt all`).

WATCH
  /quests live          The log in a pane beside Claude, redrawn as it works.
                        Splits tmux, iTerm2, WezTerm and kitty; elsewhere on
                        macOS opens a Terminal window. Always prints the
                        command, for a split you open yourself.

  /quests done          Every completed quest, not just the latest three.

  /quests statusline    Put the tracked quest in your status line: edits your
                        settings.json, keeps any status line you have, and
                        survives updates. `/quests statusline off` undoes it.

SHARE
  /quests chronicle     The session told as markdown: what you asked, what was
                        decided, what came of it. For a PR description or a
                        handoff.

GOLD, XP AND THE SHOP
  Each objective Claude checks off pays 1 💰 and 10 xp; each quest turned in
  pays 2 💰 and 20 xp. Both follow you across sessions and repos. XP sets your
  rank: Apprentice, Journeyman (301), Artificer (1001), Archmage (2001).
  /quests shop          Trinkets and Tronkets: frames, bars, trophies, banners.
  /quests buy double    Buy an item once; it's equipped straight away.
  /quests inventory     What you own, what's equipped, and your plaques.
  /quests equip heavy   Put on something you own. `unequip <item|slot>`
                        goes back to how you started.
  /quests engrave 3     Hang turned-in quest #3 in the hall as a plaque.
  /quests trophies      The hall. `unequip p2` puts a plaque in storage.
  /quests banner <text> Your own words in the header (the custom banner).

SETTINGS
  /quests config        Every setting, its value, and what it controls.
  /quests config <k> <v>
                        Change one. style: rpg | plain  reminders: nudge |
                        strict | off  toasts: summary | full | off
                        overlay: off | on  todo_handoff: ask | auto

WHAT CLAUDE LOGS
  quest      A request that needs edits or more than one step. Chat and quick
             questions aren't quests.
  objective  A step of a quest, checked off as it lands.
  journal    A decision and its reason, or a change of direction you gave.
  awaiting   A quest blocked on something only you can answer.
  rumor      Something Claude thought worth doing but did not act on. If it
             did act, that's a quest or an objective, not a rumor. A question
             for you is never a rumor: Claude asks it.

FILES
  {here}/
  {store_base()}/<project>/<session>.json
  {wallet_path()}"""


def cmd_config(key: "str | None" = None, raw: "str | None" = None) -> str:
    values, sources = cfg(), cfg_sources()
    if key and raw is not None:
        try:
            value = coerce(key, raw)
        except ValueError as exc:
            return f"Invalid value for {key}: {exc}"
        write_config_value(key, value)
        note = ""
        if sources.get(key) == "env":
            note = f"\nNOTE: CLAUDE_QUESTS_{key.upper()} is set and still overrides this."
        return f"Set {key} = {value} in {config_path()}\nTakes effect on the next prompt.{note}"
    keys = [key] if key else list(SETTINGS)
    width = max(len(k) for k in keys)
    lines = [f"CONFIG: quest-log settings, this profile", ""]
    for name in keys:
        _, accepts, doc = SETTINGS[name]
        marker = "" if sources[name] == "default" else f"   <- {sources[name]}"
        lines.append(f"  {name:<{width}}  {values[name]}{marker}")
        lines.append(f"  {'':<{width}}  accepts {' | '.join(accepts)}")
        lines.append(f"  {'':<{width}}  {doc}")
        lines.append("")
    lines.append("set: /quests config <key> <value>    env: CLAUDE_QUESTS_<KEY> overrides for one session")
    return "\n".join(lines)


USER_COMMANDS = re.compile(
    r"""^(?:
        (?P<list>list|log)
      | \#?(?P<show>\d+)
      | track \s+ \#?(?P<track>\d+)
      | abandon \s+ \#?(?P<abandon>\d+) (?: \s+ (?P<reason>.+) )?
      | todo \s+ (?P<todo>\#?\d+(?:\.\d+)? | r\d+)
      | (?P<adopt>adopt) (?: \s+ (?P<adopt_what>\d+|all) )?
      | (?P<chronicle>chronicle|story)
      | (?P<live>live|watch)
      | status\ ?line (?: \s+ (?P<sl_mode>on|off) )? (?P<sl>)
      | (?P<done>done|completed|finished)
      | (?P<config>config) (?: \s+ (?P<cfg_key>\w+) (?: \s+ (?P<cfg_val>\S+) )? )?
      | (?P<shop>shop|store)
      | buy \s+ (?P<buy>\S+)
      | (?P<inventory>inventory|inv|bag)
      | equip \s+ (?P<equip>\S+)
      | unequip \s+ (?P<unequip>\S+)
      | (?P<trophies>trophies|hall)
      | engrave \s+ \#?(?P<engrave>\d+)
      | banner \s+ (?P<banner>.+)
      | (?P<help>help)
    )$""",
    re.IGNORECASE | re.VERBOSE,
)


def dispatch(raw: str) -> str:
    root, sid = project_root(), session_id()
    path = state_path(sid, root)
    state = load(path, sid, root)
    text = one_line(raw)
    match = USER_COMMANDS.match(text)

    if not text:
        result = render_log(state)
    elif not match:
        return f"UNKNOWN: /quests {text}\n`/quests help` lists the commands."
    else:
        g = match.groupdict()
        if g["list"]:
            result = render_log(state)
        elif g["show"]:
            quest = find_quest(state, g["show"])
            result = render_entry(state, quest) if quest else f"No quest #{g['show']}."
        elif g["track"]:
            result = cmd_track(state, g["track"])
        elif g["abandon"]:
            reason = g["reason"] or "you dropped it"
            result = cmd_close(state, [g["abandon"]], {"reason": [f"{reason} (by you)"]}, "abandoned")
        elif g["todo"]:
            result = cmd_to_todo(state, g["todo"])
        elif g["adopt"]:
            result = cmd_adopt(state, g["adopt_what"])
        elif g["chronicle"]:
            return render_chronicle(state)
        elif g["done"]:
            result = render_log(state, all_done=True)
        elif g["sl"] is not None:
            return cmd_statusline_install((g["sl_mode"] or "on").lower() == "on")
        elif g["live"]:
            return launch_live(sid, root)
        elif g["shop"]:
            return render_shop()
        elif g["buy"]:
            return cmd_buy(g["buy"])
        elif g["inventory"]:
            return render_inventory()
        elif g["equip"]:
            return cmd_equip(g["equip"])
        elif g["unequip"]:
            return cmd_unequip(g["unequip"])
        elif g["trophies"]:
            return render_trophies()
        elif g["engrave"]:
            return cmd_engrave(state, g["engrave"])
        elif g["banner"]:
            return cmd_banner(g["banner"])
        elif g["config"]:
            if g["cfg_key"] and g["cfg_key"].lower() not in SETTINGS:
                return f"No setting {g['cfg_key']!r}. Settings: {', '.join(SETTINGS)}."
            return cmd_config(g["cfg_key"] and g["cfg_key"].lower(), g["cfg_val"])
        else:
            return cmd_help()
    write_json(path, state)
    return result


# ----------------------------------------------------------------- hook paths

def emit(event: "str | None", context: "str | None" = None, system: "str | None" = None,
         extra: "dict | None" = None) -> None:
    """`context` reaches Claude only; `system` reaches the terminal only.

    See /todo's DESIGN.md, "Two hook output channels", for how that was established.
    """
    out: dict = dict(extra or {})
    if context is not None and event:
        out["hookSpecificOutput"] = {"hookEventName": event, "additionalContext": context}
    if system:
        out["systemMessage"] = system
    if out:
        print(json.dumps(out))


def cli() -> str:
    return str(Path(__file__).resolve())


def protocol() -> str:
    q = cli()
    handoff = (
        "Rumors are copied to /todo automatically (todo_handoff=auto). Anything else "
        "goes to /todo only when the user asks or agrees: `to-todo <3 | 3.2 | r1>`."
        if cfg()["todo_handoff"] == "auto" else
        "Never send anything to /todo unless the user asks or agrees; then "
        "`to-todo <3 | 3.2 | r1>`."
    )
    return f"""quest-log is on. You keep a quest log of what the user asked and where you're up to, so they can check at any point what was asked, why, what's done and what's left. Update it as things happen, never in a batch at the end. Each call prints one line; don't narrate the logging to the user. A reply starting "No …" or "usage:" means nothing was written: fix the call.

CLI: `quest <verb> ...` (the plugin puts `quest` on your Bash PATH; if it's not found, use {q}).
- Each prompt arrives with "ask #N" in context. A request that needs edits or more than one step is a quest: `accept --title "..." --ask N --why "..." --reward "<what done means>" --objective "..." --objective "..."`. Chat and quick questions are not quests.
- A later ask that extends or redirects a quest: `link <quest> <ask> "what changed"`. Don't rewrite the quest; the journal keeps the history.
- While working: `check <quest>.<n>` when an objective lands, `objective <quest> "..."` when you find a new step, `journal <quest> "chose X over Y because Z"` for decisions and their consequences.
- Blocked on the user: `await <quest> "the question"`. Finished and verified: `turn-in <quest> --outcome "..." --loot <path|sha|url>`. Dropped: `abandon <quest> --reason "..."`. `track <quest>` switches focus.
- `rumor "..."` is for something worth doing that you thought of and did NOT act on. If you acted on it, it's a quest or objective instead (`accept ... --from-rumor r1`). Starting a /todo item is a quest too: `accept ... --from-todo <n>`. A question only the user can answer ("should X return 1 or raise?") is never a rumor: ask it, and `await` the quest if you can't go on without the answer.
- {handoff}"""


def plugin_version() -> "str | None":
    """The version this copy declares, read from its own plugin manifest.

    Derived from __file__ rather than CLAUDE_PLUGIN_ROOT, which is expanded in
    the hook command but not guaranteed in the process environment.
    """
    try:
        manifest = Path(__file__).resolve().parents[2] / ".claude-plugin" / "plugin.json"
        return str(json.loads(manifest.read_text())["version"]) or None
    except (OSError, ValueError, KeyError, IndexError):
        return None


def upgrade_note() -> "str | None":
    """Release notes to print once, the first session after the version changes.

    Always records the version it saw, so notes can't pile up or repeat. A fresh
    install has nothing to be told about. 0.1.0 never recorded a version, so an
    existing store is what tells an upgrade from 0.1.0 apart from a new install.
    """
    version = plugin_version()
    if not version:
        return None
    stored = read_config_file()
    seen = stored.get("last_seen_version")
    if seen == version:
        return None
    write_config_value("last_seen_version", version)
    if not seen:
        try:
            used = any(k != "last_seen_version" for k in stored) or any(
                p.is_dir() for p in store_base().iterdir())
        except OSError:
            used = False
        if not used:
            return None
    return UPGRADE_NOTES.get(version)


def hook_session_start(payload: dict) -> None:
    note = upgrade_note()  # always records, so a skipped note can't come back
    if cfg()["reminders"] == "off":
        return
    root = project_root()
    sid = session_id(payload.get("session_id"))
    source = payload.get("source", "startup")
    context = protocol()
    path = state_path(sid, root)
    if path.exists() and source in ("compact", "resume"):
        state = load(path, sid, root)
        context += (
            f"\n\nThe quest log survived a `{source}`; conversation detail behind it "
            f"may be gone. Current log:\n{render_for_claude(state)}"
        )
    elif source in ("startup", "clear"):
        carried = carryover(root, sid)  # this checkout only; `adopt` looks wider
        if carried:
            lines = [f"  {q['title']} ({'/'.join(map(str, progress(q)))}, session {p.stem[:8]})"
                     for p, _, q in carried[:5]]
            context += (
                f"\n\n{len(carried)} quest(s) from earlier sessions in this project were left "
                "unfinished. Mention them in one short line if relevant; don't work on them "
                "unless asked. `/quests adopt` lets the user continue one here.\n" + "\n".join(lines)
            )
    emit("SessionStart", context, system=note)


# Turns Claude Code starts on the user's behalf arrive through UserPromptSubmit
# too. Found live: a subagent's hand-back was logged as ask #2, its task
# notification as #3, so the quest giver's words weren't the user's.
MACHINE_PROMPTS = ("<task-notification>", "<agent-message", "[SYSTEM NOTIFICATION")


def hook_prompt(payload: dict) -> None:
    """UserPromptSubmit: record the ask verbatim, and brief Claude on the log."""
    if cfg()["reminders"] == "off":
        return
    prompt = payload.get("prompt") or ""
    if not prompt.strip() or prompt.lstrip().startswith("/quests"):
        return  # nothing asked, or just reading the log
    if prompt.lstrip().startswith(MACHINE_PROMPTS):
        return  # a subagent or background task reporting back; the user said nothing
    root = project_root()
    sid = session_id(payload.get("session_id"))
    path = state_path(sid, root)
    state = load(path, sid, root)

    previous = state["asks"][-1] if state["asks"] else None
    state["turn"] = state.get("turn", 0) + 1
    ask = {"id": len(state["asks"]) + 1, "turn": state["turn"], "text": prompt[:ASK_CAP],
           "at": now(), "quest": None}
    state["asks"].append(ask)

    lines = [f"quest-log: this prompt is ask #{ask['id']}."]
    tracked = find_quest(state, state["tracked"]) if state.get("tracked") else None
    if tracked and is_open(tracked):
        done, total = progress(tracked)
        cur = current_objective(tracked)
        nxt = f", next {tracked['id']}.{cur[0]} {cur[1]['text']}" if cur else ""
        lines[0] += f" Tracking #{tracked['id']} {tracked['title']} ({done}/{total}{nxt})."
    waiting = [q for q in state["quests"] if q["status"] == "awaiting"]
    if waiting:
        lines.append("Awaiting the user: " + "; ".join(f"#{q['id']} \"{q['awaiting']}\"" for q in waiting)
                     + " — if this prompt answers one, pick it back up.")

    # The nudge: edits and commits since the last log write, shown once, then forgotten.
    unlogged = state.get("unlogged_files") or []
    commits = state.get("unlogged_commits") or 0
    if unlogged or commits:
        did = []
        if unlogged:
            shown = ", ".join(unlogged[:4]) + (f" +{len(unlogged) - 4} more" if len(unlogged) > 4 else "")
            did.append(f"edited {len(unlogged)} file(s): {shown}")
        if commits:
            did.append(f"made {commits} git commit(s)")
        line = (f"Since your last log update you {' and '.join(did)}. "
                "If that was progress, record it (check / objective / journal / accept).")
        if previous and not previous.get("quest"):
            line += f" Ask #{previous['id']} isn't linked to any quest."
        lines.append(line)
        state["unlogged_files"], state["unlogged_commits"] = [], 0

    write_json(path, state)
    emit("UserPromptSubmit", "\n".join(lines))


GIT_COMMIT = re.compile(r"(?:^|[;&|(\s])git(?:\s+-[cC]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+commit(?![\w-])")


def hook_post_tool(payload: dict) -> None:
    """PostToolUse on file edits and commits: what changed since the last log write."""
    if cfg()["reminders"] == "off":
        return
    tool_input = payload.get("tool_input") or {}
    if payload.get("tool_name") == "Bash":
        command = tool_input.get("command") or ""
        if "quest.py" in command or not GIT_COMMIT.search(command):
            return  # most Bash is verification; a commit is a milestone
    root = project_root()
    sid = session_id(payload.get("session_id"))
    path = state_path(sid, root)
    if not path.exists():
        return
    if payload.get("tool_name") == "Bash":
        state = load(path, sid, root)
        state["unlogged_commits"] = (state.get("unlogged_commits") or 0) + 1
        write_json(path, state)
        return
    target = tool_input.get("file_path") or tool_input.get("notebook_path")
    if not target:
        return
    if target.startswith(root + os.sep):
        target = target[len(root) + 1:]
    state = load(path, sid, root)
    files = state.setdefault("unlogged_files", [])
    if target not in files:
        files.append(target)
        write_json(path, state)


# The summary is always emoji, whatever `style` says: it's one line, and the
# icons are what make it scannable at a glance.
SUMMARY_COUNTS = {"objective": "➕", "check": "✔", "fail": "✗"}


def summarize_toasts(toasts: list) -> str:
    """One line for a turn's log changes, in the order they happened:
    `📜 #1 updated · ➕2 · ✔2 · 🏆 #1 complete · ✨ #2 created "Add size" · 👂 1 rumor`
    """
    parts: "list[list]" = []  # [kind, quest, text or count]
    created, updated, prev_q = set(), set(), None
    rumors = sent = 0
    for t in toasts:
        if isinstance(t, str):  # queued by an older version mid-session
            parts.append(["text", None, t])
            continue
        kind, qid = t.get("kind"), t.get("quest")
        if kind == "rumor":
            rumors += 1
        elif kind == "todo":
            sent += 1
        elif kind in SUMMARY_COUNTS:
            if parts and parts[-1][0] == kind and parts[-1][1] == qid:
                parts[-1][2] += 1
            else:
                parts.append([kind, qid, 1])
        elif kind == "link":
            if qid not in created and qid not in updated:
                updated.add(qid)
                parts.append([kind, qid, f"📜 #{qid} updated"])
        elif kind == "accept":
            created.add(qid)
            parts.append([kind, qid, f'✨ #{qid} created "{clip(t.get("title") or "", 30)}"'])
        elif kind in ("await", "turn_in", "abandon", "adopt"):
            label = {"await": "⏸ #{} awaiting you", "turn_in": look("trophy") + " #{} complete",
                     "abandon": "🚫 #{} abandoned", "adopt": "📜 #{} resumed"}[kind]
            parts.append([kind, qid, label.format(qid)])
        else:
            parts.append(["text", None, t.get("text", "")])
    out = []
    for kind, qid, value in parts:
        if kind in SUMMARY_COUNTS:
            lead = f"#{qid} " if qid != prev_q else ""
            out.append(f"{lead}{SUMMARY_COUNTS[kind]}{value}")
        else:
            out.append(value)
        prev_q = qid if qid is not None else prev_q
    if rumors:
        out.append(f"👂 {rumors} rumor{'s' * (rumors > 1)}")
    if sent:
        out.append(f"→ {sent} to /todo")
    return " · ".join(out)


def hook_stop(payload: dict) -> None:
    """Stop: flush this turn's toasts; in strict mode, refuse to stop on unlogged edits."""
    root = project_root()
    sid = session_id(payload.get("session_id"))
    path = state_path(sid, root)
    if not path.exists():
        return
    state = load(path, sid, root)
    conf = cfg()
    toasts = state.get("toasts") or []
    state["toasts"] = []
    extra = None
    unlogged = state.get("unlogged_files") or []
    commits = state.get("unlogged_commits") or 0
    # stop_hook_active means we already blocked once this turn; never loop.
    if conf["reminders"] == "strict" and (unlogged or commits) and not payload.get("stop_hook_active"):
        did = f"edited {len(unlogged)} file(s) ({', '.join(unlogged[:4])})" if unlogged else ""
        if commits:
            did += (" and " if did else "") + f"made {commits} commit(s)"
        extra = {
            "decision": "block",
            "reason": (
                f"quest-log: you {did} this turn without updating the quest log. Record the "
                "progress, or if it was trivial, run `quest ack`, then finish."
            ),
        }
    write_json(path, state)
    system = None
    if conf["overlay"] == "on" and os.environ.get("CLAUDE_QUESTS_OVERLAY_LIVE"):
        pass  # the overlay (hooks/overlay.tsx) already toasted each change as it landed
    elif toasts and conf["toasts"] == "summary":
        system = summarize_toasts(toasts)
    elif toasts and conf["toasts"] == "full":
        system = "\n".join(t if isinstance(t, str) else t["text"] for t in toasts)
    emit(None, system=system, extra=extra)


def render_statusline(state: dict) -> str:
    """One line for Claude Code's status line: the tracked quest and what's next."""
    rpg = cfg()["style"] == "rpg"
    quest = find_quest(state, state["tracked"]) if state.get("tracked") else None
    parts = []
    if quest and is_open(quest):
        done, total = progress(quest)
        parts.append(("⚔ " if rpg else "") + clip(quest["title"], 40))
        if total:
            parts.append(f"{done}/{total}")
        cur = current_objective(quest)
        if cur:
            parts.append(("▸ " if rpg else "next: ") + clip(cur[1]["text"], 40))
    waiting = sum(q["status"] == "awaiting" for q in state["quests"])
    if waiting:
        parts.append(("⏸ " if rpg else "") + f"{waiting} awaiting you")
    return " · ".join(parts)


def statusline(payload: dict) -> str:
    """`statusLine` command: reads Claude Code's status JSON on stdin.

    The status line runs outside the session's Bash tool, so the session and
    directory come from the payload rather than the environment.
    """
    cwd = (payload.get("workspace") or {}).get("current_dir") or payload.get("cwd")
    if cwd and os.path.isdir(cwd):
        os.chdir(cwd)
    root, sid = project_root(), session_id(payload.get("session_id"))
    path = state_path(sid, root)
    if not path.exists():
        return ""
    return render_statusline(load(path, sid, root))


HOOKS = {
    "hook-session-start": hook_session_start,
    "hook-prompt": hook_prompt,
    "hook-post-tool": hook_post_tool,
    "hook-stop": hook_stop,
}

FLAGS = {"title", "kind", "ask", "why", "reward", "objective", "outcome", "loot",
         "reason", "from-rumor", "from-todo", "quest"}


def main() -> int:
    argv = sys.argv[1:]
    if not argv:
        print("usage: quest.py <verb> ... (see DESIGN.md, CLI)", file=sys.stderr)
        return 1
    cmd = argv[0]

    if cmd in HOOKS:
        try:
            payload = json.load(sys.stdin)
        except (json.JSONDecodeError, ValueError):
            payload = {}
        try:
            HOOKS[cmd](payload)
        except Exception:
            pass  # the log must never break a session
        return 0

    if cmd == "statusline":
        try:
            print(statusline(json.load(sys.stdin)))
        except Exception:
            pass  # a broken status line must not show a traceback
        return 0

    if cmd == "watch":
        pos, flags = parse_flags(argv[1:], {"session"})
        return watch(first(flags, "session") or None, once="--once" in pos)

    if cmd == "armory":
        print(json.dumps(armory(), ensure_ascii=False))
        return 0

    if cmd == "dispatch":
        raw = sys.stdin.read() if "--stdin" in argv else " ".join(argv[1:])
        print(dispatch(raw))
        return 0

    root, sid = project_root(), session_id()
    path = state_path(sid, root)
    state = load(path, sid, root)
    pos, flags = parse_flags(argv[1:], FLAGS)

    if cmd == "accept":
        result = cmd_accept(state, flags)
    elif cmd in ("check", "fail"):
        result = cmd_mark(state, pos, "done" if cmd == "check" else "failed")
    elif cmd == "objective":
        result = cmd_objective(state, pos)
    elif cmd == "journal":
        result = cmd_journal(state, pos)
    elif cmd == "link":
        result = cmd_link(state, pos)
    elif cmd == "await":
        result = cmd_await(state, pos)
    elif cmd == "track":
        result = cmd_track(state, pos[0] if pos else "")
    elif cmd in ("turn-in", "abandon"):
        result = cmd_close(state, pos, flags, "done" if cmd == "turn-in" else "abandoned")
    elif cmd == "rumor":
        result = cmd_rumor(state, pos, flags)
    elif cmd == "to-todo":
        result = cmd_to_todo(state, pos[0] if pos else "")
    elif cmd == "ack":
        logged(state)
        result = "Acknowledged; nothing to log."
    elif cmd == "show":
        quest = find_quest(state, pos[0]) if pos else None
        result = render_entry(state, quest) if quest else render_for_claude(state)
    else:
        print(f"unknown command: {cmd}", file=sys.stderr)
        return 1

    write_json(path, state)
    print(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
