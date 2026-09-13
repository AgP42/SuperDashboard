/**
 * SuperDashboard: a configurable, always-available dashboard for Supernote.
 * The bubble (⊕) floats over everything; tap expands the dashboard.
 * @format
 */

import {AppRegistry, AppState, DeviceEventEmitter, Image, NativeModules, ToastAndroid} from 'react-native';
import App from './App';
import {name as appName} from './app.json';

import {PluginManager, PluginCommAPI, PluginNoteAPI} from 'sn-plugin-lib';
import {setRoute} from './src/route';
import {showBubbleFromConfig} from './src/bubble';
import {hasSavedConfig, loadConfig} from './src/config';
import {ensureFilePermissions} from './src/permissions';
import {addClip, clipId, nextMarkNum, updateClipText} from './src/clips';
import {detectUnderlineLabels} from './src/underline';
import {pageIdAt} from './src/notepage';
import {cacheDir} from './src/paths';
import {DIGITAL_FONT, DSEG7_BOLD_B64} from './src/fonts/dseg7';

const {DashboardNative} = NativeModules;

// On-device tracing for the bubble lifecycle. The firmware doesn't log window
// removals and hideBubble() is silent, so without this the only way to know why
// the bubble vanished is guesswork (we guessed wrong twice). Timestamped;
// appendLog caps the file at 256 KB.
function blog(msg) {
  const t = new Date();
  const p = n => String(n).padStart(2, '0');
  DashboardNative?.appendLog?.(`${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())} ${msg}`).catch(() => {});
}

AppRegistry.registerComponent(appName, () => App);

PluginManager.init();

// Register the bundled DSEG7 7-segment face (Clock "Digital" style) as a RN
// fontFamily. Process-global via ReactFontManager, so one call at load covers
// both the dashboard and the Settings preview. Best-effort: on failure the
// Digital clock falls back to monospace.
DashboardNative?.registerFontBase64?.(DSEG7_BOLD_B64, DIGITAL_FONT).catch(() => {});

// The bubble is a pure function of whether the plugin view is REALLY on screen,
// and AppState is the OS-level truth for that. (measureInWindow only sees
// layout, which persists on the kept-mounted dashboard view even when it is not
// visible; that stale read hid the bubble whenever showPluginView() silently
// failed to surface, losing the bubble with no dashboard.) View foreground →
// hide the bubble; not foreground → restore it (no-op when mode 'off'). This
// self-heals every exit path (buttons, system gesture, host backgrounding) and
// a failed tap simply keeps the bubble since the view never becomes active.
let lastState = AppState.currentState;
let activeSince = 0;
blog(`[state] initial=${lastState}`);
AppState.addEventListener('change', next => {
  const now = Date.now();
  blog(`[state] ${lastState} -> ${next}`);
  if (next === 'active') {
    activeSince = now;
    blog('[bub] hide (view active)');
    DashboardNative?.hideBubble?.().catch(() => {});
  } else {
    // A view that goes active→background in under 1.5 s is the "won't open"
    // symptom: the view surfaced then was closed by an external actor (the
    // Dashboard never closes its own view outside its buttons). Flag it so the
    // next occurrence is unambiguous in the log.
    const dwell = lastState === 'active' && activeSince ? now - activeSince : -1;
    if (dwell >= 0 && dwell < 1500) blog(`[warn] PARASITE close after ${dwell}ms`);
    showBubbleFromConfig()
      .then(ok => blog(`[bub] restore (view ${next}) = ${ok}`))
      .catch(() => {});
  }
  lastState = next;
});

// Clear any bubble left over in the persistent PluginHost process from a
// previous plugin classloader (reinstall/reload → new classloader → stale
// static ref), THEN restore the bubble from config: the bubble dies with the
// PluginHost process (reboot, auto power off, crash) and nothing else brings
// it back. 'off' mode stays off. Sequenced so the cleanup can't race the
// freshly shown bubble away.
(async () => {
  try {
    await DashboardNative?.clearAllBubbles();
  } catch (e) {}
  // Chauvet plugin-preview firmware enforces FILE:READ even on raw java.io: the
  // very next step (showBubbleFromConfig → loadConfig → readTextFile) reads
  // MyStyle, and the launcher's scans read Note/Document. Request the file
  // permissions BEFORE that first read so it isn't silently denied. A denial is
  // fine: loadConfig falls back to defaults and the launcher (apps, shortcuts,
  // intent opening) stays usable; only stars/keywords/recent/config-persist need it.
  const perm = await ensureFilePermissions().catch(() => false);
  blog(`[perm] ensureFilePermissions = ${perm}`);
  const ok = await showBubbleFromConfig().catch(() => false);
  blog(`[bub] load restore = ${ok}`);
})();

