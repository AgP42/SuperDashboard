/**
 * A to-do's tick-box on its source note: find it, draw/erase the ✓ (dashboard →
 * note), and read whether it's ticked (note → dashboard). Together these give a
 * two-way sync: tick in either place and both agree, with the NOTE as the source
 * of truth whenever its box is findable.
 *
 * How the mark is identified. Element `uuid` looked like the obvious handle, but a
 * device run showed the firmware re-generates every uuid on each read (the same
 * eight geometries came back with eight different uuids five times running), so it
 * identifies nothing across calls. So the capture WRITES its own handle instead: a
 * small "#N" label beside the tick-box. A text box can be read back by its own
 * text, which is an exact match rather than a guess at a shape, and it survives a
 * move. The square itself is then simply the one nearest that label.
 *
 * Reading the ticked state (readMarkTicked): a box counts as checked when it holds
 * either our own drawn ✓ (a straight-line geometry inside it) or hand-drawn ink (a
 * pen stroke with points inside it). The box outline is a GEO_polygon and its
 * "raised-button" shadow lines sit outside the square, so neither is mistaken for
 * a check. Stroke points are EMR (rotated); we convert them with the page size.
 */
import {NativeModules} from 'react-native';
import {PluginCommAPI, PluginFileAPI} from 'sn-plugin-lib';

import {Clip} from './clips';
import {resolveClipTarget} from './notepage';
import {recycleAll, unwrap} from './starText';

const {DashboardNative} = NativeModules;

/** Must match TODO_BOX_SIDE in index.js (the side we draw). */
const BOX_SIDE = 44;
const SIDE_TOL = 12; // matching slack, in page pixels

function mlog(m: string): void {
  try {
    DashboardNative?.appendLog?.('[mark] ' + m).catch(() => {});
  } catch {}
}

export type Box = {x1: number; y1: number; x2: number; y2: number};

function boxOfPoints(points: any[]): Box | null {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const p of points ?? []) {
    if (!p || typeof p.x !== 'number') continue;
    if (p.x < x1) x1 = p.x;
    if (p.y < y1) y1 = p.y;
    if (p.x > x2) x2 = p.x;
    if (p.y > y2) y2 = p.y;
  }
  return isFinite(x1) ? {x1, y1, x2, y2} : null;
}

const centre = (b: Box) => ({x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2});

/** Find the "#N" mark and its box in an ALREADY-fetched element list, so a caller
 *  that also inspects the box reuses one getElements. null if not there. Reads
 *  each geometry's points ROBUSTLY (array OR accessor): a plain for..of over an
 *  accessor yields nothing, which would silently drop the real box and pick a
 *  wrong 44px square elsewhere on the page. */
async function findBoxInEls(els: any[], markNum: number): Promise<Box | null> {
  const tag = `#${markNum}`;
  const label = els.find(e => e && (e.type === 500 || e.type === 501 || e.type === 502) && e.textBox && (e.textBox.textContentFull ?? '').trim() === tag);
  if (!label) return null;
  const lr = label.textBox.textRect;
  const anchorPt = {x: lr.left, y: (lr.top + lr.bottom) / 2};
  const cands: Box[] = [];
  for (const e of els) {
    if (!e || e.type !== 700) continue;
    const pts = await samplePoints(e.geometry?.points, 64);
    const b = boxOfPoints(pts);
    if (b && Math.abs(b.x2 - b.x1 - BOX_SIDE) <= SIDE_TOL && Math.abs(b.y2 - b.y1 - BOX_SIDE) <= SIDE_TOL) cands.push(b);
  }
  if (!cands.length) return null;
  cands.sort((a, b) => {
    const ca = centre(a);
    const cb = centre(b);
    return Math.hypot(ca.x - anchorPt.x, ca.y - anchorPt.y) - Math.hypot(cb.x - anchorPt.x, cb.y - anchorPt.y);
  });
  return cands[0];
}

/** Find the "#N" mark and its box on ONE specific page. null if not there. */
async function findMarkOnPage(path: string, page: number, markNum: number): Promise<Box | null> {
  const els: any[] = unwrap<any[]>(await PluginFileAPI.getElements(page, path)) ?? [];
  try {
    return await findBoxInEls(els, markNum);
  } finally {
    await recycleAll(els);
  }
}

