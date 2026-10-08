#!/usr/bin/env python3
"""End-to-end tests for quest.py: the CLI verbs, the hooks and /quests.

Stdlib only, and written for Python 3.6 like the script itself. Each test gets
a scratch git repo and a scratch store, and drives quest.py the way Claude Code
does: as a subprocess, with hook payloads on stdin.

    python3 quest-log/tests/test_quest.py
"""

import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLUGIN = HERE.parent
QUEST = PLUGIN / "skills" / "quests" / "quest.py"
TODO = PLUGIN.parent / "claude-todo" / "skills" / "todo" / "todo.py"


def run(cmd, cwd, env, stdin=""):
    out = subprocess.run(cmd, cwd=cwd, env=env, input=stdin, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, universal_newlines=True, timeout=30)
    if out.returncode != 0:
        raise AssertionError("{} failed: {}".format(cmd, out.stderr))
    return out.stdout


class QuestTest(unittest.TestCase):
    sid = "sess-aaaa1111"

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        for args in (["init", "-q"], ["-c", "user.name=t", "-c", "user.email=t@t",
                                      "commit", "-q", "--allow-empty", "-m", "init"]):
            subprocess.run(["git"] + args, cwd=str(self.repo), check=True)
        self.root = run(["git", "rev-parse", "--show-toplevel"], str(self.repo), os.environ).strip()
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE_")}
        self.env.update(CLAUDE_QUESTS_DIR=str(self.tmp / "quests"),
                        CLAUDE_TODO_DIR=str(self.tmp / "todos"),
                        CLAUDE_CONFIG_DIR=str(self.tmp / "config"),
                        CLAUDE_CODE_SESSION_ID=self.sid)

    def tearDown(self):
        shutil.rmtree(str(self.tmp), ignore_errors=True)

    # -- drivers

    def q(self, *args, **env):
        e = dict(self.env, **env)
        return run([sys.executable, str(QUEST)] + list(args), str(self.repo), e).strip()

    def hook(self, name, payload=None, **env):
        payload = dict({"session_id": self.sid}, **(payload or {}))
        e = dict(self.env, **env)
        out = run([sys.executable, str(QUEST), "hook-" + name], str(self.repo), e,
                  json.dumps(payload)).strip()
        return json.loads(out) if out else {}

    def prompt(self, text):
        return self.hook("prompt", {"prompt": text})

    def quests(self, args="", **env):
        return run([sys.executable, str(QUEST), "dispatch", "--stdin"], str(self.repo),
                   dict(self.env, **env), args).strip()

    def state(self, sid=None):
        slug = re.sub(r"[^A-Za-z0-9]+", "-", self.root)
        path = self.tmp / "quests" / slug / "{}.json".format(sid or self.sid)
        return json.loads(path.read_text())

    def context(self, out):
        return out.get("hookSpecificOutput", {}).get("additionalContext", "")

    def start(self):
        self.prompt("build the thing")
        return self.q("accept", "--title", "Build the thing", "--ask", "1",
                      "--why", "because", "--reward", "tests pass",
                      "--objective", "first step", "--objective", "second step")


class Asks(QuestTest):
    def test_prompt_records_ask_verbatim(self):
        out = self.prompt("please  fix\nthe bug")
        self.assertIn("ask #1", self.context(out))
        self.assertEqual(self.state()["asks"][0]["text"], "please  fix\nthe bug")

    def test_quests_and_machine_prompts_are_not_asks(self):
        self.prompt("real ask")
        for text in ("/quests", "<task-notification>\n<task-id>x</task-id>",
                     '<agent-message from="abc">\nreport', "[SYSTEM NOTIFICATION - NOT USER INPUT]"):
            self.assertEqual(self.prompt(text), {})
        state = self.state()
        self.assertEqual(len(state["asks"]), 1)
        self.assertEqual(state["turn"], 1)

    def test_brief_names_tracked_quest_and_waiting(self):
        self.start()
        self.q("await", "1", "which colour?")
        ctx = self.context(self.prompt("blue"))
        self.assertIn("Tracking #1 Build the thing (0/2, next 1.1 first step)", ctx)
        self.assertIn('#1 "which colour?"', ctx)


