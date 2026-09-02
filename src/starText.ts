/**
 * Star-line previews and deletion.
 *
 * For each five-star on a page we find the strokes on the star's line and either
 * render them (a cropped strip of the page PNG) or OCR them. OCR
 * (recognizeElements) is unreliable: it intermittently fails; so 'text' mode
 * falls back to the image per line (handled by the scanner).
 *
 * Geometry: EMR is rotated 90° vs the screen: element x = the VERTICAL (row)
 * axis, element y = horizontal. Per-element maxX/maxY are the page EMR size, not
 * the element box; real positions come from stroke.points / fiveStar.points. The
 * image crop is expressed as fractions of the page, so it's resolution-independent.
 */
import {NativeModules} from 'react-native';
import {PluginCommAPI, PluginFileAPI} from 'sn-plugin-lib';

import {cacheDir} from './paths';

const {DashboardNative} = NativeModules;

/** Unwrap the SDK's `{success, result}` APIResponse shape (also used by scanner). */
export function unwrap<T>(res: any): T | undefined {
  if (res == null) return undefined;
  if (Array.isArray(res)) return res as T;
  if (res.result !== undefined) return res.result as T;
  return res as T;
}
const un = unwrap;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** A cropped strip of the page PNG showing one star's line. */
export interface LineImg {
  png: string; // file path of the page PNG
  yFrac: number; // strip top as a fraction of page height
  hFrac: number; // strip height as a fraction of page height
  aspect: number; // page width/height (px) for display
}

interface Box {
  s: any;
  x0: number;
  x1: number;
}
interface StarLine {
  num: number; // element numInPage (for delete)
  top: number; // line's top in the EMR row axis
  bot: number; // line's bottom
  boxes: Box[]; // stroke boxes on this line
}
interface StarGeom {
  size: any;
  els: any[]; // caller must recycle via recycleGeom
  maxX: number; // page EMR extent along the row (vertical) axis
  aspect: number; // page px width/height
  stars: StarLine[]; // top→bottom
}

async function strokeBox(e: any): Promise<Box | null> {
  try {
    const acc = e.stroke?.points;
    if (!acc) return null;
    const n = await acc.size();
    if (!n) return null;
    const pts: any[] = await acc.getRange(0, Math.min(n, 500));
    let x0 = Infinity, x1 = -Infinity;
    for (const p of pts) {
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
    }
    return {s: e, x0, x1};
  } catch {
    return null;
  }
}

async function recycleGeom(g: StarGeom | null): Promise<void> {
  if (!g) return;
  for (const e of g.els) {
    try {
      e.recycle && (await e.recycle());
    } catch {
      /* ignore */
    }
  }
}

/**
 * Read a page's elements once and, per star (top→bottom), the strokes on the
 * star's line. Returns null (already recycled) if the page has no star. On
 * success the CALLER must recycle via recycleGeom().
 */
async function readStarGeom(path: string, page0: number): Promise<StarGeom | null> {
  const size: any = un(await PluginFileAPI.getPageSize(path, page0));
  const els: any[] = un(await PluginFileAPI.getElements(page0, path)) ?? [];
  const starEls = els.filter(e => e.type === 800);
  if (!starEls.length) {
    await recycleGeom({size, els, maxX: 0, aspect: 1, stars: []});
    return null;
  }
  const strokes = els.filter(e => e.type === 0);
  const maxX = els[0]?.maxX || 20967;
  const aspect = size?.width && size?.height ? size.width / size.height : 1404 / 1872;

  const boxed: Box[] = [];
  for (const s of strokes) {
    const b = await strokeBox(s);
    if (b) boxed.push(b);
  }
  const heights = boxed.map(b => b.x1 - b.x0).sort((a, b) => a - b);
  const medianH = heights.length ? heights[Math.floor(heights.length / 2)] : 0;

  const stars: StarLine[] = starEls
    .map(e => {
      const pts: any[] = e.fiveStar?.points ?? [];
      let x0 = Infinity, x1 = -Infinity;
      for (const p of pts) {
        if (p.x < x0) x0 = p.x;
        if (p.x > x1) x1 = p.x;
      }
      return {x0, x1, num: e.numInPage};
    })
    .sort((a, b) => a.x0 - b.x0)
    .map(st => {
      const starRow = (st.x0 + st.x1) / 2;
      const band = Math.max(st.x1 - st.x0, medianH) * 0.85; // < 1 line → no bleed
      // The star glyph isn't a stroke, so all strokes on its row = the line's text.
      const boxes = boxed.filter(b => Math.abs((b.x0 + b.x1) / 2 - starRow) < band);
      let top = st.x0, bot = st.x1;
      for (const b of boxes) {
        if (b.x0 < top) top = b.x0;
        if (b.x1 > bot) bot = b.x1;
      }
      return {num: st.num, top, bot, boxes};
    });

  return {size, els, maxX, aspect, stars};
}

