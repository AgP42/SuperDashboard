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
import {ToastAndroid} from 'react-native';
import {PluginCommAPI, PluginFileAPI, PluginNoteAPI, PointUtils} from 'sn-plugin-lib';

import {Clip, updateClipSource} from './clips';
import {leavePlugin} from './bubble';
import {noteTitle} from './scanner';
import {resolveClipTarget} from './notepage';
import {loadConfig} from './config';

type Rect = {left: number; top: number; right: number; bottom: number};

/** Unwrap the SDK APIResponse shape. */
function unwrapR(r: any) {
  return r && r.success ? r.result : undefined;
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

    // OCR clip → editable text box (insertText, positioned via textRect); a
    // handwriting clip → image (insertImage). Both target the current page.
    let ok = false;
    if (asText) {
      let fontSize = 36;
      let fontPath = '';
      try {
        const c = await loadConfig();
        if (c && typeof c.clipFontSize === 'number') fontSize = c.clipFontSize;
        if (c && typeof c.clipFontPath === 'string') fontPath = c.clipFontPath;
      } catch {
        /* default */
      }
      const pageW = (pageSize && pageSize.width) || 1404;
      const pageH = (pageSize && pageSize.height) || 1872;
      const w = Math.min(pageW - 200, 1000);
      const h = Math.max(fontSize * 4, 160);
      // Centre the text box on the page, like the firmware centres a pasted image.
      const left = Math.max(20, Math.round((pageW - w) / 2));
      const top = Math.max(20, Math.round((pageH - h) / 2));
      const r: any = await PluginNoteAPI.insertText({
        textContentFull: clip.text!.trim(),
        textRect: {left, top, right: left + w, bottom: top + h},
        fontSize,
        ...(fontPath ? {fontPath} : {}), // MyStyle font for the pasted text box (else the note default)
        textAlign: 0,
        // FIXED width (0), not auto (1): with auto width the box must measure the
        // text before it can size itself, and that measurement only happens at
        // the first relayout (a user move) — so the text renders tiny until then.
        // A fixed rect makes it render at the chosen fontSize straight away.
        textFrameWidthType: 0,
        textFrameStyle: 0, // no border
        textEditable: 0, // 0 = editable
      });
      ok = !!(r && r.success);
    } else {
      const r: any = await PluginNoteAPI.insertImage(clip.png);
      ok = !!(r && r.success);
    }
    if (!ok) {
      ToastAndroid.show('Paste failed', ToastAndroid.SHORT);
      return;
    }

    // Commit first: on some firmware getLastElement only returns the freshly
    // inserted element after a save.
    try {
      await PluginNoteAPI.saveCurrentNote();
    } catch {
      /* best-effort */
    }

    // Find where it landed so the backlink can sit right under it.
    const anchorRect = await lastElementRectPx(pageSize);
    // Resolve the source NOW (follow its PAGEID across reorder AND a move to
    // another note), so a re-paste points at the current note+page, not the
    // capture-time path/number. Self-heal the clip when the page has moved.
    const t = await resolveClipTarget(clip.sourcePath, clip.sourcePageId, clip.sourcePage);
    if (t.moved) await updateClipSource(clip.id, t.path, t.page).catch(() => {});
    await insertBacklink(clip, t.path, path, t.page, pageSize, anchorRect);

    // Persist the backlink. Deliberately NO reloadFile(): the reference image
    // plugins (embedimage, image-insert) insert with a bare insertImage and no
    // reload, and rely on plain lasso move/resize working. Our reloadFile() is
    // the prime suspect for re-fitting the picture geometry and causing it to
    // squash on subsequent moves, so we drop it and let the app persist normally.
    try {
      await PluginNoteAPI.saveCurrentNote();
    } catch {
      /* best-effort */
    }
    ToastAndroid.show('✓ Pasted into note', ToastAndroid.SHORT);
    // Leave the Dashboard so the user lands back on the note and sees the paste.
    leavePlugin();
  } catch (e: any) {
    ToastAndroid.show(`Paste error: ${e && e.message}`, ToastAndroid.SHORT);
  }
}
