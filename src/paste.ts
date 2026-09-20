/**
 * Paste a Note Clip back into a note, with a link to its source page.
 *
 * Flow: the user opens the target note, taps the bubble to open the Dashboard,
 * and taps "paste" on a clip. A handwriting clip is inserted as a normal image
 * (Picture); an OCR clip (captured in 'ocr' mode, so it carries recognized
 * text) is inserted as an editable **text box** (insertText). Either way a small
 * "↩ source" link is placed directly BELOW the inserted element, so the backlink
 * always travels with the clip instead of piling up in a page corner.
 *
 * Why an image and not the vector sticker: insertSticker's element squashes
 * vertically on every move/resize (firmware re-normalises it), quickly becoming
 * unreadable. A Picture (insertImage) moves and resizes cleanly.
 *
 * NOTE-only: images + text boxes + links are note main-layer features (a DOC/PDF
 * has none), and insertImage / insertText* target the CURRENTLY displayed page,
 * i.e. the note that was open when the Dashboard was raised.
 */
import {NativeModules, ToastAndroid} from 'react-native';
import {PluginCommAPI, PluginFileAPI, PluginNoteAPI, PointUtils} from 'sn-plugin-lib';

import {Clip, updateClipSource} from './clips';
import {leavePlugin} from './bubble';
import {noteTitle} from './scanner';
import {resolveClipTarget} from './notepage';
import {loadConfig} from './config';

const {DashboardNative} = NativeModules;
type Rect = {left: number; top: number; right: number; bottom: number};

/** Unwrap the SDK APIResponse shape. */
function unwrapR(r: any) {
  return r && r.success ? r.result : undefined;
}

/** saveCurrentNote is best-effort everywhere: never let a failed save abort a paste. */
const save = () => PluginNoteAPI.saveCurrentNote().catch(() => {});

function plog(m: string): void {
  try {
    DashboardNative?.appendLog?.('[paste] ' + m).catch(() => {});
  } catch {}
}

/**
 * The insert-then-relayout protocol, in one place.
 *
 * Both pasted kinds need it: a freshly inserted element renders with the
 * firmware's own geometry until something forces a relayout (which is why moving
 * a pasted text box by hand used to be what finally applied its font size). A
 * modifyElements write IS that relayout, so we read the element back and commit
 * the geometry we actually want.
 *
 * `accept` rejects an element of the wrong kind (getLastElement can return
 * something else entirely); `patch` returns the fields to overwrite on it.
 * Returns the re-committed element, or null when it couldn't be read back.
 */
async function recommitLastElement(
  accept: (el: any) => boolean,
  patch: (el: any, page: number) => Promise<object | null> | object | null,
  tag: string,
): Promise<any | null> {
  try {
    const path = unwrapR(await PluginCommAPI.getCurrentFilePath());
    const el: any = unwrapR(await PluginFileAPI.getLastElement());
    if (!path || !el || !accept(el)) {
      plog(`${tag}: inserted but could not read it back`);
      return null;
    }
    // A freshly inserted element can report pageNum = -1 (measured on device for
    // pictures) and modifyElements rejects a negative page ("page must be >= 0"),
    // so fall back to the page actually on screen.
    const page = typeof el.pageNum === 'number' && el.pageNum >= 0 ? el.pageNum : ((unwrapR(await PluginCommAPI.getCurrentPageNum()) as number) ?? 0);
    const fields = await patch(el, page);
    if (!fields) return null;
    const mr: any = await PluginFileAPI.modifyElements(path, page, [{...el, pageNum: page, layerNum: el.layerNum ?? 0, ...fields}]);
    await save();
    if (!(mr && mr.success)) plog(`${tag}: modifyElements failed${mr && mr.error ? ' ' + mr.error.message : ''}`);
    return el;
  } catch (e: any) {
    plog(`${tag}: re-commit failed: ${e && e.message}`);
    return null;
  }
}

/**
 * Insert an OCR clip as an editable text box AND re-commit its geometry+fontSize
 * via modifyElements. Reason: a freshly inserted text box renders at a tiny
 * default size until the first relayout (which is why a manual MOVE fixes it);
 * neither textFrameWidthType:0 nor reloadFile forces that relayout, but
 * modifyElements (the programmatic equivalent of a move) does. Returns true if
 * the text box was inserted.
 */
