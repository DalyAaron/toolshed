---
name: quests
description: Show the quest log Claude keeps of this session — what was asked, why, what's done, what's left, and what's waiting on the user.
argument-hint: "[n] | done | track N | abandon N [reason] | todo N|N.M|rN | adopt [n|all] | chronicle | live | config | help"
disable-model-invocation: true
allowed-tools: Bash(${CLAUDE_SKILL_DIR}/quest.py *)
---

# /quests — the log Claude keeps

The command below has **already run**, before you saw this. Its output is the
answer; your job is to relay it, not to rebuild it.

```!
"${CLAUDE_SKILL_DIR}/quest.py" dispatch --stdin <<'QUEST_EOF'
$ARGUMENTS
QUEST_EOF
```

## How to respond

Match the first word of the output above.

### `╭─ 📜 QUEST LOG`, `Session log`, `QUEST #N` — the log, or one entry

Relay it **verbatim in a code block**. It is already laid out for a terminal:
don't reflow it, summarise it, turn it into a table, or add commentary. The user
opened the log to read the log.

If an entry shows something **awaiting you** and you can see the answer is
already in the conversation, you may add one line after the block saying so.
Nothing else.

If you notice the log is stale — work you did this session that isn't on it —
fix it with the CLI *after* relaying, then say in one line what you added. The
user is reading the log because they want it to be true.

### `# Chronicle` — the session as markdown

Relay it **verbatim as markdown**, not in a code block: it's meant to be
rendered, and copied into a PR description or a handoff as-is. No commentary.

### `Unfinished quests from other sessions` — the adopt list

Relay it verbatim in a code block.

### `LIVE:` — the log opened beside you

Relay it as is, the command in a code block so it's easy to copy. Then carry
on with anything you were doing; the pane needs nothing from you.

### `HELP:` / `CONFIG:` — reference

Relay verbatim in a code block, no commentary.

### `Tracking` / `Sent … to /todo` / `#N abandoned` / `Set <key>` / `Adopted` — a state change

One line confirming it. If the user abandoned the quest you were working on,
stop working on it. An adopted quest is now yours to continue: it's tracked,
and `/quests <n>` has its history, but don't start on it unless the user asks.

`/quests todo …` is the user giving permission to hand that entry to `/todo`, so
nothing more needs asking.

### `UNKNOWN:` / `No quest` / `Nothing to adopt` — a miss

Relay it in one line.