class Verbs(QuestTest):
    def test_lifecycle(self):
        self.assertIn("QUEST #1 accepted (main, tracked, objectives 1.1-1.2)", self.start())
        self.assertIn("1.1 done — #1 1/2", self.q("check", "1.1"))
        self.assertIn("Objective 1.3 added.", self.q("objective", "1", "third", "step"))
        self.q("journal", "1", "chose X over Y")
        self.q("check", "1.2", "1.3")
        self.assertEqual(self.q("turn-in", "1", "--outcome", "shipped", "--loot", "abc123"),
                         "#1 turned in.")
        quest = self.state()["quests"][0]
        self.assertEqual((quest["status"], quest["outcome"], quest["loot"]),
                         ("done", "shipped", ["abc123"]))
        self.assertEqual(quest["objectives"][2]["text"], "third step")

    def test_errors_write_nothing_and_say_so(self):
        self.prompt("x")
        self.assertTrue(self.q("accept", "--ask", "1").startswith("accept needs"))
        self.assertTrue(self.q("accept", "--title", "t", "--ask", "9").startswith("No ask #9"))
        self.assertTrue(self.q("check", "4.1").startswith("No quest #4"))
        self.assertTrue(self.q("objective", "1").startswith("usage:"))

    def test_second_quest_defaults_to_side(self):
        self.start()
        self.assertIn("(side, tracked", self.q("accept", "--title", "Detour"))

    def test_redirect_reopens_and_second_turn_in_succeeds(self):
        self.start()
        self.q("check", "1.1", "1.2")
        self.q("turn-in", "1", "--outcome", "first cut")
        self.prompt("actually, make it blue")
        self.assertEqual(self.q("link", "1", "2", "make it blue"), "Linked ask #2 to #1 and reopened it.")
        self.q("objective", "1", "make it blue")
        self.q("check", "1.3")
        self.assertEqual(self.q("turn-in", "1", "--outcome", "blue"), "#1 turned in.")
        quest = self.state()["quests"][0]
        self.assertEqual((quest["asks"], quest["outcome"]), ([1, 2], "blue"))
        self.assertTrue(any("Reopened" in j["text"] for j in quest["journal"]))

    def test_finished_line_shows_outcome_and_later_asks(self):
        self.start()
        self.q("turn-in", "1")
        self.assertIn("✔ #1 Build the thing — turned in", self.quests())
        self.prompt("also fix the typos")
        self.q("link", "1", "2")
        self.q("turn-in", "1", "--outcome", "built it; " + "typos checked, none found " * 3)
        log = self.quests()
        self.assertIn("✔ #1 Build the thing (+1 later ask) — built it; typos checked", log)
        self.assertIn("…", log)
        self.prompt("and again")
        self.q("link", "1", "3")
        self.q("abandon", "1")
        self.assertIn("✗ #1 Build the thing (+2 later asks) — abandoned", self.quests())

    def test_retrack_prefers_active_then_awaiting(self):
        self.start()
        self.q("accept", "--title", "Blocked one", "--kind", "side")
        self.q("await", "2", "need a key")
        self.q("accept", "--title", "Active side", "--kind", "side")
        self.q("track", "1")
        self.q("turn-in", "1")
        self.assertEqual(self.state()["tracked"], 3)
        self.q("turn-in", "3")
        state = self.state()
        self.assertEqual(state["tracked"], 2)
        self.assertEqual(state["quests"][1]["status"], "awaiting")  # left alone

    def test_check_lifts_await(self):
        self.start()
        self.q("await", "1", "q?")
        self.q("check", "1.1")
        self.assertEqual(self.state()["quests"][0]["status"], "active")

    def test_rumor_and_from_rumor(self):
        self.start()
        self.assertEqual(self.q("rumor", "tidy", "the", "docs"), "Rumor r1 noted.")
        self.q("accept", "--title", "Tidy docs", "--from-rumor", "r1")
        self.assertEqual(self.state()["rumors"][0]["quest"], 2)
        self.assertNotIn("RUMORS", self.quests())


class Nudge(QuestTest):
    def edit(self, path):
        self.hook("post-tool", {"tool_name": "Edit", "tool_input": {"file_path": path}})

    def bash(self, command):
        self.hook("post-tool", {"tool_name": "Bash", "tool_input": {"command": command}})

    def test_edits_and_commits_nudge_once(self):
        self.prompt("do it")
        self.edit(os.path.join(self.root, "a.py"))
        self.bash("git add . && git commit -qm 'x'")
        self.bash("git log --grep commit")
        self.bash("git commit-tree HEAD^{tree}")
        self.bash("pytest")
        ctx = self.context(self.prompt("next"))
        self.assertIn("edited 1 file(s): a.py and made 1 git commit(s)", ctx)
        self.assertIn("Ask #1 isn't linked", ctx)
        self.assertNotIn("Since your last", self.context(self.prompt("again")))

    def test_any_log_write_clears_nudge(self):
        self.start()
        self.edit(os.path.join(self.root, "a.py"))
        self.bash("git commit -m y")
        self.q("check", "1.1")
        self.assertNotIn("Since your last", self.context(self.prompt("next")))

    def test_quest_calls_are_not_commits(self):
        self.start()
        self.bash("quest journal 1 'git commit later'")
        self.assertEqual(self.state()["unlogged_commits"], 0)

    def test_strict_blocks_stop_once(self):
        self.start()
        self.bash("git commit -m y")
        out = self.hook("stop", CLAUDE_QUESTS_REMINDERS="strict")
        self.assertEqual(out["decision"], "block")
        self.assertIn("made 1 commit(s)", out["reason"])
        again = self.hook("stop", {"stop_hook_active": True}, CLAUDE_QUESTS_REMINDERS="strict")
        self.assertNotIn("decision", again)

    def test_stop_flushes_full_toasts(self):
        self.start()
        self.q("check", "1.1")
        out = self.hook("stop", CLAUDE_QUESTS_TOASTS="full")
        self.assertEqual(out["systemMessage"].splitlines(), [
            "📜 Quest accepted: #1 Build the thing",
            "✔ Objective complete: first step (#1 1/2)"])
        self.assertEqual(self.hook("stop"), {})
        self.q("check", "1.2")
        self.assertEqual(self.hook("stop", CLAUDE_QUESTS_TOASTS="off"), {})

    def test_overlay_takes_over_the_stop_line(self):
        self.start()
        out = self.hook("stop", CLAUDE_QUESTS_OVERLAY="on", CLAUDE_QUESTS_OVERLAY_LIVE="1")
        self.assertNotIn("systemMessage", out)
        self.assertEqual(self.state()["toasts"], [])
        self.bash("git commit -m y")
        out = self.hook("stop", CLAUDE_QUESTS_OVERLAY="on", CLAUDE_QUESTS_OVERLAY_LIVE="1",
                        CLAUDE_QUESTS_REMINDERS="strict")
        self.assertEqual(out["decision"], "block")

    def test_overlay_keeps_the_stop_line_unless_on_and_live(self):
        """Setting on in a Claude Code too old for the mod, or the mod live
        after the setting went off: either way the line still shows."""
        for env in ({"CLAUDE_QUESTS_OVERLAY": "on"}, {"CLAUDE_QUESTS_OVERLAY_LIVE": "1"}):
            self.start()
            self.assertIn("systemMessage", self.hook("stop", **env))

    def test_summary_toast_replays_the_trial_turn(self):
        """The busy turn from the interactive trial, as one line."""
        self.start()
        self.q("check", "1.1", "1.2")
        self.q("turn-in", "1")
        self.hook("stop")
        self.prompt("actually, change it")
        self.prompt("add a size method")
        self.q("link", "1", "2")
        self.q("objective", "1", "change it")
        self.q("objective", "1", "commit")
        self.q("check", "1.3", "1.4")
        self.q("link", "1", "3")
        self.q("turn-in", "1")
        self.q("accept", "--title", "Add size to Stack, with tests", "--ask", "3")
        self.q("await", "2", "method or __len__?")
        self.q("rumor", "pycache untracked")
        expected = ('📜 #1 updated · ➕2 · ✔2 · 🏆 #1 complete · '
                    '✨ #2 created "Add size to Stack, with tests" · ⏸ #2 awaiting you · 👂 1 rumor')
        for style in ("rpg", "plain"):  # always emoji
            state_toasts = self.state()["toasts"]
            out = self.hook("stop", CLAUDE_QUESTS_STYLE=style)
            self.assertEqual(out["systemMessage"], expected)
            path = self.tmp / "quests" / re.sub(r"[^A-Za-z0-9]+", "-", self.root) / (self.sid + ".json")
            state = json.loads(path.read_text())
            state["toasts"] = state_toasts
            path.write_text(json.dumps(state))

    def test_summary_names_quest_when_counts_switch(self):
        self.start()
        self.q("accept", "--title", "Other", "--objective", "a")
        self.q("check", "1.1", "2.1")
        self.q("to-todo", "1.2")
        out = self.hook("stop")["systemMessage"]
        self.assertEqual(out, '✨ #1 created "Build the thing" · ✨ #2 created "Other" · '
                              '#1 ✔1 · #2 ✔1 · → 1 to /todo')

    def test_old_toasts_value_still_works(self):
        self.start()
        self.assertIn("✨ #1 created", self.hook("stop", CLAUDE_QUESTS_TOASTS="on")["systemMessage"])

    def test_off_means_silent(self):
        self.assertEqual(self.hook("prompt", {"prompt": "x"}, CLAUDE_QUESTS_REMINDERS="off"), {})
        self.assertEqual(self.hook("session-start", CLAUDE_QUESTS_REMINDERS="off"), {})


