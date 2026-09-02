/**
 * Fast name search over an indexed snapshot of the device.
 *
 * The index holds just {name, path, isDir} for every folder and every openable
 * file under the device root (minus Android/ and hidden dirs), plus the keywords
 * already collected by the Stars/Keywords scan (read from scancache.json). Names
 * are tiny, so the whole thing is a few hundred KB and every search runs in
 * memory: no disk walk per keystroke. Persisted to the plugin-private dir so a
 * cold open searches immediately off the last snapshot, then refreshes in the
 * background.
 */
import {NativeModules} from 'react-native';

import {cacheDir} from './paths';

const {DashboardNative} = NativeModules;

// Index only the six shared-storage directories that FILE:READ actually grants:
// so the walk never even attempts paths outside the plugin's permission scope.
const SHARED = '/storage/emulated/0';
const INDEX_ROOTS = ['Note', 'Document', 'MyStyle', 'EXPORT', 'INBOX', 'SCREENSHOT'].map(d => `${SHARED}/${d}`);
const SKIP_DIR = /^(Android|\.)/;
const LIST_CONCURRENCY = 24;
const MAX_DIRS = 1500; // bounds a whole-device walk
const MAX_ENTRIES = 8000;
const INDEX_FILE = 'searchindex.json';
const SCAN_CACHE_FILE = 'scancache.json';
const MEM_TTL = 5 * 60 * 1000; // in-memory freshness before a background rebuild
/** Files worth indexing: every one is openable via open.ts. */
const OPENABLE = /\.(note|pdf|epub|cbz|xps|fb2)$/i;

export interface IndexEntry {
  name: string;
  path: string;
  isDir: boolean;
}
export interface IndexData {
  at: number;
  entries: IndexEntry[];
  truncated: boolean;
}
export interface KwEntry {
  keyword: string;
  file: string;
  page: number; // 1-based
}
export interface SearchResults {
  folders: IndexEntry[];
  notes: IndexEntry[];
  pdfs: IndexEntry[];
  docs: IndexEntry[]; // epub / cbz / xps / fb2
  keywords: KwEntry[];
}

interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  mtime: number;
}

let mem: IndexData | null = null;
let building: Promise<IndexData> | null = null;

async function walk(roots: string[]): Promise<{entries: IndexEntry[]; truncated: boolean}> {
  const out: IndexEntry[] = [];
  let frontier = roots.slice();
  const seen = new Set<string>();
  let dirs = 0;
  let truncated = false;
  while (frontier.length) {
    if (dirs >= MAX_DIRS || out.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }
    const batch = frontier.filter(d => !seen.has(d));
    batch.forEach(d => seen.add(d));
    const next: string[] = [];
    for (let i = 0; i < batch.length; i += LIST_CONCURRENCY) {
      const slice = batch.slice(i, i + LIST_CONCURRENCY);
      dirs += slice.length;
      const lists = await Promise.all(
        slice.map(d => DashboardNative.listDir(d).then((x: DirEntry[]) => x ?? []).catch(() => [] as DirEntry[])),
      );
      for (const entries of lists) {
        for (const e of entries) {
          if (e.isDir) {
            if (!SKIP_DIR.test(e.name)) {
              out.push({name: e.name, path: e.path, isDir: true});
              next.push(e.path);
            }
          } else if (OPENABLE.test(e.name)) {
            out.push({name: e.name, path: e.path, isDir: false});
          }
        }
      }
    }
    frontier = next;
  }
  return {entries: out, truncated};
}

/** Rebuild the index from a fresh device walk and persist it. */
export async function buildIndex(): Promise<IndexData> {
  if (building) return building;
  building = (async () => {
    const {entries, truncated} = await walk(INDEX_ROOTS);
    const data: IndexData = {at: Date.now(), entries, truncated};
    mem = data;
    try {
      const dir = await cacheDir();
      await DashboardNative.writeFile(dir + INDEX_FILE, JSON.stringify(data));
    } catch {
      /* best-effort persist */
    }
    return data;
  })();
  try {
    return await building;
  } finally {
    building = null;
  }
}

/** Load the index for searching: memory → persisted snapshot → fresh build.
 *  A stale snapshot is returned immediately and refreshed in the background. */
