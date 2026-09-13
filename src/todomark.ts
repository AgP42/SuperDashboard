/**
 * PROBE (read-only): find a to-do's tick-box on its source note, and tell whether
 * the user has ticked it by hand.
 *
 * How the mark is identified. Element `uuid` looked like the obvious handle, but a
 * device run showed the firmware re-generates every uuid on each read (the same
 * eight geometries came back with eight different uuids five times running), so it
 * identifies nothing across calls. So the capture WRITES its own handle instead: a
 * small "#N" label beside the tick-box. A text box can be read back by its own
 * text, which is an exact match rather than a guess at a shape, and it survives a
 * move. The square itself is then simply the one nearest that label.
 *
 * Still read-only: writing the tick back onto the note comes once this reports
 * that the box is reliably found and that hand-drawn ink inside it is detectable.
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

/** Find the "#N" mark and its box on ONE specific page. null if not there. */
async function findMarkOnPage(path: string, page: number, markNum: number): Promise<Box | null> {
  const els: any[] = unwrap<any[]>(await PluginFileAPI.getElements(page, path)) ?? [];
  try {
    const tag = `#${markNum}`;
    const label = els.find(e => e && (e.type === 500 || e.type === 501 || e.type === 502) && e.textBox && (e.textBox.textContentFull ?? '').trim() === tag);
    if (!label) return null;
    const lr = label.textBox.textRect;
    const anchorPt = {x: lr.left, y: (lr.top + lr.bottom) / 2};
    const cands = els
      .filter(e => e && e.type === 700)
      .map(g => boxOfPoints(g.geometry?.points))
      .filter((b): b is Box => !!b && Math.abs(b.x2 - b.x1 - BOX_SIDE) <= SIDE_TOL && Math.abs(b.y2 - b.y1 - BOX_SIDE) <= SIDE_TOL);
    if (!cands.length) return null;
    cands.sort((a, b) => {
      const ca = centre(a);
      const cb = centre(b);
      return Math.hypot(ca.x - anchorPt.x, ca.y - anchorPt.y) - Math.hypot(cb.x - anchorPt.x, cb.y - anchorPt.y);
    });
    return cands[0];
  } finally {
    await recycleAll(els);
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

/** Draw the ✓ (two straight lines) inside a box on a given file+page. */
export async function drawCheckInBox(path: string, page: number, box: Box): Promise<boolean> {
  const w = box.x2 - box.x1;
  const h = box.y2 - box.y1;
  const pts = [
    [box.x1 + w * 0.2, box.y1 + h * 0.55],
    [box.x1 + w * 0.42, box.y1 + h * 0.8],
    [box.x1 + w * 0.82, box.y1 + h * 0.2],
  ];
  const ok1 = await insertGeoLine(path, page, pts[0][0], pts[0][1], pts[1][0], pts[1][1]);
  const ok2 = await insertGeoLine(path, page, pts[1][0], pts[1][1], pts[2][0], pts[2][1]);
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
    const ok = await drawCheckInBox(path, page, box);
    mlog(`${clip.id}: tick on note page ${page}: ok=${ok} box=[${Math.round(box.x1)},${Math.round(box.y1)},${Math.round(box.x2)},${Math.round(box.y2)}]`);
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
      if (!e || e.type !== 700 || e.geometry?.type !== 'straightLine') continue;
      const pts: any[] = e.geometry.points ?? [];
      if (pts.length >= 2 && pts.every(inside) && typeof e.numInPage === 'number') nums.push(e.numInPage);
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
