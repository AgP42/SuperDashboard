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

/** A capture is either a reference (`clip`) or a task (`todo`). Same capture
 *  pipeline, same storage; only the block that shows it differs. */
export type ClipKind = 'clip' | 'todo';

export interface Clip {
  id: string;
  png: string; // private-dir PNG path (the thumbnail)
  sourcePath: string; // note it came from
  sourcePage: number; // RAW firmware page (from getCurrentPageNum), round-tripped to openFile
  sourcePageId?: string; // stable .note PAGEID of that page, so the backlink follows it across reorder/move (absent on clips captured before this, or when unreadable)
  text?: string; // OCR text (when captured in 'ocr' mode); pasted as an editable text box. Absent = handwriting clip (image). Empty OCR falls back to the image.
  w?: number; // clip pixel size: the dashboard renders at natural size, never upscaled
  h?: number;
  labels: string[];
  kind: ClipKind;
  /** Only meaningful when kind === 'todo': false = open, true = ticked off. */
  done?: boolean;
  /** Number printed as "#N" beside the tick-box on the note. THIS is the handle:
   *  element uuids are re-generated on every read, so the only durable way to
   *  point at a mark is to write something readable on the page and look it up by
   *  its text. Absent when the capture drew no frame. */
  markNum?: number;
  /** Where the tick-box was last seen (page pixels), to break ties and to know
   *  where to look for a hand-drawn tick. */
  boxRect?: {left: number; top: number; right: number; bottom: number};
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
      mem = (obj.clips ?? []).filter(isClip).map((c: any) => ({
        ...c,
        labels: Array.isArray(c.labels) ? c.labels : [],
        // Before to-dos had their own block, a task was an ordinary clip
        // carrying `done`. Anything else is a plain clip.
        kind: c.kind === 'todo' || (c.kind === undefined && c.done !== undefined) ? 'todo' : 'clip',
      }));
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
  arr.push({...c, labels: c.labels ?? [], kind: c.kind ?? 'clip'});
  arr.sort((a, b) => a.createdAt - b.createdAt); // oldest first for pruning
  // Prune the oldest ORDINARY clips only: a to-do was an explicit decision, so it
  // is never dropped to make room. If everything is a to-do the list grows past
  // the cap rather than losing one.
  while (arr.length > MAX_CLIPS) {
    const i = arr.findIndex(c2 => c2.kind !== 'todo');
    if (i < 0) break;
    const [old] = arr.splice(i, 1);
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

/** Self-heal a clip's source when its page was found (by stable PAGEID) in a
 *  different note or a new index. Keeps sourcePageId (the stable anchor). */
export async function updateClipSource(id: string, sourcePath: string, sourcePage: number): Promise<void> {
  const arr = await load();
  const c = arr.find(x => x.id === id);
  if (!c || (c.sourcePath === sourcePath && c.sourcePage === sourcePage)) return;
  c.sourcePath = sourcePath;
  c.sourcePage = sourcePage;
  mem = arr;
  await persist();
}

/** Tick a to-do off, or re-open it. */
export async function setClipDone(id: string, done: boolean): Promise<void> {
  const arr = await load();
  const c = arr.find(x => x.id === id);
  if (!c || c.done === done) return;
  c.done = done;
  mem = arr;
  await persist();
}

/** Move a capture between the Clips block and the To-do block. A capture that
 *  becomes a to-do starts out open; one that becomes a clip forgets its state. */
export async function setClipKind(id: string, kind: ClipKind): Promise<void> {
  const arr = await load();
  const c = arr.find(x => x.id === id);
  if (!c || c.kind === kind) return;
  c.kind = kind;
  if (kind === 'todo') c.done = c.done ?? false;
  else delete c.done;
  mem = arr;
  await persist();
}

/** Re-point a clip/to-do at where its mark was actually found (deep search): a
 *  new note/page and its stable PAGEID, so the fast path works again next time. */
export async function reanchorClip(id: string, sourcePath: string, sourcePage: number, sourcePageId: string): Promise<void> {
  const arr = await load();
  const c = arr.find(x => x.id === id);
  if (!c) return;
  c.sourcePath = sourcePath;
  c.sourcePage = sourcePage;
  if (sourcePageId) c.sourcePageId = sourcePageId;
  mem = arr;
  await persist();
}

/** Remember where the tick-box was last seen, so a later lookup can break ties
 *  between identically-sized boxes on the same page. */
export async function setClipBoxRect(id: string, r: {left: number; top: number; right: number; bottom: number}): Promise<void> {
  const arr = await load();
  const c = arr.find(x => x.id === id);
  if (!c) return;
  c.boxRect = r;
  mem = arr;
  await persist();
}

/** Store a clip's OCR text once recognized (background OCR after capture). */
export async function updateClipText(id: string, text: string): Promise<void> {
  const arr = await load();
  const c = arr.find(x => x.id === id);
  if (!c || c.text === text) return;
  c.text = text;
  mem = arr;
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

/** Next free "#N" mark number. Small and human-readable on purpose: it is printed
 *  on the note, so it has to stay short. */
export async function nextMarkNum(): Promise<number> {
  const arr = await load();
  let max = 0;
  for (const c of arr) if (typeof c.markNum === 'number' && c.markNum > max) max = c.markNum;
  return max + 1;
}

/** A short, reasonably unique id (device code; Date/Math are fine here). */
export function clipId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