export async function loadIndex(): Promise<IndexData> {
  if (mem && Date.now() - mem.at < MEM_TTL) return mem;
  if (!mem) {
    try {
      const dir = await cacheDir();
      const text: string = await DashboardNative.readTextFile(dir + INDEX_FILE);
      if (text && text.trim()) mem = JSON.parse(text);
    } catch {
      /* no snapshot yet */
    }
  }
  if (mem) {
    if (Date.now() - mem.at >= MEM_TTL) buildIndex().catch(() => {}); // refresh, don't wait
    return mem;
  }
  return buildIndex();
}

/** Keywords from the Stars/Keywords scan cache (only folders that were scanned). */
export async function loadKeywords(): Promise<KwEntry[]> {
  try {
    const dir = await cacheDir();
    const text: string = await DashboardNative.readTextFile(dir + SCAN_CACHE_FILE);
    if (!text || !text.trim()) return [];
    const obj = JSON.parse(text);
    const out: KwEntry[] = [];
    for (const [path, e] of Object.entries<any>(obj.files ?? {})) {
      for (const k of e?.keywords ?? []) {
        if (k?.keyword) out.push({keyword: k.keyword, file: path, page: k.page ?? 0});
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Lower-case + strip diacritics so "Réunion" matches "reunion". */
const fold = (s: string): string => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

/** Basename without its extension. Matching runs on this so a query letter can't
 *  hit the extension; e.g. "t" must not match the "t" in ".note". */
function stem(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}
function ext(name: string): string {
  const m = /\.([^.]+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

/** Does `needle` appear in `hay` in order (not necessarily contiguous)? approx: mode. */
function isSubseq(hay: string, needle: string): boolean {
  let i = 0;
  for (let k = 0; k < hay.length && i < needle.length; k++) if (hay[k] === needle[i]) i++;
  return i === needle.length;
}

interface TextTerm {
  alts: string[]; // folded alternatives from a|b; match if ANY
  exact: boolean; // =word → equals the whole name
  phrase: boolean; // "…"   → literal, may contain spaces (no | split, no approx)
  negate: boolean; // !word → must NOT match
}
interface ParsedQuery {
  terms: TextTerm[]; // ANDed; a negated term must fail to match
  approx: boolean; // approx: → subsequence match (typo-tolerant; skips phrases/exact)
  kwOnly: boolean; // kw:     → only keyword results
  starOnly: boolean; // star:   → only files that have a five-star
  folder: string; // f:xxx   → restrict to items whose path contains this (folded)
  types: Set<string>; // type:  → keep only these kinds (folder|note|pdf|doc)
}

/** Quote-aware tokenizer: "a b" is one (quoted) token; everything else splits on spaces. */
function rawTokens(raw: string): {t: string; quoted: boolean}[] {
  const out: {t: string; quoted: boolean}[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (m[1] !== undefined) out.push({t: m[1], quoted: true});
    else out.push({t: m[2], quoted: false});
  }
  return out;
}

function addTerm(pq: ParsedQuery, raw: string, quoted: boolean): void {
  let s = raw;
  let negate = false;
  let exact = false;
  if (!quoted) {
    while (s.startsWith('!')) {
      negate = true;
      s = s.slice(1);
    }
    if (s.startsWith('=')) {
      exact = true;
      s = s.slice(1);
    }
    if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
      quoted = true; // e.g. !"a phrase"
      s = s.slice(1, -1);
    }
  }
  const alts = (quoted ? [s] : s.split('|')).map(fold).filter(a => a.length > 0);
  if (!alts.length) return;
  pq.terms.push({alts, exact, phrase: quoted, negate});
}

/** SmartNoteAI-style grammar: words (ANDed) · "phrase" · =exact · a|b · !not ·
 *  f:folder · kw: · star: · type:note|pdf|doc|folder · approx: */
function parseQuery(raw: string): ParsedQuery {
  const pq: ParsedQuery = {terms: [], approx: false, kwOnly: false, starOnly: false, folder: '', types: new Set()};
  for (const {t, quoted} of rawTokens(raw)) {
    if (!quoted) {
      const m = /^([a-z]+):(.*)$/i.exec(t);
      if (m) {
        const key = m[1].toLowerCase();
        const val = m[2];
        if (key === 'f') {
          if (val) pq.folder = fold(val);
          continue;
        }
        if (key === 'kw') {
          pq.kwOnly = true;
          if (val) addTerm(pq, val, false);
          continue;
        }
        if (key === 'approx') {
          pq.approx = true;
          if (val) addTerm(pq, val, false);
          continue;
        }
        if (key === 'star') {
          pq.starOnly = true;
          if (val) addTerm(pq, val, false);
          continue;
        }
        if (key === 'type') {
          for (const v of val.toLowerCase().split('|')) {
            if (v === 'folder' || v === 'note' || v === 'pdf' || v === 'doc') pq.types.add(v);
          }
          continue;
        }
        // unknown prefix → treat the whole token as a term
      }
    }
    addTerm(pq, t, quoted);
  }
  return pq;
}

/** Best rank for one term over `n`: exact(3) › prefix(2) › contains(1) › none(-1). */
function termRank(n: string, term: TextTerm, approx: boolean): number {
  let best = -1;
  for (const alt of term.alts) {
    let r = -1;
    if (term.exact) r = n === alt ? 3 : -1;
    else if (approx && !term.phrase) r = isSubseq(n, alt) ? 1 : -1;
    else {
      const i = n.indexOf(alt);
      r = i < 0 ? -1 : n === alt ? 3 : i === 0 ? 2 : 1;
    }
    if (r > best) best = r;
  }
  return best;
}

/** Rank an ALREADY-FOLDED candidate against all terms (ANDed; negated terms must
 *  fail). -1 = no match. The hot path (thousands of index entries per keystroke)
 *  uses this with a precomputed folded string so no folding happens per key. */
function matchAllF(n: string, pq: ParsedQuery): number {
  if (!pq.terms.length) return 0; // no text constraint (e.g. bare `star:` / `type:pdf`): neutral match
  let best = 0;
  let anyPositive = false;
  for (const term of pq.terms) {
    const r = termRank(n, term, pq.approx);
    if (term.negate) {
      if (r >= 0) return -1; // excluded
      continue;
    }
    if (r < 0) return -1; // a required term is missing
    anyPositive = true;
    if (r > best) best = r;
  }
  return anyPositive ? best : -1; // a query of only negations lists nothing
}

/** Fold `target`, then rank. Used for keywords (folded on the fly). */
function matchAll(target: string, pq: ParsedQuery): number {
  if (!pq.terms.length) return 0;
  return matchAllF(fold(target), pq);
}

/** Per-IndexData folded caches (match string + path), computed once and reused
 *  across every keystroke. Folding all entries (up to MAX_ENTRIES) on each key
 *  was the search input lag on e-ink. Attached to the IndexData instance; a fresh
 *  build/load produces a new instance, so it never goes stale. Not persisted
 *  (buildIndex writes the plain data before any search adds this). */
function prepEntries(idx: IndexData): {f: string[]; fp: string[]} {
  const a = idx as any;
  if (a._prep && a._prep.f.length === idx.entries.length) return a._prep;
  const n = idx.entries.length;
  const f: string[] = new Array(n);
  const fp: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const e = idx.entries[i];
    f[i] = fold(e.isDir ? e.name : stem(e.name)); // files match on the stem (never the extension)
    fp[i] = fold(e.path);
  }
  a._prep = {f, fp};
  return a._prep;
}

function underRoots(path: string, roots?: string[]): boolean {
  if (!roots || !roots.length) return true; // no scope → whole device
  return roots.some(r => path === r || path.startsWith(r.endsWith('/') ? r : r + '/'));
}

export interface SearchOpts {
  roots?: string[]; // Stars-style folder scope
  starred?: Set<string>; // file paths that have a five-star (for star:)
  cap?: number;
}

/** Search the index. Files are grouped by kind (notes / pdfs / other docs); folders
 *  and keywords are separate. See parseQuery for the grammar. */
export function runSearch(idx: IndexData | null, kws: KwEntry[], rawQuery: string, opts: SearchOpts = {}): SearchResults {
  const {roots, starred, cap = 40} = opts;
  const empty: SearchResults = {folders: [], notes: [], pdfs: [], docs: [], keywords: []};
  const pq = parseQuery(rawQuery);
  // Active if there's any text OR any filter; so `star:` / `type:pdf` / `f:x` alone still list results.
  const active = pq.terms.length > 0 || pq.starOnly || pq.types.size > 0 || pq.folder !== '' || pq.kwOnly;
  if (!idx || !active) return empty;

  const folderOk = (path: string) => !pq.folder || fold(path).includes(pq.folder);
  const typeOk = (kind: string) => pq.types.size === 0 || pq.types.has(kind);

  // Keywords: match on the keyword text; scoped by the file's folder + roots.
  // star:/type: (other than note) suppress them; kw: makes them the only results.
  let keywords: (KwEntry & {r: number})[] = [];
  if (!pq.starOnly && typeOk('note')) {
    const seenKw = new Map<string, KwEntry & {r: number}>();
    for (const k of kws) {
      if (!underRoots(k.file, roots) || !folderOk(k.file)) continue;
      const r = matchAll(k.keyword, pq);
      if (r < 0) continue;
      const key = fold(k.keyword);
      const prev = seenKw.get(key);
      if (!prev || r > prev.r) seenKw.set(key, {...k, r});
    }
    keywords = [...seenKw.values()].sort((a, b) => b.r - a.r || a.keyword.localeCompare(b.keyword)).slice(0, cap);
  }
  if (pq.kwOnly) return {...empty, keywords};

  const folders: (IndexEntry & {r: number})[] = [];
  const notes: (IndexEntry & {r: number})[] = [];
  const pdfs: (IndexEntry & {r: number})[] = [];
  const docs: (IndexEntry & {r: number})[] = [];
  const prep = prepEntries(idx); // precomputed folded name/path per entry (no per-key folding)
  for (let i = 0; i < idx.entries.length; i++) {
    const e = idx.entries[i];
    if (!underRoots(e.path, roots)) continue;
    if (pq.folder && !prep.fp[i].includes(pq.folder)) continue; // folded path, precomputed
    if (e.isDir) {
      if (pq.starOnly || !typeOk('folder')) continue; // folders have no stars
      const r = matchAllF(prep.f[i], pq);
      if (r >= 0) folders.push({...e, r});
    } else {
      if (pq.starOnly && !(starred && starred.has(e.path))) continue;
      const x = ext(e.name);
      const kind = x === 'note' ? 'note' : x === 'pdf' ? 'pdf' : 'doc';
      if (!typeOk(kind)) continue;
      const r = matchAllF(prep.f[i], pq); // prep.f is the folded stem for files
      if (r < 0) continue;
      (kind === 'note' ? notes : kind === 'pdf' ? pdfs : docs).push({...e, r});
    }
  }
  const byRank = (a: {r: number; name: string}, b: {r: number; name: string}) => b.r - a.r || a.name.localeCompare(b.name);
  folders.sort(byRank);
  notes.sort(byRank);
  pdfs.sort(byRank);
  docs.sort(byRank);
  return {
    folders: folders.slice(0, cap),
    notes: notes.slice(0, cap),
    pdfs: pdfs.slice(0, cap),
    docs: docs.slice(0, cap),
    keywords,
  };
}

/** Counts for the Status/Stats block: note & pdf files from the index (device-wide),
 *  stars & keywords from the scan cache (whatever's been scanned). */
export async function loadStats(): Promise<{notes: number; pdfs: number; stars: number; keywords: number}> {
  const idx = await loadIndex();
  let notes = 0;
  let pdfs = 0;
  for (const e of idx.entries) {
    if (e.isDir) continue;
    const n = e.name.toLowerCase();
    if (n.endsWith('.note')) notes++;
    else if (n.endsWith('.pdf')) pdfs++;
  }
  let stars = 0;
  let keywords = 0;
  try {
    const dir = await cacheDir();
    const text: string = await DashboardNative.readTextFile(dir + SCAN_CACHE_FILE);
    if (text && text.trim()) {
      const obj = JSON.parse(text);
      for (const e of Object.values<any>(obj.files ?? {})) {
        for (const p of e?.stars ?? []) stars += p?.count ?? 0;
        keywords += e?.keywords?.length ?? 0;
      }
    }
  } catch {
    /* none */
  }
  return {notes, pdfs, stars, keywords};
}

/** File paths that currently have at least one five-star (from the scan cache); for star:. */
export async function loadStarredFiles(): Promise<Set<string>> {
  const set = new Set<string>();
  try {
    const dir = await cacheDir();
    const text: string = await DashboardNative.readTextFile(dir + SCAN_CACHE_FILE);
    if (!text || !text.trim()) return set;
    const obj = JSON.parse(text);
    for (const [path, e] of Object.entries<any>(obj.files ?? {})) {
      if ((e?.stars?.length ?? 0) > 0) set.add(path);
    }
  } catch {
    /* none */
  }
  return set;
}
