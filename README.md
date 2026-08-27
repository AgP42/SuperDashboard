# SuperDashboard (Supernote plugin)

A configurable, always‑available dashboard for Supernote e‑ink devices. Its face is a draggable
**bubble** (⊕) that floats over everything; tap it to open the dashboard, drag it to move it.

![SuperDashboard demo](docs/dashboard-demo.gif)

▶ [Full walkthrough (MP4)](docs/dashboard-demo.mp4) · 📖 [User Guide](USER_GUIDE.md) · ⬇ [Latest release](../../releases/latest)

Capabilities validated on A5X + Manta are written up in the public repo's `docs/FINDINGS.md` and the
`supernote-plugin-dev` skill under `.claude/skills/`.

## Which version do I need? (Supernote firmware)

In August 2026 Supernote began rolling out **Chauvet 3.29.43** (Manta / Nomad) and **2.26.40**
(A5 X / A6 X), which add a new plugin **permission system** and other breaking plugin‑API changes. It's
a developer preview today and is expected to reach everyone soon. A build made for one firmware version
does not run on the other, so pick the release that matches the version on your device (check it in the
device settings):

| Your Chauvet version | Download |
|---|---|
| Older than 3.29.43 (Manta/Nomad) / 2.26.40 (A5 X / A6 X) | **v0.22.0** |
| 3.29.43 (Manta/Nomad) / 2.26.40 (A5 X / A6 X) or later | **v1.0.0** |

Both builds are the same SuperDashboard. **v1.0.0** is rebuilt for `sn-plugin-lib` 0.1.65; on first open
it asks for **file access** (READ/WRITE) to scan your notes for stars/keywords and to remove a star — if
you deny it, the launcher (shortcuts, apps, opening files/folders) still works, only the note‑scanning
zones go empty. Once these firmware versions ship publicly, v1.0.0 becomes the main build. Installing the
wrong build shows *"package not compatible"* or the plugin does nothing.

## Two surfaces

- **Bubble tap → Dashboard**: the composed result. `⊖` folds it back to the bubble; `⚙ Configuration`
  (top‑left) opens Settings.
- **Plugin toolbar button → Dashboard** too — except on first run (no config saved yet), which opens
  the Settings wizard so there's something to configure.
- **Settings** is a guided **3‑step wizard** (Look · Sections · Content); every change autosaves.
  Header has Reset all + Save/load config.

## The bubble

![The house bubble on a note](docs/screenshots/bubble-house.png)

The bubble is the **house logo** in a rounded white chip (drawn natively so it stays crisp on
e‑ink) — icon only, no text. It shows top‑right on first use, then stays wherever you drag it. Hidden
while the dashboard is on screen and restored on the way out — driven by the app's foreground state,
so it self‑heals on every exit path (buttons, a stray system gesture, the host backgrounding the
view) and can't get stranded. It's an overlay of the persistent plugin host, so it's re‑shown when
the plugin reloads (after a reboot / auto power‑off). It's a simple **On / Off** choice in Settings →
Look — Off uses only the toolbar button. **Removing the plugin now clears the bubble automatically**
(via the firmware's plugin‑destroy event) — you no longer have to set it Off first, and a reboot
remains the ultimate fallback.

## Zones

Stacked (or 2‑column masonry), each one of:

- **Shortcuts** — open a folder, a note, a PDF, an EPUB or a comic (CBZ/XPS/FB2) in one tap (list /
  grid / inline).
- **Recent** — on the stable firmware, the device's recently‑**opened** notes & PDFs, read live from
  `/Recent/Recent.txt` (device caps it at 8). On Chauvet 3.29.43 / 2.26.40 and later that file is
  outside the permission sandbox, so Recent falls back to the recently‑**modified** notes/documents
  under `/Note` + `/Document` (newest first, cached).
- **Stars** — five‑star pages from the scan, grouped by note; optional per‑star **line preview**
  (handwriting image, or OCR text with image fallback); delete a single star (`✕★`).
- **Keywords** — keyword occurrences as tappable chips; each opens its note **on the right page**.
- **Apps** — launch device apps via exported‑activity intents.

Opening a file uses the firmware's `PluginFileAPI.openFile`, which jumps straight to the target page
(the old intent‑based opener ignored the page and reopened the last‑viewed one), with a fallback to
the legacy intents on older firmware.

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
  Hand‑editable; `normalize`/`normalizeZone` guard against malformed input. (The on‑disk folder keeps
  its historical `Dashboard` name so existing settings survive the rename to SuperDashboard.)
- **Caches** — the scan cache (`scancache.json`) and star line‑preview PNGs (`line_*.png`) live in
  the **plugin‑private dir** (`getPluginDirPath()`), not `MyStyle` (which is cloud‑synced and
  file‑observed — caches don't belong there). Orphaned line PNGs are garbage‑collected after every
  Stars scan (a deleted star / removed note / preview turned off no longer leaks its PNG). Migrated
  once from the old `MyStyle` location, which is then purged.

## Build & deploy

```bash
source ../env.sh                                       # JDK 21 + Android SDK on PATH
./buildPlugin.sh                                       # → build/outputs/SuperDashboard.snplg
gio copy build/outputs/SuperDashboard.snplg 'mtp://<device>/Supernote/MyStyle/SuperDashboard.snplg'
# install on device: Settings → Apps → Plugins → Add Plugin
```

## Known limitations

- On Chauvet 3.29.43 / 2.26.40 and later, `/Recent/Recent.txt` is outside the FILE:READ sandbox, so the
  Recent zone shows recently‑**modified** files (under `/Note` + `/Document`) instead of recently‑opened ones.
- Stars/keywords inside PDFs aren't returned by the SDK (notes only).
- New stars/keywords on the page being edited are caught by a **manual ↻ Refresh** (which flushes the
  open note); an auto‑scan alone sees them only after a page‑turn (when the editor saves).

## Support

SuperDashboard is a personal project built by a Supernote user, for Supernote users. If it saves you a
few taps every day, a small contribution is appreciated: https://ko-fi.com/agp42
