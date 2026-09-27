# toolshed

Small, self-contained tools for [Claude Code](https://claude.com/claude-code).

Add the shelf once:

```bash
claude plugin marketplace add DalyAaron/toolshed
```

Then install whatever you want from it.

To update, refresh the shelf and then the tool:

```bash
claude plugin marketplace update toolshed
claude plugin update <tool>@toolshed
```

Or, inside a Claude Code session, run `/plugin` and update from there, without
leaving the session. Updates load in your next session, or after `/reload-plugins`.

## Tools

|           | Tool                       | Install | What it does                                                                                                                                                                      | Demo |
|:----------|:---------------------------| :--- |:----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------| :---: |
| ✏️ | [**/todo**](./claude-todo) | `claude plugin install claude-todo@toolshed` | Park an idea mid-task without derailing what you're doing. It remembers the branch and commit you were on, and brings the todo back to you later.                                 | [![Demo](https://img.shields.io/badge/%E2%96%B6-Demo-ffcd75?style=for-the-badge)](https://claude.ai/artifact/JW3W83mZV4Xw3P7V3eo5Sv) |
| 📜   | [**/quests**](./quest-log) | `claude plugin install quest-log@toolshed` | It's an RPG Quest log in Claude! Every task you give Claude becomes a quest. Claude writes down what you asked, checks off each step as it goes, and tells you when it needs you. | [![Demo](https://img.shields.io/badge/%E2%96%B6-Demo-ffcd75?style=for-the-badge)](https://claude.ai/artifact/QeWVPd3Fasb3kTEso7c4Sr) |


## License

MIT — see [LICENSE](./LICENSE).