// PluginHost keeps every past version's files on reinstall (the plugin's size
// balloons over time). We run in its process, so reclaim old versions on load.
(async () => {
  try {
    const dir = await PluginManager.getPluginDirPath();
    if (dir) await DashboardNative?.cleanupOldVersions(dir);
  } catch (e) {}
})();

// Two entry points → two surfaces:
//  - toolbar button → Config
//  - bubble tap → Dashboard
// Module-level listeners survive plugin-view close (component listeners don't).
DeviceEventEmitter.addListener('onBubbleTap', async () => {
  setRoute('dashboard');
  // Ask for the view; the bubble is NOT touched here. If the view actually
  // surfaces, AppState → 'active' hides it; if showPluginView lies (returns
  // true without surfacing), AppState never flips and the bubble stays for a
  // second tap. showPluginView's own return is logged but never trusted.
  let shown;
  try {
    shown = await PluginManager.showPluginView();
  } catch (e) {
    shown = `err:${e && e.message}`;
  }
  blog(`[bub] tap -> showPluginView=${shown}`);
});
// Chauvet removed addPluginLifeListener({onStart,onStop}) → registerPluginLifeListener
// with a single onMsg(msg). msg.state runs 0..5 = init, mount, start, pause,
// unmount, DESTROY. state 5 (destroy) is the "the plugin is being removed / torn
// down for good" signal plugins never had before. Normal open/close only emits
// start/pause (2/3); destroy fires on uninstall/disable; so we use it as the
// long-wanted onRemove: clear any floating bubble this plugin left in the
// persistent PluginHost process, so removing the plugin no longer strands a bubble
// (users previously had to set the bubble Off first, or reboot). clearAllBubbles is
// process-wide but only removes views tagged as OURS, so it can't touch other plugins.
PluginManager.registerPluginLifeListener({
  onMsg(msg) {
    const state = msg && msg.state;
    blog(`[life] state=${state}`);
    if (state === 5) {
      blog('[life] destroy → clearing our bubble');
      DashboardNative?.clearAllBubbles?.().catch(() => {});
    }
  },
});

const TOOLBAR_BTN = 100;
const LASSO_BTN = 200;
const LASSO_TODO_BTN = 201;

// ---- Note Clips: lasso → "Add to Dashboard" (headless capture) ------------
// Native pen colours for the optional capture frame (dark grey / black).
const FRAME_PEN = {black: 0x00, grey: 0x9d};
// Side (page pixels) of the tick-box drawn beside a to-do's frame. Constant on
// purpose: it is how the box is recognised on the page later.
const TODO_BOX_SIDE = 44;

/** Unwrap the SDK APIResponse shape. */
function unwrapR(r) {
  return r && r.success ? r.result : undefined;
}

/** Fit a size within `max` on its longest edge (keeps aspect). */
function capSize(sz, max) {
  const m = Math.max(sz.width, sz.height);
  if (m <= max) return {width: Math.round(sz.width), height: Math.round(sz.height)};
  const k = max / m;
  return {width: Math.max(1, Math.round(sz.width * k)), height: Math.max(1, Math.round(sz.height * k))};
}

/** Draw a thin rectangle on the note around the captured area (a single geometry). */
async function drawGeoBox(penColor, left, top, right, bottom, penWidth = 200) {
  await PluginCommAPI.insertGeometry({
    penColor,
    penType: 10, // fineliner
    penWidth, // schema minimum is 100
    type: 'GEO_polygon',
    points: [
      {x: left, y: top},
      {x: right, y: top},
      {x: right, y: bottom},
      {x: left, y: bottom},
      {x: left, y: top},
    ],
    showLassoAfterInsert: false,
  });
}

async function drawGeoLine(penColor, x1, y1, x2, y2, penWidth) {
  await PluginCommAPI.insertGeometry({
    penColor,
    penType: 10,
    penWidth,
    type: 'straightLine',
    points: [{x: x1, y: y1}, {x: x2, y: y2}],
    showLassoAfterInsert: false,
  });
}

