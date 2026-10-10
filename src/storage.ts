/**
 * Storage volumes: internal shared storage + removable SD cards.
 *
 * The PluginHost's view of /storage does NOT list mounted cards, so the native
 * side asks Android (StorageManager / getExternalFilesDirs), as SuperSearch and
 * SmartNoteAI do; plain java.io then reads the card under the FILE:READ grant.
 */
import {NativeModules} from 'react-native';

import {loadConfig} from './config';

const {DashboardNative} = NativeModules;

export const INTERNAL_ROOT = '/storage/emulated/0';

/** Folders an SD card root exposes that are never user content. */
export const SD_SYSTEM_DIR = /^(Android|\..*|LOST\.DIR|System Volume Information|\$RECYCLE\.BIN)$/i;

let sdCache: {at: number; roots: string[]} | null = null;
const SD_TTL = 30_000; // a card is rarely (un)plugged; re-ask at most twice a minute

/** Mounted SD card roots, e.g. ["/storage/1C04-5DD5"] ([] when none). */
export async function sdRoots(): Promise<string[]> {
  const now = Date.now();
  if (sdCache && now - sdCache.at < SD_TTL) return sdCache.roots;
  let roots: string[] = [];
  try {
    roots = ((await DashboardNative?.listStorageVolumes?.()) ?? []).filter((r: any) => typeof r === 'string' && r);
  } catch {
    /* no card / old native build */
  }
  sdCache = {at: now, roots};
  return roots;
}

/** True when `path` lives on a removable card (not internal shared storage). */
export function isSdPath(path: string): boolean {
  return !!path && !path.startsWith(INTERNAL_ROOT + '/') && path !== INTERNAL_ROOT;
}

export interface StorageRoot {
  label: string;
  root: string;
}

/** Internal storage + every mounted card ("SD card", or "SD card 1", "SD card 2"…). */
export async function storageRoots(): Promise<StorageRoot[]> {
  const vols = await sdRoots();
  return [{label: 'Internal', root: INTERNAL_ROOT}, ...vols.map((root, i) => ({label: vols.length > 1 ? `SD card ${i + 1}` : 'SD card', root}))];
}

/** The user's explicit opt-in ("Also search the SD card" on a Search block):
 *  only then do the name index and the heading index walk the card. */
export async function searchSdEnabled(): Promise<boolean> {
  try {
    const cfg = await loadConfig();
    return cfg.zones.some(z => z.type === 'search' && !!(z as any).searchSd);
  } catch {
    return false;
  }
}