/** Sample up to `cap` points from a geometry/stroke point container, which the
 *  firmware exposes EITHER as a plain array OR as a lazy ElementDataAccessor
 *  (size()/getRange()). Old notes mix both, so we must not assume `.some`/`.map`
 *  exist on it — that was crashing the read with "undefined is not a function". */
async function samplePoints(container: any, cap: number): Promise<any[]> {
  try {
    if (!container) return [];
    if (Array.isArray(container)) return container.slice(0, cap);
    if (typeof container.size === 'function' && typeof container.getRange === 'function') {
      const n = await container.size();
      if (!n) return [];
      return (await container.getRange(0, Math.min(n, cap))) ?? [];
    }
  } catch {
    /* fall through */
  }
  return [];
}

/** Inspect a box: does it hold OUR drawn ✓ (a straight-line geometry inside), and
 *  which pen strokes (type 0) form a hand-drawn check inside it (their numInPage,
 *  for normalisation)? The stroke pass reads points off EVERY stroke on the page
 *  (two native calls each) so it runs ONLY when a pageSize is given (the caller
 *  passes one only for the note being viewed, on an explicit refresh). Strokes are
 *  EMR — rotated 90° (element x = vertical, y = horizontal) with the horizontal axis
 *  flipped — and the EMR extent is carried per-element as maxX/maxY; converting with
 *  THOSE (not PointUtils' 8.45 assumption) stays correct on non-standard pages. */
async function inspectBox(els: any[], box: Box, pageSize: any): Promise<{ourCheck: boolean; handNums: number[]}> {
  const inset = 4;
  const inside = (x: number, y: number) => x > box.x1 + inset && x < box.x2 - inset && y > box.y1 + inset && y < box.y2 - inset;
  let ourCheck = false;
  for (const e of els) {
    if (!e || e.type !== 700 || e.geometry?.type !== 'straightLine') continue;
    const pts = await samplePoints(e.geometry.points, 16);
    if (pts.some((p: any) => p && inside(p.x, p.y))) {
      ourCheck = true;
      break;
    }
  }
  const handNums: number[] = [];
  const W = pageSize?.width || 0;
  const H = pageSize?.height || 0;
  if (W && H) {
    for (const e of els) {
      if (!e || e.type !== 0 || typeof e.numInPage !== 'number') continue;
      const maxX = e.maxX || 0;
      const maxY = e.maxY || 0;
      if (!maxX || !maxY) continue;
      const pts = await samplePoints(e.stroke?.points, 24);
      if (!pts.length) continue;
      let hitn = 0;
      for (const p of pts) {
        const px = W - (p.y / maxY) * W;
        const py = (p.x / maxX) * H;
        if (inside(px, py)) hitn++;
      }
      // A check drawn inside this tiny box has MOST of its points inside; a stroke
      // merely passing nearby has few → require a majority so normalisation never
      // deletes adjacent handwriting.
      if (hitn >= 2 && hitn * 2 >= pts.length) handNums.push(e.numInPage);
    }
  }
  return {ourCheck, handNums};
}

/** Page size in pixels, preferring the UNGATED getPageDisplaySize for the current
 *  file (getPageSize is FILE:READ-gated on Chauvet 3.29.43+ and can silently return
 *  an unusable size — which breaks the EMR→pixel conversion for hand-ink). Page
 *  sizes are uniform within a note, so the displayed page's size stands in. */
async function pageSizeOf(path: string, page: number): Promise<any> {
  try {
    const cur = unwrap<string>(await PluginCommAPI.getCurrentFilePath().catch(() => ''));
    const gpds = (PluginCommAPI as any).getPageDisplaySize;
    if (cur === path && typeof gpds === 'function') {
      const d = unwrap<any>(await gpds.call(PluginCommAPI).catch(() => null));
      if (d && d.width && d.height) return d;
    }
  } catch {
    /* fall through to the gated call */
  }
  return unwrap<any>(await PluginFileAPI.getPageSize(path, page));
}

/**
 * DIRECTION 2 (note → dashboard), on an explicit refresh: is the to-do's box
 * checked, and if the user checked it BY HAND, replace that ink with our own ✓ so
 * the dashboard can later untick it (erasing hand ink is otherwise impossible, so
 * the to-do would keep re-checking itself). The erase+redraw runs ONLY when the box
 * is on the currently-viewed page, where insertGeometry places the ✓ correctly and
 * the hand ink can be hit-tested reliably. Additive by design: it reports
 * ticked:true when checked, never asks the caller to untick. found:false when the
 * box isn't on the expected page. The per-stroke scan is why this is refresh-only,
 * not run on every open.
 */