class SessionStart(QuestTest):
    def test_protocol_and_compact(self):
        self.assertIn("quest <verb>", self.context(self.hook("session-start")))
        self.start()
        ctx = self.context(self.hook("session-start", {"source": "compact"}))
        self.assertIn("1.1 [open] first step", ctx)

    def test_startup_surfaces_other_sessions(self):
        self.start()
        other = "sess-bbbb2222"
        out = self.hook("session-start", {"session_id": other, "source": "startup"},
                        CLAUDE_CODE_SESSION_ID=other)
        self.assertIn("Build the thing (0/2, session sess-aaa)", self.context(out))

    def test_upgrade_note_once_and_not_on_fresh_install(self):
        version = json.loads((PLUGIN / ".claude-plugin" / "plugin.json").read_text())["version"]
        self.assertNotIn("systemMessage", self.hook("session-start"))
        config = self.tmp / "quests" / "config.json"
        self.assertEqual(json.loads(config.read_text())["last_seen_version"], version)
        config.write_text(json.dumps({"last_seen_version": "0.0.1"}))
        out = self.hook("session-start")
        expect = self.module().UPGRADE_NOTES.get(version)
        self.assertEqual(out.get("systemMessage"), expect)
        self.assertNotIn("systemMessage", self.hook("session-start"))

    def test_upgrade_from_unversioned_install(self):
        """0.1.0 never recorded a version; an existing store marks the upgrade."""
        self.start()
        out = self.hook("session-start")
        version = json.loads((PLUGIN / ".claude-plugin" / "plugin.json").read_text())["version"]
        self.assertEqual(out.get("systemMessage"), self.module().UPGRADE_NOTES.get(version))

    def module(self):
        spec = importlib.util.spec_from_file_location("quest", str(QUEST))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod


class UserCommands(QuestTest):
    def test_log_entry_and_misses(self):
        self.assertIn("Nothing logged yet", self.quests())
        self.start()
        log = self.quests()
        self.assertTrue(log.startswith("╭─ 📜 QUEST LOG"))
        self.assertIn(" ▶ #1  Build the thing", log)
        self.assertIn("▱▱▱▱▱▱▱▱ 0/2", log)
        self.assertIn("       ▸ 1. first step", log)
        self.assertIn("       🎁 tests pass", log)
        self.assertTrue(self.quests("1").startswith("QUEST #1 — Build the thing"))
        self.assertEqual(self.quests("9"), "No quest #9.")
        self.assertTrue(self.quests("frobnicate").startswith("UNKNOWN:"))
        self.assertTrue(self.quests("help").startswith("HELP:"))

    def test_rpg_layout(self):
        self.start()
        self.q("await", "1", "which colour?")
        for n in range(2, 7):
            self.q("accept", "--title", "Quest {}".format(n), "--kind", "side", "--objective", "x")
        for n in (2, 3, 4, 5):
            self.q("turn-in", str(n), "--outcome", "outcome {}".format(n))
        self.q("track", "6")
        self.q("check", "6.1")
        self.q("objective", "1", "third step")  # a later objective; #1 stays awaiting
        self.q("await", "1", "which colour?")
        log = self.quests()
        lines = log.splitlines()
        self.assertEqual(log.count("Build the thing"), 1)          # awaiting quests shown once
        self.assertIn('       “which colour?”', lines)
        self.assertNotIn("first step", log)                        # only the tracked quest expands
        self.assertIn(" ▶ #6  Quest 6", log)
        self.assertIn(" 🏆 COMPLETED (4)", lines)
        self.assertIn("   ✔ #5 Quest 5 — outcome 5", lines)
        self.assertNotIn("#2 Quest 2", log)
        self.assertIn("     + 1 more · /quests done lists them all", lines)
        self.assertIn("   ✔ #2 Quest 2 — outcome 2", self.quests("done").splitlines())
        mod = SessionStart.module(self)
        frame = [l for l in lines if l and l[0] in "╭╰"]
        self.assertEqual([mod.cells(l) for l in frame], [mod.WIDTH, mod.WIDTH])
        rows = [l for l in lines if "▰" in l or "▱" in l]
        self.assertEqual({mod.cells(l) for l in rows}, {mod.WIDTH})  # bars right-aligned

    def test_long_titles_are_clipped_not_wrapped(self):
        self.prompt("x")
        self.q("accept", "--title", "A " * 60, "--objective", "o")
        self.q("accept", "--title", "B", "--kind", "side")
        row = [l for l in self.quests().splitlines() if l.startswith("   #1")][0]
        self.assertIn("…", row)

    def test_plain_style(self):
        self.start()
        self.assertIn("Set style = plain", self.quests("config style plain"))
        log = self.quests()
        self.assertTrue(log.startswith("Session log"))
        self.assertNotIn("tip:", log)

    def test_user_abandon(self):
        self.start()
        self.assertEqual(self.quests("abandon 1 too slow"), "#1 abandoned (2 objective(s) were still open).")
        self.assertIn("too slow (by you)", self.state()["quests"][0]["outcome"])

    def test_chronicle(self):
        self.start()
        self.q("check", "1.1")
        self.q("journal", "1", "chose X over Y")
        self.q("rumor", "look at Z")
        text = self.quests("chronicle")
        self.assertTrue(text.startswith("# Chronicle — repo"))
        for line in ("## Build the thing — in progress", "> **Asked:** build the thing",
                     "- [x] first step", "- [ ] second step", "- chose X over Y",
                     "## Noticed, not acted on", "- look at Z"):
            self.assertIn(line, text)

    def test_adopt(self):
        self.start()
        self.q("check", "1.1")
        other = {"CLAUDE_CODE_SESSION_ID": "sess-bbbb2222"}
        self.assertIn("1. Build the thing  [1/2]", self.quests("adopt", **other))
        self.assertEqual(self.quests("adopt 1", **other), "Adopted #1 Build the thing.")
        mine = self.state("sess-bbbb2222")
        quest = mine["quests"][0]
        self.assertEqual((quest["status"], mine["tracked"]), ("active", 1))
        self.assertEqual(quest["inherited_asks"][0]["text"], "build the thing")
        self.assertEqual(self.state()["quests"][0]["status"], "adopted")
        self.assertIn("continued in another session", self.quests())
        self.assertIn("asked, turn 1 of session sess-aaa", self.quests("1", **other))
        self.assertTrue(self.quests("1", **other).startswith("QUEST #1"))
        self.assertTrue(self.quests("adopt 1", **other).startswith("Nothing to adopt"))