async function insertLockedText(clip: Clip, pageSize: {width: number; height: number}, cfg: any): Promise<boolean> {
  // normalize() has already validated these, so read them straight.
  const fontSize: number = cfg?.clipFontSize ?? 96;
  const fontPath: string = cfg?.clipFontPath ?? '';
  const pageW = (pageSize && pageSize.width) || 1404;
  const pageH = (pageSize && pageSize.height) || 1872;
  const w = Math.min(pageW - 200, 1000);
  // The firmware RE-FITS the text to fill its box on the first relayout (a move):
  // measured on device, it lands on fontSize = boxHeight / (1.667 * lines). So an
  // oversized box (we used to reserve 4 lines) made a 28pt paste jump to 96pt as
  // soon as it was moved. Size the box SNUGLY to the text instead, and the
  // firmware's own fit reproduces exactly the fontSize we asked for.
  const text = clip.text!.trim();
  const LINE = 5 / 3; // box height consumed per line, per fontSize unit
  const perLine = Math.max(8, Math.floor(w / (fontSize * 0.55))); // rough advance width
  const lines = Math.max(
    1,
    text.split('\n').reduce((n, ln) => n + Math.max(1, Math.ceil(ln.length / perLine)), 0),
  );
  // Snug, but never taller than the page: past that the box would hang off the
  // bottom (top clamps to 20 while the height keeps growing). When a clip is too
  // long to fit at the chosen size, the firmware's own fit shrinks the text to
  // the box, which is what we want here.
  const h = Math.min(Math.round(lines * fontSize * LINE), pageH - 40);
  const left = Math.max(20, Math.round((pageW - w) / 2)); // centre on the page
  const top = Math.max(20, Math.round((pageH - h) / 2));
  const textRect = {left, top, right: left + w, bottom: top + h};
  const r0: any = await PluginNoteAPI.insertText({
    textContentFull: text,
    textRect,
    fontSize,
    ...(fontPath ? {fontPath} : {}),
    textAlign: 0,
    textFrameWidthType: 0,
    textFrameStyle: 0,
    textEditable: 0,
  });
  if (!(r0 && r0.success)) return false;
  await save();
  await recommitLastElement(
    el => (el.type === 500 || el.type === 501 || el.type === 502) && el.textBox,
    el => ({textBox: {...el.textBox, textRect, fontSize, textFrameWidthType: 0, ...(fontPath ? {fontPath} : {})}}),
    'text',
  );
  return true;
}

/** Insert `src` as a Picture and force it onto an explicit rect. With `fixed`
 *  the picture is placed there verbatim (used for the twin); otherwise the rect
 *  comes from the inserted picture's natural size: aspect kept, fitted to the
 *  page, and never upscaled past the source PNG (upscaling past the source
 *  crashes the note app's OpenCV resize). */
async function placeImage(
  src: string,
  clip: Clip,
  pageSize: {width: number; height: number},
  fixed?: Rect,
): Promise<{inserted: boolean; rect: Rect | null}> {
  const pageW = (pageSize && pageSize.width) || 1404;
  const pageH = (pageSize && pageSize.height) || 1872;
  const r0: any = await PluginNoteAPI.insertImage(src);
  if (!(r0 && r0.success)) return {inserted: false, rect: null};
  await save();
  let rect: Rect | null = fixed ?? null;
  await recommitLastElement(
    el => el.type === 200 && el.picture && el.picture.rect,
    async el => {
      const r = el.picture.rect;
      const natW = r.right - r.left;
      const natH = r.bottom - r.top;
      if (natW <= 0 || natH <= 0) return null;
      if (fixed) {
        rect = fixed;
      } else {
        // Keep aspect, fit the page, and never upscale past the source PNG:
        // asking the note to draw an image larger than its bitmap crashes its
        // OpenCV resize.
        const srcW = clip.w || natW;
        const scale = Math.min(1, (pageW - 160) / natW, (pageH * 0.7) / natH, srcW / natW);
        const w = Math.max(1, Math.round(natW * scale));
        const h = Math.max(1, Math.round(natH * scale));
        const left = Math.max(20, Math.round((pageW - w) / 2));
        const top = Math.max(20, Math.round((pageH - h) / 2));
        rect = {left, top, right: left + w, bottom: top + h};
      }
      // The app drops the backing PNG after a save; restore it or the write fails.
      const picturePath = el.picture.picturePath;
      if (picturePath) {
        try {
          const exists = await DashboardNative?.fileExists?.(picturePath);
          if (!exists) await DashboardNative?.copyFile?.(src, picturePath);
        } catch {
          /* best-effort */
        }
      }
      return {picture: {...el.picture, rect}};
    },
    'image',
  );
  return {inserted: true, rect};
}

