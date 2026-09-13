/**
 * Table of contents of a .note: its Supernote "Title" headings (type 100),
 * OCR'd to text. The firmware exposes NO text on a Title element (only its
 * geometry, a visual `style`, and `controlTrailNums` = the indices of the
 * strokes that make up the title), so the only way to get a heading's text is
 * to recognise its strokes. We fetch each page's elements once, map strokes by
 * their in-page index, pick exactly the strokes a title owns via
 * controlTrailNums (no pixel-vs-EMR coordinate guessing), and OCR those. A
 * CONVERTED (typewritten) title has no strokes left, so its text is read
 * directly from the text box covering it.
 *
 * Titles are NOTE-only: PDF/EPUB have none, so this returns readable:false for
 * anything that isn't a .note. Results are cached PER PAGE, keyed by the page's
 * .note footer block address, so only pages that actually changed are re-OCR'd
 * (~1-2s per title) and re-opening an unchanged note is instant.
 *
 * This module owns toccache.json: both consumers (the Contents block and the
 * title search in searchIndex) go through readNoteToc / allTitles, so the
 * on-disk shape stays private to one file.
 */
import {NativeModules} from 'react-native';
import {PluginFileAPI} from 'sn-plugin-lib';

import {readPageRevs} from './notepage';
import {cacheDir} from './paths';
import {notesModifiedSince, NoteFile} from './scanner';
import {recognize, recycleAll, unwrap} from './starText';

const {DashboardNative} = NativeModules;
const TOC_FILE = 'toccache.json';
const CACHE_VERSION = 3; // bumped so the legacy-style-0 title fix re-reads notes (v2 was polluted with pre-fix results)
const MAX_PAGES = 400; // safety cap so a runaway note can't scan unbounded

export interface TocEntry {
  text: string; // OCR'd heading (or '(untitled)' when recognition yields nothing)
  page: number; // 1-based page for openFile
  style: number; // Title.style 1..4 (visual style; used for optional indent)
}

function tlog(m: string): void {
  try {
    DashboardNative?.appendLog?.('[toc] ' + m).catch(() => {});
  } catch {}
}

// ---- cache: path -> per-page {footer rev fingerprint, titles} -------------
// `rev` is the page's .note footer block address (see readPageRevs): the format
// is append-only, so it changes iff that page itself was edited — unlike file
// mtime, which a cloud-sync touch also moves.
interface PageCache {
  rev: string;
  titles: TocEntry[];
}
interface CacheShape {
  version: number;
  notes: Record<string, {pages: Record<string, PageCache>}>;
  lastIndexAt?: number; // watermark for the on-open auto-refresh (see autoRefreshTitles)
}
let mem: CacheShape | null = null;
let dirty = false;

async function loadCache(): Promise<CacheShape> {
  if (mem) return mem;
  mem = {version: CACHE_VERSION, notes: {}};
  try {
    const dir = await cacheDir();
    const text: string = await DashboardNative.readTextFile(dir + TOC_FILE);
    if (text && text.trim()) {
      const obj = JSON.parse(text);
      // Discard a cache written by a different layout rather than mis-reading it.
      if (obj && obj.notes && obj.version === CACHE_VERSION) mem = {version: CACHE_VERSION, notes: obj.notes, lastIndexAt: obj.lastIndexAt};
    }
  } catch {
    /* none yet */
  }
  return mem!;
}

/** Write the cache, but only when something actually changed: a plain cache hit
 *  (the common case on every dashboard open) must not re-serialise the whole
 *  library, and a library-wide index must not do it once per note. */
async function persist(): Promise<void> {
  if (!dirty || !mem) return;
  try {
    const dir = await cacheDir();
    await DashboardNative.writeFile(dir + TOC_FILE, JSON.stringify(mem));
    dirty = false;
  } catch {
    /* best-effort */
  }
}

function cleanHeading(s: string): string {
  const first =
    (s || '')
      .split(/[\r\n]+/)
      .map(x => x.trim())
      .find(Boolean) || '';
  const t = first.replace(/\s+/g, ' ').trim();
  return t.length > 80 ? t.slice(0, 80).trim() : t;
}

