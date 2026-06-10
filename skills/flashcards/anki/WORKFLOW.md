# Anki TSV Export Workflow

Continue here after completing the shared Steps 1–3 in `SKILL.md`.

---

## Step 4: Prepare LaTeX (Do NOT Render)

**Critical:** Do NOT use KaTeX CLI. Keep LaTeX as raw text.

For each card with LaTeX:
1. Identify inline vs display math
2. Wrap in MathJax delimiters:
   - Inline: `\(LATEX\)`
   - Display: `\[LATEX\]`

See `anki/RENDERING.md` for delimiter rules and examples.

---

## Step 5: Build TSV File

### File Header

```
#separator:Tab
#html:true
#columns:Front	Back	Layer	Topic	Tags
```

**Note:** `#html:true` because MathJax delimiters contain backslashes that Anki should interpret as markup.

### Layer Field Values

Write the full display label into the Layer field:
- `L1 · Recall`
- `L2 · Understanding`
- `L3 · Boundaries`

This displays directly on the card — no template conditionals needed.

### Tags Column

Each card gets its own tags (space-separated):
- `STEM` — all cards
- Layer tag: `L1-Recall`, `L2-Understanding`, or `L3-Boundaries`
- Topic tag: sanitised topic name, e.g. `Statistics`, `LinearAlgebra`

### Row Format

```
[question]<TAB>[answer with \(...\)]<TAB>[layer label]<TAB>[topic name]<TAB>[tags]
```

### Example

```
#separator:Tab
#html:true
#columns:Front	Back	Layer	Topic	Tags
What is the formula for variance?	\(\sigma^2 = E[(X - \mu)^2]\)	L1 · Recall	Statistics	STEM L1-Recall Statistics
When does the CLT fail?	When the underlying distribution has infinite variance, e.g. Cauchy distribution.	L3 · Boundaries	Statistics	STEM L3-Boundaries Statistics
```

### Escaping Rules

- **Tabs in content:** Replace with spaces (tabs are the delimiter)
- **Newlines in answers:** Use `<br>` for multi-line answers (rare for atomic cards)
- **Quotes:** No escaping needed in TSV

---

## Step 6: Validate Before Saving

Before saving, verify:
- [ ] Card count matches generation count
- [ ] No literal tab characters inside question/answer fields
- [ ] All LaTeX is wrapped in `\(...\)` or `\[...\]`
- [ ] Every row has exactly 5 tab-separated columns
- [ ] Layer field uses full labels (`L1 · Recall`, etc.)

---

## Step 7: Save and Present

Save to `/mnt/user-data/outputs/[name]_anki.txt`

Report:
```
Generated 45 cards for Anki import:
- L1 (Recall): 18 cards
- L2 (Understanding): 15 cards
- L3 (Boundaries): 12 cards
```

Then include the import instructions from `anki/IMPORT_GUIDE.md`.

---

## Iterative Refinement

On user feedback (e.g., "Card 12's formula is wrong"):
1. Locate the row in the TSV file
2. Fix the content (keep MathJax delimiters)
3. `str_replace` that row
4. Same file path

On "add more cards about X":
1. Generate new rows (repeat shared Steps 2–3)
2. Wrap their LaTeX in MathJax delimiters
3. Append new rows to the end of the TSV file
4. Same file path

On "remove cards about X":
1. Identify matching rows
2. Delete them via `str_replace` (replace with empty string)
3. Same file path

