# Importing into Anki

Present these instructions to the user after generating the TSV file.

---

## Step 1: Set Up Note Type (First Time Only)

1. Open Anki → **Tools → Manage Note Types**
2. Click **Add** → choose **Add: Basic** → name it **"3-Layer Card"**
3. Click **Fields...** and add these fields (Front and Back already exist):
   - **Layer**
   - **Topic**
   - **Tags** (Anki handles this automatically from the Tags column)
4. Click **Cards...** and set up the template from `anki/NOTE_TYPE_TEMPLATE.md`

## Step 2: Import the File

1. Open Anki → **File → Import**
2. Select the downloaded `.txt` file
3. In the import dialog:
   - **Type:** Select your "3-Layer Card" note type
   - **Deck:** Choose your target deck (or create a new one)
   - Verify the field mapping:

| File Column | → | Anki Field |
|-------------|---|------------|
| Column 1 | → | Front |
| Column 2 | → | Back |
| Column 3 | → | Layer |
| Column 4 | → | Topic |
| Column 5 | → | Tags |

4. Click **Import**

## Step 3: Verify

1. Browse to your deck
2. Open a card with math notation
3. Verify that formulas render correctly
4. If math doesn't render, ensure you're using Anki 2.1+ (has built-in MathJax)

---

## Studying by Layer

Create filtered decks to study specific layers:

1. **Tools → Create Filtered Deck**
2. Use these searches:
   - L1 only: `"deck:Your Deck" tag:L1-Recall`
   - L2 only: `"deck:Your Deck" tag:L2-Understanding`
   - L3 only: `"deck:Your Deck" tag:L3-Boundaries`
   - Specific topic: `"deck:Your Deck" tag:Statistics`
   - Combined: `"deck:Your Deck" tag:L3-Boundaries tag:Statistics`

---

## Troubleshooting

**Math not rendering:**
- Ensure Anki version is 2.1 or later (built-in MathJax)
- Verify formulas use `\(...\)` delimiters, not `$...$`

**Layer not showing on cards:**
- Verify the Layer field exists in your note type
- Check that `{{Layer}}` is in your card template (see `anki/NOTE_TYPE_TEMPLATE.md`)

**Wrong number of cards imported:**
- Check the import summary for duplicate/skipped notes
- Verify the TSV file has the correct number of data rows (excluding header lines)

