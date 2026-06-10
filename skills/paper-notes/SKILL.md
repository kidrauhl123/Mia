---
name: daily-paper-generator
description: Use when the user asks to generate daily paper digests on a general topic. This skill supports both arXiv and bioRxiv (or either one), then produces structured Chinese/English summaries for selected papers.
version: 0.5.1
---

# Daily Paper Generator

## Overview

Discover, screen, and summarize recent papers for any research topic.

Supported sources:
- arXiv
- bioRxiv
- both (`--source both`)

Core workflow:
1. Define topic query and time window
2. Search papers from arXiv / bioRxiv
3. Select Top 10 candidates per field
4. Score and narrow to Top 3 per field
5. Choose Top 1 per field
6. Generate bilingual summaries
7. Save outputs to `daily paper/`

## When to Use

Use this skill when:
- The user asks for a daily/weekly paper digest on any topic
- The user wants recent papers from arXiv and/or bioRxiv
- The user needs structured bilingual notes for reading and tracking

## Output Format

Each summary should contain:
1. Paper title
2. Authors and venue/source
3. Link(s) and date
4. Chinese review (~300 words)
5. English review (concise academic prose)
6. Metadata table
7. Appendix (optional resources)

## Quick Reference

| Task | Method |
|---|---|
| Search papers | Use `scripts/arxiv_search.py` with `--source arxiv|biorxiv|both` |
| Topic selection | Use general-topic queries from `references/keywords.md` |
| Evaluate quality | Use `references/quality-criteria.md` |
| Write Chinese review | Use `references/writing-style.md` |
| Write English review | Follow scientific writing best practices |

## Workflow

### Step 1: Define query

Choose a concrete topic query. Examples:
- `test-time adaptation for medical imaging`
- `multimodal foundation model for healthcare`
- `protein language model interpretability`

### Step 2: Search arXiv and/or bioRxiv

Use helper script:

```bash
python skills/daily-paper-generator/scripts/arxiv_search.py \
  --query "test-time adaptation for medical imaging" \
  --source both \
  --months 1 \
  --max-results 80 \
  --output /tmp/papers.json
```

Notes:
- `--source arxiv`: arXiv only
- `--source biorxiv`: bioRxiv only
- `--source both`: merge both sources and sort by date

### Step 3: Top 10 candidate selection (per field)

For each candidate paper:
1. Check topic relevance from title + abstract
2. Remove obviously off-topic papers
3. Keep **Top 10 candidates** for this field

Minimum rule:
- Do not jump directly from raw search results to final paper.
- Keep an explicit Top 10 list first.

### Step 4: Top 3 quality shortlist (per field)

For the Top 10 pool:
1. Score each paper with `references/quality-criteria.md`
2. Rank by weighted score
3. Keep **Top 3**

### Step 5: Final Top 1 selection (per field)

For the Top 3 shortlist:
1. Compare novelty + method completeness + experimental credibility
2. Check practical impact for the field
3. Select **Top 1** as the final pick

Required output trace:
- Top 10 candidate list
- Top 3 scored shortlist (with weighted scores)
- Final Top 1 and one-paragraph selection rationale

### Step 6: Generate bilingual summaries

For each selected paper, generate:
- 中文评语：背景、挑战、贡献、方法、结果、局限
- English Review: concise, factual, non-formulaic

### Step 7: Save output

Recommended directory and naming:

```text
daily paper/
  YYYY-MM-DD-HHMM-paper-1.md
  YYYY-MM-DD-HHMM-paper-2.md
  YYYY-MM-DD-HHMM-paper-3.md
```

## Additional Resources

- `references/keywords.md`: general-topic query templates
- `references/quality-criteria.md`: scoring rubric
- `references/writing-style.md`: review writing style
- `example/daily paper example.md`: output example
- `scripts/arxiv_search.py`: arXiv + bioRxiv search helper

## Important Notes

1. Use explicit topic queries, avoid single-word vague queries.
2. Keep the time window explicit (`--months N`).
3. Distinguish source in metadata (`arxiv` vs `biorxiv`).
4. Use the fixed narrowing rule: **Top 10 -> Top 3 -> Top 1** (per field).
5. If a paper lacks robust evaluation, mark confidence and limitations clearly.
6. Do not fabricate unavailable fields (institution/GitHub/code links).