class Live(QuestTest):
    def fake_bin(self, name, status=0):
        """A stand-in for tmux/osascript that records its arguments."""
        bindir = self.tmp / "bin"
        bindir.mkdir(exist_ok=True)
        tool = bindir / name
        tool.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$(dirname "$0")/{}.args"\nexit {}\n'.format(name, status))
        tool.chmod(0o755)
        return bindir

    def live(self, **env):
        bindir = self.fake_bin("tmux")
        self.fake_bin("osascript")
        e = dict(self.env, PATH=str(bindir) + os.pathsep + self.env["PATH"], **env)
        for key in ("TMUX", "TERM_PROGRAM", "WEZTERM_PANE", "KITTY_WINDOW_ID"):
            e.setdefault(key, "")
        return run([sys.executable, str(QUEST), "dispatch", "--stdin"], str(self.repo), e, "live").strip()

    def args(self, name):
        path = self.tmp / "bin" / (name + ".args")
        return path.read_text() if path.exists() else ""

    def test_tmux_split(self):
        out = self.live(TMUX="/tmp/tmux-1/default,1,0")
        self.assertTrue(out.startswith("LIVE: opened the log in a tmux pane"))
        self.assertIn("split-window", self.args("tmux"))
        self.assertIn("watch --session " + self.sid, self.args("tmux"))

    def test_iterm_split(self):
        out = self.live(TERM_PROGRAM="iTerm.app")
        self.assertIn("an iTerm2 pane", out)
        self.assertIn("split vertically", self.args("osascript"))

    @unittest.skipUnless(sys.platform == "darwin", "macOS fallback")
    def test_ide_terminal_falls_back_to_a_window(self):
        out = self.live(TERMINAL_EMULATOR="JetBrains-JediTerm")
        self.assertIn("a new Terminal window", out)
        self.assertIn('tell application "Terminal" to do script', self.args("osascript"))
        self.assertIn("watch --session " + self.sid, out)  # the command, to paste

    def test_failed_split_falls_through(self):
        self.fake_bin("tmux", status=1)
        bindir = self.tmp / "bin"
        e = dict(self.env, PATH=str(bindir) + os.pathsep + self.env["PATH"], TMUX="x",
                 TERM_PROGRAM="", WEZTERM_PANE="", KITTY_WINDOW_ID="")
        out = run([sys.executable, str(QUEST), "dispatch", "--stdin"], str(self.repo), e, "live")
        self.assertNotIn("tmux pane", out)
        self.assertIn("watch --session", out)

    def test_watch_once_follows_the_latest_session(self):
        out = self.q("watch", "--once")
        self.assertIn("No log yet", out)
        self.start()
        other = {"CLAUDE_CODE_SESSION_ID": "sess-bbbb2222"}
        self.hook("prompt", {"session_id": "sess-bbbb2222", "prompt": "hi"}, **other)
        os.utime(str(self.tmp / "quests" / re.sub(r"[^A-Za-z0-9]+", "-", self.root) / "sess-bbbb2222.json"),
                 (2e9, 2e9))
        self.assertIn("live · session sess-bbb", self.q("watch", "--once"))
        pinned = self.q("watch", "--once", "--session", self.sid)
        self.assertIn("▶ #1  Build the thing", pinned)
        self.assertIn("╰─ live · session sess-aaa", pinned)
        self.assertNotIn("/quests help", pinned)


