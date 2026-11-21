/**
 * Relay tasks feed (read-only).
 *
 * Relay (a third-party macOS app by u/stuffimadeuk) mirrors the user's Supernote
 * to-dos and drops a JSON snapshot on the device through Supernote Cloud sync:
 *   /storage/emulated/0/MyStyle/Plugins/Relay/relay-tasks.json
 * SuperDashboard only READS it — nothing leaves the device, nothing is written
 * back. Spec: "Relay Tasks File Spec (v1)" (schema "relay-tasks", schemaVersion 1).
 *
 * Robustness (per the spec): Relay replaces the file by delete + upload, so it
 * can be briefly missing or half-synced. The last good copy is kept (memory +
 * plugin-private cache) and shown instead, flagged as such.
 *
 * Privacy: task titles/details are never logged (same rule as the debug log, #6).
 */
import {NativeModules} from 'react-native';

import {cacheDir} from './paths';

const {DashboardNative} = NativeModules;

export const RELAY_PATH = '/storage/emulated/0/MyStyle/Plugins/Relay/relay-tasks.json';
const LAST_GOOD_FILE = 'relay-last-good.json';
export const RELAY_SCHEMA = 'relay-tasks';
export const RELAY_MAX_VERSION = 1;

export interface RelayList {
  id: string;
  name: string;
  order: number;
}
export interface RelayNote {
  path: string;
  name: string;
  /** 1-based, as in the spec (our openFile() takes 1-based too). */
  page: number;
}
export interface RelayTask {
  id: string;
  listId: string;
  list: string;
  title: string;
  detail: string;
  done: boolean;
  /** 'YYYY-MM-DD' (day only) or null. */
  due: string | null;
  important: boolean;
  reminder: boolean;
  completedAt: string | null;
  lastModified: string | null;
  note: RelayNote | null;
}
export interface RelayFeed {
  generatedAt: string | null;
  generator: string;
  lists: RelayList[];
  tasks: RelayTask[];
}

export type RelayParse = {ok: true; feed: RelayFeed} | {ok: false; reason: 'bad-json' | 'bad-schema' | 'too-new'; version?: number};

const str = (v: any, d = ''): string => (typeof v === 'string' ? v : d);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Parse + validate a relay-tasks.json text. Lenient on optional fields (unknown
 *  fields ignored, bad optional values dropped), strict on the envelope. Tasks
 *  missing an id or title are skipped rather than failing the whole file. */
export function parseRelay(text: string): RelayParse {
  let raw: any;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return {ok: false, reason: 'bad-json'};
  }
  if (!raw || typeof raw !== 'object' || raw.schema !== RELAY_SCHEMA) return {ok: false, reason: 'bad-schema'};
  const ver = Number(raw.schemaVersion);
  if (!Number.isFinite(ver) || ver < 1) return {ok: false, reason: 'bad-schema'};
  if (Math.floor(ver) > RELAY_MAX_VERSION) return {ok: false, reason: 'too-new', version: ver};

  const lists: RelayList[] = (Array.isArray(raw.lists) ? raw.lists : [])
    .filter((l: any) => l && typeof l.id === 'string')
    .map((l: any, i: number) => ({id: l.id, name: str(l.name, l.id), order: typeof l.order === 'number' ? l.order : i}));

  const tasks: RelayTask[] = [];
  for (const t of Array.isArray(raw.tasks) ? raw.tasks : []) {
    if (!t || typeof t.id !== 'string' || typeof t.title !== 'string') continue;
    const n = t.note;
    const note: RelayNote | null =
      n && typeof n.path === 'string' && n.path
        ? {
            path: n.path,
            name: str(n.name) || n.path.replace(/^.*\//, '').replace(/\.note$/i, ''),
            page: typeof n.page === 'number' && n.page >= 1 ? Math.floor(n.page) : 1,
          }
        : null;
    tasks.push({
      id: t.id,
      listId: str(t.listId, 'inbox'),
      list: str(t.list),
      title: t.title,
      detail: str(t.detail),
      done: t.done === true,
      due: typeof t.due === 'string' && DAY.test(t.due) ? t.due : null,
      // Spec: importance passed through as-is; "0" = normal, anything else = important.
      important: t.importance != null && String(t.importance) !== '0' && String(t.importance) !== '',
      reminder: t.reminder === true,
      completedAt: typeof t.completedAt === 'string' ? t.completedAt : null,
      lastModified: typeof t.lastModified === 'string' ? t.lastModified : null,
      note,
    });
  }
  return {ok: true, feed: {generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : null, generator: str(raw.generator), lists, tasks}};
}