export async function normalizeTodoMark(clip: Clip, currentPath: string): Promise<{found: boolean; ticked: boolean}> {
  if (typeof clip.markNum !== 'number') return {found: false, ticked: false};
  try {
    const t = await resolveClipTarget(clip.sourcePath, clip.sourcePageId, clip.sourcePage);
    const onCurrent = t.path === currentPath;
    const els: any[] = unwrap<any[]>(await PluginFileAPI.getElements(t.page, t.path)) ?? [];
    try {
      const box = await findBoxInEls(els, clip.markNum);
      if (!box) return {found: false, ticked: false};
      const size = onCurrent ? await pageSizeOf(t.path, t.page) : null; // stroke scan only on the open note
      const {ourCheck, handNums} = await inspectBox(els, box, size);
      if (ourCheck) return {found: true, ticked: true};
      if (onCurrent && handNums.length) {
        // Normalise the hand check: delete the ink, draw our own ✓ (erasable later).
        await PluginFileAPI.deleteElements(t.path, t.page, handNums.slice().sort((a, b) => b - a)).catch(() => {});
        const drawn = await drawCheckInBox(t.path, t.page, box, true);
        mlog(`${clip.id}: normalised hand-check (${handNums.length} stroke(s) → ✓) drawn=${drawn}`);
        return {found: true, ticked: true};
      }
      return {found: true, ticked: false};
    } finally {
      await recycleAll(els);
    }
  } catch (e: any) {
    mlog(`${clip.id}: normalizeTodoMark failed: ${e && e.message}`);
    return {found: false, ticked: false};
  }
}

/** Fast path: the mark on the to-do's recorded source page (follows the page via
 *  PAGEID across reorder / cross-note page move). null if not there. */
export async function findTodoBox(clip: Clip): Promise<{path: string; page: number; box: Box} | null> {
  if (typeof clip.markNum !== 'number') return null;
  const t = await resolveClipTarget(clip.sourcePath, clip.sourcePageId, clip.sourcePage);
  const box = await findMarkOnPage(t.path, t.page, clip.markNum);
  if (!box) {
    mlog(`${clip.id}: mark "#${clip.markNum}" not on page ${t.page} of ${t.path}`);
    return null;
  }
  return {path: t.path, page: t.page, box};
}

/** DEEP SEARCH: scan every page of the given notes for the mark. Used only on
 *  demand (the mark's box was lasso-cut to another page/note). Returns the hit
 *  plus timing, or null. `should` lets the caller abort between pages. */
export async function deepFindMark(
  clip: Clip,
  paths: string[],
  should?: () => boolean,
  onProgress?: (done: number, total: number, note: string) => void,
): Promise<{path: string; page: number; box: Box; ms: number; scanned: number} | null> {
  const start = Date.now();
  if (typeof clip.markNum !== 'number') return null;
  // Sum page counts first so the progress bar has a real total (getNoteTotalPageNum
  // is one cheap call per note).
  const totals: number[] = [];
  let total = 0;
  for (const path of paths) {
    let t = 0;
    try {
      t = Math.min(unwrap<number>(await PluginFileAPI.getNoteTotalPageNum(path)) ?? 0, 400);
    } catch {
      t = 0;
    }
    totals.push(t);
    total += t;
  }
  onProgress?.(0, total, '');
  let scanned = 0;
  for (let i = 0; i < paths.length; i++) {
    if (should && !should()) break;
    const path = paths[i];
    for (let p = 0; p < totals[i]; p++) {
      if (should && !should()) {
        mlog(`${clip.id}: deep-find CANCELLED after ${scanned} pages, ${Date.now() - start}ms`);
        return null;
      }
      scanned++;
      let box: Box | null = null;
      try {
        box = await findMarkOnPage(path, p, clip.markNum);
      } catch {
        /* skip page */
      }
      // Report progress every 10 pages (or when the note changes): a setState per
      // page forces an e-ink re-render each time, which dominated the scan cost.
      if (scanned % 10 === 0 || p === 0) onProgress?.(scanned, total, path);
      if (box) {
        const ms = Date.now() - start;
        mlog(`${clip.id}: deep-find HIT on ${path} p${p} after ${scanned} pages, ${ms}ms`);
        return {path, page: p, box, ms, scanned};
      }
    }
  }
  mlog(`${clip.id}: deep-find MISS over ${scanned} pages in ${paths.length} note(s), ${Date.now() - start}ms`);
  return null;
}