class StatusLine(QuestTest):
    def line(self, **env):
        payload = {"session_id": self.sid, "workspace": {"current_dir": str(self.repo)}}
        e = dict(self.env, **env)
        e.pop("CLAUDE_CODE_SESSION_ID")
        return run([sys.executable, str(QUEST), "statusline"], "/", e, json.dumps(payload)).strip()

    def test_statusline(self):
        self.assertEqual(self.line(), "")
        self.start()
        self.q("check", "1.1")
        self.assertEqual(self.line(), "⚔ Build the thing · 1/2 · ▸ second step")
        self.q("await", "1", "q?")
        self.assertEqual(self.line(CLAUDE_QUESTS_STYLE="plain"),
                         "Build the thing · 1/2 · next: second step · 1 awaiting you")


class StatusLineInstall(QuestTest):
    def settings(self):
        path = self.tmp / "config" / "settings.json"
        return json.loads(path.read_text()) if path.exists() else None

    def write_settings(self, data):
        path = self.tmp / "config" / "settings.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data))

    def run_line(self, command):
        """Run a settings.json statusLine command the way Claude Code does."""
        payload = json.dumps({"session_id": self.sid, "workspace": {"current_dir": str(self.repo)}})
        env = {k: v for k, v in self.env.items() if k != "CLAUDE_CODE_SESSION_ID"}
        return run(["sh", "-c", command], "/", env, payload)

    def test_fresh_install_runs(self):
        self.start()
        self.assertIn("STATUS LINE: on, in", self.quests("statusline"))
        entry = self.settings()["statusLine"]
        self.assertEqual(entry["type"], "command")
        self.assertEqual(self.run_line(entry["command"]).strip(), "⚔ Build the thing · 0/2 · ▸ first step")
        self.assertIn("already on", self.quests("status line on"))

    def test_keeps_and_restores_an_existing_line(self):
        self.start()
        mine = {"type": "command", "command": "echo 'my line'  # has a comment", "padding": 1}
        self.write_settings({"model": "opus", "statusLine": mine})
        self.assertIn("after your existing one", self.quests("statusline"))
        settings = self.settings()
        self.assertEqual(settings["model"], "opus")
        self.assertEqual(settings["statusLine"]["padding"], 1)
        self.assertEqual(self.run_line(settings["statusLine"]["command"]),
                         "my line · ⚔ Build the thing · 0/2 · ▸ first step")
        backup = self.tmp / "config" / "settings.json.quest-log.bak"
        self.assertEqual(json.loads(backup.read_text())["statusLine"], mine)
        self.assertIn("previous status line is back", self.quests("statusline off"))
        self.assertEqual(self.settings(), {"model": "opus", "statusLine": mine})
        self.assertIn("isn't in your status line", self.quests("statusline off"))

    def test_empty_quest_line_leaves_other_line_alone(self):
        self.write_settings({"statusLine": {"type": "command", "command": "echo mine"}})
        self.quests("statusline")
        self.assertEqual(self.run_line(self.settings()["statusLine"]["command"]), "mine")

    def test_off_without_previous_removes(self):
        self.quests("statusline")
        self.quests("statusline off")
        self.assertNotIn("statusLine", self.settings())

    def test_unreadable_settings_left_alone(self):
        path = self.tmp / "config" / "settings.json"
        path.parent.mkdir(parents=True)
        path.write_text("{ not json")
        self.assertIn("couldn't read", self.quests("statusline"))
        self.assertEqual(path.read_text(), "{ not json")

    def test_installed_copy_picks_newest_version(self):
        """From the plugin cache, the command follows updates to newer versions."""
        cache = self.tmp / "config" / "plugins" / "cache" / "toolshed" / "quest-log"
        for version in ("1.0.0", "1.10.0", "1.9.0"):
            shutil.copytree(str(PLUGIN), str(cache / version),
                            ignore=shutil.ignore_patterns("tests", "__pycache__"))
        self.start()
        run([sys.executable, str(cache / "1.0.0" / "skills" / "quests" / "quest.py"),
             "dispatch", "--stdin"], str(self.repo), self.env, "statusline")
        command = self.settings()["statusLine"]["command"]
        self.assertIn("sort -V", command)
        marker = cache / "1.10.0" / "skills" / "quests" / "quest.py"
        marker.write_text(marker.read_text().replace('parts.append(("⚔ " if rpg else "")',
                                                     'parts.append(("NEWEST " if rpg else "")'))
        self.assertTrue(self.run_line(command).startswith("NEWEST Build the thing"))


class TodoHandoff(QuestTest):
    def test_rumor_objective_quest_to_todo(self):
        self.start()
        self.q("rumor", "look at Z")
        self.assertIn("Sent rumor r1 to /todo #1", self.q("to-todo", "r1"))
        self.assertIn("to /todo #2", self.q("to-todo", "1.2"))
        self.assertIn("already /todo #1", self.q("to-todo", "r1"))
        self.assertEqual(self.state()["quests"][0]["objectives"][1]["state"], "parked")

    def test_from_todo_traces_the_chain(self):
        self.start()
        self.q("rumor", "add a gitignore")
        self.q("to-todo", "r1")
        self.q("to-todo", "1.2")
        self.prompt("/todo next")
        self.q("accept", "--title", "Ignore pycache", "--ask", "2", "--from-todo", "1")
        self.q("accept", "--title", "Second step", "--from-todo", "#2")
        self.q("accept", "--title", "Elsewhere", "--from-todo", "7")
        journals = [q["journal"][0]["text"] for q in self.state()["quests"][1:]]
        self.assertEqual(journals, [
            "Began as rumor r1 (turn 1), then /todo #1.",
            "Began as objective 1.2 of #1, then /todo #2.",
            "Began as /todo #7."])
        self.assertEqual(self.state()["quests"][1]["from_todo"], 1)

    def test_foreign_store_is_refused(self):
        self.start()
        slug = re.sub(r"[^A-Za-z0-9]+", "-", self.root)
        store = self.tmp / "todos" / slug / "{}.json".format(self.sid)
        store.parent.mkdir(parents=True)
        store.write_text(json.dumps({"items": []}))
        self.assertIn("isn't in the format", self.q("to-todo", "1"))

    @unittest.skipUnless(TODO.exists(), "claude-todo not beside quest-log")
    def test_schema_matches_todo_py(self):
        """cmd_to_todo writes todo.py's store directly; fail loudly if it drifts."""
        self.start()
        self.q("to-todo", "1.1")
        cwd = os.getcwd()
        saved = {k: os.environ.get(k) for k in self.env}
        os.environ.update(self.env)
        os.chdir(str(self.repo))
        try:
            spec = importlib.util.spec_from_file_location("todo", str(TODO))
            todo = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(todo)
            ours = json.loads(todo.state_path(self.sid, self.root).read_text())
            native = todo.load(self.tmp / "none.json", self.sid, self.root)
            todo.cmd_add(native, "a native todo")
            self.assertEqual(set(ours), set(native))
            missing = set(native["todos"][0]) - set(ours["todos"][0])
            self.assertEqual(missing, set(), "todo.py items gained fields cmd_to_todo doesn't write")
            self.assertIn("first step", todo.cmd_list(ours))
        finally:
            os.chdir(cwd)
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v