/** Read a single page's titles (0-based page). */
async function readPageTitles(path: string, page0: number): Promise<TocEntry[]> {
  const els: any[] = unwrap<any[]>(await PluginFileAPI.getElements(page0, path)) ?? [];
  try {
    // Keep every real Title. NOTE the API asymmetry: passing style 0 to
    // setLassoTitle *removes* a title, but style 0 STORED on an element is a
    // legacy heading (older notes, before multi-style headings) — those must be
    // shown. We only drop a style-0 title with no ink at all (a stray ghost),
    // keeping legacy s0 headings, which always carry their strokes.
    // "has ink" tolerates both shapes the firmware uses for controlTrailNums: a
    // plain array, or a lazy accessor (truthy, non-array) — so a legacy s0 heading
    // isn't dropped just because its trail list came back as an accessor.
    const hasInk = (ct: any) => (Array.isArray(ct) ? ct.length > 0 : !!ct);
    const titles = els.filter(e => e && e.type === 100 && e.title && (e.title.style !== 0 || hasInk(e.title.controlTrailNums)));
    if (!titles.length) return []; // the common case: no page size, no OCR
    // Map every stroke by its in-page index so a title can grab exactly its own
    // strokes (Title.controlTrailNums are those in-page indices).
    const strokeByNum = new Map<number, any>();
    for (const e of els) if (e && e.type === 0 && typeof e.numInPage === 'number') strokeByNum.set(e.numInPage, e);
    // A converted title's ink is gone; its text sits in a text box over its rect.
    const tboxes = els.filter(e => e && (e.type === 500 || e.type === 501 || e.type === 502) && e.textBox && e.textBox.textRect && e.textBox.textContentFull);

    /** Text of a converted title: a field on the title, else the text box
     *  overlapping the title's rect. '' when none. */
    const typedTitleText = (t: any): string => {
      const d = cleanHeading(t.title.textContentFull || t.title.text || '');
      if (d) return d;
      const x1 = t.title.X;
      const y1 = t.title.Y;
      if (typeof x1 !== 'number') return '';
      const x2 = x1 + (t.title.width || 0);
      const y2 = y1 + (t.title.height || 0);
      for (const b of tboxes) {
        const r = b.textBox.textRect;
        if (!(r.left > x2 || r.right < x1 || r.top > y2 || r.bottom < y1)) return cleanHeading(b.textBox.textContentFull);
      }
      return '';
    };

    // Fetched only now: a page with no titles never pays for it, and a note with
    // mixed page sizes still OCRs each page against its own rect.
    const size = unwrap<any>(await PluginFileAPI.getPageSize(path, page0));
    const out: TocEntry[] = [];
    for (const t of titles) {
      const nums: number[] = Array.isArray(t.title.controlTrailNums) ? t.title.controlTrailNums : [];
      const strokes = nums.map(n => strokeByNum.get(n)).filter(Boolean);
      const ocr = strokes.length ? cleanHeading(await recognize(strokes, size)) : '';
      out.push({text: ocr || typedTitleText(t) || '(untitled)', page: page0 + 1, style: t.title.style || 1});
    }
    const unread = out.filter(t => t.text === '(untitled)').length;
    tlog(`page ${page0}: ${out.length} titles${unread ? `, ${unread} unreadable` : ''}`);
    return out;
  } finally {
    await recycleAll(els);
  }
}

/**
 * TOC of a .note. `{readable:false}` when the path is missing or not a .note
 * (PDF/EPUB have no titles). INCREMENTAL: only pages whose footer rev changed
 * since last time are re-OCR'd; unchanged pages are served from cache, new pages
 * are added, deleted pages drop out. So adding or editing one page costs one
 * page's OCR, not the whole note.
 *
 * `flush: false` keeps the result in memory only — used by indexTitles, which
 * writes once for the whole run instead of once per note.
 */
