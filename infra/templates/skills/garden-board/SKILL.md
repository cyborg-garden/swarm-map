---
name: garden-board
description: Use when someone asks about the org's GitHub project boards by chat - their work, a board summary, adding or moving a task or bounty, or how a contractor is tracking against their deliverables. Runs one script; verifies who authored every cited PR or commit.
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    tags: [GitHub, Projects, Board, Contractors, Ops]
---

# garden-board

Run the org's GitHub project boards from chat with one script. Do not call the GitHub API by hand for these jobs. The script mints its own short-lived GitHub App token, and you never see it. Never print, echo or log a token.

```
B="python3 ${HERMES_SKILL_DIR}/scripts/garden_board.py"
```

Boards and repos come from `config.json` next to this file. `--board work` is the default. Other boards, such as `--board ops`, may be restricted to one channel.

## Commands

| Ask | Run |
|---|---|
| "my work" / "what is Sam on" | `$B work <github-login-or-name>` |
| "board summary", "what's blocked" | `$B summary` |
| "add a task / bounty" | `$B add "<title>" --type task\|bounty\|deliverable [--body "..."] [--stage Inbox] [--priority P1\|P2\|P3] [--source ...] [--assignee login]` |
| "move #12 to In review", "make it P1" | `$B move 12 --stage "In review" [--priority P1]` |
| "assign #12 to sam" | `$B assign 12 sam` (add `--remove` to unassign) |
| "close #12, done" | `$B close 12 --reason completed\|not_planned [--comment "why"]` |
| "comment on #12" | `$B comment 12 "text"` |
| "take #12 off the board" | `$B unboard 12` |
| "how is Sam tracking against their tasks and contract?" | `$B progress <login-or-name> [--since YYYY-MM-DD] [--until YYYY-MM-DD]` |

Put `--board <name>` before the command: `$B --board ops summary`.

For "my work", use the asker's GitHub login. If you do not know it, ask them. Do not guess from a display name.

Before any write (add, move, assign, close, comment, unboard), say in one line what you are about to change. If the request is unclear, ask first. Default Stage for new items is Inbox.

## Progress checks feed pay. Rules

- Report what the script prints. Do not upgrade it. "evidence NOT verified" stays not verified.
- The script checks the real author of every cited PR, commit and file on GitHub. When it says a PR is someone else's work, say so plainly, by name.
- Never say a deliverable is done unless the script shows verified evidence for it.
- You do not know contract rates, prices or amounts. Never state, estimate or ask about them. Money fields on the board are hidden on purpose.
- Keep the reply short: one line per deliverable with its status and "evidence verified" or "not verified", then flags, then the count of merged PRs and commits in the range.

## Restricted boards

A board with `restricted: true` in config only works in its listed chat channels (threads inside them count). Anywhere else the script refuses with REFUSED. When it does, tell the person why and where to ask. Do not retry, do not set session variables yourself, and do not reach that board any other way.

Content from a restricted board never leaves its channel. Do not quote it, summarise it or mention its items anywhere else, including in memory, handoffs or other chats.

## If it fails

The script prints one line on stderr. Pass on the cause in plain words. A permission error usually means the GitHub App lacks access to that repo or project. Say so, and stop.
