# SuperDashboard (Supernote plugin)

A configurable, always‑available dashboard for Supernote e‑ink devices. Its face is a draggable
**bubble** (⊕) that floats over everything; tap it to open the dashboard, drag it to move it.

![SuperDashboard demo](docs/dashboard-demo.gif)

▶ [Full walkthrough (MP4)](docs/dashboard-demo.mp4) · 📖 [User Guide](USER_GUIDE.md) · ⬇ [Latest release](../../releases/latest)

Capabilities validated on A5X + Manta are written up in the public repo's `docs/FINDINGS.md` and the
`supernote-plugin-dev` skill under `.claude/skills/`.

## Screenshots

| Dashboard | Clock faces | Configuration |
|---|---|---|
| ![Dashboard](docs/img/dashboard-hero.png) | ![Clock faces](docs/img/clock-styles.png) | ![Configuration](docs/img/config-look.png) |
| ![Stars](docs/img/stars.png) | ![MyStyle font](docs/img/font.png) | ![Another theme](docs/img/dashboard-themes.png) |

A 2‑column dashboard (Clock with two extra time zones + the week number, Device, Files, Clips, Search,
Stars, Apps, Recent, Keywords, Shortcuts); one dashboard showing every clock face (including the
7‑segment **Digital** one); the Look step of the settings wizard; the Stars block with handwriting
line previews; the whole UI in a MyStyle font; and a different design with sections collapsed.

## Which version do I need? (Supernote firmware)

In August 2026 Supernote began rolling out **Chauvet 3.29.43** (Manta / Nomad) and **2.26.40**
(A5 X / A6 X), which add a new plugin **permission system** and other breaking plugin‑API changes. It's
a developer preview today and is expected to reach everyone soon. A build made for one firmware version
does not run on the other, so pick the release that matches the version on your device (check it in the
device settings):

| Your Chauvet version | Download |
|---|---|
| Older than 3.29.43 (Manta/Nomad) / 2.26.40 (A5 X / A6 X) | **v0.22.0** |
| 3.29.43 (Manta/Nomad) / 2.26.40 (A5 X / A6 X) or later | **latest release** |

Both builds are the same SuperDashboard. The Chauvet build is rebuilt for `sn-plugin-lib` 0.1.65; on
first open it asks for **file access** (READ/WRITE) to scan your notes for stars/keywords and to remove a
star; if you deny it, the launcher (shortcuts, apps, opening files/folders) still works, only the
note‑scanning zones go empty. Once these firmware versions ship publicly, the Chauvet build becomes the
main one. Installing the wrong build shows *"package not compatible"* or the plugin does nothing.

## Permissions

On the plugin‑preview firmware SuperDashboard declares two **plugin permissions** in
`PluginConfig.json` (`uses-permissions`). They're requested once on first open and listed under
**Settings → Apps → Plugins → SuperDashboard → Permissions**:

![About this plugin, in device Settings](docs/img/about.png)

- **`plugin.permission.FILE:READ`**: read your notes and folders. Needed to scan for **stars &
  keywords**, build the **name‑search index**, read the **Recent** list, browse folders in the
  **Navigation** block, **capture Note Clips** by lasso, and load your **saved configuration**.
- **`plugin.permission.FILE:WRITE`**: write files. Needed to **save your configuration/profiles**, to
  **delete a star** from a note, and (only when you turn it on) to **draw the clip frame** on a note.

Why they're required: the Chauvet firmware enforces file access even on raw `java.io` reads of shared
storage; without `FILE:READ` the scans and the config read fail silently. If you **decline**, the
launcher (shortcuts, apps, opening files/folders, clock, device status) still works; only the
note‑scanning zones (Stars, Keywords, Search, Recent) and saving settings are affected.

SuperDashboard is **fully offline**: it declares **no `INTERNET`** permission and makes no network
calls. At the Android level it additionally uses the floating‑window permission (for the bubble) and
the app‑query permission (to list & launch apps for the Apps zone).

