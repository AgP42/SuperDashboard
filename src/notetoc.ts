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

import {noteFileSize, readPageRevs} from './notepage';
import {cacheDir} from './paths';
import {notesModifiedSince, NoteFile} from './scanner';
import {recognize, recycleAll, unwrap} from './starText';
import {sdRoots, searchSdEnabled} from './storage';

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
  hv?: number; // heading-reader version the titles were read with (see HEADING_V)
}
// Bumped when readPageTitles changes in a way that fixes already-cached text, so
// pages that HAVE headings are re-read once (title-less pages are unaffected).
// v3: lazy controlTrailNums were read as empty, so a heading fell back to an
// overlapping text box (e.g. a template's typed date) instead of its own ink.
const HEADING_V = 3;
const staleHeadings = (pc: PageCache) => (pc.hv ?? 1) < HEADING_V && pc.titles.length > 0;
interface CacheShape {
  version: number;
  notes: Record<string, {pages: Record<string, PageCache>; size?: number}>; // size: file size when last read (skip-if-unchanged)
  lastIndexAt?: number; // watermark for the on-open auto-refresh (see autoRefreshTitles)
  lastFullIndexAt?: number; // last library-wide index run (config buttons)
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
      if (obj && obj.notes && obj.version === CACHE_VERSION) mem = {version: CACHE_VERSION, notes: obj.notes, lastIndexAt: obj.lastIndexAt, lastFullIndexAt: obj.lastFullIndexAt};
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
  } catch (e: any) {
    // Best-effort, but never silent: a failing save means every index run is lost.
    tlog(`cache save FAILED: ${e && e.message}`);
  }
}

/** Entries of a list the firmware returns EITHER as a plain array OR as a lazy
 *  ElementDataAccessor (size()/getRange()), capped at `cap`. */
