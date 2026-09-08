/**
 * Underline -> clip label (fully offline OCR).
 *
 * If the lasso selection contains a "clean" straight underline (drawn with the
 * Supernote straight-line shape tool), recognise the handwriting sitting
 * directly above it and use that text as the clip's label. This runs ONLY when
 * such a line is present in the selection, so an ordinary clip capture is left
 * completely untouched: no OCR, no extra delay, no prompt. The user's whole
 * gesture stays "lasso -> Add to Dashboard"; the underline is an optional,
 * silent hint that costs nothing when absent.
 *
 * Coordinates are all in pixel (Android screen) space: geometry points,
 * contour points and the recognizer's region box are already pixels, and the
 * page size passed in comes from getPageDisplaySize().
 */
import {NativeModules} from 'react-native';
import {PluginCommAPI} from 'sn-plugin-lib';

const {DashboardNative} = NativeModules;
/** Diagnostic trace to the plugin log file (temporary, for tuning the band). */
function ulog(m: string): void {
  try {
    DashboardNative?.appendLog?.('UL ' + m).catch(() => {});
  } catch {}
}

type Size = {width: number; height: number};

function unwrapR(r: any) {
  return r && r.success ? r.result : undefined;
}

type Box = {x1: number; y1: number; x2: number; y2: number};

/** Pixel bounding box of an element: recognizer region if present, else the
 *  contour points. Returns null when neither yields a usable box. */
async function elementBox(el: any): Promise<Box | null> {
  const r = el && el.recognizeResult;
  if (r) {
    const x1 = r.up_left_point_x;
    const y1 = r.up_left_point_y;
    const x2 = r.down_right_point_x;
    const y2 = r.down_right_point_y;
    if (typeof x2 === 'number' && typeof y2 === 'number' && x2 - x1 > 1 && y2 - y1 > 1) {
      return {x1, y1, x2, y2};
    }
  }
  try {
    const n = await el.contoursSrc.size();
    if (n > 0) {
      const segs = await el.contoursSrc.getRange(0, n); // Point[][]
      let x1 = Infinity;
      let y1 = Infinity;
      let x2 = -Infinity;
      let y2 = -Infinity;
      for (const seg of segs) {
        const pts = Array.isArray(seg) ? seg : [seg];
        for (const p of pts) {
          if (!p || typeof p.x !== 'number') continue;
          if (p.x < x1) x1 = p.x;
          if (p.y < y1) y1 = p.y;
          if (p.x > x2) x2 = p.x;
          if (p.y > y2) y2 = p.y;
        }
      }
      if (isFinite(x1)) return {x1, y1, x2, y2};
    }
  } catch {
    /* fall through */
  }
  return null;
}

function cleanLabel(s: string): string {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > 40 ? t.slice(0, 40).trim() : t;
}

/**
 * Recognise the word(s) written directly above EACH clean underline in the
 * current lasso selection — one label per underline (three underlined words →
 * three labels). Must be called while the lasso is still active (before
 * setLassoBoxState). Returns [] when there is no clean underline, nothing sits
 * above one, or OCR yields nothing. `pageSize` MUST be the full page size (from
 * getPageDisplaySize) — recognizeElements rejects a lasso-sized rect. `els` is
 * the caller's already-fetched lasso elements: we READ them (never recycle
 * them), so the caller keeps ownership and there is no double-fetch/double-
 * recycle of the same native strokes.
 */
export async function detectUnderlineLabels(pageSize: Size, els: any[]): Promise<string[]> {
  try {
    // 1) Every clean, roughly-horizontal straight line in the selection is an
    //    underline (each marks one word to label).
    const geos: any[] = unwrapR(await PluginCommAPI.getLassoGeometries()) || [];
    const lines: {lineY: number; lxMin: number; lxMax: number}[] = [];
    for (const g of geos) {
      if (!g || g.type !== 'straightLine' || !Array.isArray(g.points) || g.points.length < 2) continue;
      const a = g.points[0];
      const b = g.points[g.points.length - 1];
      const dx = Math.abs(b.x - a.x);
      const dy = Math.abs(b.y - a.y);
      if (dx < 40 || dy > dx * 0.5) continue; // too short or too steep to be an underline
      lines.push({lineY: (a.y + b.y) / 2, lxMin: Math.min(a.x, b.x), lxMax: Math.max(a.x, b.x)});
    }
    if (lines.length === 0) return [];
    // Stable order: top-to-bottom, then left-to-right.
    lines.sort((p, q) => p.lineY - q.lineY || p.lxMin - q.lxMin);

    // 2) Read every stroke's box once (from the caller's els), then assign
    //    strokes to each underline.
    {
      const pageH = (pageSize && pageSize.height) || 1872;
      const strokes: {el: any; box: Box}[] = [];
      for (const el of els) {
        if (!el || el.type !== 0) continue; // strokes only (excludes the line geometry)
        const box = await elementBox(el);
        if (box) strokes.push({el, box});
      }

      const labels: string[] = [];
      const seen = new Set<string>();
      for (const L of lines) {
        const padX = (L.lxMax - L.lxMin) * 0.15 + 20;
        const xHit = (b: Box) => b.x2 >= L.lxMin - padX && b.x1 <= L.lxMax + padX;
        // Size the word's x-height from the baseline-ish strokes just above the line.
        const near = strokes.filter(s => xHit(s.box) && s.box.y2 <= L.lineY + pageH * 0.05 && s.box.y2 >= L.lineY - pageH * 0.25);
        if (near.length === 0) continue;
        const heights = near.map(n => n.box.y2 - n.box.y1).filter(h => h > 0).sort((x, y) => x - y);
        const medH = heights.length ? heights[Math.floor(heights.length / 2)] : pageH * 0.04;
        // A stroke belongs to THIS word if it is a letter sitting on this line:
        // its TOP is at/above the baseline (with a small tolerance). This keeps
        // ascenders / capitals / T-bars / i-dots (top well above) AND descenders
        // like f, g, y (their body starts above the line, so the stroke's top is
        // above even though its tail dips under), while EXCLUDING the next line's
        // text that sits just BELOW the underline (its top is under the line).
        // `up` also caps the reach so the row ABOVE isn't pulled in.
        const up = Math.min(Math.max(medH * 1.8, pageH * 0.04), pageH * 0.12);
        const tol = Math.max(pageH * 0.01, medH * 0.35); // how far a top may sit below the baseline and still count
        const top = L.lineY - up;
        const chosen = strokes.filter(s => xHit(s.box) && s.box.y1 <= L.lineY + tol && s.box.y2 >= top).map(s => s.el);
        if (chosen.length === 0) continue;
        const txt = unwrapR(await PluginCommAPI.recognizeElements(chosen, pageSize));
        ulog(`line y=${Math.round(L.lineY)} x=[${Math.round(L.lxMin)},${Math.round(L.lxMax)}] chosen=${chosen.length} medH=${Math.round(medH)} up=${Math.round(up)} tol=${Math.round(tol)} raw="${typeof txt === 'string' ? txt : ''}"`);
        const lab = cleanLabel(typeof txt === 'string' ? txt : '');
        if (lab && !seen.has(lab)) {
          seen.add(lab);
          labels.push(lab);
        }
      }
      return labels;
    }
  } catch {
    return [];
  }
}