class Gold(QuestTest):
    def gold(self):
        path = self.tmp / "quests" / "wallet.json"
        return json.loads(path.read_text())["gold"] if path.exists() else 0

    def test_objectives_pay_one_quests_pay_two_once(self):
        self.start()
        self.q("check", "1.1")
        self.q("check", "1.1")                      # re-checking pays nothing
        self.q("fail", "1.2")                       # failures pay nothing
        self.assertEqual(self.gold(), 1)
        self.q("turn-in", "1", "--outcome", "done")
        self.assertEqual(self.gold(), 3)
        self.prompt("one more thing")
        self.q("link", "1", "2", "extend it")       # reopened...
        self.q("turn-in", "1", "--outcome", "done again")
        self.assertEqual(self.gold(), 3)            # ...but a quest pays once
        self.q("accept", "--title", "Dropped", "--objective", "o")
        self.q("abandon", "2", "--reason", "no")
        self.assertEqual(self.gold(), 3)

    def test_purse_is_shared_across_sessions_and_repos(self):
        self.start()
        self.q("check", "1.1")
        other = self.tmp / "other"
        other.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=str(other), check=True)
        env = dict(self.env, CLAUDE_CODE_SESSION_ID="sess-bbbb2222")
        run([sys.executable, str(QUEST), "accept", "--title", "Elsewhere", "--objective", "o"],
            str(other), env)
        run([sys.executable, str(QUEST), "check", "1.1"], str(other), env)
        self.assertEqual(self.gold(), 2)

    def test_gold_sits_bottom_right_of_the_frame(self):
        self.start()
        self.q("check", "1.1", "1.2")
        self.q("turn-in", "1")
        lines = self.quests().splitlines()
        bottom = next(l for l in lines if l.startswith("╰"))
        self.assertTrue(bottom.endswith(" 4 💰 ─╯"), bottom)
        mod = SessionStart.module(self)
        self.assertEqual(mod.cells(bottom), mod.WIDTH)

    def test_empty_purse_reads_zero(self):
        self.assertIn(" 0 💰 ─╯", self.quests())