export async function readNoteToc(path: string, flush = true): Promise<{readable: boolean; titles: TocEntry[]}> {
  if (!path || !/\.note$/i.test(path)) return {readable: false, titles: []};
  const cache = await loadCache();
  const revs = await readPageRevs(path);
  // Every page gets a rev so the result is always cacheable. A readable footer
  // gives a per-page rev (real incremental). Without one (rare), we fall back to
  // a coarse whole-note fingerprint `nf:<pageCount>`, identical for every page:
  // unchanged notes then hit the cache instead of re-OCR'ing on every open. The
  // trade-off is that a footer-less note edited WITHOUT changing its page count
  // won't refresh — acceptable for that rare case, and far better than a
  // multi-second re-OCR every time.
  let pages: {page: number; rev: string}[];
  if (revs && revs.length) {
    pages = revs;
  } else {
    const total = unwrap<number>(await PluginFileAPI.getNoteTotalPageNum(path)) ?? 0;
    pages = Array.from({length: total}, (_, p) => ({page: p, rev: `nf:${total}`}));
    tlog(`no footer for ${path}; coarse-cached over ${total} pages`);
  }

  const prev = cache.notes[path]?.pages ?? {};
  const next: Record<string, PageCache> = {};
  const titles: TocEntry[] = [];
  let ocrPages = 0;
  let capped = 0;
  for (const {page, rev} of pages) {
    if (page >= MAX_PAGES) {
      capped++;
      continue;
    }
    const key = String(page);
    const cached = prev[key];
    if (cached && cached.rev === rev) {
      next[key] = cached; // unchanged page → reuse, no OCR
      titles.push(...cached.titles);
      continue;
    }
    let pageTitles: TocEntry[] = [];
    let ok = true;
    try {
      pageTitles = await readPageTitles(path, page);
    } catch (e: any) {
      ok = false;
      tlog(`page ${page} failed: ${e && e.message}`);
    }
    if (ok) next[key] = {rev, titles: pageTitles}; // only cache a page we read cleanly
    titles.push(...pageTitles);
    ocrPages++;
  }
  if (capped) tlog(`capped: ${capped} pages beyond ${MAX_PAGES} skipped for ${path}`);
  const changed = ocrPages > 0 || Object.keys(prev).length !== Object.keys(next).length;
  if (changed) {
    cache.notes[path] = {pages: next};
    dirty = true;
    if (flush) await persist();
  }
  tlog(`toc ${path}: ${titles.length} titles, re-read ${ocrPages}/${pages.length} pages`);
  return {readable: true, titles};
}

/**
 * Library-wide title indexing for the Search block: read the headings of every
 * given note, incrementally (readNoteToc re-OCRs only pages whose footer rev
 * changed). Notes that no longer exist are dropped from the cache, and the whole
 * cache is written ONCE at the end. First run pays the OCR cost; later runs are
 * near-instant.
 */
export async function indexTitles(notePaths: string[], onProgress?: (done: number, total: number) => void, prune = true): Promise<{notes: number; titles: number}> {
  const total = notePaths.length;
  const t0 = Date.now();
  let titles = 0;
  for (let i = 0; i < total; i++) {
    try {
      const r = await readNoteToc(notePaths[i], false); // one write for the whole run
      titles += r.titles.filter(t => t.text !== '(untitled)').length;
    } catch (e: any) {
      tlog(`index ${notePaths[i]} failed: ${e && e.message}`);
    }
    onProgress?.(i + 1, total);
  }
  const cache = await loadCache();
  // Forget notes that were deleted or renamed, so search can't offer dead pages.
  // Skipped when the caller's note list may be incomplete (a truncated index),
  // which would otherwise purge notes that simply weren't listed.
  if (prune) {
    const live = new Set(notePaths);
    for (const p of Object.keys(cache.notes)) {
      if (!live.has(p)) {
        delete cache.notes[p];
        dirty = true;
      }
    }
  }
  // A full index IS the watermark: notes edited after it starts are caught by the
  // next on-open auto-refresh. Use the start time so an edit during indexing isn't missed.
  cache.lastIndexAt = t0;
  dirty = true;
  await persist();
  tlog(`indexTitles: ${total} notes, ${titles} titles`);
  return {notes: total, titles};
}

// Serialise auto-refresh runs: rapid dashboard re-entries must not overlap them.
let refreshing = false;
const AUTO_CAP = 8; // notes re-OCR'd per open, kept small so the deferred pass never hogs the device

