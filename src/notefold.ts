/**
 * Per-notebook fold state inside the Stars and Keywords blocks (tap a notebook's
 * name to fold/unfold its stars or keywords). Persisted in the plugin-private
 * dir so a long list stays folded across dashboard opens, without growing
 * config.json with note paths.
 *
 * Stored as the notebooks whose state DIFFERS from the block's default
 * ("Notebooks: expanded / collapsed by default"), so flipping that default
 * doesn't need a migration.
 */
import {NativeModules} from 'react-native';
import {useEffect, useState} from 'react';

import {cacheDir} from './paths';

const {DashboardNative} = NativeModules;
const FILE = 'notefold.json';
const MAX_PER_KIND = 500; // bound the file; oldest flips drop first

type Kind = 'stars' | 'keywords';
let mem: Record<Kind, string[]> | null = null;

async function load(): Promise<Record<Kind, string[]>> {
  if (mem) return mem;
  mem = {stars: [], keywords: []};
  try {
    const dir = await cacheDir();
    const text: string = await DashboardNative.readTextFile(dir + FILE);
    const obj = text && text.trim() ? JSON.parse(text) : null;
    for (const k of ['stars', 'keywords'] as Kind[]) {
      if (Array.isArray(obj?.[k])) mem[k] = obj[k].filter((p: any) => typeof p === 'string');
    }
  } catch {
    /* none yet */
  }
  return mem;
}

async function save(): Promise<void> {
  if (!mem) return;
  try {
    const dir = await cacheDir();
    await DashboardNative.writeFile(dir + FILE, JSON.stringify(mem));
  } catch {
    /* best-effort */
  }
}

/** Fold state for one block kind. `isFolded(path)` = this notebook's group is
 *  folded; `toggle(path)` flips it and persists. */
export function useNoteFold(kind: Kind, foldedByDefault: boolean) {
  const [flipped, setFlipped] = useState<Set<string>>(() => new Set(mem?.[kind] ?? []));
  useEffect(() => {
    load().then(m => setFlipped(new Set(m[kind])));
  }, [kind]);
  const isFolded = (path: string) => foldedByDefault !== flipped.has(path);
  const toggle = (path: string) => {
    const next = new Set(flipped);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setFlipped(next);
    load().then(m => {
      const list = [...next];
      m[kind] = list.length > MAX_PER_KIND ? list.slice(list.length - MAX_PER_KIND) : list;
      save();
    });
  };
  // `state` changes only when a fold changes: use it as a memo dependency.
  return {isFolded, toggle, state: flipped};
}

export type NoteFold = ReturnType<typeof useNoteFold>;