/**
 * Paste a handwriting clip as an image, inserted TWICE and exactly superimposed.
 *
 * Why twice: measured on a Manta, when a lasso selection contains a SINGLE
 * picture the note app treats the lasso box as that picture's resize frame, so
 * merely dragging it rewrites its rect and the image loses a few percent every
 * move (unreadable after 4-5). The moment the selection holds more than one
 * element the app only translates the group, which is why handwriting (dozens of
 * strokes) never suffers. A pixel-identical second copy is invisible and makes
 * the selection a group whatever the user lassos. This is a firmware workaround,
 * not a preference, so it is ALWAYS on.
 */
async function insertLockedImage(clip: Clip, pageSize: {width: number; height: number}): Promise<boolean> {
  const first = await placeImage(clip.png, clip, pageSize);
  if (!first.inserted) return false;
  // Only twin when we know the exact rect: a misaligned copy would be visible.
  if (first.rect) await placeImage(clip.png, clip, pageSize, first.rect);
  return true;
}

/** Pixel rect of the just-inserted element (Picture OR text box), read back via
 *  getLastElement, so the backlink can sit right under it. Returns null if it
 *  can't be determined. */
async function lastElementRectPx(pageSize: {width: number; height: number}): Promise<Rect | null> {
  try {
    const el: any = unwrapR(await PluginFileAPI.getLastElement());
    const pageW = (pageSize && pageSize.width) || 1404;
    const pageH = (pageSize && pageSize.height) || 1872;
    let out: Rect | null = null;
    const pic = el && el.picture && el.picture.rect;
    const tb = el && el.textBox && el.textBox.textRect;
    if (pic && typeof pic.left === 'number') {
      // Empirically getLastElement returns Picture.rect in PIXELS (verified on
      // Manta: a 640-wide clip reported right-left=640 on a 1920px page), even
      // though the SDK types label it EMR. Use it directly when it fits the page;
      // only fall back to an EMR conversion if the values overflow pixel space.
      if (pic.right <= pageW * 1.05 && pic.bottom <= pageH * 1.05) {
        out = {left: pic.left, top: pic.top, right: pic.right, bottom: pic.bottom};
      } else {
        const tl = PointUtils.emrPoint2Android({x: pic.left, y: pic.top}, pageSize as any);
        const br = PointUtils.emrPoint2Android({x: pic.right, y: pic.bottom}, pageSize as any);
        out = {left: Math.min(tl.x, br.x), top: Math.min(tl.y, br.y), right: Math.max(tl.x, br.x), bottom: Math.max(tl.y, br.y)};
      }
    } else if (tb && typeof tb.left === 'number') {
      out = {left: tb.left, top: tb.top, right: tb.right, bottom: tb.bottom}; // text boxes use pixel coords
    }
    try {
      el && el.recycle && el.recycle();
    } catch {
      /* ignore */
    }
    return out;
  } catch {
    return null;
  }
}

/** Insert the "↩ source" text link. Placed just below the pasted image when we
 *  know where it landed, else at the page bottom. Big tap target for e-ink.
 *  Best-effort. `currentPath` is the note we're pasting INTO. */
