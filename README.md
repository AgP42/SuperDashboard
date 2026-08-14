# Dashboard (Supernote plugin)

A configurable, always‑available dashboard for Supernote e‑ink devices. Its face is a draggable
**bubble** (⊕) that floats over everything; tap it to open the dashboard, drag it to move it.

![Dashboard demo](docs/dashboard-demo.gif)

▶ [Full walkthrough (MP4)](docs/dashboard-demo.mp4) · 📖 [User Guide](USER_GUIDE.md) · ⬇ [Latest release](../../releases/latest)

Capabilities validated on A5X + Manta are written up in the public repo's `docs/FINDINGS.md` and the
`supernote-plugin-dev` skill under `.claude/skills/`.

## Two surfaces

- **Bubble tap → Dashboard**: the composed result. `⊖` folds it back to the bubble; `⚙ Configuration`
  (top‑left) opens Settings.
- **Plugin toolbar button → Dashboard** too — except on first run (no config saved yet), which opens
  the Settings wizard so there's something to configure.
- **Settings** is a guided **3‑step wizard** (Look · Sections · Content); every change autosaves.
  Header has Reset all + Save/load config.

## The bubble

Shows top‑right on first use, then stays wherever you drag it. Hidden while the dashboard is on
screen and restored on the way out — driven by the app's foreground state, so it self‑heals on every
exit path (buttons, a stray system gesture, the host backgrounding the view) and can't get stranded.
It's an overlay of the persistent plugin host, so it's re‑shown when the plugin reloads (after a
reboot / auto power‑off). Turn it **Off** in Settings → Look to use only the toolbar button.

## Zones

Stacked (or 2‑column masonry), each one of:

- **Shortcuts** — open a folder, a note, a PDF, or an EPUB in one tap (list / grid / inline).
- **Recent** — recently‑opened notes & PDFs, read live from `/Recent/Recent.txt` (no scan; device
  caps it at 8).
- **Stars** — five‑star pages from the scan, grouped by note; optional per‑star **line preview**
  (handwriting image, or OCR text with image fallback); delete a single star (`✕★`).
- **Keywords** — keyword occurrences as tappable chips; each opens its note + page.
- **Apps** — launch device apps via exported‑activity intents.

## Scanning

Stars/Keywords come from scanning the chosen folders. The scan is **incremental** (a persisted
per‑file cache keyed by path+mtime — only edited notes are re‑scanned), so the first scan of a folder
set is slow and later ones are near‑instant. Zones over the same folders share one scan.

A **manual ↻ Refresh** additionally flushes the note currently open underneath (`saveCurrentNote`) so
stars/keywords you just added on the current page are caught without turning the page. Auto‑scan on
open never flushes.

## Storage

- **Config** — JSON at `MyStyle/Plugins/Dashboard/config.json`, written by the wizard (native atomic
  write, read via the native reader — `fetch` caches `file://`). Named profiles in `profiles.json`.
  Hand‑editable; `normalize`/`normalizeZone` guard against malformed input.
- **Caches** — the scan cache (`scancache.json`) and star line‑preview PNGs (`line_*.png`) live in
  the **plugin‑private dir** (`getPluginDirPath()`), not `MyStyle` (which is cloud‑synced and
  file‑observed — caches don't belong there). Orphaned line PNGs are garbage‑collected after every
  Stars scan (a deleted star / removed note / preview turned off no longer leaks its PNG). Migrated
  once from the old `MyStyle` location, which is then purged.

## Build & deploy

```bash
source ../env.sh
./buildPlugin.sh                                   # → build/outputs/dashboard.snplg
gio copy build/outputs/dashboard.snplg 'mtp://<device>/Supernote/MyStyle/dashboard.snplg'
# install on device: Settings → Apps → Plugins → Add Plugin
```

## Known limitations

- PDFs open on their last‑used page (no page‑jump yet).
- Stars/keywords inside PDFs aren't returned by the SDK (notes only).
- New stars/keywords on the page being edited are caught by a **manual ↻ Refresh** (which flushes the
  open note); an auto‑scan alone sees them only after a page‑turn (when the editor saves).

## Support

Dashboard is a personal project built by a Supernote user, for Supernote users. If it saves you a few
taps every day, a small contribution is appreciated: https://ko-fi.com/agp42