## Two surfaces

- **Bubble tap → Dashboard**: the composed result. `⊖` folds it back to the bubble; `⚙ Configuration`
  (top‑left) opens Settings.
- **Plugin toolbar button → Dashboard** too; except on first run (no config saved yet), which opens
  the Settings wizard so there's something to configure.
- **Settings** is a guided **2‑step wizard** (Look · Sections); every change autosaves. Each block is
  configured inline with a **🔧** button in the Sections step. Header has Reset all + Save/load config.

## Configuration

The **Look** step picks the column count (1/2/3), the vertical flow (masonry / fixed height), one of
**9 designs** (ledger, boxed, airy, grid black, grid grey, compact, card, minimal, underline), the
bubble, text & heading sizes, the **font** (System default or any `.ttf`/`.otf` you drop into
`MyStyle/fonts`), whether block type icons show, the Note‑Clips frame, and the scan policy. The
**Sections** step is a per‑column canvas with a live preview: **＋ add block** picks a type, ▲▼ reorder,
◀▶ move between columns, **🔧** configures a block inline, ✕ removes it.

| Look | Sections |
|---|---|
| ![Look step](docs/img/config-look-2.png) | ![Sections step](docs/img/config-sections.png) |

## The bubble

![The house bubble on a note](docs/screenshots/bubble-house.png)

