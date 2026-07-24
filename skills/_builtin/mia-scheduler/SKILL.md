---
name: mia-scheduler
description: Manage reminders and scheduled tasks for the current Mia conversation.
---

# Mia Scheduled Tasks

Use the built-in Mia scheduling tools to manage tasks that execute in the
current conversation with the current Agent.  Do not use shell commands,
operating-system schedulers, `sleep`, `at`, `cronjob`, or text control tags.

## Rules

1. Tasks are scoped to this conversation. The tool does not expose or modify
   tasks from other conversations.
2. Before changing or deleting an existing task, call
   `schedule_list_current` and use an id returned by that tool.
3. Creating a new task does not replace existing tasks. Do not ask for a
   confirmation that the user has already given.
4. Only confirm success after `schedule_create`, `schedule_update`, or
   `schedule_delete` returns successfully. If a tool fails, explain the
   failure plainly instead of claiming the task was created.
5. Never output `[CRON_LIST]`, `[CRON_CREATE]`, `[CRON_UPDATE]`, or
   `[CRON_DELETE]`. They are not Mia commands.

## Tools

### List

Call `schedule_list_current` to inspect tasks in this conversation.

### Create

Call `schedule_create` with:

- `name`: a short task name.
- `schedule`: a five- or six-field cron expression, a relative expression such
  as `in 5 minutes`, a future RFC3339 timestamp, or an accepted schedule
  object.
- `scheduleDescription`: a human-readable description in the user's local
  time.
- `message`: the complete, self-contained instruction the Agent should follow
  when the task fires.

The `message` is the actual future instruction, not merely the user's request.
For example, for “remind me every day at 10”, use a message such as “Reply with
a short, friendly reminder that it is now time to …”.

### Update

Call `schedule_update` with `jobId` plus every field that needs changing.  Set
`status` to `paused` or `active` to pause or resume a task.

### Delete

Call `schedule_delete` with a `jobId` returned by `schedule_list_current`.
