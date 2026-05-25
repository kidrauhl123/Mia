# Pet Avatar Presets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the 16 pet-style images as a second manually selectable default avatar group for Fellow create/edit.

**Architecture:** Keep the existing 16 human default avatars and automatic `avatarAssetForKey()` behavior unchanged. Add a separate pet preset group with its own asset folders and make the Fellow avatar picker switch between preset groups before rendering the same existing circular preset buttons.

**Tech Stack:** Electron renderer, vanilla JavaScript, CSS, PNG assets, existing `npm run check`.

---

### Task 1: Add Pet Avatar Assets

**Files:**
- Create: `src/renderer/assets/avatars-pet/01.png` through `16.png`
- Create: `src/renderer/assets/avatar-thumbs-pet/01.png` through `16.png`

- [ ] **Step 1: Copy full pet assets**

Copy `/Users/jung/Downloads/宠物切图/pet_01.png` through `pet_16.png` into `src/renderer/assets/avatars-pet/01.png` through `16.png`.

- [ ] **Step 2: Generate pet thumbnails**

Generate square 256x256 PNG thumbnails into `src/renderer/assets/avatar-thumbs-pet/01.png` through `16.png`, fitting each source image inside the square without changing the source images.

- [ ] **Step 3: Verify asset counts**

Run: `find src/renderer/assets/avatars-pet src/renderer/assets/avatar-thumbs-pet -maxdepth 1 -type f | wc -l`

Expected: `32`

### Task 2: Extend the Fellow Avatar Picker

**Files:**
- Modify: `src/renderer/app.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/styles.css`

- [ ] **Step 1: Add preset group state**

Add `fellowAvatarPresetGroup: "human"` to renderer state. Do not change `avatarAssetForKey()`.

- [ ] **Step 2: Split presets into groups**

Keep the current 16 entries as the `human` group, add a `pet` group pointing to `./assets/avatars-pet/01.png` through `16.png`, and keep `avatarPresets` as a flattened compatibility array for existing lookup helpers.

- [ ] **Step 3: Add group switch markup**

Insert two buttons above the Fellow default avatar grid:

```html
<section class="avatar-default-panel" aria-label="默认头像">
  <div class="avatar-default-tabs" role="tablist" aria-label="默认头像风格">
    <button type="button" data-avatar-group="human">人形</button>
    <button type="button" data-avatar-group="pet">宠物</button>
  </div>
  <section class="avatar-defaults" aria-label="默认头像"></section>
</section>
```

- [ ] **Step 4: Render only the active group**

Update `renderFellowAvatarDefaults()` so it renders `avatarPresetGroups[state.fellowAvatarPresetGroup]`, wires tab clicks to switch the group and re-render, and still uses `setFellowAvatarDraft()` plus existing crop helpers when a preset is clicked.

- [ ] **Step 5: Style the tabs without disturbing the grid**

Add compact segmented tab styles and keep the existing `.avatar-defaults` grid dimensions.

### Task 3: Verify

**Files:**
- Test: `src/check.js`

- [ ] **Step 1: Run syntax and structure check**

Run: `npm run check`

Expected: `Mia project structure OK`

- [ ] **Step 2: Inspect focused diff**

Run: `git diff -- src/renderer/app.js src/renderer/index.html src/renderer/styles.css src/renderer/assets/avatars-pet src/renderer/assets/avatar-thumbs-pet`

Expected: only avatar picker logic, styles, markup, and new pet assets are changed.