async function listAll(c: any, cap: number): Promise<any[]> {
  try {
    if (!c) return [];
    if (Array.isArray(c)) return c.slice(0, cap);
    if (typeof c.size === 'function' && typeof c.getRange === 'function') {
      const n = await c.size();
      return n ? (await c.getRange(0, Math.min(n, cap))) ?? [] : [];
    }
  } catch {
    /* unreadable → none */
  }
  return [];
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

    /** The heading's own rect (page pixels), or null. */
    const rectOf = (t: any) => {
      const x1 = t.title.X;
      const y1 = t.title.Y;
      if (typeof x1 !== 'number' || typeof y1 !== 'number') return null;
      return {x1, y1, x2: x1 + (t.title.width || 0), y2: y1 + (t.title.height || 0)};
    };

    /** Text of a converted title: a field on the title, else a text box that sits
     *  INSIDE the heading's rect (its centre in it). A mere overlap is not enough:
     *  a template's typed date just above the heading overlapped it and was taken
     *  for the heading's text. '' when none. */
    const typedTitleText = (t: any): string => {
      const d = cleanHeading(t.title.textContentFull || t.title.text || '');
      if (d) return d;
      const r0 = rectOf(t);
      if (!r0) return '';
      for (const b of tboxes) {
        const r = b.textBox.textRect;
        const cx = (r.left + r.right) / 2;
        const cy = (r.top + r.bottom) / 2;
        if (cx >= r0.x1 && cx <= r0.x2 && cy >= r0.y1 && cy <= r0.y2) return cleanHeading(b.textBox.textContentFull);
      }
      return '';
    };

    /** Pen strokes lying inside the heading's rect: the fallback when the title
     *  doesn't list its strokes. Strokes are EMR (rotated, per-element maxX/maxY
     *  extent), converted to page pixels as in todomark. */
    const strokesInRect = async (t: any, W: number, H: number): Promise<any[]> => {
      const r0 = rectOf(t);
      if (!r0 || !W || !H) return [];
      const m = 8;
      const out: any[] = [];
      for (const e of strokeByNum.values()) {
        const maxX = e.maxX || 0;
        const maxY = e.maxY || 0;
        if (!maxX || !maxY) continue;
        const pts = await listAll(e.stroke?.points, 12);
        if (!pts.length) continue;
        let inside = 0;
        for (const pt of pts) {
          const px = W - (pt.y / maxY) * W;
          const py = (pt.x / maxX) * H;
          if (px >= r0.x1 - m && px <= r0.x2 + m && py >= r0.y1 - m && py <= r0.y2 + m) inside++;
        }
        if (inside * 2 > pts.length) out.push(e);
      }
      return out;
    };

    // Fetched only now: a page with no titles never pays for it, and a note with
    // mixed page sizes still OCRs each page against its own rect.
    const size = unwrap<any>(await PluginFileAPI.getPageSize(path, page0));
    const out: TocEntry[] = [];
    for (const t of titles) {
      // controlTrailNums comes as a plain array OR a lazy accessor; reading only
      // the array form left every accessor heading with no strokes at all.
      const ct = t.title.controlTrailNums;
      const nums: number[] = (await listAll(ct, 4000)).filter((n: any) => typeof n === 'number');
      let strokes = nums.map(n => strokeByNum.get(n)).filter(Boolean);
      let src = 'ink';
      if (!strokes.length) {
        strokes = await strokesInRect(t, size?.width || 0, size?.height || 0);
        src = 'rect';
      }
      const ocr = strokes.length ? cleanHeading(await recognize(strokes, size)) : '';
      const typed = ocr ? '' : typedTitleText(t);
      const text = ocr || typed || '(untitled)';
      const via = ocr ? src : typed ? 'textbox' : 'none';
      // Only the fallbacks are worth a line (a full re-index reads thousands of headings).
      if (via !== 'ink')
        tlog(`page ${page0}: heading s${t.title.style} nums=${nums.length}(${Array.isArray(ct) ? 'array' : ct ? 'accessor' : 'none'}) strokes=${strokes.length} via ${via} → ${text === '(untitled)' ? 'untitled' : `${text.length} chars`}`); // no note content in logs
      out.push({text, page: page0 + 1, style: t.title.style || 1});
    }
    const unread = out.filter(t => t.text === '(untitled)').length;
    // Only worth a line when something couldn't be read (a full index reads
    // thousands of pages; a line each looked like "new titles found").
    if (unread) tlog(`page ${page0}: ${out.length} titles, ${unread} unreadable`);
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
// One read per note at a time: the Contents block and the on-open auto-refresh
// both asked for the same note at once and each paid the full OCR (2 × 27 s seen
// on a 15-page note). A second caller now joins the read already in flight.
const inflight = new Map<string, Promise<{readable: boolean; titles: TocEntry[]}>>();

/** `force` re-reads every page, ignoring the cache (the "Re-index all" button). */
export type PageProgress = (pagesRead: number, pagesToRead: number) => void;

export function readNoteToc(path: string, flush = true, force = false, onPage?: PageProgress): Promise<{readable: boolean; titles: TocEntry[]}> {
  const key = (force ? 'F|' : '') + path; // a forced read must not just join a cached one
  const running = inflight.get(key);
  // Joining a read started by a batching caller (flush=false: index run /
  // auto-refresh) must still save when THIS caller wants it saved, or a kill
  // before that batch's next save loses the result.
  if (running) return flush ? running.then(async r => (await persist(), r)) : running;
  const p = readNoteTocOnce(path, flush, force, onPage).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function readNoteTocOnce(path: string, flush: boolean, force: boolean, onPage?: PageProgress): Promise<{readable: boolean; titles: TocEntry[]}> {
  if (!path || !/\.note$/i.test(path)) return {readable: false, titles: []};
  const cache = await loadCache();
  // Unchanged file (same size: the format is append-only, every save grows it)
  // → serve the cached headings without the per-page fingerprint reads, which
  // cost ~3 native calls per page and made a library "Update" crawl through
  // thousands of them for nothing.
  const size = await noteFileSize(path);
  const known = cache.notes[path];
  if (!force && size > 0 && known?.size === size && !Object.values(known.pages).some(pc => pc && staleHeadings(pc))) {
    const titles: TocEntry[] = [];
    for (const k of Object.keys(known.pages).sort((a, b) => Number(a) - Number(b))) titles.push(...(known.pages[k]?.titles ?? []));
    return {readable: true, titles};
  }
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

  const prev = force ? {} : cache.notes[path]?.pages ?? {};
  const next: Record<string, PageCache> = {};
  const titles: TocEntry[] = [];
  let ocrPages = 0;
  let movedPages = 0;
  let failedPages = 0;
  let capped = 0;
  // Only revs carrying a PAGEID identify one page; a bare length (`:N`, notes
  // without PAGEIDs), a '0' unreadable block or the coarse `nf:` fallback would
  // match unrelated pages.
  const prevByRev = new Map<string, PageCache>();
  for (const pc of Object.values(prev)) if (pc && /^[^:]+:/.test(pc.rev) && !pc.rev.startsWith('nf:')) prevByRev.set(pc.rev, pc);
  for (const {page, rev} of pages) {
    if (page >= MAX_PAGES) {
      capped++;
      continue;
    }
    const key = String(page);
    const cached = prev[key];
    if (cached && cached.rev === rev && !staleHeadings(cached)) {
      next[key] = cached; // unchanged page → reuse, no OCR
      titles.push(...cached.titles);
      continue;
    }
    // Same page (PAGEID + content) cached under another index: it only moved
    // (a page was inserted/deleted/reordered before it). Reuse its titles,
    // renumbered, instead of re-OCR'ing it.
    const moved = prevByRev.get(rev);
    if (moved && !staleHeadings(moved)) {
      const renum = {rev, titles: moved.titles.map(t => ({...t, page: page + 1})), hv: moved.hv};
      next[key] = renum;
      titles.push(...renum.titles);
      movedPages++;
      continue;
    }
    let pageTitles: TocEntry[] = [];
    let ok = true;
    try {
      onPage?.(page + 1, pages.length);
      pageTitles = await readPageTitles(path, page);
    } catch (e: any) {
      ok = false;
      failedPages++;
      tlog(`page ${page} failed: ${e && e.message}`);
    }
    if (ok) next[key] = {rev, titles: pageTitles, hv: HEADING_V}; // only cache a page we read cleanly
    titles.push(...pageTitles);
    ocrPages++;
  }
  if (capped) tlog(`capped: ${capped} pages beyond ${MAX_PAGES} skipped for ${path}`);
  // Remember the file size only when every page was read cleanly: a failed page
  // isn't cached, and a matching size would otherwise skip it forever.
  const sizeToKeep = failedPages ? undefined : size || undefined;
  const changed = ocrPages > 0 || movedPages > 0 || Object.keys(prev).length !== Object.keys(next).length || known?.size !== sizeToKeep;
  if (changed) {
    cache.notes[path] = {pages: next, size: sizeToKeep};
    dirty = true;
    if (flush) await persist();
  }
  tlog(`toc ${path}: ${titles.length} titles, re-read ${ocrPages}/${pages.length} pages${movedPages ? `, ${movedPages} moved` : ''}`);
  return {readable: true, titles};
}

/** Where a library-wide index run is: `done` of `total` notes finished; while a
 *  note is being read, `path` and (when pages are re-read) `page` of `pages`. */
export interface IndexProgress {
  done: number;
  total: number;
  path?: string;
  page?: number;
  pages?: number;
}

/**
 * Library-wide title indexing for the Search block: read the headings of every
 * given note, incrementally (readNoteToc re-OCRs only pages whose footer rev
 * changed). Notes that no longer exist are dropped from the cache, and the whole
 * cache is written ONCE at the end. First run pays the OCR cost; later runs are
 * near-instant.
 */
export async function indexTitles(
  notePaths: string[],
  onProgress?: (p: IndexProgress) => void,
  prune: boolean | ((path: string) => boolean) = true, // a function limits pruning to paths it accepts
  force = false, // re-read every page of every note (ignore the cache)
): Promise<{notes: number; titles: number}> {
  const total = notePaths.length;
  const t0 = Date.now();
  let titles = 0;
  for (let i = 0; i < total; i++) {
    try {
      onProgress?.({done: i, total, path: notePaths[i]});
      const r = await readNoteToc(notePaths[i], false, force, (pg, pgs) =>
        onProgress?.({done: i, total, path: notePaths[i], page: pg, pages: pgs}),
      ); // one write for the whole run
      titles += r.titles.filter(t => t.text !== '(untitled)').length;
    } catch (e: any) {
      tlog(`index ${notePaths[i]} failed: ${e && e.message}`);
    }
    onProgress?.({done: i + 1, total, path: notePaths[i]});
    // Save as we go: a full index is ~an hour of OCR, and the plugin can be
    // killed mid-run (reinstall, host teardown). Saving only at the end lost
    // the whole run on any interruption.
    if ((i + 1) % 5 === 0) await persist();
  }
  const cache = await loadCache();
  // Forget notes that were deleted or renamed, so search can't offer dead pages.
  // Skipped when the caller's note list may be incomplete (a truncated index),
  // which would otherwise purge notes that simply weren't listed.
  if (prune) {
    const live = new Set(notePaths);
    for (const p of Object.keys(cache.notes)) {
      if (!live.has(p) && (prune === true || prune(p))) {
        delete cache.notes[p];
        dirty = true;
      }
    }
  }
  // A full index IS the watermark: notes edited after it starts are caught by the
  // next on-open auto-refresh. Use the start time so an edit during indexing isn't missed.
  cache.lastIndexAt = t0;
  cache.lastFullIndexAt = t0; // before the save, or it is never written
  dirty = true;
  await persist();
  tlog(`indexTitles${force ? ' (full re-read)' : ''}: ${total} notes, ${titles} titles in ${Math.round((Date.now() - t0) / 1000)}s`);
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
      modified = await notesModifiedSince(since, (await searchSdEnabled()) ? await sdRoots() : []);
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

/** What the shared heading database holds (shown in the config panel). */
export async function titleIndexStats(): Promise<{notes: number; titles: number; lastIndexAt?: number; lastFullIndexAt?: number}> {
  const cache = await loadCache();
  let notes = 0;
  let titles = 0;
  for (const note of Object.values(cache.notes)) {
    notes++;
    for (const pc of Object.values(note?.pages ?? {})) titles += (pc?.titles ?? []).filter(t => t.text && t.text !== '(untitled)').length;
  }
  return {notes, titles, lastIndexAt: cache.lastIndexAt, lastFullIndexAt: cache.lastFullIndexAt};
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
