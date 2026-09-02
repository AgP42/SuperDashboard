/**
 * Private, non-synced storage for machine-only files (scan cache, star line
 * PNGs). MyStyle/ is watched by the firmware's file observers and synced to
 * the Supernote cloud; keeping caches there uploaded every scan's output
 * (seen in logcat: XL-L-FromLocalTask pushing scancache.json to the cloud).
 * config.json / profiles.json / dashboard-log.txt intentionally STAY in
 * MyStyle: they're the user-visible contract (hand-editable, and reachable
 * over MTP on the adb-less A5X).
 */
import {PluginManager} from 'sn-plugin-lib';

export const LEGACY_CACHE_DIR = '/storage/emulated/0/MyStyle/Plugins/Dashboard/';

let dir: string | null = null;

/** Plugin-private cache dir (with trailing slash). Falls back to the legacy
 *  MyStyle dir if the SDK can't provide one. */
export async function cacheDir(): Promise<string> {
  if (dir) return dir;
  try {
    const d = await PluginManager.getPluginDirPath();
    if (d) dir = d.endsWith('/') ? d : d + '/';
  } catch {
    /* fall through to legacy */
  }
  if (!dir) dir = LEGACY_CACHE_DIR;
  return dir;
}
