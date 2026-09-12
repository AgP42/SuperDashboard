/**
 * Stable page IDs from a .note file (so a clip backlink can FOLLOW a page that
 * was reordered or moved, instead of pointing at a stale page number).
 *
 * The Supernote SDK hides the page ID (Link.destPageId is present natively but
 * never surfaced to plugins), so — like SmartNoteAI — we read it straight from
 * the .note binary. Format: magic "noteSN"; the last 4 bytes are the footer
 * block address; a "block" is [uint32-LE length][payload]; the footer payload
 * lists `<PAGE{n}:{addr}>` (n is 1-indexed); each page block contains
 * `<PAGEID:{stableId}>`. We read only the few small ranges we need via the
 * native readFileRange (RandomAccessFile), never the whole file — and the
 * common lookups check the HINTED page block first, so a page that hasn't moved
 * costs one footer read + one block read (O(1)), not a full walk.
 */
import {NativeModules} from 'react-native';

import {recentModifiedFiles} from './scanner';

const {DashboardNative} = NativeModules;

type Range = {success?: boolean; fileSize?: number; latin1?: string};

/** One ranged read → {size, s} (s = the bytes as a latin1 string), or null. */
async function read(path: string, off: number, len: number): Promise<{size: number; s: string} | null> {
  try {
    const r: Range = await DashboardNative?.readFileRange?.(path, off, len);
    if (!r || !r.success || typeof r.fileSize !== 'number') return null;
    return {size: r.fileSize, s: typeof r.latin1 === 'string' ? r.latin1 : ''};
  } catch {
    return null;
  }
}

/** Little-endian uint32 from the first 4 latin1 chars of `s`. */
function u32le(s: string): number {
  return (s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24)) >>> 0;
}

/** Read a `[u32-LE len][payload]` block at `addr` as a latin1 string, guarding
 *  stale/corrupt offsets. null on any problem. */
async function readBlock(path: string, addr: number, size: number): Promise<string | null> {
  if (addr <= 0 || addr + 4 > size) return null;
  const lenR = await read(path, addr, 4);
  if (!lenR || lenR.s.length < 4) return null;
  const len = u32le(lenR.s);
  if (len === 0 || len > 4_000_000 || addr + 4 + len > size) return null;
  const payload = await read(path, addr + 4, len);
  return payload ? payload.s : null;
}

/** Footer only → {size, pages:[{page(0-idx), addr}]}. null when the file isn't a
 *  readable .note (so callers can tell "unreadable" from "id absent"). */
async function readFooterPages(path: string): Promise<{size: number; pages: {page: number; addr: number}[]} | null> {
  if (!/\.note$/i.test(path)) return null;
  const stat = await read(path, 0, 6);
  if (!stat || stat.size < 32 || stat.s.slice(0, 6) !== 'noteSN') return null;
  const size = stat.size;
  const tailR = await read(path, size - 4, 4);
  if (!tailR || tailR.s.length < 4) return null;
  const footer = await readBlock(path, u32le(tailR.s), size);
  if (footer === null) return null;
  const pages: {page: number; addr: number}[] = [];
  const re = /<PAGE(\d+):(\d+)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(footer)) !== null) {
    const p = parseInt(m[1], 10) - 1; // footer is 1-indexed → 0-indexed
    if (p >= 0) pages.push({page: p, addr: parseInt(m[2], 10)});
  }
  return {size, pages};
}

/** Per-page change signal (like SmartNoteAI's footer signature): each page's
 *  block ADDRESS from the footer. The .note format is append-only, so a page's
 *  block address changes ONLY when that page's own edit is flushed to the footer
 *  — not when another page changes, and not merely when the file grows (the size
 *  grows before the footer is rewritten, which is why the address, not the size,
 *  is the reliable signal). Costs a single footer read (no per-page reads, no
 *  OCR). Ordered by 0-indexed page. null if the file isn't a readable .note. */
