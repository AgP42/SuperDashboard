/**
 * Device scanner for the Stars and Keywords zones.
 * Walks user-chosen folders via the native listDir (gives mtime), then reads
 * five-stars / keywords through the SDK. Notes only (SDK APIs don't cover PDFs).
 */
import {NativeModules} from 'react-native';
import {PluginCommAPI, PluginFileAPI, PluginNoteAPI} from 'sn-plugin-lib';

import {starLineImages, starLineTexts, LineImg, unwrap} from './starText';
import {LineMode} from './config';
import {cacheDir, LEGACY_CACHE_DIR} from './paths';

const {DashboardNative} = NativeModules;

const MAX_FILES = 800; // safety cap on notes collected in one scan
const MAX_DIRS = 600; // safety cap on directories visited (bounds full-device scans)
const DEVICE_ROOT = '/storage/emulated/0'; // scanned when no folder is selected

interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  mtime: number;
}

// The SDK's per-file APIs aren't re-entrant: running the Stars and Keywords
// scans concurrently (both auto-scan on mount) makes one fail silently. Serialize
// all scans so only one runs at a time. `queued` tracks the burst: while >0,
// scans queued together may share one directory walk (see collectNotes).
let scanChain: Promise<unknown> = Promise.resolve();
let queued = 0;
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  queued++;
  const run = scanChain.then(fn, fn);
  scanChain = run.then(
    () => undefined,
    () => undefined,
  ).then(() => {
    if (--queued === 0) walkCache.clear();
  });
  return run;
}

// Dedupe concurrent scans of the same folder set (several zones scanning the
// same folders share one scan instead of each redoing the work).
const inflight = new Map<string, Promise<any>>();
/** Canonical key for a folder set (also used by the session cache). */
export function foldersKey(folders: string[]): string {
  return (folders ?? []).slice().sort().join('|');
}
function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export interface NoteFile {
  path: string;
  mtime: number;
}

// Skip the huge Android tree and hidden dirs on a whole-device walk.
const SKIP_DIR = /^(Android|\.)/;
const LIST_CONCURRENCY = 24; // parallel listDir calls per batch

// Scans queued in the same burst (Stars then Keywords on one dashboard entry,
// serialized above) reuse one walk instead of redoing ~600 listDir round-trips.
// Cleared when the burst drains, so a later manual refresh walks fresh.
const walkCache = new Map<string, {files: NoteFile[]; truncated: boolean}>();

async function collectNotes(roots: string[]): Promise<{files: NoteFile[]; truncated: boolean}> {
  const key = foldersKey(roots);
  const hit = walkCache.get(key);
  if (hit) return hit;
  const res = await walkNotes(roots);
  walkCache.set(key, res);
  return res;
}

/** Recursively collect .note files under the given roots, newest first.
 *  BFS level-by-level with parallel listDir — a serial walk of ~600 dirs was
 *  the dominant scan cost (each listDir is a native round-trip). */
async function walkNotes(roots: string[]): Promise<{files: NoteFile[]; truncated: boolean}> {
  const out: NoteFile[] = [];
  // No folder selected → scan the whole device (bounded by the caps below).
  const start = [...(roots ?? [])].filter(Boolean);
  let frontier = start.length ? start : [DEVICE_ROOT];
  let truncated = false;
  const seen = new Set<string>();

  while (frontier.length) {
    if (out.length >= MAX_FILES || seen.size >= MAX_DIRS) {
      truncated = true;
      break;
    }
    // Claim this level's unseen dirs (bounded by MAX_DIRS).
    const batch: string[] = [];
    for (const d of frontier) {
      if (seen.has(d)) continue;
      seen.add(d);
      batch.push(d);
      if (seen.size >= MAX_DIRS) break;
    }
    const next: string[] = [];
    for (let i = 0; i < batch.length; i += LIST_CONCURRENCY) {
      const slice = batch.slice(i, i + LIST_CONCURRENCY);
      const lists = await Promise.all(
        slice.map(d => DashboardNative.listDir(d).then((x: DirEntry[]) => x ?? []).catch(() => [] as DirEntry[])),
      );
      for (const entries of lists) {
        for (const e of entries) {
          if (e.isDir) {
            if (!SKIP_DIR.test(e.name)) next.push(e.path);
          } else if (/\.note$/i.test(e.name)) {
            out.push({path: e.path, mtime: e.mtime});
          }
        }
      }
    }
    frontier = next;
  }
  out.sort((a, b) => b.mtime - a.mtime); // most recent first
  return {files: out, truncated};
}

