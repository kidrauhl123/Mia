# Revision Notes Generator

> **Source:** Converted from [revision-notes/prompt-v2.txt](https://github.com/maaarcooo/llm-custom-instructions/blob/main/revision-notes/prompt-v2.txt)

Generate concise, accurate revision notes from PDF or Markdown study materials.

## The Problem

Study materials are often dense, poorly organised, or contain errors. Condensing them manually is slow and risks missing key content or carrying forward inaccuracies. Students need structured notes that prioritise examinable knowledge without the clutter of specification codes, repeated content, or unnecessary padding.

## The Solution

Automated generation of concise revision notes that cross-checks source accuracy and corrects errors. The output is structured markdown with clear heading hierarchy, bold key terms, and equations in code blocks. Higher Tier content is included and optionally marked, while specification/syllabus reference codes are excluded — the focus is purely on knowledge content.

## Key Features

- **5-step process** — Read, identify, verify, write, output
- **Accuracy verification** — Cross-checks facts against known information and corrects errors in the source
- **Writing guidelines** — Concise, complete, accurate, structured, clean, Higher Tier
- **Higher Tier support** — Includes advanced content with optional (HT) marking
- **Clean output** — Excludes specification codes, focuses on knowledge content

## When to Use

When asked to create revision notes, study notes, topic summaries, or condensed notes from educational PDFs, Markdown files, textbooks, or course materials.

## How It Works

1. **Read** the source file thoroughly
2. **Identify** key content: bolded terms, highlighted text, and Higher Tier material
3. **Verify** accuracy of all information — correct any errors found
4. **Write** concise notes covering all essential knowledge
5. **Output** as a structured markdown file

## Writing Guidelines

- **Concise**: Condense to essential points
- **Complete**: Cover all necessary knowledge
- **Accurate**: Cross-check and correct errors
- **Structured**: Clear headings and logical organisation
- **Clean**: Exclude specification/syllabus codes
- **Higher Tier**: Include and optionally mark with (HT)

## Output Format

Markdown with title, section headings, bold key terms, and equations in code blocks.

```markdown
# Topic Title

## Section Heading

**Key term** — definition or explanation.

Another important point covering essential knowledge.

### Subsection

- Concise bullet points for related facts
- `equation or formula in code block`
```

## Sample Prompts

```
Use "revision-notes-generator" skill to create revision notes of the study materials.
```

```
Use "revision-notes-generator" skill to create revision notes of the study materials with title "<title>".
```

## Installation

Place the `SKILL.md` file in your Claude skills directory:

```
skills/
└── revision-notes-generator/
    └── SKILL.md
```

Then trigger by asking Claude to create revision notes, study notes, or topic summaries.
