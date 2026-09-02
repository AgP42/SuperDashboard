package com.dashboard;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.StatFs;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import java.io.File;
import java.util.List;

/**
 * Native bridge for the Dashboard plugin:
 *  - openNote / openFolder / launchActivity: open device targets by intent
 *  - listLaunchableApps: enumerate launchable apps for the Apps zone / config
 *  - overlay: the draggable floating bubble (tap→expand, long-press→close)
 *  - writeFile / appendLog: persistence & on-device logging (SDK has no writeFile)
 */
public class DashboardNativeModule extends ReactContextBaseJavaModule {
    private final Handler main = new Handler(Looper.getMainLooper());

    // Overlay state is static → one bubble per process; last position survives hide/show.
    private static WindowManager wm;
    private static View overlayView;
    private static WindowManager.LayoutParams overlayParams;
    private static int lastX = -1, lastY = -1;
    private int startX, startY;
    private float startRawX, startRawY;
    private boolean dragging;
    private static final String BUBBLE_TAG = "DASHBOARD_BUBBLE";

    public DashboardNativeModule(ReactApplicationContext ctx) {
        super(ctx);
    }

    @Override
    public String getName() {
        return "DashboardNative";
    }

    private void emit(String event, WritableMap payload) {
        getReactApplicationContext()
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                .emit(event, payload);
    }

    // ---- Intents ----------------------------------------------------------

    /** Open a .note in the editor at a 1-based page (page<=0 → last-used page). */
    @ReactMethod
    public void openNote(String path, int page, Promise promise) {
        try {
            Intent intent = new Intent();
            intent.setComponent(new ComponentName(
                    "com.ratta.supernote.note",
                    "com.ratta.supernote.note.view.NoteInsidePagesActivity"));
            intent.putExtra("file_path", path);
            if (page > 0) intent.putExtra("page", page);
            intent.setAction(Intent.ACTION_VIEW); // required or the file_path extra is ignored
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getReactApplicationContext().startActivity(intent);
            promise.resolve(true);
        } catch (Exception e) {
            promise.reject("OPEN_NOTE_FAILED", e.getClass().getSimpleName() + ": " + e.getMessage(), e);
        }
    }

    /**
     * Open a PDF/document in the Supernote Document viewer. Uses the `file_path`
     * extra (a raw file:// data URI throws FileUriExposedException). The `page`
     * extra is passed but currently appears ignored by the viewer (opens last page).
     */
    @ReactMethod
    public void openDocument(String path, int page, Promise promise) {
        try {
            Intent intent = new Intent();
            intent.setComponent(new ComponentName(
                    "com.supernote.document",
                    "com.supernote.document.MainActivity"));
            intent.putExtra("file_path", path);
            if (page > 0) intent.putExtra("page", page);
            intent.setAction(Intent.ACTION_VIEW);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getReactApplicationContext().startActivity(intent);
            promise.resolve(true);
        } catch (Exception e) {
            promise.reject("OPEN_DOC_FAILED", e.getClass().getSimpleName() + ": " + e.getMessage(), e);
        }
    }

    /** Open the file manager navigated into a folder. */
    @ReactMethod
    public void openFolder(String folderPath, Promise promise) {
        try {
            Intent intent = new Intent();
            intent.setComponent(new ComponentName(
                    "com.ratta.supernote.inbox",
                    "com.ratta.supernote.explorer.FileManagerMainActivity"));
            intent.putExtra("folder_path", folderPath);
            intent.putExtra("source_type", 2);
            intent.setAction(Intent.ACTION_VIEW);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getReactApplicationContext().startActivity(intent);
            promise.resolve(true);
        } catch (Exception e) {
            promise.reject("OPEN_FOLDER_FAILED", e.getClass().getSimpleName() + ": " + e.getMessage(), e);
        }
    }

    /** Launch any activity by "package/activity" component string (Apps zone). */
    @ReactMethod
    public void launchActivity(String component, Promise promise) {
        try {
            String[] parts = component.split("/", 2);
            Intent intent = new Intent();
            intent.setComponent(new ComponentName(parts[0], parts[1]));
            intent.setAction(Intent.ACTION_MAIN);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getReactApplicationContext().startActivity(intent);
            promise.resolve(true);
        } catch (Exception e) {
            promise.reject("LAUNCH_FAILED", e.getClass().getSimpleName() + ": " + e.getMessage(), e);
        }
    }

