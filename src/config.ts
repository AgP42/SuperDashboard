/**
 * Dashboard configuration: schema, defaults, load/save, named profiles.
 * Stored at MyStyle/Plugins/Dashboard/config.json (older MyStyle/Dashboard/ is a
 * read-only fallback). Read/written via the native reader/writer (fetch caches
 * file:// URLs → stale config; the SDK has no writeFile). The wizard writes it;
 * advanced users can hand-edit the same JSON.
 */
import {NativeModules} from 'react-native';

import {AppItem} from './apps';

const {DashboardNative} = NativeModules;

const CONFIG_PATH = '/storage/emulated/0/MyStyle/Plugins/Dashboard/config.json';
const LEGACY_CONFIG_PATH = '/storage/emulated/0/MyStyle/Dashboard/config.json';

/** The device's own /Recent/Recent.txt only ever holds the last 8 opened files. */
export const RECENT_MAX = 8;

/** The bubble is icon‑only now (the house) or off. Older configs used 'label'/'hint'
 *  — normalize() folds those into 'icon'. */
export type BubbleMode = 'icon' | 'off';

export type ShortcutItem =
  | {kind: 'folder'; label: string; path: string}
  | {kind: 'note-last'; label: string; path: string}
  | {kind: 'note-page'; label: string; path: string; page: number};

export type {AppItem};

/** Keyword zone rendering styles. */
export type KeywordDisplay = 'list' | 'inline' | 'byfolder';

/** Order of notes within a Stars/Keywords zone. */
export type NoteSort = 'recent' | 'name';

/** How a Stars zone previews each star's line: nothing / handwriting image / OCR text. */
export type LineMode = 'off' | 'image' | 'text';

/** Layout of items within a Shortcuts / Apps zone. */
export type ItemDisplay = 'list' | 'grid' | 'inline';

export type Zone =
  | {type: 'shortcuts'; title?: string; items: ShortcutItem[]; display?: ItemDisplay}
  | {type: 'stars'; title?: string; folders: string[]; noteSort?: NoteSort; lineMode?: LineMode; canDelete?: boolean}
  | {
      type: 'keywords';
      title?: string;
      folders: string[];
      sort: 'keyword' | 'note';
      /** Which specific keywords to show (empty/absent = all). */
      keywords?: string[];
      display?: KeywordDisplay;
      noteSort?: NoteSort;
    }
  | {type: 'apps'; title?: string; apps: AppItem[]; display?: ItemDisplay}
  | {type: 'recent'; title?: string; count?: number; display?: ItemDisplay};

export interface ScanSettings {
  /** Auto-rescan a zone when its cache is older than this many hours (0 = off).
   *  A zone that has never been scanned always auto-scans on first view. */
  autoRefreshHours: number;
  /** Rescan every time the dashboard opens. */
  autoOnOpen: boolean;
}

/** Visual style of the zones (see docs/dashboard-designs.html). */
export type Theme = 'ledger' | 'boxed' | 'airy';
/** Zone arrangement: stacked (full width) or a two-column grid. */
export type Layout = 'stack' | 'grid';

/** Dashboard text size (also enlarges tap targets). */
export type TextScale = 'S' | 'M' | 'L' | 'XL';

export interface DashboardConfig {
  bubble: {mode: BubbleMode};
  scan: ScanSettings;
  theme: Theme;
  layout: Layout;
  textScale: TextScale;
  /** Zone-title size, independent from the content text ('S' = the historical look). */
  headingScale: TextScale;
  zones: Zone[];
}

export const DEFAULT_CONFIG: DashboardConfig = {
  bubble: {mode: 'icon'},
  scan: {autoRefreshHours: 24, autoOnOpen: false},
  theme: 'boxed',
  layout: 'stack',
  textScale: 'L',
  headingScale: 'S',
  zones: [
    {
      type: 'shortcuts',
      title: 'Shortcuts',
      items: [{kind: 'folder', label: 'Notes', path: '/storage/emulated/0/Note'}],
    },
    {type: 'recent', title: 'Recent', count: 8, display: 'list'},
    {type: 'stars', title: 'Stars', folders: ['/storage/emulated/0/Note']},
    {
      type: 'keywords',
      title: 'Keywords',
      folders: ['/storage/emulated/0/Note'],
      sort: 'keyword',
    },
    {
      type: 'apps',
      title: 'Apps',
      apps: [
        {label: 'ToDo', component: 'com.ratta.supernote.task/com.ratta.supernote.task.TaskActivity'},
        {label: 'Calendar', component: 'com.ratta.supernote.calendar/com.ratta.supernote.calendar.MainActivity'},
      ],
    },
  ],
};

/** Load config from disk, falling back to DEFAULT_CONFIG if missing/invalid.
 *  Uses the native reader (not fetch, which caches file:// → stale config after a Save). */