class Shop(QuestTest):
    def purse(self):
        return json.loads((self.tmp / "quests" / "wallet.json").read_text())

    def fund(self, gold, **extra):
        path = self.tmp / "quests" / "wallet.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(dict({"gold": gold, "xp": 0}, **extra)))

    def frame(self, out):
        mod = SessionStart.module(self)
        lines = out.splitlines()
        return [l for l in lines if l and l[0] in "╭╰╔╚┏┗+"], mod

    def test_xp_and_rank_bar_in_the_log(self):
        self.start()
        self.q("check", "1.1", "1.2")
        self.q("turn-in", "1")
        self.assertEqual(self.purse()["xp"], 40)
        lines = self.quests().splitlines()
        self.assertTrue(lines[1].startswith(" 🏅 APPRENTICE · 40 xp"), lines[1])
        self.assertTrue(lines[1].endswith("▰▱▱▱▱▱▱▱ 261 to Journeyman"), lines[1])
        self.assertEqual(SessionStart.module(self).cells(lines[1]), SessionStart.module(self).WIDTH)

    def test_rank_up_is_toasted_and_top_rank_is_max(self):
        self.fund(0, xp=295)
        self.start()
        self.q("check", "1.1")
        self.assertIn("🏅 Rank up: Journeyman", json.dumps(self.state()["toasts"], ensure_ascii=False))
        self.fund(0, xp=5000)
        self.assertIn("ARCHMAGE · 5000 xp", self.quests())
        self.assertIn("▰▰▰▰▰▰▰▰ max rank", self.quests())

    def test_old_purse_gets_xp_for_its_gold(self):
        path = self.tmp / "quests" / "wallet.json"
        path.parent.mkdir(parents=True)
        path.write_text('{"gold": 6}')
        self.assertIn("APPRENTICE · 60 xp", self.quests())

    def test_armory_is_the_shop_as_data(self):
        """What the overlay draws its shop, inventory and hall from."""
        self.fund(12, xp=320, owned=["beads"], equipped={"bar": "beads"})
        self.quests("buy double")
        data = json.loads(self.q("armory"))
        self.assertEqual((data["gold"], data["xp"]), (2, 320))
        self.assertEqual(data["rank"], {"name": "Journeyman", "floor": 301,
                                        "next": {"name": "Artificer", "floor": 1001}})
        self.assertEqual(data["look"], {"bar": ["●", "○"], "trophy": "🏆", "banner": None})
        wares = {w["id"]: w for w in data["wares"]}
        self.assertEqual(list(wares), list(SessionStart.module(self).SHOP))
        self.assertEqual({k: wares["double"][k] for k in ("price", "owned", "equipped", "preview")},
                         {"price": 10, "owned": True, "equipped": True, "preview": "╔══╗"})
        self.assertEqual((wares["rounded"]["owned"], wares["rounded"]["equipped"]), (True, False))
        self.assertEqual((wares["gem"]["owned"], wares["gem"]["section"]), (False, "✦ TROPHIES"))
        self.assertEqual((data["plaque_price"], data["plaques"]), (3, []))

    # -- pets

    def pet(self, **fields):
        """A pet as the wallet holds it, settled `hours_ago`."""
        import time
        hours = fields.pop("hours_ago", 0)
        return dict({"id": 1, "species": "cat", "name": "Whiskers", "joy": 50, "full": 50,
                     "at": int(time.time() - hours * 3600), "petted": 0}, **fields)

    def test_an_egg_hatches_one_of_ten_by_weight(self):
        self.fund(2010)
        out = self.quests("buy egg", CLAUDE_QUESTS_SEED="7")
        self.assertRegex(out, r"^The egg cracks\.\.\. it's an? .+ \((common|uncommon|rare|legendary)\)! "
                              r"Meet \w+, pet #1\. .* 1010 💰 left\.$")
        again = self.quests("buy egg", CLAUDE_QUESTS_SEED="7")
        self.assertIn("pet #2", again)
        self.assertIn("Not enough gold: a mystery egg costs 1000", self.quests("buy egg"))
        pets = self.purse()["pets"]
        mod = SessionStart.module(self)
        self.assertEqual(len(mod.SPECIES), 10)
        self.assertEqual(pets[0]["species"], pets[1]["species"])  # same seed, same egg
        self.assertIn(pets[0]["species"], mod.SPECIES)
        self.assertEqual((pets[0]["joy"], pets[0]["full"]), (70, 70))
        # weighted: over many eggs every species turns up, the commonest most
        import collections, random
        random.seed(1)
        seen = collections.Counter(mod.hatch() for _ in range(3000))
        self.assertEqual(set(seen), set(mod.SPECIES))
        self.assertGreater(seen["duck"], seen["dragon"] * 4)

    def test_food_is_bought_a_portion_at_a_time_and_fed(self):
        self.fund(10, pets=[self.pet(species="cat", full=40, joy=40)])
        self.assertIn("No food in your inventory", self.quests("feed 1"))
        self.assertEqual(self.quests("buy kibble"), "Bought kibble 🥣 for 1 💰\n×1 in your inventory.\n9 💰 left.")
        self.assertIn("×1 in your inventory.\n7 💰 left.", self.quests("buy treats"))
        self.assertIn("No feast in your inventory", self.quests("feed 1 feast"))
        inventory = self.quests("inventory")
        self.assertIn("🍖 FOOD", inventory)
        self.assertRegex(inventory, r"◇ kibble .* Kibble +×1 · /quests feed <pet> kibble")
        mod = SessionStart.module(self)
        self.assertEqual({mod.cells(l) for l in inventory.splitlines() if "feed <pet>" in l}, {mod.WIDTH})
        # no food named: its favourite, when there is some
        out = self.quests("feed Whiskers")
        self.assertIn("Whiskers wolfs down the treat 🍪. Its favourite!", out)
        cat = self.purse()["pets"][0]
        self.assertAlmostEqual(cat["full"], 50, delta=0.5)
        self.assertAlmostEqual(cat["joy"], 62, delta=0.5)  # 40 + 12 + 10 for the favourite
        self.assertEqual(self.purse()["food"], {"kibble": 1, "treat": 0})
        self.assertIn("wolfs down the kibble", self.quests("feed cat"))
        self.fund(5, pets=[self.pet(full=99)], food={"kibble": 1})
        self.assertIn("Whiskers is full", self.quests("feed 1"))
        self.assertEqual(self.purse()["food"], {"kibble": 1})

    def test_petting_cheers_less_when_it_has_just_been_petted(self):
        self.fund(0, pets=[self.pet(species="dog", name="Biscuit", joy=50)])
        self.assertEqual(self.quests("pet 1"), "You pet Biscuit. It wags its tail. Now content.")
        self.assertIn("though it's had a lot of fuss just now", self.quests("pet biscuit"))
        self.assertAlmostEqual(self.purse()["pets"][0]["joy"], 60, delta=0.5)  # 8, then 2
        self.assertIn("No pet 'rex'", self.quests("pet rex"))

    def test_joy_and_fullness_fade_by_the_hour_faster_when_hungry(self):
        self.fund(0, pets=[self.pet(id=1, joy=80, full=80, hours_ago=10),
                           self.pet(id=2, name="Tom", joy=80, full=26, hours_ago=10)])
        pets = {p["id"]: p for p in json.loads(self.q("armory"))["pets"]}
        # fed the whole time: 2 joy and 3 full an hour
        self.assertEqual((pets[1]["joy"], pets[1]["full"], pets[1]["hungry"]), (60, 50, False))
        # hungry after 2 hours: then joy fades at 6 an hour
        self.assertEqual((pets[2]["joy"], pets[2]["full"], pets[2]["hungry"]), (80 - 4 - 48, 0, True))
        self.assertEqual(pets[2]["mood"], "glum")

    def test_pets_are_named_and_shown_in_the_pen(self):
        self.fund(0, pets=[self.pet(species="dragon", name="Smoulder")], food={"feast": 2})
        self.assertEqual(self.quests("name 1 Sir Flambé"), "Smoulder is now called Sir Flambé 🐉.")
        pen = self.quests("pets")
        self.assertIn("#1 🐉 Sir Flambé", pen)
        self.assertIn("Dragon · legendary", pen)
        self.assertIn("🍗 2", pen)
        data = json.loads(self.q("armory"))
        self.assertEqual(data["egg_price"], 1000)
        self.assertEqual([f["id"] for f in data["food"]], ["kibble", "treat", "feast"])
        self.assertEqual(data["food"][2]["stock"], 2)
        self.assertEqual({k: data["pets"][0][k] for k in ("name", "kind", "rarity", "likes")},
                         {"name": "Sir Flambé", "kind": "Dragon", "rarity": "legendary", "likes": "feast"})
        self.fund(0)
        self.assertIn("The pen is empty", self.quests("pets"))
        self.assertIn("No pets yet", self.quests("pet 1"))

    def test_buy_once_equips_and_charges(self):
        self.fund(12)
        self.assertIn("Not enough gold: the Gem trophy costs 25", self.quests("buy gem"))
        self.assertEqual(self.quests("buy double"),
                         "Bought the Double frame ╔══╗ for 10 💰\nEquipped, and in your inventory.\n2 💰 left.")
        self.assertIn("You already own the Double frame", self.quests("buy double"))
        self.assertIn("No 'nope' in the shop", self.quests("buy nope"))
        self.assertEqual(self.purse()["gold"], 2)
        self.assertEqual(self.purse()["owned"], ["double"])
        frame, mod = self.frame(self.quests())
        self.assertEqual([l[:2] for l in frame], ["╔═", "╚═"])
        self.assertEqual([mod.cells(l) for l in frame], [mod.WIDTH, mod.WIDTH])

    def test_equip_and_unequip_switch_between_owned_skins(self):
        self.fund(0, owned=["double", "heavy", "beads", "crown"])
        self.assertIn("You don't own the ASCII frame yet: 5 💰", self.quests("equip ascii"))
        self.assertEqual(self.quests("equip heavy"), "Equipped the Heavy frame.")
        self.assertTrue(self.quests().startswith("┏━ 📜 QUEST LOG"))
        self.assertIn("isn't equipped", self.quests("unequip double"))
        self.assertIn("back to the Rounded frame", self.quests("unequip frame"))
        self.assertTrue(self.quests().startswith("╭─ 📜 QUEST LOG"))
        self.assertIn("the one you started with", self.quests("unequip rounded"))
        self.quests("equip beads")
        self.quests("equip crown")
        self.start()
        self.q("check", "1.1")
        self.q("turn-in", "1")
        log = self.quests()
        self.assertIn("●○○○○○○○ 271 to Journeyman", log)
        self.assertIn(" 👑 COMPLETED (1)", log)
        inv = self.quests("inventory")
        self.assertIn("◆ beads", inv)
        self.assertIn("◇ classic", inv)
        self.assertIn("◆ rounded", inv)

    def test_banners(self):
        self.fund(40)
        self.assertIn("needs the custom banner", self.quests("banner Hello"))
        self.quests("buy refactorer")
        self.assertIn("📜 QUEST LOG · ⚔ the Refactorer", self.quests())
        self.assertIn("Give it words", self.quests("buy custom"))
        self.assertEqual(self.quests('banner "Ship It"'), "Banner set: ⚔ Ship It")
        self.assertIn("📜 QUEST LOG · ⚔ Ship It", self.quests())
        self.quests("unequip banner")
        self.assertNotIn("⚔ Ship It", self.quests())
        self.assertEqual(self.quests("unequip banner"), "No banner to take off.")

    def test_engrave_hangs_a_plaque_once(self):
        self.start()
        self.assertIn("No quest #1 turned in", self.quests("engrave 1"))
        self.q("check", "1.1", "1.2")
        self.q("turn-in", "1", "--outcome", "It shipped")
        self.assertIn("The walls are bare", self.quests("trophies"))
        self.assertIn(" 💡 /quests done lists this session's finished quests", self.quests("trophies"))
        self.assertIn("Engraved #1 as plaque p1 for 3 💰", self.quests("engrave 1"))
        self.assertIn("already hanging", self.quests("engrave 1"))
        self.assertEqual(self.purse()["gold"], 1)
        hall = self.quests("trophies")
        self.assertIn("✦ Build the thing", hall)
        self.assertIn("It shipped", hall)
        self.assertIn("1 on display", hall)
        self.assertIn("in storage", self.quests("unequip p1"))
        self.assertIn("+ 1 in storage", self.quests("trophies"))
        self.assertIn("on display", self.quests("equip p1"))

    def test_shop_rows_fit_the_frame(self):
        self.fund(10, owned=["beads"], equipped={"bar": "beads"})
        shop = self.quests("shop")
        self.assertIn("TRINKETS AND TRONKETS 🏆", shop)
        self.assertIn("purse 10 💰", shop)
        self.assertIn("◆ equipped", shop)
        mod = SessionStart.module(self)
        rows = [l for l in shop.splitlines() if l.startswith("   ") and ("💰" in l or "equipped" in l)]
        self.assertEqual(len(rows), 17)  # 12 wares for sale, the plaque, the egg and 3 foods
        self.assertEqual({mod.cells(l) for l in rows}, {mod.WIDTH})

    def test_claude_cannot_shop(self):
        self.fund(50)
        out = subprocess.run([sys.executable, str(QUEST), "buy", "gem"], cwd=str(self.repo), env=self.env,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
        self.assertNotEqual(out.returncode, 0)
        self.assertEqual(self.purse()["gold"], 50)


class Tips(QuestTest):
    def tip(self, out):
        return next((l for l in out.splitlines() if l.startswith(" 💡 ")), None)

    def test_tips_follow_what_applies(self):
        self.assertIsNone(self.tip(self.quests()))
        self.q("rumor", "someday")
        self.assertEqual(self.tip(self.quests()), " 💡 /quests todo r<n>")
        self.start()
        self.assertEqual(self.tip(self.quests()),
                         " 💡 /quests track <n> · abandon <n> [reason] · todo <n>|<n.m>|r<n>")
        other = self.quests(CLAUDE_CODE_SESSION_ID="sess-bbbb2222")
        self.assertEqual(self.tip(other), " 💡 /quests adopt")
        self.assertIn("Also: /quests track <n>", self.quests(CLAUDE_QUESTS_STYLE="plain"))

    def test_short_argument_hint(self):
        skill = (PLUGIN / "skills" / "quests" / "SKILL.md").read_text()
        self.assertIn('argument-hint: "[n] | done | shop | inventory | chronicle | live | config | help"', skill)


class Wrapper(QuestTest):
    def test_bin_quest_runs_the_cli(self):
        self.prompt("x")
        out = run([str(PLUGIN / "bin" / "quest"), "accept", "--title", "Via bin", "--ask", "1"],
                  str(self.repo), self.env)
        self.assertIn("QUEST #1 accepted", out)


if __name__ == "__main__":
    unittest.main(verbosity=1)