async function insertBacklink(clip: Clip, targetPath: string, currentPath: string, effectivePage: number, pageSize: {width: number; height: number}, imgRect: Rect | null): Promise<void> {
  try {
    const pageW = (pageSize && pageSize.width) || 1404;
    const pageH = (pageSize && pageSize.height) || 1872;
    const label = '↩ ' + noteTitle(targetPath) + (effectivePage >= 0 ? ' p.' + (effectivePage + 1) : '');
    const h = 72; // taller = easier to tap on e-ink
    let left: number;
    let top: number;
    let w: number;
    if (imgRect) {
      left = Math.max(20, imgRect.left);
      top = Math.min(pageH - h - 10, imgRect.bottom + 8); // just under the image
      w = Math.min(pageW - left - 20, Math.max(360, imgRect.right - imgRect.left));
    } else {
      left = 80;
      top = Math.max(80, pageH - 140);
      w = Math.min(pageW - left * 2, 900);
    }
    // Same note as the clip's source → note-page link (linkType 0); a different
    // note → note-file link (linkType 1). A note-file link (1) refuses to jump
    // within the current file, and a note-page link (0) is the same-file form.
    const sameNote = !!currentPath && currentPath === targetPath;
    // Page conventions differ by link type (both verified on device):
    //  - linkType 0 (note page, same file): 0-based, like openFile.
    //  - linkType 1 (note file, other note): 1-based (passing the 0-based value
    //    landed one page early).
    // effectivePage is the CURRENT index (PAGEID-resolved), so a re-paste after
    // the source moved still anchors to the right page.
    const destPage = effectivePage < 0 ? 0 : sameNote ? effectivePage : effectivePage + 1;
    await PluginNoteAPI.insertTextLink({
      linkType: sameNote ? 0 : 1,
      destPath: targetPath,
      destPage,
      // A cross-note (linkType 1) link ignores the numeric destPage (opens the
      // note at its last-viewed page). The stable page ID is what the firmware
      // uses to jump AND follow reorder, so pass it through: the field is
      // commented-out in the SDK model but insertTextLink allows unknown keys,
      // so it reaches native. Harmless if ignored (destPage stays the fallback).
      ...(clip.sourcePageId ? {destPageId: clip.sourcePageId} : {}),
      style: 0, // solid underline
      rect: {left, top, right: left + w, bottom: top + h},
      fontSize: 40, // bigger, easier to tap
      fullText: label,
      showText: label,
      isItalic: 0,
    } as any);
  } catch {
    /* backlink is best-effort */
  }
}

/** Bounding rect (page pixels) of the elements added since the `before` set of
 *  numInPage, so the backlink can sit under a pasted sticker. insertSticker lands
 *  its content as strokes/pictures/etc. with no single rect, so we diff the page.
 *  Strokes are EMR (rotated 90° + x-flipped), converted with each element's own
 *  maxX/maxY; pictures/text/geometry are already pixels. null if nothing new. */
async function newElementsRect(path: string, page: number, pageSize: {width: number; height: number}, before: Set<number>): Promise<Rect | null> {
  const W = (pageSize && pageSize.width) || 0;
  const H = (pageSize && pageSize.height) || 0;
  const els: any[] = unwrapR(await PluginFileAPI.getElements(page, path)) ?? [];
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  const add = (x: number, y: number) => {
    if (x < x1) x1 = x;
    if (y < y1) y1 = y;
    if (x > x2) x2 = x;
    if (y > y2) y2 = y;
  };
  try {
    let scanned = 0;
    for (const e of els) {
      if (!e || (typeof e.numInPage === 'number' && before.has(e.numInPage))) continue;
      if (e.type === 200 && e.picture?.rect) {
        const r = e.picture.rect;
        add(r.left, r.top);
        add(r.right, r.bottom);
      } else if ((e.type === 500 || e.type === 501 || e.type === 502) && e.textBox?.textRect) {
        const r = e.textBox.textRect;
        add(r.left, r.top);
        add(r.right, r.bottom);
      } else if (e.type === 700 && Array.isArray(e.geometry?.points)) {
        for (const p of e.geometry.points) add(p.x, p.y);
      } else if (e.type === 0 && e.stroke?.points && W && H && scanned < 400) {
        const maxX = e.maxX || 0;
        const maxY = e.maxY || 0;
        if (!maxX || !maxY) continue;
        scanned++;
        try {
          const acc = e.stroke.points;
          const n = await acc.size();
          if (!n) continue;
          const pts: any[] = await acc.getRange(0, Math.min(n, 64));
          for (const p of pts) add(W - (p.y / maxY) * W, (p.x / maxX) * H);
        } catch {
          /* skip stroke */
        }
      }
    }
  } finally {
    for (const e of els) {
      try {
        e && e.recycle && e.recycle();
      } catch {}
    }
  }
  return isFinite(x1) ? {left: x1, top: y1, right: x2, bottom: y2} : null;
}

/** Paste the clip's .sticker (native ink) via insertSticker, into the current page.
 *  Returns {ok, rect}: rect is the bounding box of the pasted ink (for the
 *  backlink). ok:false when there's no sticker (older clips) so the caller falls
 *  back to the PNG. */
