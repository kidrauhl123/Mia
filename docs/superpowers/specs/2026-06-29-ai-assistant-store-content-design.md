# AI Assistant Store Content Design

Date: 2026-06-29

Status: ready for user review

## Context

Mia already has a Skill library. The current "发现 AI 助手" content blurs the
line between assistants and skills: presets such as "文档编辑", "表格整理师",
"会议纪要官", and "汇报设计师" are mostly ability labels with a persona wrapper.
That makes the assistant store feel noisy and weak because users cannot tell why
they should add an assistant instead of installing or enabling a skill.

External AI agent products show two useful patterns:

- Tool and workflow products name concrete jobs and integrations.
- Character products sell personality and entertainment.

Mia should not copy either pattern directly. Mia's product shape is a contact
list of long-lived bots that can remember context, hold responsibility for a
domain, and use Skills as tools. Therefore the official assistant store should
curate durable working relationships, not one-off capabilities or generated
personas.

## Product Decision

An AI Assistant in Mia is a long-lived contact with:

- a durable responsibility,
- a bound context such as a course, project, repo, job search, or personal task
  stream,
- default Skills,
- a runtime target,
- and conversation memory.

A Skill is a reusable capability. It answers "what can the agent do?" An
Assistant answers "who owns this ongoing thing for me?"

The assistant store must present assistant templates as context-bearing
contacts. It must not present them as skill cards with friendlier names.

## Goals

- Make the "助手 vs 技能" boundary obvious in content and UI.
- Replace generic official assistant presets with a smaller, more opinionated
  set of long-running assistant templates.
- Give each template a first-run setup shape so adding an assistant creates a
  useful context-bearing contact, not an empty bot.
- Keep Skills visible as default tools behind the assistant, not as the main
  product promise.
- Make the first official set useful for Mia's real product advantages: local
  files, long-lived chat contacts, task reminders, project context, repos, and
  multiple agent runtimes.

## Non-Goals

- This design does not redesign the Skill marketplace.
- This design does not remove custom bot creation.
- This design does not require a new visual design direction for the store
  grid.
- This design does not make assistants autonomous background workers by default.
  Scheduled or background behavior still goes through Mia's task system.
- This design does not add entertainment or character-role assistants to the
  first official set.

## Content Model

Each official assistant template has these user-facing fields:

- `name`: a contact-like role name, not a skill or command name.
- `responsibility`: the ongoing thing this assistant owns.
- `bestFor`: when the user should add this assistant.
- `setupPrompt`: what Mia asks during first add.
- `contextBindings`: the context objects the assistant can hold, such as folders,
  repo path, course name, deadlines, job direction, or reporting cadence.
- `defaultSkills`: skill IDs enabled by default.
- `runtimeRecommendation`: suggested runtime target or engine category.
- `handoffExamples`: examples of future messages the user would send to this
  assistant.

The card view should show only the decision-critical subset:

- role name,
- ongoing responsibility,
- first setup requirement,
- default Skill chips.

The detail/setup view can show examples and runtime choices.

## First Official Set

The first curated set should contain no more than six templates.

### 课程助教

Responsibility: manage one course over time: materials, assignments, exam prep,
and recurring questions.

Setup:

- course name,
- course material folder or uploaded files,
- exam and assignment dates if known.

Default Skills:

- PDF/document reading,
- study review,
- problem explanation,
- task reminders.

Future handoff examples:

- "把本周课件整理成复习提纲。"
- "这次作业要求是什么，截止前我还差哪些步骤？"
- "按考试时间倒排复习计划。"

### 项目汇报负责人

Responsibility: maintain reporting context for one research or work project,
including meeting notes, slides, decisions, feedback, and next report prep.

Setup:

- project name,
- project folder,
- report audience,
- reporting cadence.

Default Skills:

- presentation creation,
- document editing,
- meeting notes,
- spreadsheet/chart handling.

Future handoff examples:

- "根据上次反馈准备下周组会大纲。"
- "把这几份材料整理成 8 页汇报。"
- "哪些结论还缺数据支撑？"

### 实验记录管理员

Responsibility: maintain one experiment or data project: data files, field
definitions, chart outputs, result notes, and report language.

Setup:

- experiment or project name,
- data folder,
- field notes or schema,
- expected report format.

Default Skills:

- spreadsheet cleanup,
- statistics/charting,
- document writing,
- file organization.

Future handoff examples:

- "把今天的新数据合并进记录表。"
- "画趋势图并写结果段落。"
- "检查哪些字段含义还不明确。"

### 求职投递管家

Responsibility: manage one job-search direction over time: resume versions, job
descriptions, application status, interview notes, and follow-ups.

Setup:

- target role or direction,
- resume file,
- initial JD links or files,
- preferred follow-up cadence.

Default Skills:

- document editing,
- web/JD analysis,
- task reminders,
- interview preparation.

Future handoff examples:

- "针对这个 JD 改一版简历。"
- "记录这次投递并提醒我三天后跟进。"
- "根据面试反馈补一轮练习题。"