/**
 * Mark the captured area on the note: a rectangle for a clip, and for a to-do the
 * same rectangle plus a small empty TICK-BOX straddling its top-left corner, so
 * the two kinds are distinguishable on paper.
 *
 * Returns the uuid of the last geometry inserted (read straight back), which is a
 * stable handle on the mark even after the user moves it — position is not.
 */
async function drawClipFrame(rect, style, kind, markNum) {
  if (!rect) return null;
  const outerColor = FRAME_PEN[style]; // undefined when style === 'off'
  try {
    // Outer rectangle around the captured area, only when a frame style is set.
    if (outerColor != null) await drawGeoBox(outerColor, rect.left, rect.top, rect.right, rect.bottom);
    if (kind !== 'todo') return null;
    // A to-do ALWAYS gets its tick-box + "#N" — that pair IS the note<->dashboard
    // handle, independent of the clip-frame preference. Use black if no frame color.
    const penColor = outerColor != null ? outerColor : FRAME_PEN.black;
    const side = TODO_BOX_SIDE;
    const m = 4;
    // Clamp the box center on-page: near the top-left edge rect.left/top can be
    // < side/2, which would push the box (and label) to negative coords.
    const cx = Math.max(side / 2 + m, rect.left);
    const cy = Math.max(side / 2 + m, rect.top);
    const box = {left: cx - side / 2, top: cy - side / 2, right: cx + side / 2, bottom: cy + side / 2};
    await drawGeoBox(penColor, box.left, box.top, box.right, box.bottom);
    const off = 4; // heavier right+bottom edge = a "raised button" not drawn by hand
    await drawGeoLine(penColor, box.right + off, box.top + off, box.right + off, box.bottom + off, 600);
    await drawGeoLine(penColor, box.left + off, box.bottom + off, box.right + off, box.bottom + off, 600);
    // "#N" label — the durable handle (uuids are regenerated on every read). If it
    // fails to insert, the to-do would have no findable handle, so report failure
    // (return null) rather than store a mark we can never locate again.
    const fs = 28;
    const h = Math.round(fs * (5 / 3));
    const left = box.right + 10;
    const top = Math.max(m, Math.round(cy - h / 2));
    try {
      const r = await PluginNoteAPI.insertText({
        textContentFull: `#${markNum}`,
        textRect: {left, top, right: left + 110, bottom: top + h},
        fontSize: fs,
        textAlign: 0,
        textFrameWidthType: 0,
        textFrameStyle: 0,
        textEditable: 0,
      });
      if (!(r && r.success)) {
        blog(`[clip] mark label insert not ok`);
        return null;
      }
    } catch (e) {
      blog(`[clip] mark label failed: ${e && e.message}`);
      return null;
    }
    return box;
  } catch (e) {
    blog(`[clip] drawFrame failed: ${e && e.message}`);
    return null;
  }
}
/** Save the current lasso selection as an image clip, backlinked to its page.
 *  Headless: no plugin view is opened (frictionless collection). */