/**
 * Draw the ✓ (two straight lines) inside a box on a given file+page.
 * `onCurrentPage`: the box is on the note's currently-displayed page, so we can
 * use PluginCommAPI.insertGeometry — the SAME pixel-coordinate API the capture
 * used to draw the box, which places correctly on ANY page size. The file-level
 * insertElements path (used when the target page isn't displayed) mis-scales the
 * coordinates on non-standard page sizes, so it stays a best-effort fallback.
 */
export async function drawCheckInBox(path: string, page: number, box: Box, onCurrentPage = false): Promise<boolean> {
  const w = box.x2 - box.x1;
  const h = box.y2 - box.y1;
  const pts = [
    [box.x1 + w * 0.2, box.y1 + h * 0.55],
    [box.x1 + w * 0.42, box.y1 + h * 0.8],
    [box.x1 + w * 0.82, box.y1 + h * 0.2],
  ];
  const line = onCurrentPage
    ? (a: number, b: number, c: number, d: number) => insertGeoLineHere(a, b, c, d)
    : (a: number, b: number, c: number, d: number) => insertGeoLine(path, page, a, b, c, d);
  const ok1 = await line(pts[0][0], pts[0][1], pts[1][0], pts[1][1]);
  const ok2 = await line(pts[1][0], pts[1][1], pts[2][0], pts[2][1]);
  return ok1 && ok2; // both strokes, or it's only half a tick
}

/**
 * DIRECTION 1 (dashboard → note): draw a check inside the to-do's box on its
 * source note (NOT the open note) via insertElements. Returns true if drawn.
 */
export async function writeTodoCheck(clip: Clip): Promise<boolean> {
  try {
    const found = await findTodoBox(clip);
    if (!found) {
      mlog(`${clip.id}: cannot tick on note (box not found)`);
      return false;
    }
    const {path, page, box} = found;
    // Prefer insertGeometry (page-size-correct pixels) when the box is on the
    // note's displayed page — the common case when ticking from the dashboard.
    const curPath = unwrap<string>(await PluginCommAPI.getCurrentFilePath().catch(() => '')) ?? '';
    const curPage = unwrap<number>(await PluginCommAPI.getCurrentPageNum().catch(() => -1)) ?? -1;
    const onCurrent = curPath === path && curPage === page;
    const ok = await drawCheckInBox(path, page, box, onCurrent);
    mlog(`${clip.id}: tick on note page ${page} (${onCurrent ? 'insertGeometry' : 'insertElements'}): ok=${ok} box=[${Math.round(box.x1)},${Math.round(box.y1)},${Math.round(box.x2)},${Math.round(box.y2)}]`);
    return ok;
  } catch (e: any) {
    mlog(`${clip.id}: writeTodoCheck failed: ${e && e.message}`);
    return false;
  }
}

/**
 * DIRECTION 1 (un-tick): remove the check from the to-do's box on its note.
 * Deletes the straight-line geometries whose BOTH endpoints sit inside the box;
 * the box outline and its shadow sit on/outside the border, so they're left.
 */
/** Erase the ✓ (straight lines whose both endpoints are inside the box) at a
 *  known box on a file+page. Leaves the box outline and its shadow (on/outside
 *  the border). Returns true if the delete succeeded or there was nothing to erase. */
export async function eraseCheckInBox(path: string, page: number, box: Box): Promise<boolean> {
  const els: any[] = unwrap<any[]>(await PluginFileAPI.getElements(page, path)) ?? [];
  try {
    const inset = 3;
    const inside = (pt: any) => pt && pt.x > box.x1 + inset && pt.x < box.x2 - inset && pt.y > box.y1 + inset && pt.y < box.y2 - inset;
    const nums: number[] = [];
    for (const e of els) {
      if (!e || e.type !== 700 || e.geometry?.type !== 'straightLine' || typeof e.numInPage !== 'number') continue;
      const pts = await samplePoints(e.geometry.points, 8); // array OR accessor (see samplePoints)
      if (pts.length >= 2 && pts.every(inside)) nums.push(e.numInPage);
    }
    if (!nums.length) return true; // nothing drawn — not a failure
    nums.sort((a, b) => b - a); // delete highest index first
    const r: any = await PluginFileAPI.deleteElements(path, page, nums);
    return r === true || !!(r && r.success);
  } finally {
    await recycleAll(els);
  }
}