export async function readPageRevs(path: string): Promise<{page: number; rev: string}[] | null> {
  const fp = await readFooterPages(path);
  if (!fp) return null;
  return fp.pages.map(p => ({page: p.page, rev: String(p.addr)})).sort((a, b) => a.page - b.page);
}

/** PAGEID marker in a page block ('' if none). */
function pageIdFromBlock(block: string): string {
  const id = /<PAGEID:([^>]+)>/.exec(block);
  return id && id[1].length > 0 ? id[1] : '';
}

/** Stable PAGEID of a given 0-indexed page ('' if unavailable). O(1): footer +
 *  the one page block. */
export async function pageIdAt(notePath: string, page: number): Promise<string> {
  if (page < 0) return '';
  try {
    const fp = await readFooterPages(notePath);
    if (!fp) return '';
    const entry = fp.pages.find(p => p.page === page);
    if (!entry) return '';
    const block = await readBlock(notePath, entry.addr, fp.size);
    return block ? pageIdFromBlock(block) : '';
  } catch {
    return '';
  }
}

/** Locate a PAGEID inside ONE note, checking the HINT index first (a page that
 *  hasn't moved is found in a single block read). `readable` distinguishes a
 *  successfully-read note where the id is absent (index -1) from an unreadable
 *  one — callers must NOT self-heal on an unreadable/transient result. */
async function findInNote(notePath: string, pageId: string, hint: number): Promise<{readable: boolean; index: number}> {
  const fp = await readFooterPages(notePath);
  if (!fp || fp.pages.length === 0) return {readable: false, index: -1};
  const ordered = fp.pages.slice().sort((a, b) => (a.page === hint ? -1 : b.page === hint ? 1 : 0));
  for (const p of ordered) {
    const block = await readBlock(notePath, p.addr, fp.size);
    if (block && pageIdFromBlock(block) === pageId) return {readable: true, index: p.page};
  }
  return {readable: true, index: -1};
}

/** Search OTHER notes for a PAGEID (the clip's source page moved to a different
 *  note). Recent notes first — a just-moved page lands in a recently-modified
 *  file — capped and early-exiting per note. Returns {path, page} or null. */
export async function findPageIdAcrossNotes(pageId: string, excludePath: string, cap = 40): Promise<{path: string; page: number} | null> {
  if (!pageId) return null;
  let files: string[] = [];
  try {
    files = await recentModifiedFiles(200);
  } catch {
    return null;
  }
  const notes = files.filter(p => /\.note$/i.test(p) && p !== excludePath).slice(0, cap);
  for (const p of notes) {
    const r = await findInNote(p, pageId, -1).catch(() => ({readable: false, index: -1}));
    if (r.readable && r.index >= 0) return {path: p, page: r.index};
  }
  return null;
}

/** Resolve a clip's CURRENT source {note, 0-indexed page}, following its stable
 *  PAGEID: first in its own note (covers reorder, O(1) when unmoved), then
 *  across other notes (covers a page moved to a different note → `moved: true`,
 *  caller self-heals). Falls back to the captured path+number when the PAGEID is
 *  gone or the source note is unreadable — and, crucially, does NOT trigger a
 *  cross-note search/self-heal on a transient unreadable source (which could
 *  otherwise rebind the clip to a note holding a COPY of the page). */
export async function resolveClipTarget(
  sourcePath: string,
  sourcePageId: string | undefined,
  sourcePage: number,
): Promise<{path: string; page: number; moved: boolean}> {
  if (sourcePageId) {
    const inSource = await findInNote(sourcePath, sourcePageId, sourcePage).catch(() => ({readable: false, index: -1}));
    if (inSource.readable && inSource.index >= 0) return {path: sourcePath, page: inSource.index, moved: false};
    // Only search other notes when the source note WAS readable and the id is
    // genuinely absent (the page left this note). Never on a transient failure.
    if (inSource.readable) {
      const found = await findPageIdAcrossNotes(sourcePageId, sourcePath).catch(() => null);
      if (found) return {path: found.path, page: found.page, moved: true};
    }
  }
  return {path: sourcePath, page: sourcePage, moved: false};
}
