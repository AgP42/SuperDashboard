/**
 * Short, on-device help for each module, shown from the ⓘ in a block's header.
 * The full user guide (with screenshots) lives on GitHub; this is the quick,
 * contextual version. Keyed by Zone type. Keep each body to a few sentences.
 */
export const HELP: Record<string, {title: string; body: string}> = {
  shortcuts: {
    title: 'Shortcuts',
    body: 'One-tap openers for the folders, notes, PDFs, EPUBs and comics you use most; each opens on the right page. Configure them with the multi-select browser, shown as a list, grid or inline.',
  },
  nav: {
    title: 'Files',
    body: 'A file browser inside the dashboard: walk your folders and open any note or document without leaving the dashboard.',
  },
  search: {
    title: 'Search',
    body: 'Finds file and folder names, keywords, and (when enabled) note headings; tap a result to open it on its exact page. Turn on "Also search note titles" in this block’s settings to include headings. Grammar hints show under the box: f:folder, kw:, title:, star:, type:, "phrase", =exact, a|b, !exclude, approx:.',
  },
  toc: {
    title: 'Contents',
    body: 'The headings of the note open behind the dashboard, as an outline; tap one to jump to its page. Titles are OCR’d once and cached, so unchanged notes are instant; converted and older-note headings are included. The same index powers note-title search.',
  },
  recent: {
    title: 'Recent',
    body: 'Your recently-modified notes and documents, newest first. Choose how many to show (4 to 20) in this block’s settings.',
  },
  stars: {
    title: 'Stars',
    body: 'Every starred page from the last scan, grouped by note, with an optional per-star line preview (image, or text via OCR). Tap to open the page; the small x-star deletes a single star from the note. Rescan with the ↻ in the header.',
  },
  keywords: {
    title: 'Keywords',
    body: 'Your notes’ keywords as tappable chips, grouped by keyword; each chip opens that note on its page. Rescan with the ↻ in the header.',
  },
  clock: {
    title: 'Clock',
    body: 'Time, date, week number and extra time zones, in several faces (including a 7-segment Digital one). Set the face, 12/24-hour, date, week-number style, region format and any number of +/- offset time zones in this block’s settings.',
  },
  status: {
    title: 'Device',
    body: 'Battery, free storage (internal and SD card) and a library stats line (notes, PDFs, stars, keywords). Toggle each part in this block’s settings.',
  },
  apps: {
    title: 'Apps',
    body: 'Buttons that launch device apps (ToDo, Calendar, Files, or any installed app). Pick them with the multi-select picker.',
  },
  clips: {
    title: 'Note Clips',
    body: 'Snippets you lassoed from a note with "Dashboard Clip", pinned as labelled thumbnails. Tap one to jump to its source page, or Paste it into a note (image or OCR text) with a link back. Underline a word while clipping to auto-label it. Filter, sort and resize in this block’s settings.',
  },
  todo: {
    title: 'To-do',
    body: 'Tasks you lassoed with "Dashboard To-do"; each is marked on the note with a tick-box and a #N tag. Tick it here to draw the check on the note, or tick it by hand on the note and tap "↻ Check notes". Open/Done tabs, labels and Clear done. Un-checking is done from the dashboard.',
  },
};