async function handleLassoToClip(kind) {
  // `els` (the captured strokes) are kept alive for the underline-label OCR and
  // the OPTIONAL background OCR, then freed EXACTLY ONCE on every exit path via
  // recycleEls() (recognizeElements is element-based, so it still works on them
  // after the lasso is dismissed). Declared at function scope so the catch can
  // free them too.
  let els = [];
  let elsRecycled = false;
  const recycleEls = () => {
    if (elsRecycled) return;
    elsRecycled = true;
    for (const e of els) {
      try {
        e && e.recycle && e.recycle();
      } catch {}
    }
  };
  try {
    await ensureFilePermissions();
    const path = unwrapR(await PluginCommAPI.getCurrentFilePath());
    if (!path || !/\.note$/i.test(path)) {
      ToastAndroid.show('Open a note to clip', ToastAndroid.SHORT);
      return;
    }
    // getCurrentPageNum and openFile share the firmware's page space, so we
    // round-trip the RAW value with no ±1 (SSN does the same). A conversion here
    // is what put the backlink one page early. -1 = "keep last-viewed" fallback.
    const pageRaw = unwrapR(await PluginCommAPI.getCurrentPageNum());
    const page = typeof pageRaw === 'number' ? pageRaw : -1;
    const elR = await PluginCommAPI.getLassoElements();
    els = elR && elR.success ? elR.result : [];
    if (!els || els.length === 0) {
      ToastAndroid.show('Nothing selected', ToastAndroid.SHORT);
      return;
    }
    // Load config once (clip content mode + frame) and the page size (reused by
    // the OCR pass and the underline-label detector).
    let cfg = null;
    try {
      cfg = await loadConfig();
    } catch {}
    let ps = null;
    try {
      ps = unwrapR(await PluginCommAPI.getPageDisplaySize());
    } catch {}

    // Stable PAGEID of the source page (parsed from the .note file), so the
    // backlink can FOLLOW this page if it's later reordered/moved, instead of
    // sticking to the page number. After the "nothing selected" guard so an
    // empty mis-tap pays no file read. Best-effort: '' falls back to the number.
    let sourcePageId = '';
    try {
      sourcePageId = await pageIdAt(path, page);
    } catch {}

    // Optional auto-labels: each word the user underlined with the clean
    // straight-line tool becomes a label (three underlines → three labels). Runs
    // only when such a line is in the selection (otherwise instant no-op), and
    // must happen while the lasso is still active (before setLassoBoxState).
    let autoLabels = [];
    if (ps && ps.width) {
      try {
        autoLabels = await detectUnderlineLabels(ps, els);
      } catch (e) {
        blog(`[clip] underline: ${e && e.message}`);
      }
    }

    // Grab the lasso bounds BEFORE dismissing, whenever we'll draw on the note:
    // a clip only when a frame style is set, but a TO-DO always (its mark is drawn
    // regardless of the clip-frame preference).
    let frame = (cfg && cfg.clipFrame) || 'off';
    let rect = null;
    if (frame !== 'off' || kind === 'todo') {
      try {
        rect = unwrapR(await PluginCommAPI.getLassoRect());
      } catch (e) {
        blog(`[clip] getLassoRect: ${e && e.message}`);
      }
    }

    // Save the lasso as a sticker (official SDK), then a PNG thumbnail: private dir.
    const dir = await cacheDir();
    const id = clipId();
    const stickerPath = `${dir}clip_${id}.sticker`;
    const pngPath = `${dir}clip_${id}.png`;
    const sr = await PluginCommAPI.saveStickerByLasso(stickerPath);
    if (!(sr && sr.success)) {
      blog(`[clip] saveStickerByLasso failed: ${sr && sr.error && sr.error.message}`);
      ToastAndroid.show('Clip failed', ToastAndroid.SHORT);
      recycleEls();
      return;
    }
    let size = {width: 480, height: 320};
    try {
      const sz = unwrapR(await PluginCommAPI.getStickerSize(stickerPath));
      if (sz && sz.width) size = capSize(sz, 640);
    } catch (e) {
      blog(`[clip] getStickerSize: ${e && e.message}`);
    }
    await PluginCommAPI.generateStickerThumbnail(stickerPath, pngPath, size);
    // The .sticker was only an intermediate for the PNG; drop it. Pasting a clip
    // back into a note uses the PNG (insertImage → a normal Picture element):
    // the vector sticker path (insertSticker) squashes vertically on every
    // move/resize, so we deliberately paste raster instead.
    try {
      await DashboardNative?.pruneMatching?.(dir, `clip_${id}.sticker`, '');
    } catch {}

    // A to-do always gets a mark (its note<->dashboard handle), whatever the
    // clip-frame setting; a plain clip only gets the frame when the user enabled it.
    const frameStyle = kind === 'todo' && frame === 'off' ? 'grey' : frame;
    const markNum = kind === 'todo' && rect ? await nextMarkNum() : undefined;
    const boxRect = rect && (kind === 'todo' || frame !== 'off') ? await drawClipFrame(rect, frameStyle, kind, markNum) : null;
    // If the mark couldn't be drawn (e.g. label insert failed), don't persist a
    // dangling markNum with no handle on the page.
    const savedMarkNum = boxRect ? markNum : undefined;
    try {
      await PluginCommAPI.setLassoBoxState(2); // dismiss the lasso (keeps the handwriting)
    } catch (e) {
      blog(`[clip] setLassoBoxState: ${e && e.message}`);
    }

    // Store the clip's real pixel size so the dashboard renders it at natural
    // size (never upscaled larger than the original extract). Added WITHOUT text
    // first, so the clip appears immediately and the user has control back; the
    // optional OCR (below) fills the text in a moment later.
    await addClip({
      id,
      png: pngPath,
      sourcePath: path,
      sourcePage: page,
      sourcePageId: sourcePageId || undefined,
      w: size.width,
      h: size.height,
      labels: autoLabels,
      kind,
      ...(kind === 'todo' ? {done: false} : {}),
      ...(boxRect ? {boxRect} : {}),
      ...(typeof savedMarkNum === 'number' ? {markNum: savedMarkNum} : {}),
      createdAt: Date.now(),
    });
    blog(`[clip] added ${kind} ${id} from ${path} p.${page}${autoLabels.length ? ` labels="${autoLabels.join(', ')}"` : ''}`);
    ToastAndroid.show(autoLabels.length ? `✓ Added · ${autoLabels.join(', ')}` : '✓ Added to Dashboard', ToastAndroid.SHORT);

    // Background OCR (opt-in): control is already back with the user (toast
    // shown, lasso dismissed). Recognize the CAPTURED strokes (the snapshot, not
    // the source note), store the text so the dashboard shows/pastes it as text.
    // Empty/failed OCR leaves the clip as an image (fallback, like Stars 'text').
    // If OCR is off, just free the held elements now.
    if (cfg && cfg.clipText === 'ocr' && ps && ps.width) {
      (async () => {
        try {
          const SHAPES = [700, 800]; // drop geometry + five-star so a stray line can't suppress text
          const textEls = els.filter(e => e && !SHAPES.includes(e.type));
          if (textEls.length) {
            const r = await PluginCommAPI.recognizeElements(textEls, ps);
            const txt = r && r.success ? (r.result || '').trim() : '';
            if (txt) {
              await updateClipText(id, txt);
              DeviceEventEmitter.emit('dashboard_refresh_all'); // if the dashboard is open, swap to text
              blog(`[clip] ocr ok ${id} (${txt.length} chars) "${txt.slice(0, 80)}"`);
            } else {
              blog(`[clip] ocr empty ${id} -> image fallback`);
            }
          }
        } catch (e) {
          blog(`[clip] ocr: ${e && e.message}`);
        } finally {
          recycleEls();
        }
      })();
    } else {
      recycleEls();
    }
  } catch (e) {
    blog(`[clip] err: ${e && e.message}`);
    ToastAndroid.show(`Clip error: ${e && e.message}`, ToastAndroid.SHORT);
    recycleEls();
  }
}