export interface StarPage {
  page: number; // 1-based
  count: number; // stars on that page
  lines?: (LineImg | undefined)[]; // handwriting strip per star ('image', or 'text' fallback for failed OCR)
  texts?: string[]; // OCR text per star's line (lineMode 'text'; '' where OCR failed → image fallback)
}
export interface StarNote {
  file: string;
  mtime: number;
  pages: StarPage[];
}

// ---- Per-file scan cache (persisted) --------------------------------------
// Keyed by file path; invalidated by mtime. Lets a rescan skip every unchanged
// file (the SDK per-file calls are the cost) — 2nd+ scans become near-instant.
// Stores ALL keywords (filter applied at assembly) so zones with different
// filters share it. Shared by Stars and Keywords so each file is read once.
interface FileScan {
  mtime: number;
  stars?: StarPage[]; // undefined = not scanned for stars yet
  starsLineMode?: LineMode; // which line preview is cached (recompute if the zone changes it)
  keywords?: {keyword: string; page: number}[]; // 1-based page; undefined = not scanned
}
const CACHE_FILE = 'scancache.json';
let fileCache: Map<string, FileScan> | null = null;
let cacheDirty = false;

async function loadCache(): Promise<Map<string, FileScan>> {
  if (fileCache) return fileCache;
  const map = new Map<string, FileScan>();
  const dir = await cacheDir();
  try {
    // Native reader like every other file read (fetch caches file:// URLs).
    let text: string = await DashboardNative.readTextFile(dir + CACHE_FILE);
    let migrated = false;
    if ((!text || !text.trim()) && dir !== LEGACY_CACHE_DIR) {
      // One-time migration from the old MyStyle location (cloud-synced —
      // caches don't belong there). Deleted after the first private save.
      text = await DashboardNative.readTextFile(LEGACY_CACHE_DIR + CACHE_FILE);
      migrated = true;
    }
    if (text && text.trim()) {
      const obj = JSON.parse(text);
      for (const [k, v] of Object.entries(obj.files ?? {})) map.set(k, v as FileScan);
      if (migrated) {
        // Migrated entries reference line PNGs in the legacy dir, which we
        // purge — drop the previews so the next scan regenerates them in the
        // private dir instead of showing dead file paths.
        for (const e of map.values()) {
          for (const p of e.stars ?? []) {
            delete p.lines;
            delete p.texts;
          }
          if (e.starsLineMode) e.starsLineMode = 'off';
        }
        cacheDirty = true;
      }
    }
  } catch {
    /* no cache yet */
  }
  fileCache = map;
  return map;
}

async function saveCache(): Promise<void> {
  if (!fileCache || !cacheDirty) return;
  const dir = await cacheDir();
  const json = JSON.stringify({version: 1, files: Object.fromEntries(fileCache)});
  try {
    await DashboardNative.writeFile(dir + CACHE_FILE, json);
  } catch {
    // The plugin-private dir can be transiently read-only (seen on SmartNote
    // AI) — one retry, then give up until the next scan.
    await new Promise(r => setTimeout(r, 300));
    try {
      await DashboardNative.writeFile(dir + CACHE_FILE, json);
    } catch {
      return;
    }
  }
  cacheDirty = false;
  purgeLegacyOnce(dir);
}

// After the cache lives privately, remove the old MyStyle copies (cache JSON
// and line PNGs) so nothing machine-only keeps syncing to the cloud.
let legacyPurged = false;
function purgeLegacyOnce(dir: string) {
  if (legacyPurged || dir === LEGACY_CACHE_DIR) return;
  legacyPurged = true;
  DashboardNative.pruneMatching?.(LEGACY_CACHE_DIR, CACHE_FILE, '').catch(() => {});
  DashboardNative.pruneMatching?.(LEGACY_CACHE_DIR, 'line_', '').catch(() => {});
}

/**
 * Garbage-collect line_*.png strips no longer referenced by any cached star —
 * a deleted star, an edited/removed note, or line preview switched off used to
 * leave its PNG behind forever (the only pruning was per-page at regeneration
 * time, which never runs for a page that lost its last star). Runs after every
 * Stars scan: keep what the cache references, delete the rest.
 */
async function sweepLineImages(): Promise<void> {
  if (!fileCache) return;
  try {
    const dir = await cacheDir();
    const keep = new Set<string>();
    for (const e of fileCache.values()) {
      for (const p of e.stars ?? []) {
        for (const img of p.lines ?? []) {
          if (img?.png) keep.add(img.png.substring(img.png.lastIndexOf('/') + 1));
        }
      }
    }
    const entries: DirEntry[] = (await DashboardNative.listDir(dir)) ?? [];
    for (const en of entries) {
      if (!en.isDir && en.name.startsWith('line_') && !keep.has(en.name)) {
        await DashboardNative.pruneMatching(dir, en.name, '');
      }
    }
  } catch {
    /* best-effort GC */
  }
}

