/**
 * SuperDashboard: a configurable, always-available dashboard for Supernote.
 * The bubble (⊕) floats over everything; tap expands the dashboard.
 * @format
 */

import {AppRegistry, AppState, DeviceEventEmitter, Image, NativeModules, ToastAndroid} from 'react-native';
import App from './App';
import {name as appName} from './app.json';

import {PluginManager, PluginCommAPI} from 'sn-plugin-lib';
import {setRoute} from './src/route';
import {showBubbleFromConfig} from './src/bubble';
import {hasSavedConfig, loadConfig} from './src/config';
import {ensureFilePermissions} from './src/permissions';
import {addClip, clipId} from './src/clips';
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

// ---- Note Clips: lasso → "Add to Dashboard" (headless capture) ------------
// Native pen colours for the optional capture frame (dark grey / black).
const FRAME_PEN = {black: 0x00, grey: 0x9d};

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
async function drawClipFrame(rect, style) {
  const penColor = FRAME_PEN[style];
  if (penColor == null || !rect) return;
  try {
    await PluginCommAPI.insertGeometry({
      penColor,
      penType: 10, // fineliner
      penWidth: 200, // schema minimum is 100
      type: 'GEO_polygon',
      points: [
        {x: rect.left, y: rect.top},
        {x: rect.right, y: rect.top},
        {x: rect.right, y: rect.bottom},
        {x: rect.left, y: rect.bottom},
        {x: rect.left, y: rect.top},
      ],
      showLassoAfterInsert: false,
    });
  } catch (e) {
    blog(`[clip] drawFrame failed: ${e && e.message}`);
  }
}

/** Save the current lasso selection as an image clip, backlinked to its page.
 *  Headless: no plugin view is opened (frictionless collection). */
async function handleLassoToClip() {
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
    const els = elR && elR.success ? elR.result : [];
    if (!els || els.length === 0) {
      ToastAndroid.show('Nothing selected', ToastAndroid.SHORT);
      return;
    }
    for (const e of els) {
      try {
        e && e.recycle && e.recycle();
      } catch {}
    }

    // Optional frame: read the setting, and grab the bounds BEFORE dismissing.
    let frame = 'off';
    try {
      frame = (await loadConfig()).clipFrame || 'off';
    } catch {}
    let rect = null;
    if (frame !== 'off') {
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
    // The .sticker was only an intermediate; drop it, keep the PNG.
    try {
      await DashboardNative?.pruneMatching?.(dir, `clip_${id}.sticker`, '');
    } catch {}

    if (frame !== 'off' && rect) await drawClipFrame(rect, frame);
    try {
      await PluginCommAPI.setLassoBoxState(2); // dismiss the lasso (keeps the handwriting)
    } catch (e) {
      blog(`[clip] setLassoBoxState: ${e && e.message}`);
    }

    // Store the clip's real pixel size so the dashboard renders it at natural
    // size (never upscaled larger than the original extract).
    await addClip({id, png: pngPath, sourcePath: path, sourcePage: page, w: size.width, h: size.height, labels: [], createdAt: Date.now()});
    blog(`[clip] added ${id} from ${path} p.${page}`);
    ToastAndroid.show('✓ Added to Dashboard', ToastAndroid.SHORT);
  } catch (e) {
    blog(`[clip] err: ${e && e.message}`);
    ToastAndroid.show(`Clip error: ${e && e.message}`, ToastAndroid.SHORT);
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
  name: 'Add to Dashboard',
  icon: Image.resolveAssetSource(require('./assets/icon.png')).uri,
  editDataTypes: [0, 1, 2, 3, 4],
  showType: 0,
});

PluginManager.registerButtonListener({
  // Lasso button → capture a clip headlessly. Toolbar button → Dashboard (or the
  // Settings wizard on first open, where no config was ever saved).
  onButtonPress(e) {
    if (e && e.id === LASSO_BTN) {
      handleLassoToClip();
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
