---
name: revision-notes-generator
description: Generate concise revision notes from PDF or Markdown study materials. Use when asked to create revision notes, study notes, topic summaries, or condensed notes from educational PDFs, Markdown files, textbooks, or course materials. Outputs as a markdown file.
---

# Revision Notes Generator

Generate concise, accurate revision notes from PDF or Markdown content in markdown format.

## Process

1. Read the source PDF or Markdown file thoroughly
2. Identify all key content: **bolded terms**, highlighted text, and Higher Tier material
3. Verify accuracy of all information in the source — correct any errors
4. Write concise notes covering all essential topic knowledge
5. Output as markdown file with the specified title

## Writing Guidelines

**Concise**: Condense information to essential points. Remove filler and redundancy.

**Complete**: Cover all necessary knowledge for the topic. Don't omit key concepts.

**Accurate**: Cross-check facts against your knowledge. Flag or correct any errors in the source material.

**Structured**: Use clear headings and logical organisation. Group related concepts.

**Clean**: No clutter — exclude specification codes, redundant headers, or formatting artefacts from the source.

**Higher Tier**: Clearly include all Higher Tier content — optionally mark with (HT) if helpful.

## Output Format

Markdown file with:
- Title as H1 heading (use exact title specified by user)
- Logical section headings (H2/H3)
- Key terms in **bold**
- Equations/formulas in code blocks or LaTeX where appropriate
- Concise bullet points or short paragraphs

**Exclude**: Specification/syllabus reference codes (e.g., "1.1.3 a)", "1.1.3 b)"). These clutter the notes — focus only on the actual knowledge content.

## Example Structure

```markdown
# [Topic Title]

## Key Concepts

**Term**: Definition.

## Section Name

Core explanation in concise form.

- Key point one
- Key point two (HT)

## Equations

`formula = expression`
```

## Quality Checklist

- [ ] Title matches user's specification exactly
- [ ] All bolded/highlighted terms from source included
- [ ] Higher Tier content included
- [ ] Information verified for accuracy
- [ ] No unnecessary repetition
- [ ] Clear logical structure
- [ ] No specification reference codes included