async function scanFileStars(path: string, mode: LineMode, mtime: number): Promise<StarPage[]> {
  const pageIdx = unwrap<number[]>(await PluginFileAPI.searchFiveStars(path)) ?? [];
  if (!pageIdx.length) return [];
  const counts = new Map<number, number>();
  for (const p of pageIdx) counts.set(p + 1, (counts.get(p + 1) ?? 0) + 1); // 0→1-based
  const pages: StarPage[] = [...counts.entries()].map(([page, count]) => ({page, count})).sort((a, b) => a.page - b.page);
  await addLinePreview(path, pages, mode, mtime);
  return pages;
}

/** Populate pages[].lines (image) or .texts (OCR) per the mode ('off' = nothing).
 *  'text' falls back to a handwriting image for any line the (unreliable) OCR
 *  can't read. Clears the other mode's stale data so a switch doesn't show it. */
async function addLinePreview(path: string, pages: StarPage[], mode: LineMode, mtime: number): Promise<void> {
  for (const pg of pages) {
    pg.lines = undefined;
    pg.texts = undefined;
    if (mode === 'image') {
      pg.lines = await starLineImages(path, pg.page - 1, mtime);
    } else if (mode === 'text') {
      pg.texts = await starLineTexts(path, pg.page - 1);
      if (pg.texts.some(t => !t)) {
        // OCR failed on some lines → render the page once and keep the strip
        // only for those lines.
        const imgs = await starLineImages(path, pg.page - 1, mtime);
        pg.lines = pg.texts.map((t, k) => (t ? undefined : imgs[k]));
      }
    }
  }
}

async function scanFileKeywords(path: string): Promise<{keyword: string; page: number}[]> {
  const total = unwrap<number>(await PluginFileAPI.getNoteTotalPageNum(path)) ?? 0;
  const pageList = Array.from({length: total}, (_, k) => k);
  const kws = unwrap<any[]>(await PluginFileAPI.getKeyWords(path, pageList)) ?? [];
  return kws.map((k: any) => ({keyword: k?.keyword ?? '', page: (k?.page ?? 0) + 1}));
}

/** Bring each file's cache entry up to date for the requested dimensions. */
async function ensureScanned(
  files: NoteFile[],
  need: {stars?: boolean; lineMode?: LineMode; keywords?: boolean},
  onProgress?: (done: number, total: number, phase?: 'scan' | 'ocr') => void,
): Promise<Map<string, FileScan>> {
  const cache = await loadCache();
  const mode: LineMode = need.lineMode ?? 'off';
  let lastEmit = Date.now();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    let e = cache.get(f.path);
    if (!e || e.mtime !== f.mtime) {
      e = {mtime: f.mtime}; // new or edited → discard stale results
      cache.set(f.path, e);
      cacheDirty = true;
    }
    let ocr = false;
    try {
      if (need.stars) {
        if (e.stars === undefined) {
          e.stars = await scanFileStars(f.path, mode, f.mtime);
          e.starsLineMode = mode;
          cacheDirty = true;
          ocr = mode !== 'off' && e.stars.length > 0;
        } else if (mode !== 'off' && e.starsLineMode !== mode) {
          await addLinePreview(f.path, e.stars, mode, f.mtime);
          e.starsLineMode = mode;
          cacheDirty = true;
          ocr = e.stars.length > 0;
        }
      }
      if (need.keywords && e.keywords === undefined) {
        e.keywords = await scanFileKeywords(f.path);
        cacheDirty = true;
      }
    } catch {
      /* skip unreadable file */
    }
    // Time-throttle progress (~3/s): a state update per file caused an e-ink
    // re-render storm (~80ms each). Throttling keeps the count moving smoothly on
    // a cold scan while a warm (all-cached) rescan stays one render.
    const now = Date.now();
    if (now - lastEmit >= 300) {
      onProgress?.(i + 1, files.length, ocr ? 'ocr' : 'scan');
      lastEmit = now;
    }
  }
  onProgress?.(files.length, files.length, 'scan'); // final
  await saveCache();
  return cache;
}

/**
 * Flush the note currently open in the editor (if it's a .note inside `roots`)
 * so a scan picks up stars/keywords on the page shown underneath, without the
 * user turning the page. saveCurrentNote() is the SDK's sanctioned way to
 * persist unsaved edits (the editor otherwise only auto-saves on page-turn).
 * Only call from a MANUAL refresh — flushing on every open foregrounded the
 * editor and made the dashboard flicker (the reverted v0.20.2 regression).
 * Best-effort; returns the flushed path or null.
 */