PluginManager.registerButton(1, ['NOTE', 'DOC'], {
  id: TOOLBAR_BTN,
  name: 'SuperDashboard',
  icon: Image.resolveAssetSource(require('./assets/icon.png')).uri,
  showType: 1,
});

// Lasso toolbar button (NOTE only; DOC/PDF has no lasso plugin slot). showType:0
// = headless: we capture in onButtonPress without opening the plugin view.
PluginManager.registerButton(2, ['NOTE'], {
  id: LASSO_BTN,
  name: 'Dashboard Clip',
  icon: Image.resolveAssetSource(require('./assets/icon.png')).uri,
  // Lasso data types that KEEP this button enabled: 0=stroke, 1=title,
  // 2=picture, 3=text, 4=link, 5=geometry. The firmware greys the button out if
  // the selection contains ANY type not listed here, so geometry (5) is
  // required: without it a selection that includes a shape/line (e.g. the clean
  // underline used for auto-labels) disables "Add to Dashboard".
  editDataTypes: [0, 1, 2, 3, 4, 5],
  showType: 0,
});

// Same capture, filed as a task instead of a reference.
PluginManager.registerButton(2, ['NOTE'], {
  id: LASSO_TODO_BTN,
  name: 'Dashboard To-do',
  icon: Image.resolveAssetSource(require('./assets/icon.png')).uri,
  editDataTypes: [0, 1, 2, 3, 4, 5],
  showType: 0,
});

PluginManager.registerButtonListener({
  // Lasso button → capture a clip headlessly. Toolbar button → Dashboard (or the
  // Settings wizard on first open, where no config was ever saved).
  onButtonPress(e) {
    if (e && (e.id === LASSO_BTN || e.id === LASSO_TODO_BTN)) {
      handleLassoToClip(e.id === LASSO_TODO_BTN ? 'todo' : 'clip');
      return;
    }
    blog('[btn] toolbar pressed');
    (async () => {
      let saved = false;
      try {
        saved = await hasSavedConfig();
      } catch (err) {
        blog(`[btn] hasSavedConfig error: ${err && err.message}`);
      }
      blog(`[btn] hasSavedConfig=${saved} -> route=${saved ? 'dashboard' : 'config'}`);
      setRoute(saved ? 'dashboard' : 'config');
    })();
  },
});
