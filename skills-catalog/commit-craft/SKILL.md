---
name: commit-craft
description: 把零散改动整理成规范的 Conventional Commits 提交信息。
category: 办公学习
source: Mia 官方
---

# Commit Craft

When the user asks for a commit message, inspect the staged diff and write a
Conventional Commits message.

## Rules

- Header: `type(scope): summary`, imperative mood, <= 72 chars.
- Types: feat, fix, refactor, docs, test, chore, perf, build.
- Body: explain the *why*, wrap at 72 cols. Omit if the header is enough.
- One logical change per commit; suggest splitting if the diff mixes concerns.

## Output

Return only the commit message, ready to paste — no surrounding prose.
