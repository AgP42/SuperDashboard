/**
 * Plugin file permissions (sn-plugin-lib 0.1.65 / Chauvet plugin-preview firmware).
 *
 * The preview host enforces FILE:READ/WRITE even on raw java.io access to shared
 * storage (Note, Document, MyStyle, …). The Dashboard's native module reads shared
 * storage directly — listDir() walks Note/Document folders, readTextFile() reads
 * config.json/profiles.json in MyStyle — and the launcher also reads stars/keywords
 * through the SDK (searchFiveStars/getKeyWords/getElements/getPageSize/
 * generateNotePng). Without FILE:READ every one of those throws a native
 * "no READ permission on sdcard" SecurityException and the scan/config read fails
 * SILENTLY. Deleting a star (deleteElements) needs FILE:WRITE.
 *
 * Both permissions are declared in PluginConfig.json `uses-permissions` — without
 * the declaration requestPermission fails with code 1500.
 *
 * Only the plugin's PRIVATE dir (getPluginDirPath → scan cache, line PNGs) is
 * permission-free, so cleanupOldVersions and the private cache keep working even
 * when the user denies the request — which is why the launcher (app tiles,
 * shortcuts, folder/intent opening) stays usable without any permission.
 */
import {NativeModules} from 'react-native';
import {PluginManager} from 'sn-plugin-lib';

const {DashboardNative} = NativeModules;

export const PERM_FILE_READ = 'plugin.permission.FILE:READ';
export const PERM_FILE_WRITE = 'plugin.permission.FILE:WRITE';

/** Mirror index.js's on-device log so a denied grant is visible in dashboard-log.txt. */
function plog(msg: string): void {
  try {
    DashboardNative?.appendLog?.(`[perm] ${msg}`).catch(() => {});
  } catch {
    /* logging is best-effort */
  }
}

// Cache only SUCCESS: a denied request re-prompts the next time the user takes an
// action that needs files (so they can change their mind), but a granted one is
// never asked again this process.
let granted = false;

/**
 * Grant one permission (idempotent per call).
 *   hasPermission → 0 = not granted, 1 = granted
 *   requestPermission → 0 = deny, 1 = allow this time, 2 = always allow
 */
async function ensure(permission: string, desc: string): Promise<boolean> {
  const has = await PluginManager.hasPermission(permission);
  if (has === 1) return true;
  const res = await PluginManager.requestPermission(permission, desc);
  plog(`requestPermission(${permission}) → ${res}`);
  return res === 1 || res === 2;
}

/**
 * Ensure FILE:READ + FILE:WRITE before the launcher touches shared storage.
 * Call early in boot (before the first config read / bubble restore) and it's a
 * no-op on every later call once granted. On the OLD firmware the permission APIs
 * don't exist (the native side throws) — we then assume granted so a 0.1.65-built
 * plugin still runs there.
 *
 * @returns whether reading AND writing shared storage are allowed. On `false`
 *   the caller must degrade gracefully (empty scans, default config) — never crash.
 */
export async function ensureFilePermissions(): Promise<boolean> {
  if (granted) return true;
  try {
    const read = await ensure(
      PERM_FILE_READ,
      'SuperDashboard reads your notes and folders to build the dashboard (stars, keywords, recent, shortcuts).',
    );
    const write = await ensure(
      PERM_FILE_WRITE,
      'SuperDashboard needs write access to remove a star from a note when you tap delete.',
    );
    granted = read && write;
    plog(`ensureFilePermissions read=${read} write=${write} → ${granted}`);
    return granted;
  } catch (e: any) {
    // Legacy host with no permission system: don't block the plugin.
    plog(`no permission host (${e?.message}) — assuming granted`);
    granted = true;
    return true;
  }
}
