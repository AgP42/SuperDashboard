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

/** The bubble is icon-only now (the house) or off. Older configs used 'label'/'hint';
 *  normalize() folds those into 'icon'. */
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

/** Clock block display style. */
export type ClockStyle = 'large' | 'compact' | 'weekday' | 'jumbo' | 'mono' | 'stamp';

/** Week-number convention. iso = ISO-8601 (Mon start, wk1 has first Thursday);
 *  us = week 1 contains Jan 1, Sunday start. */
export type WeekNum = 'off' | 'iso' | 'us';

/** An extra clock face: a label + a whole/half-hour offset from the device's
 *  local time (the user dials it in with +/- buttons). */
export interface ClockExtra {
  label: string;
  offset: number; // hours relative to local time (may be fractional, e.g. 5.5)
}

/** Layout of items within a Shortcuts / Apps zone. */
export type ItemDisplay = 'list' | 'grid' | 'inline';

/** Fixed-mode block height (also the spacer's height). */
export type BlockHeight = 'S' | 'M' | 'L';

/** Fields common to every block: column, fixed-mode height, collapsed state. */
export interface ZoneCommon {
  /** 0-based column index (clamped to the layout's column count). Default 0. */
  col?: number;
  /** Height in 'fixed' vertical mode; also the spacer's height. Default 'M'. */
  h?: BlockHeight;
  /** Collapsed → only the title + an expand arrow show. */
  collapsed?: boolean;
}

/** Emoji per block type: used in the config canvas, the add menu, and (optionally)
 *  on the dashboard block titles. */
export const ZONE_ICONS: Record<string, string> = {
  shortcuts: '⧉',
  stars: '★',
  keywords: '#',
  apps: '▦',
  recent: '🗒️',
  clock: '🕑',
  search: '🔍',
  status: '🔋',
  nav: '🗂️',
  clips: '✂️',
  spacer: '▢',
};

/** Human label per block type: the SINGLE source for the block's default name,
 *  so the "＋ add block" menu, the config section name, and the dashboard title
 *  all read identically (e.g. status → "Device", nav → "Files"). */
export const ZONE_LABELS: Record<string, string> = {
  shortcuts: 'Shortcuts',
  stars: 'Stars',
  keywords: 'Keywords',
  apps: 'Apps',
  recent: 'Recent',
  clock: 'Clock',
  search: 'Search',
  status: 'Device',
  nav: 'Files',
  clips: 'Clips',
  spacer: 'Empty',
};

/** Clip ordering in a Clips block. */
export type ClipSort = 'new' | 'old' | 'label' | 'note';

/** Optional grey/black rectangle drawn on the note around a captured clip. */
export type ClipFrame = 'off' | 'grey' | 'black';

export type Zone = ZoneCommon &
  (
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
    | {type: 'recent'; title?: string; count?: number; display?: ItemDisplay}
    | {type: 'clock'; title?: string; style?: ClockStyle; hour24?: boolean; locale?: string; showDate?: boolean; weekNum?: WeekNum; extras?: ClockExtra[]}
    | {type: 'search'; title?: string; folders?: string[]}
    | {type: 'status'; title?: string; battery?: boolean; storage?: boolean; stats?: boolean}
    | {type: 'nav'; title?: string; root?: string}
    | {type: 'clips'; title?: string; folders?: string[]; labels?: string[]; display?: 'grid' | 'list'; sort?: ClipSort; size?: 'S' | 'M' | 'L'}
    | {type: 'spacer'; title?: string}
  );

export interface ScanSettings {
  /** Auto-rescan a zone when its cache is older than this many hours (0 = off).
   *  A zone that has never been scanned always auto-scans on first view. */
  autoRefreshHours: number;
  /** Rescan every time the dashboard opens. */
  autoOnOpen: boolean;
}

/** Visual style of the zones. grid/gridgray = thin hairline cells (black/grey);
 *  compact = dense, card = rounded filled card, minimal = no frame, underline =
 *  headline rule. */
export type Theme = 'ledger' | 'boxed' | 'airy' | 'grid' | 'gridgray' | 'compact' | 'card' | 'minimal' | 'underline';
export const THEMES: Theme[] = ['ledger', 'boxed', 'airy', 'grid', 'gridgray', 'compact', 'card', 'minimal', 'underline'];

/** How blocks flow down a column: natural height (masonry) or a set height that
 *  scrolls inside (fixed). */
export type VMode = 'masonry' | 'fixed';

/** Layout: 1-3 independent columns + the vertical flow mode. Replaces the old
 *  'stack' | 'grid' string (still read for migration). */
export interface LayoutConfig {
  columns: 1 | 2 | 3;
  vmode: VMode;
}

/** Pixel height per BlockHeight in 'fixed' mode / for spacers. */
export const BLOCK_HEIGHTS: Record<BlockHeight, number> = {S: 190, M: 300, L: 430};

/** Dashboard text size (also enlarges tap targets). */
export type TextScale = 'S' | 'M' | 'L' | 'XL';

export interface DashboardConfig {
  bubble: {mode: BubbleMode};
  scan: ScanSettings;
  theme: Theme;
  layout: LayoutConfig;
  textScale: TextScale;
  /** Zone-title size, independent from the content text ('S' = the historical look). */
  headingScale: TextScale;
  /** A MyStyle/fonts .ttf/.otf path to use for dashboard text; '' / undefined = system default. */
  font?: string;
  /** Show each block's type icon on its dashboard title. */
  showIcons?: boolean;
  /** Rectangle drawn on the note around a lassoed clip (off by default). */
  clipFrame?: ClipFrame;
  zones: Zone[];
}