export async function flushCurrentNote(roots: string[]): Promise<string | null> {
  try {
    const path = unwrap<string>(await PluginCommAPI.getCurrentFilePath());
    if (!path || !/\.note$/i.test(path)) return null;
    const inScope =
      !roots.length ||
      roots.some(r => path === r || path.startsWith(r.endsWith('/') ? r : r + '/'));
    if (!inScope) return null;
    await PluginNoteAPI.saveCurrentNote();
    // Force a re-scan of this note even if its mtime didn't visibly change, and
    // drop the shared walk so the fresh mtime is picked up.
    fileCache?.delete(path);
    walkCache.clear();
    return path;
  } catch {
    return null;
  }
}

/** Stars grouped by note (recent notes first). page is 1-based; count = stars on that page.
 *  lineMode 'image'/'text' adds a per-star line preview (slower scan). */
export function scanStars(
  roots: string[],
  lineMode: LineMode = 'off',
  alsoKeywords = false, // one pass also caches keywords → the Keywords zone is then instant
  onProgress?: (done: number, total: number, phase?: 'scan' | 'ocr') => void,
): Promise<{notes: StarNote[]; truncated: boolean; total: number}> {
  return dedupe('S#' + lineMode[0] + (alsoKeywords ? 'K' : '') + foldersKey(roots), () =>
    serialize(() => scanStarsImpl(roots, lineMode, alsoKeywords, onProgress)),
  );
}

async function scanStarsImpl(
  roots: string[],
  lineMode: LineMode,
  alsoKeywords: boolean,
  onProgress?: (done: number, total: number, phase?: 'scan' | 'ocr') => void,
): Promise<{notes: StarNote[]; truncated: boolean; total: number}> {
  const {files, truncated} = await collectNotes(roots);
  const cache = await ensureScanned(files, {stars: true, lineMode, keywords: alsoKeywords}, onProgress);
  await sweepLineImages(); // drop strips whose star/note is gone
  const notes: StarNote[] = [];
  for (const f of files) {
    const e = cache.get(f.path);
    if (!e?.stars || e.stars.length === 0) continue;
    // Return COPIES: addLinePreview mutates the per-file cache's StarPage objects
    // on a later mode switch, which would otherwise corrupt this returned snapshot.
    const pages =
      lineMode === 'off' ? e.stars.map(p => ({page: p.page, count: p.count})) : e.stars.map(p => ({...p}));
    notes.push({file: f.path, mtime: f.mtime, pages});
  }
  return {notes, truncated, total: files.length};
}

export interface KeywordHit {
  keyword: string;
  file: string;
  mtime: number;
  page: number; // 1-based
}

/** Flat keyword occurrences across the chosen roots (notes recent first). */
export function scanKeywords(
  roots: string[],
  alsoStars = false, // one pass also caches star detection → the Stars zone is then instant (no images)
  onProgress?: (done: number, total: number, phase?: 'scan' | 'ocr') => void,
): Promise<{hits: KeywordHit[]; truncated: boolean; total: number}> {
  // Dedupe by folders only (all keywords are scanned; per-zone keyword
  // selection is applied at render), so multiple keyword zones over the same
  // folders share one scan.
  return dedupe('K#' + (alsoStars ? 'S' : '') + '|' + foldersKey(roots), () =>
    serialize(() => scanKeywordsImpl(roots, alsoStars, onProgress)),
  );
}

async function scanKeywordsImpl(
  roots: string[],
  alsoStars: boolean,
  onProgress?: (done: number, total: number, phase?: 'scan' | 'ocr') => void,
): Promise<{hits: KeywordHit[]; truncated: boolean; total: number}> {
  const {files, truncated} = await collectNotes(roots);
  const cache = await ensureScanned(files, {keywords: true, stars: alsoStars}, onProgress);
  const hits: KeywordHit[] = [];
  for (const f of files) {
    const e = cache.get(f.path);
    if (!e?.keywords) continue;
    for (const k of e.keywords) {
      hits.push({keyword: k.keyword, file: f.path, mtime: f.mtime, page: k.page});
    }
  }
  return {hits, truncated, total: files.length};
}

export function basename(path: string): string {
  return path.substring(path.lastIndexOf('/') + 1);
}

export function noteTitle(path: string): string {
  return basename(path).replace(/\.(note|pdf|epub)$/i, '');
}

export function parentFolder(path: string): string {
  const dir = path.substring(0, path.lastIndexOf('/'));
  return dir.substring(dir.lastIndexOf('/') + 1) || dir;
}