/**
 * On-open incremental refresh of the shared title cache (used by BOTH the Contents
 * block and the title search — one database). Reads only notes modified since the
 * last run's watermark, so Search stays fresh even when no Contents block is shown
 * and the user never re-runs the config index. Oldest-first with a per-open cap and
 * a note-by-note watermark, so an interrupted run resumes instead of restarting.
 * Best-effort and deferred by the caller — never blocks the dashboard open.
 */
export async function autoRefreshTitles(): Promise<{modified: number; done: number; capped: boolean}> {
  if (refreshing) return {modified: 0, done: 0, capped: false};
  refreshing = true;
  try {
    // NOTE: we do NOT flushCurrentNote() here — saveCurrentNote foregrounds the
    // editor and makes the dashboard flicker on every open (the v0.20.2
    // regression, see scanner.ts). A heading just written on the open page is
    // therefore picked up on the NEXT open (once the editor auto-saves on
    // page-turn) or immediately via a manual "Refresh all".
    const cache = await loadCache();
    const since = cache.lastIndexAt ?? 0;
    const t0 = Date.now();
    let modified: NoteFile[] = [];
    try {
      modified = await notesModifiedSince(since);
    } catch {
      return {modified: 0, done: 0, capped: false};
    }
    if (!modified.length) return {modified: 0, done: 0, capped: false};
    const batch = modified.slice(0, AUTO_CAP);
    let done = 0;
    for (const f of batch) {
      try {
        await readNoteToc(f.path, false); // incremental per note; persisted in batches below
      } catch (e: any) {
        tlog(`autoRefresh ${f.path} failed: ${e && e.message}`);
      }
      cache.lastIndexAt = f.mtime; // advance note-by-note so an interrupted run resumes here
      dirty = true;
      done++;
      if (done % 5 === 0) await persist();
    }
    const capped = modified.length > batch.length;
    if (!capped) {
      // Drained the backlog → jump the watermark to the walk time (not "now": a
      // note edited DURING this run has mtime > t0 and must be caught next open).
      cache.lastIndexAt = t0;
    } else if (modified[batch.length]?.mtime === batch[batch.length - 1].mtime) {
      // The next unprocessed note shares the last processed note's mtime; a strict
      // `> mtime` filter would skip it forever, so step the watermark back 1ms to
      // re-include the whole tie group next open (already-read notes are cache hits).
      cache.lastIndexAt = batch[batch.length - 1].mtime - 1;
    }
    dirty = true;
    await persist();
    tlog(`autoRefresh: ${modified.length} modified since ${since}, ${done} read${capped ? ` (capped ${AUTO_CAP}, ${modified.length - batch.length} left)` : ''}`);
    return {modified: modified.length, done, capped};
  } finally {
    refreshing = false;
  }
}

/** The titles already in the cache for one note, WITHOUT any footer read or OCR.
 *  Lets the Contents block paint instantly from the last result while the real
 *  (possibly re-OCR'ing) refresh runs afterwards. null when the note isn't cached. */
export async function cachedToc(path: string): Promise<TocEntry[] | null> {
  if (!path || !/\.note$/i.test(path)) return null;
  const cache = await loadCache();
  const note = cache.notes[path];
  if (!note) return null;
  const out: TocEntry[] = [];
  for (const pc of Object.values(note.pages)) out.push(...pc.titles);
  out.sort((a, b) => a.page - b.page);
  return out;
}

/** Every cached heading, flattened for the Search block. Reads the in-memory
 *  cache when it's already loaded, so a dashboard holding both a Contents block
 *  and a title-enabled Search block parses the file once. */
export async function allTitles(): Promise<{title: string; file: string; page: number}[]> {
  const cache = await loadCache();
  const out: {title: string; file: string; page: number}[] = [];
  for (const [file, note] of Object.entries(cache.notes)) {
    for (const pc of Object.values(note?.pages ?? {})) {
      for (const t of pc?.titles ?? []) {
        if (t.text && t.text !== '(untitled)') out.push({title: t.text, file, page: t.page});
      }
    }
  }
  return out;
}