    /** List launchable apps as [{label, packageName, component}] for the Apps zone / config. */
    @ReactMethod
    public void listLaunchableApps(Promise promise) {
        try {
            PackageManager pm = getReactApplicationContext().getPackageManager();
            Intent launcher = new Intent(Intent.ACTION_MAIN);
            launcher.addCategory(Intent.CATEGORY_LAUNCHER);
            List<ResolveInfo> apps = pm.queryIntentActivities(launcher, 0);
            WritableArray out = Arguments.createArray();
            for (ResolveInfo ri : apps) {
                ActivityInfo ai = ri.activityInfo;
                WritableMap m = Arguments.createMap();
                CharSequence label = ai.loadLabel(pm);
                m.putString("label", label != null ? label.toString() : ai.name);
                m.putString("packageName", ai.packageName);
                m.putString("component", ai.packageName + "/" + ai.name);
                out.pushMap(m);
            }
            promise.resolve(out);
        } catch (Exception e) {
            promise.reject("LIST_APPS_FAILED", e.getClass().getSimpleName() + ": " + e.getMessage(), e);
        }
    }

    /**
     * List a directory as [{name, path, isDir, mtime}] using java.io.File.
     * More reliable than the SDK's device-wide getFileList (which crashed the
     * plugin view) and gives mtime for "most recent" sorting.
     */
    @ReactMethod
    public void listDir(String dirPath, Promise promise) {
        try {
            File dir = new File(dirPath);
            File[] children = dir.listFiles();
            WritableArray out = Arguments.createArray();
            if (children != null) {
                for (File c : children) {
                    WritableMap m = Arguments.createMap();
                    m.putString("name", c.getName());
                    m.putString("path", c.getAbsolutePath());
                    m.putBoolean("isDir", c.isDirectory());
                    m.putDouble("mtime", (double) c.lastModified());
                    out.pushMap(m);
                }
            }
            promise.resolve(out);
        } catch (Exception e) {
            promise.reject("LISTDIR_FAILED", e.getClass().getSimpleName() + ": " + e.getMessage(), e);
        }
    }

    // ---- Persistence / logging -------------------------------------------

    /** Write text to an absolute path (SDK has no writeFile). Creates parent dirs. */
    /** Write atomically: fill a temp file then rename, so a kill mid-write can't
     *  corrupt/truncate config.json or profiles.json. */
    @ReactMethod
    public void writeFile(String path, String content, Promise promise) {
        try {
            File f = new File(path);
            File parent = f.getParentFile();
            if (parent != null && !parent.exists()) parent.mkdirs();
            File tmp = new File(path + ".tmp");
            try (java.io.FileWriter w = new java.io.FileWriter(tmp, false)) {
                w.write(content);
                w.flush();
            }
            if (!tmp.renameTo(f)) {
                // rename can fail if the target exists on some filesystems
                f.delete();
                if (!tmp.renameTo(f)) throw new java.io.IOException("rename failed");
            }
            promise.resolve(true);
        } catch (Exception e) {
            promise.reject("WRITE_FAILED", e.getClass().getSimpleName() + ": " + e.getMessage(), e);
        }
    }

    /** Delete files in `dir` whose name starts with `prefix`, except `keepName`.
     *  Used to prune stale per-page handwriting PNGs (line_<hash>_p<n>_<mtime>.png). */
    @ReactMethod
    public void pruneMatching(String dir, String prefix, String keepName, Promise promise) {
        try {
            File[] kids = new File(dir).listFiles();
            int removed = 0;
            if (kids != null) {
                for (File k : kids) {
                    String n = k.getName();
                    if (n.startsWith(prefix) && !n.equals(keepName) && k.isFile()) {
                        if (k.delete()) removed++;
                    }
                }
            }
            promise.resolve(removed);
        } catch (Exception e) {
            promise.reject("PRUNE_FAILED", e.getClass().getSimpleName() + ": " + e.getMessage(), e);
        }
    }

