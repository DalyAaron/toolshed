# toolshed

Small, self-contained tools for [Claude Code](https://claude.com/claude-code).

Add the shelf once:

```bash
claude plugin marketplace add DalyAaron/toolshed
```

Then install whatever you want from it.

## Tools

| | Install | What it does |
| :--- | :--- | :--- |
| [**/todo**](./claude-todo) | `claude plugin install claude-todo@toolshed` | Park an idea mid-task without derailing what you're doing. It remembers the branch, commit and files you were editing, and brings the todo back to you later. |

## Layout

Each tool is a self-contained plugin directory with its own manifest, docs and
version. The marketplace manifest at `.claude-plugin/marketplace.json` lists
them; adding a tool means adding a directory and one entry.

## License

MIT — see [LICENSE](./LICENSE).
