---
name: mia-scheduler
description: Scheduled task management for Mia. Use when the user asks to create, query, update, or delete reminders and recurring tasks shown in Mia 活跃任务.
---

# Mia Scheduled Tasks

You can manage Mia scheduled tasks that execute in the current conversation with the current Agent.

## IMPORTANT RULES

1. **ONE task per conversation** - Each conversation can only have ONE scheduled task.
2. **Output commands directly** - Do not wrap commands in Markdown code blocks.
3. **ALWAYS include closing tags** - `[CRON_CREATE]` must end with `[/CRON_CREATE]`; `[CRON_UPDATE]` must end with `[/CRON_UPDATE]`.
4. Do not use shell commands, operating-system cron, `sleep`, `at`, `launchd`, or an MCP scheduler tool. Only the protocol below creates tasks in Mia 活跃任务.

## Workflow

This is a two-step workflow. Each step is one internal Agent turn.

### Step 1: Query

Output exactly `[CRON_LIST]` and nothing else. Wait for the hidden system response.

### Step 2: Act

- If the system reports no scheduled tasks, immediately output `[CRON_CREATE]`; do not ask for confirmation the user already gave.
- If a task exists and the user wants to change it, output `[CRON_UPDATE: <job-id>]`.
- If a task exists and the user requests an unrelated replacement, ask whether to replace the existing task.
- If the user explicitly asks to remove the existing task, output `[CRON_DELETE: <job-id>]`.

## Create

Output exactly this structure:

[CRON_CREATE]
name: Short task name
schedule: Five-field cron expression, relative delay, or future RFC3339 timestamp
schedule_description: Human-readable schedule in the user's local time
message: Complete, self-contained instruction for the Agent when the task fires
[/CRON_CREATE]

The `message` is the actual instruction executed on every trigger. It must say what to do, not merely repeat “remind me”. For example:

- User: “每天上午 9 点提醒我写日报”
- `schedule`: `0 9 * * *`
- `message`: `用一句简短中文提醒用户现在该写日报。`

For a one-shot task, `schedule` may be a relative value such as `in 5 minutes` or a future RFC3339 timestamp such as `2026-07-13T09:00:00+08:00`.

## Update

[CRON_UPDATE: <job-id>]
name: Updated task name
schedule: Full updated schedule
schedule_description: Full human-readable schedule
message: Full updated self-contained instruction
[/CRON_UPDATE]

Use the real id returned by `[CRON_LIST]`. Always provide all four fields.

## Query

Output exactly `[CRON_LIST]`.

## Delete

Output exactly `[CRON_DELETE: <job-id>]` using the id returned by `[CRON_LIST]`.
