---
name: mia-scheduler
description: Create, list, update, pause, resume, and delete Mia scheduled tasks through the Mia scheduler tools. Use when the user asks for reminders, alarms, countdowns, one-shot tasks, recurring tasks such as daily/weekly/monthly reminders, cron-like schedules, or asks to manage Mia 活跃任务.
---

# Mia Scheduler

## Overview

Use Mia's scheduler MCP tools for every reminder or scheduled-task request. A created task appears in Mia's 活跃任务 view and fires by sending the saved prompt back into this same conversation.

Different agent runtimes may expose these MCP tools with a namespace. Treat names such as `schedule_create`, `mcp_mia_scheduler_schedule_create`, and `mcp__mia-scheduler__schedule_create` as the same create capability.

## Rules

- Use the runtime's scheduler create tool for new reminders and tasks.
- Use the runtime's scheduler list tool before update, delete, pause, or resume when the task id is unknown.
- Use the runtime's scheduler update, delete, pause, or resume tools for existing tasks.
- Do not ask which bot or engine should run the task; Mia injects the current bot and conversation.
- Do not invent delivery channels, retries, popups, logs, or alternate rooms. Mia currently creates conversation tasks only.
- 不要使用名为 `cronjob` 的工具，也不要使用 shell、`sleep`、`at`、`osascript`、`cron`、`launchd` 或本地临时命令来冒充 Mia 定时任务；这些不会进入 Mia 活跃任务。
- If no `schedule_*` tool is available, say that Mia's scheduler tool is unavailable and that no task was created.

## Creating Tasks

Infer obvious local times using `Asia/Shanghai` unless the user gives another timezone. Ask one short question only when the time or recurrence is genuinely ambiguous.

Examples:

- "5分钟后提醒我吃饭" -> `schedule_create` with a one-shot `at` timestamp five minutes in the future; title "吃饭提醒"; prompt "提醒我吃饭。"
- "每天早上9点提醒我写日报" -> `schedule_create` with cron `0 9 * * *`; title "写日报提醒"; prompt "提醒我写日报。"
- "每周一下午3点提醒我开周会" -> `schedule_create` with cron `0 15 * * 1`; title "周会提醒"; prompt "提醒我开周会。"

After `schedule_create` succeeds, briefly tell the user the task is set and mention it will appear in Mia 活跃任务. Include the task title or id only if useful.

## Managing Tasks

For "看看我的任务", "取消那个吃饭提醒", "暂停日报提醒", or similar requests, call `schedule_list` first if the task id is not already known. Then call the matching management tool. Confirm the result in one sentence.