export async function clearTodoCheck(clip: Clip): Promise<boolean> {
  try {
    const found = await findTodoBox(clip);
    if (!found) {
      mlog(`${clip.id}: cannot un-tick (box not found)`);
      return false;
    }
    const ok = await eraseCheckInBox(found.path, found.page, found.box);
    mlog(`${clip.id}: un-tick on page ${found.page} ok=${ok}`);
    return ok;
  } catch (e: any) {
    mlog(`${clip.id}: clearTodoCheck failed: ${e && e.message}`);
    return false;
  }
}

/**
 * "Untrack" a to-do on delete: remove ONLY its "#N" label, and only if it's on
 * the to-do's EXPECTED page (one getElements, no deep scan — delete happens on
 * old notes long afterwards and must stay cheap). The frame, tick-box and any
 * check are left in place, so the note still shows it was a to-do; losing the
 * "#N" is the visible "no longer tracked" signal. Silent no-op if the label
 * isn't on the expected page.
 */
export async function untrackTodoMark(clip: Clip): Promise<void> {
  try {
    if (typeof clip.markNum !== 'number') return;
    const t = await resolveClipTarget(clip.sourcePath, clip.sourcePageId, clip.sourcePage);
    const tag = `#${clip.markNum}`;
    const els: any[] = unwrap<any[]>(await PluginFileAPI.getElements(t.page, t.path)) ?? [];
    try {
      const label = els.find(e => e && (e.type === 500 || e.type === 501 || e.type === 502) && e.textBox && (e.textBox.textContentFull ?? '').trim() === tag);
      if (!label || typeof label.numInPage !== 'number') {
        mlog(`${clip.id}: untrack — ${tag} not on expected page ${t.page}, left as is`);
        return;
      }
      const r: any = await PluginFileAPI.deleteElements(t.path, t.page, [label.numInPage]);
      mlog(`${clip.id}: untrack removed ${tag} ok=${r === true || !!(r && r.success)}`);
    } finally {
      await recycleAll(els);
    }
  } catch (e: any) {
    mlog(`${clip.id}: untrackTodoMark failed: ${e && e.message}`);
  }
}

/** Insert one straight line on the CURRENT page via insertGeometry — pixel coords,
 *  page-size-correct (the same API the capture used for the box). */
async function insertGeoLineHere(x1: number, y1: number, x2: number, y2: number): Promise<boolean> {
  try {
    const r: any = await PluginCommAPI.insertGeometry({
      penColor: 0x00,
      penType: 10,
      penWidth: 300,
      type: 'straightLine',
      points: [
        {x: x1, y: y1},
        {x: x2, y: y2},
      ],
      showLassoAfterInsert: false,
    });
    return r === true || !!(r && r.success);
  } catch (e: any) {
    mlog(`insertGeoLineHere threw: ${e && e.message}`);
    return false;
  }
}

/** Insert one straight-line geometry into an arbitrary file+page. Tries the
 *  createElement→populate→insertElements path and logs the outcome so a first
 *  device run shows whether the element shape is accepted. */
async function insertGeoLine(path: string, page: number, x1: number, y1: number, x2: number, y2: number): Promise<boolean> {
  try {
    const r: any = await PluginCommAPI.createElement(700);
    const el: any = r && r.success ? r.result : null;
    if (!el) {
      mlog('createElement(700) returned nothing');
      return false;
    }
    el.type = 700;
    el.geometry = {
      ...(el.geometry || {}),
      type: 'straightLine',
      penColor: 0x00,
      penType: 10,
      penWidth: 300,
      points: [
        {x: x1, y: y1},
        {x: x2, y: y2},
      ],
    };
    const ins: any = await PluginFileAPI.insertElements(path, page, [el]);
    try {
      el.recycle && el.recycle();
    } catch {}
    if (!(ins && ins.success)) mlog(`insertElements failed${ins && ins.error ? ': ' + ins.error.message : ''}`);
    return !!(ins && ins.success);
  } catch (e: any) {
    mlog(`insertGeoLine threw: ${e && e.message}`);
    return false;
  }
}