### 个人事务秘书

Responsibility: capture and track personal commitments that appear in chats,
notes, and reminders.

Setup:

- preferred reminder style,
- common task categories,
- optional personal context notes.

Default Skills:

- task creation,
- note summarization,
- meeting notes,
- light document drafting.

Future handoff examples:

- "把这段聊天里的承诺整理成待办。"
- "明天下午提醒我跟进这件事。"
- "每周五帮我回顾未完成事项。"

### 代码仓库维护员

Responsibility: maintain one code repository over time: bugs, tests, PR review,
release notes, and technical debt.

Setup:

- repo path,
- default agent engine,
- preferred test command,
- optional GitHub repo link.

Default Skills:

- code reading,
- terminal/test execution,
- GitHub or local repo workflow,
- changelog/release-note drafting.

Future handoff examples:

- "看一下这个失败测试是不是回归。"
- "审一下当前分支的改动。"
- "整理这个版本的 release notes。"

## Assistant Store UX

The store should avoid implying that assistant templates are just installable
Skills.

Card copy should use this hierarchy:

1. Role name.
2. "长期负责：" one short responsibility sentence.
3. "第一次需要：" one setup requirement.
4. Skill chips as supporting metadata.

The primary action should be "添加并设置", not only "添加". The next step is a
small initialization flow, because a context-bearing assistant is not useful
until it knows what it owns.

The initialization flow should collect only the fields needed to make the
assistant's first conversation useful. Every optional field must be skippable.

After setup, the assistant appears in Contacts and behaves like a normal bot
contact. The assistant store is not the place to operate the assistant after
creation.

## Relationship To Skills

Skills stay as the capability marketplace and configuration surface.

Assistants may reference default Skills, but the store should not sell the
Skill itself. For example:

- Bad assistant title: "PDF 证据整理"
- Good assistant title: "课程助教"
- Supporting Skill chip: "PDF 阅读"

The assistant setup may enable recommended Skills by default. Users can later
change enabled Skills from the assistant contact detail or Skill settings.

If a proposed official assistant has no durable context binding, it probably
belongs in Skills or slash commands instead of the assistant store.

## Data Shape

The official library can keep using `botPresets`, but each preset should gain
assistant-template fields:

```json
{
  "key": "course-tutor",
  "name": "课程助教",
  "category": "学习",
  "responsibility": "长期管理一门课的资料、作业、复习和答疑。",
  "setup": {
    "fields": [
      { "id": "courseName", "label": "课程名", "type": "text", "required": true },
      { "id": "materialsFolder", "label": "课程资料", "type": "folder", "required": false },
      { "id": "deadlines", "label": "考试/作业节点", "type": "textarea", "required": false }
    ]
  },
  "capabilities": {
    "enabledSkills": ["mia-official:paper-research", "mia-official:study-review"]
  }
}
```

Existing fields such as `line`, `desc`, `demo`, and `persona` can remain for
backward compatibility during migration, but new content should be generated
from the assistant-template fields.

## Migration

The current ten presets should be replaced or hidden from the official default
set:

- "论文搭子", "复习搭子", and "答疑助手" fold into "课程助教".
- "汇报设计师" and "会议纪要官" fold into "项目汇报负责人".
- "实验数据助手" and "表格整理师" fold into "实验记录管理员".
- "简历面试官" becomes "求职投递管家".
- "文档编辑" is demoted to a Skill/default capability, not an assistant.
- "剧情主持" is removed from the first official productivity set.

Custom user-created bots are unaffected.

## Error Handling

If setup data is missing, Mia should still create the assistant but start the
first conversation with a setup prompt asking for the missing context.

If a default Skill is unavailable, the assistant should still be created and
show the missing Skill as inactive metadata. The user should see a clear repair
or install action in the detail surface, not a failed add flow.

If folder or repo binding is denied by the OS, Mia should create the assistant
without that binding and ask the user to grant or select the folder later.

## Testing

Focused tests should verify:

- official presets include responsibility/setup/default skill metadata;
- assistant store cards render responsibility and setup requirements, not only
  skill labels;
- adding an official assistant persists setup fields into the bot persona or
  metadata;
- missing setup fields create a usable assistant with a first-message prompt;
- Skill chips remain metadata and do not replace the assistant title;
- existing user bots and custom bot creation remain compatible.

## Product Decisions For First Implementation

Setup bindings should be preserved as structured bot metadata when the current
bot save path can do so without a schema migration. If the current bot contract
cannot persist arbitrary metadata safely, the first implementation should fold a
plain-language setup summary into `personaText` and `description`, then leave the
structured metadata migration for a follow-up. The assistant must still behave
correctly from the user's perspective in either storage shape.

Assistant templates can create multiple contacts. For example, one "课程助教"
template can create "高等数学助教" and "计算机网络助教" as separate contacts
with separate context.

The store shows templates only. Created assistant instances live in Contacts and
normal conversation surfaces. The store should not become a second assistant
management view.
