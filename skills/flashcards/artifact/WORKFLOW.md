# Artifact Mode Workflow

Continue here after completing the shared Steps 1–3 in `SKILL.md`.

---

## Step 4: Write Raw LaTeX

For each card with mathematical notation, write the formula as a **raw LaTeX string**.

**Critical**: Output raw LaTeX syntax only. Do NOT:
- Pre-render to HTML
- Wrap in dollar signs or delimiters
- Use KaTeX CLI

The React artifact handles rendering client-side via the KaTeX library.

**Example**:
```javascript
// Correct: raw LaTeX string
a: 'T = \\frac{\\bar{Y}_T - \\bar{Y}_C}{\\widehat{SE}(\\bar{Y}_T - \\bar{Y}_C)}'

// Wrong: pre-compiled HTML
a: '<span class="katex"><span class="katex-mathml">...'
```

For LaTeX syntax lookup: `references/LATEX_SYNTAX.md`

---

## Step 5: Build Artifact

ALWAYS use the exact template from `artifact/template.jsx`. Replace:
- `TITLE` constant
- `topicNames` mapping
- `flashcards` array

### Card Data Structure

```javascript
{ id: 1, layer: 'L1', topic: 'TopicKey', starred: false, q: 'Question text', a: 'Raw LaTeX or plain text' }
```

The `a` field contains:
- Raw LaTeX for mathematical content (e.g., `'\\frac{a}{b}'`)
- Plain text for non-mathematical answers

The template's `MathRenderer` component automatically detects and renders LaTeX.

If the `frontend-design` skill is installed, follow its guidance for React artifact best practices.

---

## Step 6: Save and Present

Save to `/mnt/user-data/outputs/[name]_flashcards.jsx`

Report:
```
Draft: 45 cards (L1: 18, L2: 15, L3: 12). Review and let me know changes.
```

---

## Iterative Refinement

On user feedback (e.g., "Card 12's formula needs an inverse"):
1. Locate card in artifact
2. Update the raw LaTeX string
3. `str_replace` that card's entry
4. Same file path

On "save my starred cards":
- Update `starred: true` for specified IDs via `str_replace`

On "add more cards about X":
1. Generate new cards (repeat shared Steps 2–3 for new topic/content)
2. Append to the `flashcards` array via `str_replace`
3. Same file path