    /**
     * PluginHost keeps every past version's files (app_<ts>.npk / _libs / oat)
     * on reinstall — a plugin's footprint balloons over time. We run inside the
     * PluginHost process, so we can delete our own old versions: keep the newest
     * timestamp (the running one), drop the rest. dirPath = getPluginDirPath().
     */
    @ReactMethod
    public void cleanupOldVersions(String dirPath, Promise promise) {
        try {
            File dir = new File(dirPath);
            File[] files = dir.listFiles();
            WritableMap m = Arguments.createMap();
            if (files == null) { m.putDouble("freed", 0); m.putString("kept", "none"); promise.resolve(m); return; }
            long maxTs = -1;
            for (File f : files) {
                String n = f.getName();
                if (n.startsWith("app_") && n.endsWith(".npk")) {
                    long ts = leadingTs(n.substring(4));
                    if (ts > maxTs) maxTs = ts;
                }
            }
            if (maxTs < 0) { m.putDouble("freed", 0); m.putString("kept", "none"); promise.resolve(m); return; }
            String keep = Long.toString(maxTs);
            long freed = 0;
            // Older app_<ts>.npk and app_<ts>_libs directories
            for (File f : files) {
                String n = f.getName();
                if (n.startsWith("app_") && !n.contains(keep)) freed += deleteRecursively(f);
            }
            // Compiled artifacts in oat/ for older versions
            File oat = new File(dir, "oat");
            if (oat.isDirectory()) freed += cleanOat(oat, keep);
            m.putDouble("freed", (double) freed);
            m.putString("kept", keep);
            promise.resolve(m);
        } catch (Exception e) {
            promise.reject("CLEANUP_FAILED", e.getClass().getSimpleName() + ": " + e.getMessage(), e);
        }
    }

    /** Leading run of digits of a string → long (-1 if none). */
    private static long leadingTs(String s) {
        int i = 0;
        while (i < s.length() && Character.isDigit(s.charAt(i))) i++;
        if (i == 0) return -1;
        try { return Long.parseLong(s.substring(0, i)); } catch (Exception e) { return -1; }
    }