export type RelayStatus = 'ok' | 'stale-copy' | 'missing' | 'unreadable' | 'too-new';
export interface RelayState {
  status: RelayStatus;
  feed: RelayFeed | null;
  /** For 'too-new': the schemaVersion found. */
  version?: number;
}

let mem: RelayFeed | null = null;

async function readText(path: string): Promise<string | null> {
  try {
    const t: string = await DashboardNative.readTextFile(path);
    return t && t.trim() ? t : null;
  } catch {
    return null;
  }
}

async function lastGood(): Promise<RelayFeed | null> {
  if (mem) return mem;
  const t = await readText((await cacheDir()) + LAST_GOOD_FILE);
  const p = t ? parseRelay(t) : null;
  if (p && p.ok) mem = p.feed;
  return mem;
}

/** Read the feed. On a missing/broken file, fall back to the last good copy
 *  ('stale-copy'); only report missing/unreadable when there's nothing to show. */
export async function loadRelay(): Promise<RelayState> {
  const text = await readText(RELAY_PATH);
  if (text) {
    const p = parseRelay(text);
    if (p.ok) {
      mem = p.feed;
      try {
        await DashboardNative.writeFile((await cacheDir()) + LAST_GOOD_FILE, text);
      } catch {
        /* cache is best-effort */
      }
      return {status: 'ok', feed: p.feed};
    }
    if (p.reason === 'too-new') return {status: 'too-new', feed: null, version: p.version};
    const prev = await lastGood();
    return prev ? {status: 'stale-copy', feed: prev} : {status: 'unreadable', feed: null};
  }
  const prev = await lastGood();
  return prev ? {status: 'stale-copy', feed: prev} : {status: 'missing', feed: null};
}

// ---- Date helpers (local time; due is a day without time of day) ----------

const pad = (n: number) => (n < 10 ? '0' + n : String(n));
export const dayKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export type DueBucket = 'overdue' | 'today' | 'tomorrow' | 'week' | 'later' | 'none';

export function dueBucket(due: string | null, now: Date = new Date()): DueBucket {
  if (!due) return 'none';
  const today = dayKey(now);
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  const t1 = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (due === dayKey(t1)) return 'tomorrow';
  const t7 = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7);
  return due <= dayKey(t7) ? 'week' : 'later';
}

export const BUCKET_LABELS: Record<DueBucket, string> = {
  overdue: 'Overdue',
  today: 'Today',
  tomorrow: 'Tomorrow',
  week: 'Next 7 days',
  later: 'Later',
  none: 'No date',
};

/** Short due label for a row: "today", "tomorrow", "Mon 24", "24 Nov 2027". */
export function dueLabel(due: string, now: Date = new Date()): string {
  const b = dueBucket(due, now);
  if (b === 'today') return 'today';
  if (b === 'tomorrow') return 'tomorrow';
  const [y, m, d] = due.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getDay()];
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1];
  if (b === 'week') return `${wd} ${d}`;
  return y === now.getFullYear() ? `${d} ${mo}` : `${d} ${mo} ${y}`;
}

/** "just now" / "5 min ago" / "3 h ago" / "2 d ago" for the feed's generatedAt. */
export function ageLabel(iso: string | null, now: number = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return 'unknown';
  const min = Math.max(0, Math.floor((now - t) / 60000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