/** OCR strokes, retrying the transient "Recognition failed (117)" error. '' if
 *  it recognises nothing (the firmware OCR is unreliable; hence 'image' mode). */
async function recognize(elements: any[], size: any): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw: any = await PluginCommAPI.recognizeElements(elements, {width: size?.width, height: size?.height});
    if (raw && raw.success) return typeof raw.result === 'string' ? raw.result.replace(/\s+/g, ' ').trim() : '';
    await sleep(150);
  }
  return '';
}

/** A cropped handwriting strip per star on page `page0` (0-based), top→bottom.
 *  `mtime` keys the PNG; older PNGs for this page are pruned. [] on failure. */
export async function starLineImages(path: string, page0: number, mtime: number): Promise<LineImg[]> {
  const g = await readStarGeom(path, page0);
  if (!g) return [];
  try {
    const dir = await cacheDir();
    const png = `${dir}line_${hashPath(path)}_p${page0}_${mtime}.png`;
    const r: any = await PluginFileAPI.generateNotePng({notePath: path, page: page0, times: 1, pngPath: png, type: 0});
    if (!(r === true || r?.success)) return g.stars.map(() => ({png: '', yFrac: 0, hFrac: 0, aspect: g.aspect}));
    // keep only this page's current PNG; drop stale-mtime ones
    const name = png.substring(png.lastIndexOf('/') + 1);
    DashboardNative?.pruneMatching?.(dir, `line_${hashPath(path)}_p${page0}_`, name).catch(() => {});
    return g.stars.map(st => {
      const pad = (st.bot - st.top) * 0.12;
      const y0 = Math.max(0, st.top - pad);
      const y1 = Math.min(g.maxX, st.bot + pad);
      return {png, yFrac: y0 / g.maxX, hFrac: (y1 - y0) / g.maxX, aspect: g.aspect};
    });
  } finally {
    await recycleGeom(g);
  }
}

/** OCR text per star's line (top→bottom); '' where the recognizer fails. */
export async function starLineTexts(path: string, page0: number): Promise<string[]> {
  const g = await readStarGeom(path, page0);
  if (!g) return [];
  try {
    const out: string[] = [];
    for (const st of g.stars) out.push(st.boxes.length ? await recognize(st.boxes.map(b => b.s), g.size) : '');
    return out;
  } finally {
    await recycleGeom(g);
  }
}

/** Delete the `index`-th five-star (top→bottom order) on page `page0` (0-based),
 *  keeping the handwriting. Returns true if deleted. */
export async function deleteStarByIndex(path: string, page0: number, index: number): Promise<boolean> {
  const g = await readStarGeom(path, page0);
  if (!g) return false;
  try {
    if (index < 0 || index >= g.stars.length) return false;
    const res: any = await PluginFileAPI.deleteElements(path, page0, [g.stars[index].num]);
    return res === true || !!res?.success;
  } finally {
    await recycleGeom(g);
  }
}

function hashPath(p: string): string {
  let h = 0;
  for (let i = 0; i < p.length; i++) h = (h * 31 + p.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