export const DEFAULT_CONFIG: DashboardConfig = {
  bubble: {mode: 'icon'},
  scan: {autoRefreshHours: 24, autoOnOpen: false},
  theme: 'boxed',
  layout: {columns: 1, vmode: 'masonry'},
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
 *  loadConfig() would return DEFAULT_CONFIG; the two are indistinguishable
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

/** Migrate/validate the layout. Accepts the new object shape AND the retired
 *  'stack'/'grid' strings so old (and other users') configs keep working. */
function normalizeLayout(raw: any): LayoutConfig {
  if (raw === 'grid') return {columns: 2, vmode: 'masonry'};
  if (raw === 'stack') return {columns: 1, vmode: 'masonry'};
  if (raw && typeof raw === 'object') {
    const columns: 1 | 2 | 3 = raw.columns === 2 ? 2 : raw.columns === 3 ? 3 : 1;
    const vmode: VMode = raw.vmode === 'fixed' ? 'fixed' : 'masonry';
    return {columns, vmode};
  }
  return {columns: 1, vmode: 'masonry'};
}

/** Shallow validation so a malformed field can't crash the dashboard. */
function normalize(raw: any): DashboardConfig {
  // Fallbacks come from DEFAULT_CONFIG so each default has one owner.
  // Only 'off' or 'icon' now; fold the retired 'label'/'hint' (and anything else) into 'icon'.
  const mode: BubbleMode = raw?.bubble?.mode === 'off' ? 'off' : 'icon';
  const layout = normalizeLayout(raw?.layout);
  // Old 2-column ('grid') configs auto-split zones even/odd; reproduce that as a
  // round-robin column assignment so a pre-update config keeps its 2-column look.
  const legacyGrid = raw?.layout === 'grid';
  const hasZones = Array.isArray(raw?.zones);
  const rawZones: any[] = hasZones ? raw.zones.filter(isZone) : (DEFAULT_CONFIG.zones as any[]);
  const zones: Zone[] = rawZones.map((z: any, i: number) => {
    const nz: any = normalizeZone(z);
    const rawCol = typeof z.col === 'number' ? z.col : legacyGrid ? i % 2 : 0;
    nz.col = Math.max(0, Math.min(layout.columns - 1, rawCol));
    nz.h = ['S', 'M', 'L'].includes(z.h) ? z.h : 'M';
    return nz as Zone;
  });
  const scan: ScanSettings = {
    autoRefreshHours:
      typeof raw?.scan?.autoRefreshHours === 'number'
        ? raw.scan.autoRefreshHours
        : DEFAULT_CONFIG.scan.autoRefreshHours,
    autoOnOpen: raw?.scan?.autoOnOpen === true,
  };
  const theme: Theme = THEMES.includes(raw?.theme) ? raw.theme : DEFAULT_CONFIG.theme;
  const textScale: TextScale = ['S', 'M', 'L', 'XL'].includes(raw?.textScale)
    ? raw.textScale
    : DEFAULT_CONFIG.textScale;
  const headingScale: TextScale = ['S', 'M', 'L', 'XL'].includes(raw?.headingScale)
    ? raw.headingScale
    : DEFAULT_CONFIG.headingScale;
  const font: string | undefined = typeof raw?.font === 'string' && raw.font ? raw.font : undefined;
  const showIcons = raw?.showIcons === true;
  const clipFrame: ClipFrame = ['off', 'grey', 'black'].includes(raw?.clipFrame) ? raw.clipFrame : 'off';
  return {bubble: {mode}, scan, theme, layout, textScale, headingScale, font, showIcons, clipFrame, zones};
}

function isZone(z: any): z is Zone {
  return z && ['shortcuts', 'stars', 'keywords', 'apps', 'recent', 'clock', 'search', 'status', 'nav', 'clips', 'spacer'].includes(z.type);
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
      // A higher count can't show more than the device tracks; clamp to [1, RECENT_MAX].
      return {...z, count: Math.min(RECENT_MAX, Math.max(1, typeof z.count === 'number' ? z.count : RECENT_MAX))};
    case 'clock': {
      const extras: ClockExtra[] = Array.isArray(z.extras)
        ? z.extras
            .filter((e: any) => e && typeof e.offset === 'number')
            .map((e: any) => ({label: typeof e.label === 'string' ? e.label : '', offset: e.offset}))
            .slice(0, 6)
        : [];
      return {
        ...z,
        style: ['large', 'compact', 'weekday', 'jumbo', 'mono', 'stamp'].includes(z.style) ? z.style : 'large',
        hour24: z.hour24 !== false, // default: 24-hour
        showDate: z.showDate !== false, // default: show the date
        weekNum: ['iso', 'us'].includes(z.weekNum) ? z.weekNum : 'off',
        extras,
      };
    }
    case 'search':
      return {...z, folders: arr(z.folders)}; // empty = whole device
    case 'status':
    case 'nav':
      return {...z};
    case 'clips':
      return {
        ...z,
        folders: arr(z.folders),
        labels: arr(z.labels),
        sort: ['new', 'old', 'label', 'note'].includes(z.sort) ? z.sort : 'new',
        size: ['S', 'M', 'L'].includes(z.size) ? z.size : 'M',
      };
    case 'spacer':
      return {...z}; // empty block; height comes from `h` (set in normalize)
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
