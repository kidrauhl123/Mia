# Anki MCP Direct Push Workflow

Continue here after completing the shared Steps 1–3 in `SKILL.md`.

**Prerequisite:** Anki must be running with the MCP Server addon (code `124672614`) active on `http://127.0.0.1:3141/`.

---

## Step 4: Prepare LaTeX (Do NOT Render)

**Critical:** Do NOT use KaTeX CLI. Keep LaTeX as raw text.

For each card with LaTeX:
1. Identify inline vs display math
2. Wrap in MathJax delimiters:
   - Inline: `\(LATEX\)`
   - Display: `\[LATEX\]`

See `anki/RENDERING.md` for delimiter rules and examples. Anki renders the math via its built-in MathJax — the delimiters are identical regardless of whether cards arrive via TSV import or MCP push.

---

## Step 5: Ensure Note Type Exists

1. Call `model_names` to list existing note types
2. If **"3-Layer Card"** is missing, create it:

Call `create_model` with:
- **modelName:** `3-Layer Card`
- **fields:** `Front`, `Back`, `Layer`, `Topic`
- **cardTemplates:** front/back HTML from `anki/NOTE_TYPE_TEMPLATE.md`
- **css:** styling from `anki/NOTE_TYPE_TEMPLATE.md`

3. If the model already exists, call `model_field_names` with modelName `3-Layer Card` and verify it returns `[Front, Back, Layer, Topic]`

Optionally call `update_model_styling` to refresh the CSS if `anki/NOTE_TYPE_TEMPLATE.md` has been updated.

---

## Step 6: Ensure Deck Exists

1. Call `list_decks` to list existing decks
2. If the target deck is missing, call `create_deck` with the desired deck name
3. If the user didn't specify a deck name, ask them — or default to `"STEM"`

---

## Step 7: Push Cards to Anki

For each generated card, call `add_note` with:

```
deckName: "<target deck>"
modelName: "3-Layer Card"
fields:
  Front: "<question text>"
  Back: "<answer with \(...\) or \[...\] MathJax delimiters>"
  Layer: "L1 · Recall"            (or "L2 · Understanding" or "L3 · Boundaries")
  Topic: "<topic name>"
tags: ["STEM", "L1-Recall", "<TopicName>"]
```

### Tag Format

Same as TSV mode (space-separated in the tags array):
- `STEM` — all cards
- Layer tag: `L1-Recall`, `L2-Understanding`, or `L3-Boundaries`
- Topic tag: sanitised topic name, e.g. `Statistics`, `LinearAlgebra`

### Error Handling

If `add_note` fails for a card:
- Log the failure with the card's Front text
- Continue with remaining cards
- Report failures at the end

---

## Step 8: Report Results

```
Pushed 45 cards directly to Anki (deck: "STEM"):
- L1 (Recall): 18 cards
- L2 (Understanding): 15 cards
- L3 (Boundaries): 12 cards

No import needed — cards are already in Anki.
```

If any cards failed, append:
```
⚠ 2 cards failed to push (see details above). You can retry or switch to TSV export mode.
```

---

## Iterative Refinement

On user feedback (e.g., "Card 12's formula is wrong"):
1. Call `find_notes` with a query matching the card (e.g., `"deck:STEM Front:*formula for variance*"`)
2. Call `notes_info` to get the note ID and current field values
3. Call `update_note_fields` with the corrected fields

On "add more cards about X":
1. Generate new cards (repeat shared Steps 2–3)
2. Wrap their LaTeX in MathJax delimiters
3. Call `add_note` for each new card

On "remove cards about X":
1. Call `find_notes` with `"tag:TopicName"` or a field-based query
2. Confirm with the user which cards to delete
3. Call `delete_notes` with the note IDs

On "show me the cards in Anki":
1. Call `gui_browse` with `"deck:DeckName"` to open Anki's browser

On "update the card styling":
1. Call `update_model_styling` with the new CSS for model `3-Layer Card`

