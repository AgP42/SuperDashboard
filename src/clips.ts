/**
 * Note Clips store: snippets lassoed from a note and "added to Dashboard".
 * Each clip is a PNG (a sticker thumbnail) kept in the plugin's PRIVATE dir,
 * plus a backlink to its source note+page and any labels. Persisted to
 * clips.json (private, not cloud-synced). Capped at MAX_CLIPS (oldest pruned).
 */
import {NativeModules} from 'react-native';

import {cacheDir} from './paths';

const {DashboardNative} = NativeModules;
const CLIPS_FILE = 'clips.json';
const MAX_CLIPS = 200;

export interface Clip {
  id: string;
  png: string; // private-dir PNG path (the thumbnail)
  sourcePath: string; // note it came from
  sourcePage: number; // RAW firmware page (from getCurrentPageNum), round-tripped to openFile
  w?: number; // clip pixel size: the dashboard renders at natural size, never upscaled
  h?: number;
  labels: string[];
  createdAt: number;
}

let mem: Clip[] | null = null;

function isClip(c: any): c is Clip {
  return c && typeof c.id === 'string' && typeof c.png === 'string' && typeof c.sourcePath === 'string';
}

async function load(): Promise<Clip[]> {
  if (mem) return mem;
  mem = [];
  try {
    const dir = await cacheDir();
    const text: string = await DashboardNative.readTextFile(dir + CLIPS_FILE);
    if (text && text.trim()) {
      const obj = JSON.parse(text);
      mem = (obj.clips ?? []).filter(isClip).map((c: any) => ({...c, labels: Array.isArray(c.labels) ? c.labels : []}));
    }
  } catch {
    /* none yet */
  }
  return mem!;
}

async function persist(): Promise<void> {
  try {
    const dir = await cacheDir();
    await DashboardNative.writeFile(dir + CLIPS_FILE, JSON.stringify({version: 1, clips: mem ?? []}));
  } catch {
    /* best-effort */
  }
}

/** Delete a clip's image file(s) from the private dir (clip_<id>.png / .sticker). */
async function deleteFiles(id: string): Promise<void> {
  try {
    const dir = await cacheDir();
    await DashboardNative.pruneMatching?.(dir, `clip_${id}.`, '');
  } catch {
    /* ignore */
  }
}

export async function listClips(): Promise<Clip[]> {
  return (await load()).slice().sort((a, b) => b.createdAt - a.createdAt); // newest first
}

/** Add a clip; prune the oldest beyond MAX_CLIPS (and their files). Used by the
 *  capture flow in index.js. */
export async function addClip(c: Clip): Promise<void> {
  const arr = await load();
  arr.push({...c, labels: c.labels ?? []});
  arr.sort((a, b) => a.createdAt - b.createdAt); // oldest first for pruning
  while (arr.length > MAX_CLIPS) {
    const old = arr.shift();
    if (old) await deleteFiles(old.id);
  }
  mem = arr;
  await persist();
}

export async function deleteClip(id: string): Promise<void> {
  const arr = await load();
  mem = arr.filter(c => c.id !== id);
  await deleteFiles(id);
  await persist();
}

export async function setClipLabels(id: string, labels: string[]): Promise<void> {
  const arr = await load();
  const c = arr.find(x => x.id === id);
  if (!c) return;
  c.labels = labels;
  mem = arr;
  await persist();
}

/** Distinct labels across all clips (for the config filter picker). */
export async function allClipLabels(): Promise<string[]> {
  const set = new Set<string>();
  for (const c of await load()) for (const l of c.labels) set.add(l);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** A short, reasonably unique id (device code; Date/Math are fine here). */
export function clipId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
