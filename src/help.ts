/**
 * Short, on-device help for each module, shown from the ⓘ in the Settings ->
 * Sections step. Keyed by Zone type. Three parts: what it does, how to configure
 * its options, and an optional "good to know". The full user guide (with
 * screenshots) is on GitHub; this is the quick, precise version.
 */
export interface HelpEntry {
  title: string;
  what: string;
  how: string;
  good?: string;
}

export const HELP: Record<string, HelpEntry> = {
  shortcuts: {
    title: 'Shortcuts',
    what: 'One-tap openers for the folders, notes, PDFs and EPUBs you use most; each opens on its saved page.',
    how: 'Add with the "+" (a browser: tick several items, then Save). Reorder with ▲▼, remove with ✕. Layout: List, Grid (tiles) or Inline (wrapping chips).',
  },
  nav: {
    title: 'Files',
    what: 'A file browser inside the dashboard: walk your folders and open any note or document without leaving it.',
    how: 'Root folder: tap "✎ set" to choose where the browser starts (default /Note).',
  },
  search: {
    title: 'Search',
    what: 'Finds file & folder names, keywords, and (optionally) note headings; tap a result to open it on its page.',
    how: '"Also search note titles": On to include headings, then tap "≣ Index titles now" once. Scope: add folders to limit the search, or leave empty for the whole device.',
    good: 'Grammar under the box: "phrase", =exact, a|b, !exclude, f:folder, kw:, title:, star:, type:note|pdf|doc|folder, approx:. The title index is incremental, so re-running it after adding notes is fast.',
  },
  toc: {
    title: 'Contents',
    what: 'An outline of the headings in the note open behind the dashboard; tap one to jump to its page.',
    how: '"Indent by title level": Off = flat list; On indents each heading by its Supernote title style, mapping Style 1 (black), 2 (gray/white), 3 (gray/black), 4 (shadow) to levels 1-4.',
    good: 'Headings are OCR’d once per note and cached, so unchanged notes are instant. Converted (typewritten) and older-note headings are included.',
  },
  recent: {
    title: 'Recent',
    what: 'Your recently-modified notes and documents, newest first.',
    how: 'Count: 4, 8, 12, 16 or 20. Layout: List, Grid (tiles) or Inline (wrapping chips).',
    good: 'On Chauvet 3.29.43 / 2.26.40+ this shows recently-modified files (the recently-opened list is outside the plugin’s sandbox there).',
  },
  stars: {
    title: 'Stars',
    what: 'Every starred (★) page from the last scan, grouped by note.',
    how: 'Folders to scan: add some, or leave empty for the whole device. Note order: By date / By name. Line preview: Off, Image, or Text (OCR the line, image if it fails). "Allow deleting a star": On adds a ✕★ to remove a star from the note (keeps the text).',
    good: 'Image/Text previews make the scan slower; scanning is incremental, so later refreshes are fast. Rescan with the ↻ in the block header.',
  },
  keywords: {
    title: 'Keywords',
    what: 'Your notes’ keywords as tappable chips; each opens its note on the right page.',
    how: 'Folders to scan (empty = whole device). Note order: By date / By name. Group by: Keyword or Note. View: List, Inline or By folder. "+ Keyword" limits the block to chosen ones; "Show all" clears the filter.',
  },
  clock: {
    title: 'Clock',
    what: 'Time, date, week number and extra time zones, in a choice of faces.',
    how: 'Style: Large, Compact, Weekday, Jumbo, Digital (7-segment) or Stamp. Time format: 24- or 12-hour. Date: Show/Hide. Week number: Off, ISO (Mon) or US (Sun). Region format sets date order and names. "+ add time zone": label + offset with - / + (½ adds 30 min), up to 6.',
    good: 'A live preview updates as you change the options.',
  },
  status: {
    title: 'Device',
    what: 'Battery, free storage and a library stats line.',
    how: 'Toggle each line independently: Battery, Free storage (internal + SD card), and Stats (counts of notes, PDFs, stars, keywords).',
  },
  apps: {
    title: 'Apps',
    what: 'Buttons that launch device apps (ToDo, Calendar, Files, or any installed app).',
    how: 'Add with "+ Apps" (tick from Supernote apps or "Show all apps", then Save). Reorder with ▲▼, remove with ✕. Layout: Inline (wrapping), Grid (tiles) or List.',
  },
  clips: {
    title: 'Note Clips',
    what: 'Snippets you lassoed from notes with "Dashboard Clip", as labelled thumbnails; tap one to jump to its source, or paste it back into a note.',
    how: 'Layout: Grid or List. Thumbnail size: Small / Medium / Large. Sort: Newest, Oldest, Label, or Note (groups clips under a per-note header). Display: Handwriting, OCR text, or Both. Filter by source folders and/or labels (empty = all).',
    good: 'Display OCR/Both needs "OCR text" on in Look : Note capture. "Paste Ink" drops the clip back as editable strokes; underline a word while clipping to auto-label it.',
  },
  todo: {
    title: 'To-do',
    what: 'Tasks you lassoed with "Dashboard To-do"; each is marked on the note with a tick-box and a #N tag.',
    how: 'Open / Done tabs, "↻ Check notes" (pull a hand-drawn check from the open note) and "Clear done". Layout, Thumbnail size, Sort, Display and the folder / label filters work like Clips.',
    good: 'Tick in the dashboard to draw the check on the note; or tick it by hand on the note and it shows as done here after "↻ Check notes". Un-checking is done from the dashboard. You can also move a marked to-do around, even to another page or note: the plugin finds it again by its #N tag.',
  },
};