async function readJson(path: string): Promise<string | null> {
  try {
    const text: string = await DashboardNative.readTextFile(path);
    return text && text.trim() ? text : null;
  } catch {
    return null;
  }
}

/** Whether a config has ever been saved to disk. False on first open, where
 *  loadConfig() would return DEFAULT_CONFIG — the two are indistinguishable
 *  from the config object alone. */
export async function hasSavedConfig(): Promise<boolean> {
  return (
    (await readJson(CONFIG_PATH)) != null || (await readJson(LEGACY_CONFIG_PATH)) != null
  );
}

export async function loadConfig(): Promise<DashboardConfig> {
  const text = (await readJson(CONFIG_PATH)) ?? (await readJson(LEGACY_CONFIG_PATH));
  if (!text) return DEFAULT_CONFIG;
  try {
    return normalize(JSON.parse(text));
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** Persist config to disk. Returns true on success. */
export async function saveConfig(cfg: DashboardConfig): Promise<boolean> {
  try {
    await DashboardNative.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    return true;
  } catch {
    return false;
  }
}

/** Shallow validation so a malformed field can't crash the dashboard. */
function normalize(raw: any): DashboardConfig {
  // Fallbacks come from DEFAULT_CONFIG so each default has one owner.
  // Only 'off' or 'icon' now; fold the retired 'label'/'hint' (and anything else) into 'icon'.
  const mode: BubbleMode = raw?.bubble?.mode === 'off' ? 'off' : 'icon';
  const zones: Zone[] = Array.isArray(raw?.zones) ? raw.zones.filter(isZone).map(normalizeZone) : DEFAULT_CONFIG.zones;
  const scan: ScanSettings = {
    autoRefreshHours:
      typeof raw?.scan?.autoRefreshHours === 'number'
        ? raw.scan.autoRefreshHours
        : DEFAULT_CONFIG.scan.autoRefreshHours,
    autoOnOpen: raw?.scan?.autoOnOpen === true,
  };
  const theme: Theme = ['ledger', 'boxed', 'airy'].includes(raw?.theme) ? raw.theme : DEFAULT_CONFIG.theme;
  const layout: Layout = raw?.layout === 'grid' ? 'grid' : 'stack';
  const textScale: TextScale = ['S', 'M', 'L', 'XL'].includes(raw?.textScale)
    ? raw.textScale
    : DEFAULT_CONFIG.textScale;
  const headingScale: TextScale = ['S', 'M', 'L', 'XL'].includes(raw?.headingScale)
    ? raw.headingScale
    : DEFAULT_CONFIG.headingScale;
  return {bubble: {mode}, scan, theme, layout, textScale, headingScale, zones};
}

function isZone(z: any): z is Zone {
  return z && ['shortcuts', 'stars', 'keywords', 'apps', 'recent'].includes(z.type);
}

/** Guarantee a zone's required arrays/fields exist so a hand-edited config
 *  (the docs invite it) can't crash rendering. */
function normalizeZone(z: any): Zone {
  const arr = (v: any) => (Array.isArray(v) ? v : []);
  switch (z.type) {
    case 'shortcuts':
      return {...z, items: arr(z.items)};
    case 'stars':
      return {...z, folders: arr(z.folders)};
    case 'keywords':
      return {...z, folders: arr(z.folders), sort: z.sort === 'note' ? 'note' : 'keyword'};
    case 'apps':
      return {...z, apps: arr(z.apps)};
    case 'recent':
      // A higher count can't show more than the device tracks — clamp to [1, RECENT_MAX].
      return {...z, count: Math.min(RECENT_MAX, Math.max(1, typeof z.count === 'number' ? z.count : RECENT_MAX))};
    default:
      return z;
  }
}

// ---- Named config profiles (save / reload; guards against accidental reset) --
const PROFILES_PATH = '/storage/emulated/0/MyStyle/Plugins/Dashboard/profiles.json';

async function readProfiles(): Promise<Record<string, DashboardConfig>> {
  try {
    const text = await readJson(PROFILES_PATH);
    if (text) return JSON.parse(text).profiles ?? {};
  } catch {
    /* none yet / malformed */
  }
  return {};
}
async function writeProfiles(p: Record<string, DashboardConfig>): Promise<void> {
  await DashboardNative.writeFile(PROFILES_PATH, JSON.stringify({profiles: p}, null, 2));
}

export async function listProfiles(): Promise<string[]> {
  return Object.keys(await readProfiles()).sort((a, b) => a.localeCompare(b));
}
export async function saveProfile(name: string, cfg: DashboardConfig): Promise<void> {
  const p = await readProfiles();
  p[name.trim()] = cfg;
  await writeProfiles(p);
}
export async function loadProfile(name: string): Promise<DashboardConfig | null> {
  const p = await readProfiles();
  return p[name] ? normalize(p[name]) : null;
}
export async function deleteProfile(name: string): Promise<void> {
  const p = await readProfiles();
  delete p[name];
  await writeProfiles(p);
}
