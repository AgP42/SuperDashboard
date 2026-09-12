# Changelog

What changed in each **public release** of SuperDashboard, written from the user's
side: what you can do that you couldn't before. Development builds in between are
not listed.

Every release is on the [releases page](https://github.com/AgP42/SuperDashboard/releases);
the `.snplg` goes in your device's `MyStyle` folder, then
**Settings → Apps → Plugins → Choose Installation Package**.

---

## v1.8.21 — 2026-09-09

### Improved
- **Stars, "Text" line preview: typewritten lines are read directly.** When a star
  sits on a line you typed (or handwriting you converted to text), that text is now
  read straight from the note instead of being OCR'd. It shows as exact, legible
  text rather than falling back to an image that shrank to nothing in a two-column
  layout. Handwriting is still OCR'd, with the image as a fallback.

### Fixed
- **Renaming a block now saves when you handwrite the name.** The title field saves
  as you type, not only on "Done" or when you tap away, so a handwritten name that
  the device converts to text is no longer silently lost.

---

## v1.8.20 — 2026-09-08

A large **Note Clips** update.

### New
- **Paste a clip back into any note**, in one tap. Handwriting is inserted as an
  image, an OCR'd clip as an **editable text box**; both centred, each with a small
  **"↩ source"** link back to where it came from.
- **Backlinks follow the page.** Reorder the source note's pages, or move the page
  to another note, and tapping the clip still lands on the right page.
- **OCR clips to text** (optional). Recognition runs in the background right after
  capture, so it never slows down the capture itself. Each Clips block shows
  **Handwriting**, **OCR text**, or **Both**, and pasted text uses a font and size
  of your choice, including your MyStyle fonts.
- **Auto-label by underlining.** Underline a word (or several) with the straight-line
  tool while clipping and each becomes a label, on-device.
- **Per-clip cards**, collapsible: a header with the source note, page and labels; a
  body with the content and the actions.
- **Live label filter** in the block header, chips combining with OR, plus a grey
  **no label** chip.
- **Sort and group** by Newest / Oldest / Label / Note.

### Changed
- The lasso button is now **"Clip to Dashboard"**, and it no longer greys out when
  the selection contains a shape or a straight line.

### Fixed
- Pasted clips no longer distort when moved, pasted OCR text boxes appear at the
  right size immediately, the first-render image smear on e-ink is gone, and
  underline label capture handles capitals, ascenders and descenders without
  pulling in text from the line below.

---

## v1.6.7 — 2026-09-02

A large feature release.

### New
- **Note Clips.** Lasso anything in a note and pin it to the dashboard as a labelled
  thumbnail that links back to its exact source page. Filter by folder or label,
  sort, size, and optionally draw a grey or black frame on the note.
- **A much richer Clock.** Extra time zones dialled in with +/- offsets (including
  half-hour zones), ISO or US week numbers, optional date, and several faces
  including a bundled 7-segment **Digital** style.
- **Name search.** A Search block over file and folder names plus scanned keywords,
  with a compact query grammar: `"phrase"`, `=exact`, `a|b`, `!not`, `f:folder`,
  `kw:`, `star:`, `type:`, `approx:`.
- **Device status**: battery, free storage (internal and SD card), and a library tally.
- **File browser** block, **1/2/3 columns** with masonry or fixed-height flow,
  **collapsible** blocks, a **MyStyle font** picker, and nine designs.

---

## v1.0.2 — 2026-09-01

### Fixed
- **The bubble appeared as a black square** on some e-ink devices (reported on
  Manta). The overlay window is now translucent, so the rounded chip shows the page
  behind its corners as intended.

---

## v1.0.1 — 2026-08-30

### Fixed
- **The bubble was too large** on 300 dpi devices (Manta, Nomad), about 1 cm wide.
  The house icon is sized in SP again, so it follows the device font-size setting
  and the chip is back to roughly 6-7 mm.

---

## v1.0.0 — 2026-08-27

First release under the name **SuperDashboard**: a configurable, always-available
dashboard reached from a draggable house bubble, built from shortcuts, recent files,
stars, keywords and app launchers. Fully offline.

### New
- Support for **Chauvet 3.29.43** (Manta / Nomad) and **2.26.40** (A5 X / A6 X) and
  their new plugin **permission system**.
- Renamed to SuperDashboard, with a new **house logo** and a cleaner bubble drawn
  natively so it stays crisp on e-ink.
- Files open **on the target page** from stars, keywords and shortcuts.
- Removing the plugin **clears its bubble** automatically, instead of stranding it.
- **Recent** falls back to recently-modified notes and documents on firmware where
  the device's own recent list is outside the plugin sandbox.

> Earlier builds were published as **Dashboard v0.x** for pre-Chauvet-3.29.43
> firmware. They are not covered by this changelog.