The bubble is the **house logo** in a rounded white chip (drawn natively so it stays crisp on
e‑ink): icon only, no text. It shows top‑right on first use, then stays wherever you drag it. Hidden
while the dashboard is on screen and restored on the way out; driven by the app's foreground state,
so it self‑heals on every exit path (buttons, a stray system gesture, the host backgrounding the
view) and can't get stranded. It's an overlay of the persistent plugin host, so it's re‑shown when
the plugin reloads (after a reboot / auto power‑off). It's a simple **On / Off** choice in Settings →
Look: Off uses only the toolbar button. **Removing the plugin now clears the bubble automatically**
(via the firmware's plugin‑destroy event); you no longer have to set it Off first, and a reboot
remains the ultimate fallback.

## Zones

Arranged in **1, 2 or 3 independent columns**, flowing either as **masonry** (each block takes its
natural height) or **fixed height** (each block gets a set height and scrolls inside; collapsing a
block keeps its grid slot so the ones below it don't jump up). Any titled block **collapses** to its
title (▾/▸), and the block's type icon can be shown or hidden on the title.

- **Shortcuts**: open a folder, a note, a PDF, an EPUB or a comic (CBZ/XPS/FB2) in one tap (list /
  grid / inline).
- **Files**: a small in‑dashboard file browser: walk your folders and open a note/document without
  leaving the dashboard.
- **Search**: type to find files, folders and keywords across your notes (small query grammar, see
  below).
- **Recent**: on the stable firmware, the device's recently‑**opened** notes & PDFs, read live from
  `/Recent/Recent.txt` (device caps it at 8). On Chauvet 3.29.43 / 2.26.40 and later that file is
  outside the permission sandbox, so Recent falls back to the recently‑**modified** notes/documents
  under `/Note` + `/Document` (newest first, cached).
- **Stars**: five‑star pages from the scan, grouped by note; optional per‑star **line preview**
  (handwriting image, or OCR text with image fallback); delete a single star (`✕★`).
- **Keywords**: keyword occurrences as tappable chips; each opens its note **on the right page**.
- **Clock**: time + date + week number + extra time zones, in a choice of faces (see below).
- **Device**: battery, free storage (internal + SD card) and a stats line (notes / pdf / stars /
  keywords counts); each part is toggleable.
- **Apps**: launch device apps via exported‑activity intents.
- **Note Clips**: snippets you lassoed from your notes, as labelled thumbnails (see below).
- **Empty**: a spacer to reserve vertical space / line columns up.

The **Stars** and **Keywords** blocks show their last‑scan time and a small **↻** in the block header
(left of the collapse arrow), so a rescan is one tap without a heavy in‑card button.

Opening a file uses the firmware's `PluginFileAPI.openFile`, which jumps straight to the target page
(the old intent‑based opener ignored the page and reopened the last‑viewed one), with a fallback to
the legacy intents on older firmware.

### Note Clips

In a note, lasso anything and tap **"Add to Dashboard"** in the lasso toolbar; the snippet is captured
silently (no view opens) and pinned as a labelled thumbnail in any **Clips** block. Tapping a clip
jumps back to its **exact source note and page**. Label a clip with **🏷** (the editor lists your
existing labels to reuse, plus a field for a new one). A Clips block can **filter** by source folder
and/or label, **sort** Newest / Oldest / Label / Note, switch grid or list, and set thumbnail **size**
S / M / L; a clip is never scaled larger than the original extract. Optionally a thin **frame**
(off / grey / black, set in Look) is drawn on the note around what you captured, as a permanent mark
(removing the clip does not erase it). Notes only (PDF lasso isn't supported); up to 200 clips.

![Note lassoed for a clip](docs/img/note-clip-source.png)

### Clock

Faces: **Large**, **Compact**, **Weekday**, **Jumbo**, **Digital** (a real 7‑segment display, bundled
so it works offline) and **Stamp**. 12 or 24 hour; the **date** is optional; an optional **week
number** in either **ISO** (Monday‑start, the European standard) or **US** (Sunday‑start) convention;
and any number of **extra time zones**, each a label plus a +/- hour offset from your device's local
time (a ½ control adds the 30‑minute zones). A regional format sets the date order and month/day names.

![Clock faces](docs/img/clock-styles.png)

### Search

Searches file & folder names plus keywords from your scanned notes, grouped into Notes / PDFs / other
docs / Folders / Keywords. Grammar: `"phrase"` (literal), `=exact`, `a|b` (either), `!word` (exclude),
`f:folder`, `kw:` (keywords only), `star:` (starred files only), `type:note|pdf|doc|folder`, and
`approx:` (typo‑tolerant). A block can be scoped to specific folders.

![Search results](docs/img/search.png)

## Scanning

Stars/Keywords come from scanning the chosen folders. The scan is **incremental** (a persisted
per‑file cache keyed by path+mtime; only edited notes are re‑scanned), so the first scan of a folder
set is slow and later ones are near‑instant. Zones over the same folders share one scan.

A **manual ↻ Refresh** additionally flushes the note currently open underneath (`saveCurrentNote`) so
stars/keywords you just added on the current page are caught without turning the page. Auto‑scan on
open never flushes.

## Storage

- **Config**: JSON at `MyStyle/Plugins/Dashboard/config.json`, written by the wizard (native atomic
  write, read via the native reader; `fetch` caches `file://`). Named profiles in `profiles.json`.
  Hand‑editable; `normalize`/`normalizeZone` guard against malformed input. (The on‑disk folder keeps
  its historical `Dashboard` name so existing settings survive the rename to SuperDashboard.)
- **Caches**: the scan cache (`scancache.json`) and star line‑preview PNGs (`line_*.png`) live in
  the **plugin‑private dir** (`getPluginDirPath()`), not `MyStyle` (which is cloud‑synced and
  file‑observed; caches don't belong there). Orphaned line PNGs are garbage‑collected after every
  Stars scan (a deleted star / removed note / preview turned off no longer leaks its PNG). Migrated
  once from the old `MyStyle` location, which is then purged.

## Build & deploy

```bash
source ../env.sh                                       # JDK 21 + Android SDK on PATH
./buildPlugin.sh                                       # → build/outputs/SuperDashboard.snplg
gio copy build/outputs/SuperDashboard.snplg 'mtp://<device>/Supernote/MyStyle/SuperDashboard.snplg'
# install on device: Settings → Apps → Plugins → Choose Installation Package (pick the .snplg)
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