    /** Delete a file/dir recursively, returning the bytes reclaimed. */
    private static long deleteRecursively(File f) {
        long sum = 0;
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) sum += deleteRecursively(k);
        } else {
            sum += f.length();
        }
        f.delete();
        return sum;
    }

    /** In oat/, drop compiled artifacts (app_<oldts>.odex/vdex/art) not matching keep. */
    private static long cleanOat(File oat, String keep) {
        long sum = 0;
        File[] kids = oat.listFiles();
        if (kids == null) return 0;
        for (File k : kids) {
            if (k.isDirectory()) {
                sum += cleanOat(k, keep);
            } else if (k.getName().startsWith("app_") && !k.getName().contains(keep)) {
                sum += k.length();
                k.delete();
            }
        }
        return sum;
    }

    /** Read a whole text file, fresh each call (no fetch caching). Reads fully —
     *  a single read() could truncate config/profiles and corrupt the JSON. */
    @ReactMethod
    public void readTextFile(String path, Promise promise) {
        try {
            File f = new File(path);
            if (!f.exists()) {
                promise.resolve("");
                return;
            }
            byte[] all = java.nio.file.Files.readAllBytes(f.toPath());
            promise.resolve(new String(all, "UTF-8"));
        } catch (Exception e) {
            promise.reject("READ_FAILED", e.getClass().getSimpleName() + ": " + e.getMessage(), e);
        }
    }

    @ReactMethod
    public void appendLog(String text, Promise promise) {
        try {
            File f = new File("/storage/emulated/0/MyStyle/dashboard-log.txt");
            // Cap the debug log so it can't grow without bound; start fresh.
            if (f.length() > 262_144) f.delete();
            try (java.io.FileWriter w = new java.io.FileWriter(f, true)) {
                w.write(text + "\n");
            }
            promise.resolve(true);
        } catch (Exception e) {
            promise.reject("LOG_FAILED", e.getClass().getSimpleName() + ": " + e.getMessage(), e);
        }
    }

    // ---- Fonts (user .ttf/.otf from MyStyle/fonts) ------------------------

    /** List usable font files in MyStyle/fonts as [{name, path}]. */
    @ReactMethod
    public void listFonts(Promise promise) {
        try {
            File dir = new File("/storage/emulated/0/MyStyle/fonts");
            File[] kids = dir.listFiles();
            WritableArray out = Arguments.createArray();
            if (kids != null) {
                for (File f : kids) {
                    String n = f.getName().toLowerCase();
                    if (f.isFile() && (n.endsWith(".ttf") || n.endsWith(".otf"))) {
                        WritableMap m = Arguments.createMap();
                        m.putString("name", f.getName());
                        m.putString("path", f.getAbsolutePath());
                        out.pushMap(m);
                    }
                }
            }
            promise.resolve(out);
        } catch (Exception e) {
            promise.reject("LISTFONTS_FAILED", e.getClass().getSimpleName() + ": " + e.getMessage(), e);
        }
    }

    /** Register a MyStyle font file under a RN fontFamily name so {@code <Text fontFamily>}
     *  can use it. RN can't load a font from an arbitrary path directly — this bridges it. */
    @ReactMethod
    public void registerFont(String path, String family, Promise promise) {
        try {
            android.graphics.Typeface tf = android.graphics.Typeface.createFromFile(path);
            com.facebook.react.common.assets.ReactFontManager.getInstance().addCustomFont(family, tf);
            promise.resolve(true);
        } catch (Exception e) {
            promise.reject("REGFONT_FAILED", e.getClass().getSimpleName() + ": " + e.getMessage(), e);
        }
    }

    /** Register a font shipped inside the JS bundle (base64) under a RN fontFamily.
     *  Used for the bundled DSEG7 7-segment face so the plugin stays fully offline:
     *  decode → write to cacheDir → Typeface.createFromFile → addCustomFont. */
    @ReactMethod
    public void registerFontBase64(String base64, String family, Promise promise) {
        try {
            java.io.File out = new java.io.File(getReactApplicationContext().getCacheDir(), "font_" + family + ".ttf");
            // Decode + write only once; a later process load reuses the cached .ttf
            // (registration itself is per-process, but the 31 KB decode/write is not
            // repeated). try-with-resources closes the stream even if write() throws.
            if (!out.exists() || out.length() == 0) {
                byte[] bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
                try (java.io.FileOutputStream fos = new java.io.FileOutputStream(out)) {
                    fos.write(bytes);
                }
            }
            android.graphics.Typeface tf = android.graphics.Typeface.createFromFile(out);
            com.facebook.react.common.assets.ReactFontManager.getInstance().addCustomFont(family, tf);
            promise.resolve(true);
        } catch (Exception e) {
            promise.reject("REGFONT64_FAILED", e.getClass().getSimpleName() + ": " + e.getMessage(), e);
        }
    }

    // ---- Device status (battery / storage / info) ------------------------

    /** Battery {level: 0-100 (or -1), charging: bool} via the sticky battery intent. */
    @ReactMethod
    public void getBattery(Promise promise) {
        try {
            Intent b = getReactApplicationContext().registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            WritableMap m = Arguments.createMap();
            if (b == null) {
                m.putInt("level", -1);
                m.putBoolean("charging", false);
                promise.resolve(m);
                return;
            }
            int level = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            int scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
            int status = b.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
            m.putInt("level", (scale > 0 && level >= 0) ? Math.round(level * 100f / scale) : -1);
            m.putBoolean("charging", status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL);
            promise.resolve(m);
        } catch (Exception e) {
            promise.reject("BATTERY_FAILED", e.getClass().getSimpleName() + ": " + e.getMessage(), e);
        }
    }

    /** Free/total bytes for internal shared storage, and the SD card if present. */
    @ReactMethod
    public void getStorage(Promise promise) {
        try {
            WritableMap m = Arguments.createMap();
            StatFs in = new StatFs(Environment.getExternalStorageDirectory().getAbsolutePath());
            m.putDouble("internalFree", (double) in.getAvailableBytes());
            m.putDouble("internalTotal", (double) in.getTotalBytes());
            boolean hasSd = false;
            // The 2nd app-specific external dir, when present, lives on removable media.
            File[] ext = getReactApplicationContext().getExternalFilesDirs(null);
            if (ext != null && ext.length > 1 && ext[1] != null) {
                try {
                    StatFs sd = new StatFs(ext[1].getAbsolutePath());
                    m.putDouble("sdFree", (double) sd.getAvailableBytes());
                    m.putDouble("sdTotal", (double) sd.getTotalBytes());
                    hasSd = true;
                } catch (Exception ignored) {}
            }
            m.putBoolean("hasSd", hasSd);
            promise.resolve(m);
        } catch (Exception e) {
            promise.reject("STORAGE_FAILED", e.getClass().getSimpleName() + ": " + e.getMessage(), e);
        }
    }

    // ---- Overlay bubble ---------------------------------------------------

    /**
     * Show the floating bubble: the SuperDashboard house in a rounded white chip with
     * a black outline (like SuperStickyNote's bubble). Icon‑only — no label/hint text.
     */
    @ReactMethod
    public void showBubble(Promise promise) {
        main.post(() -> {
            try {
                Context ctx = getReactApplicationContext();
                if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(ctx)) {
                    promise.reject("NO_PERMISSION", "overlay permission not granted");
                    return;
                }
                // Remove our tracked view AND any orphaned bubbles left in the
                // (persistent PluginHost) process by a previous classloader.
                removeOverlayInternal();
                clearTaggedBubbles();
                wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);

                // The bubble is just the SuperDashboard house, DRAWN on a Canvas (loading
                // R.drawable inside the persistent plugin host renders unreliably — an ugly
                // black bar, the same issue SuperStickyNote hit). It sits in a rounded white
                // chip with a black outline, matching SuperStickyNote's bubble.
                // Size the house in SP (like the old ⊕ glyph did) so it tracks the device's
                // font-size setting — that's why the old bubble felt "adaptive" — and keep
                // it small: the previous dp(34) icon + dp(12) padding + dp(3) border read as
                // ~1cm on a 300dpi Manta/Nomad. ~24sp + dp(8) padding + dp(2) border ≈ 6–7mm.
                int glyphSize = (int) TypedValue.applyDimension(
                        TypedValue.COMPLEX_UNIT_SP, 24, ctx.getResources().getDisplayMetrics());
                ImageView panel = new ImageView(ctx);
                panel.setTag(BUBBLE_TAG);
                panel.setImageBitmap(makeHouseIcon(glyphSize));
                panel.setScaleType(ImageView.ScaleType.CENTER);
                panel.setPadding(dp(8), dp(8), dp(8), dp(8));
                panel.setBackground(roundedBg(Color.WHITE, Color.BLACK, dp(16), dp(2)));

                int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                        ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                        : WindowManager.LayoutParams.TYPE_PHONE;
                overlayParams = new WindowManager.LayoutParams(
                        WindowManager.LayoutParams.WRAP_CONTENT,
                        WindowManager.LayoutParams.WRAP_CONTENT,
                        type,
                        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                        // TRANSLUCENT (not OPAQUE): the bubble is a ROUNDED chip, so the view's
                        // square corners are transparent. On an OPAQUE overlay some e-ink
                        // compositors (reported on Manta) fill those transparent corners with
                        // BLACK — the bubble then looks like a black square. TRANSLUCENT keeps
                        // the window's alpha so the corners show the note behind, as intended.
                        PixelFormat.TRANSLUCENT);
                // Coordinates are top-left origin (matches the drag handler).
                // First placement (no dragged position yet) → top-right corner;
                // x needs the laid-out width, so it's set in a post() below.
                final boolean firstPlacement = lastX < 0;
                overlayParams.gravity = Gravity.TOP | Gravity.START;
                overlayParams.x = lastX >= 0 ? lastX : dp(40); // provisional; fixed on first layout
                overlayParams.y = lastY >= 0 ? lastY : dp(40);

                // No long-press: a tap opens the dashboard, a drag moves the bubble.
                // (Long-press-to-delete fired on slow e-ink taps → the bubble vanished.
                //  The bubble is turned off from Settings → Look instead.)
                panel.setOnTouchListener((v, ev) -> {
                    switch (ev.getAction()) {
                        case MotionEvent.ACTION_DOWN:
                            startX = overlayParams.x; startY = overlayParams.y;
                            startRawX = ev.getRawX(); startRawY = ev.getRawY();
                            dragging = false;
                            return true;
                        case MotionEvent.ACTION_MOVE: {
                            float dx = ev.getRawX() - startRawX, dy = ev.getRawY() - startRawY;
                            if (!dragging && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) dragging = true;
                            if (dragging) {
                                int vw = v.getWidth(), vh = v.getHeight();
                                int maxX = Math.max(0, screenW() - vw);
                                int maxY = Math.max(0, screenH() - vh);
                                overlayParams.x = clamp(startX + (int) dx, 0, maxX);
                                overlayParams.y = clamp(startY + (int) dy, 0, maxY);
                                lastX = overlayParams.x; lastY = overlayParams.y;
                                try { wm.updateViewLayout(overlayView, overlayParams); } catch (Exception ignored) {}
                            }
                            return true;
                        }
                        case MotionEvent.ACTION_UP:
                            if (!dragging) emit("onBubbleTap", Arguments.createMap());
                            return true;
                        default:
                            return false;
                    }
                });

                overlayView = panel;
                wm.addView(overlayView, overlayParams);
                if (firstPlacement) {
                    // Snap to the top-right once the bubble's width is known.
                    panel.post(() -> {
                        try {
                            int x = Math.max(0, screenW() - panel.getWidth() - dp(12));
                            overlayParams.x = x;
                            lastX = x;
                            lastY = overlayParams.y;
                            wm.updateViewLayout(panel, overlayParams);
                        } catch (Exception ignored) {}
                    });
                }
                promise.resolve(true);
            } catch (Exception e) {
                promise.reject("SHOW_BUBBLE_FAILED", e.getClass().getSimpleName() + ": " + e.getMessage(), e);
            }
        });
    }

    @ReactMethod
    public void hideBubble(Promise promise) {
        main.post(() -> {
            removeOverlayInternal();
            promise.resolve(true);
        });
    }

    private void removeOverlayInternal() {
        if (overlayView != null && wm != null) {
            try { wm.removeView(overlayView); } catch (Exception ignored) {}
        }
        overlayView = null;
        overlayParams = null;
    }

    /**
     * Remove every bubble view in this process, even orphans from a previous
     * plugin classloader (PluginHost persists across reload/reinstall, so a
     * stale bubble can't be reached via our static reference). We reflect into
     * WindowManagerGlobal — process-wide — and drop any view tagged BUBBLE_TAG.
     */
    @ReactMethod
    public void clearAllBubbles(Promise promise) {
        main.post(() -> {
            int n = clearTaggedBubbles();
            if (promise != null) promise.resolve(n);
        });
    }

    @SuppressWarnings("unchecked")
    private int clearTaggedBubbles() {
        int removed = 0;
        try {
            Class<?> wmg = Class.forName("android.view.WindowManagerGlobal");
            Object inst = wmg.getMethod("getInstance").invoke(null);
            java.lang.reflect.Field f = wmg.getDeclaredField("mViews");
            f.setAccessible(true);
            java.util.List<View> views = (java.util.List<View>) f.get(inst);
            WindowManager w = (WindowManager) getReactApplicationContext()
                    .getSystemService(Context.WINDOW_SERVICE);
            for (View v : new java.util.ArrayList<>(views)) {
                if (v != null && BUBBLE_TAG.equals(v.getTag())) {
                    try { w.removeViewImmediate(v); removed++; } catch (Exception ignored) {}
                }
            }
        } catch (Throwable ignored) {
            // Reflection unavailable → fall back to the tracked reference only.
        }
        if (removed > 0) {
            overlayView = null;
            overlayParams = null;
        }
        return removed;
    }

    private int screenW() {
        return getReactApplicationContext().getResources().getDisplayMetrics().widthPixels;
    }

    private int screenH() {
        return getReactApplicationContext().getResources().getDisplayMetrics().heightPixels;
    }

    private int clamp(int v, int lo, int hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    private int dp(int v) {
        float d = getReactApplicationContext().getResources().getDisplayMetrics().density;
        return (int) (v * d);
    }

    /** A rounded chip background: solid fill + outline (used for the bubble). */
    private GradientDrawable roundedBg(int fill, int stroke, int radius, int strokeW) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill);
        g.setCornerRadius(radius);
        g.setStroke(strokeW, stroke);
        return g;
    }

    /**
     * Draw the SuperDashboard house (24×24 viewBox) as a stroked bitmap — the bubble
     * face and a match for the plugin icon. Drawn in code because loading R.drawable
     * inside the plugin host renders unreliably. Round cap/join keeps the line-art
     * clean at small sizes on e-ink.
     */
    private Bitmap makeHouseIcon(int size) {
        Bitmap bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas cv = new Canvas(bmp);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setColor(Color.BLACK);
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeWidth(size * 2f / 24f);
        p.setStrokeCap(Paint.Cap.ROUND);
        p.setStrokeJoin(Paint.Join.ROUND);
        float s = size / 24f; // 24×24 viewBox
        // Outline: left eave → apex → right eave → down the right wall → floor → close up the left wall.
        Path house = new Path();
        house.moveTo(4 * s, 9.5f * s);
        house.lineTo(12 * s, 2.5f * s);
        house.lineTo(20 * s, 9.5f * s);
        house.lineTo(20 * s, 20 * s);
        house.lineTo(4 * s, 20 * s);
        house.close();
        // Door, open at the floor line.
        Path door = new Path();
        door.moveTo(9.5f * s, 20 * s);
        door.lineTo(9.5f * s, 13.5f * s);
        door.lineTo(14.5f * s, 13.5f * s);
        door.lineTo(14.5f * s, 20 * s);
        cv.drawPath(house, p);
        cv.drawPath(door, p);
        return bmp;
    }
}