async function insertStickerClip(clip: Clip, path: string, page: number, pageSize: {width: number; height: number}): Promise<{ok: boolean; rect: Rect | null}> {
  const sticker = clip.png.replace(/\.png$/i, '.sticker');
  try {
    const exists = await DashboardNative?.fileExists?.(sticker);
    if (!exists) {
      plog('no .sticker for clip; falling back to image');
      return {ok: false, rect: null};
    }
    // Snapshot the page's element ids so we can find what the sticker adds.
    const before = new Set<number>();
    try {
      const els0: any[] = unwrapR(await PluginFileAPI.getElements(page, path)) ?? [];
      for (const e of els0) {
        if (typeof e?.numInPage === 'number') before.add(e.numInPage);
        try {
          e && e.recycle && e.recycle();
        } catch {}
      }
    } catch {
      /* best-effort */
    }
    const r: any = await PluginCommAPI.insertSticker(sticker);
    const ok = r === true || !!(r && r.success);
    plog(`insertSticker ok=${ok}`);
    if (!ok) return {ok: false, rect: null};
    await save();
    let rect: Rect | null = null;
    try {
      rect = await newElementsRect(path, page, pageSize, before);
    } catch {
      /* backlink just falls back to page bottom */
    }
    plog(`sticker rect=${rect ? `[${rect.left | 0},${rect.top | 0},${rect.right | 0},${rect.bottom | 0}]` : 'null'}`);
    return {ok: true, rect};
  } catch (e: any) {
    plog(`insertSticker threw: ${e && e.message}`);
    return {ok: false, rect: null};
  }
}

/** Paste a clip into the currently-open note (+ a link back to its source).
 *  `preferText` (from the block's display mode) inserts an editable text box when
 *  the clip has OCR text; otherwise the clip is pasted as an image. */
export async function pasteClip(clip: Clip, preferText = !!(clip.text && clip.text.trim())): Promise<void> {
  try {
    const path = unwrapR(await PluginCommAPI.getCurrentFilePath());
    if (!path || !/\.note$/i.test(path)) {
      ToastAndroid.show('Open a note first, then paste', ToastAndroid.LONG);
      return;
    }

    const pageSize = unwrapR(await PluginCommAPI.getPageDisplaySize()) || {width: 1404, height: 1872};
    const asText = preferText && !!(clip.text && clip.text.trim());
    let cfg: any = null;
    try {
      cfg = await loadConfig();
    } catch {
      /* defaults */
    }

    // OCR clip → editable text box. A handwriting clip → native sticker ink when we
    // have one (insertSticker), falling back to the twin-image paste otherwise.
    const pageNum = (unwrapR(await PluginCommAPI.getCurrentPageNum()) as number) ?? 0;
    let ok: boolean;
    let anchorRect: Rect | null = null;
    if (asText) {
      ok = await insertLockedText(clip, pageSize, cfg);
    } else {
      const s = await insertStickerClip(clip, path, pageNum, pageSize);
      if (s.ok) {
        ok = true;
        anchorRect = s.rect; // the sticker's own bbox (getLastElement can't see it)
      } else {
        ok = await insertLockedImage(clip, pageSize);
      }
    }
    if (!ok) {
      ToastAndroid.show('Paste failed', ToastAndroid.SHORT);
      return;
    }

    // Commit first: on some firmware getLastElement only returns the freshly
    // inserted element after a save.
    await save();

    // Find where it landed so the backlink can sit right under it (the sticker
    // path already computed its rect; image/text read it back here).
    if (!anchorRect) anchorRect = await lastElementRectPx(pageSize);
    // Resolve the source NOW (follow its PAGEID across reorder AND a move to
    // another note), so a re-paste points at the current note+page, not the
    // capture-time path/number. Self-heal the clip when the page has moved.
    const t = await resolveClipTarget(clip.sourcePath, clip.sourcePageId, clip.sourcePage);
    if (t.moved) await updateClipSource(clip.id, t.path, t.page).catch(() => {});
    // The backlink can be turned off (clipBacklink: false) to paste a bare image.
    if (cfg?.clipBacklink !== false) await insertBacklink(clip, t.path, path, t.page, pageSize, anchorRect);

    // Persist the backlink. Deliberately NO reloadFile(): it re-fits a Picture's
    // geometry, and the reference image plugins don't call it either.
    await save();
    ToastAndroid.show('✓ Pasted into note', ToastAndroid.SHORT);
    // Leave the Dashboard so the user lands back on the note and sees the paste.
    leavePlugin();
  } catch (e: any) {
    ToastAndroid.show(`Paste error: ${e && e.message}`, ToastAndroid.SHORT);
  }
}
