/**
 * Dashboard zone rendering: shortcuts / stars / keywords / apps.
 * A `theme` (ledger / boxed / airy) controls the visual shell via ZoneFrame;
 * the list bodies are shared. Stars & keywords use a per-session cache.
 */
import React, {useContext, useEffect, useMemo, useState} from 'react';
import {DeviceEventEmitter, Image, Modal, NativeModules, StyleSheet, Text, TextInput, TouchableOpacity, View} from 'react-native';

import {BLOCK_HEIGHTS, KeywordDisplay, RECENT_MAX, ScanSettings, Theme, Zone, ZONE_ICONS} from './config';
import {openFile, openFileAtPage, openFolder, launchApp} from './open';
import {deleteStarByIndex, LineImg} from './starText';
import {NativeUIUtils} from 'sn-plugin-lib';
import {scanStars, scanKeywords, flushCurrentNote, noteTitle, parentFolder, KeywordHit} from './scanner';
import {readRecent} from './recent';
import {loadIndex, loadKeywords, loadStarredFiles, loadStats, buildIndex, runSearch, IndexData, IndexEntry, KwEntry} from './searchIndex';
import {ClockFace} from './clock';
import {Clip, listClips, deleteClip, setClipLabels, allClipLabels} from './clips';

const {DashboardNative} = NativeModules;
import {getStars, setStars, getKeywords, setKeywords, formatScanTime, shouldAutoScan} from './scancache';
import {fileGlyph, ThemedButton, ui} from './ui';

/** Scaled style overrides for tappable text (bigger targets = fewer mis-taps). */
export interface TScale {
  s: number;
  /** Zone-title multiplier (1 = the historical look); applied to each theme's base size. */
  hs: number;
  /** User font family (registered from MyStyle/fonts), or undefined for system default. */
  font?: string;
  item: object;
  page: object;
  chip: object;
  head: object;
  app: object;
}
export function tscale(s: number, hs = 1, font?: string): TScale {
  const ff = font ? {fontFamily: font} : {};
  return {
    s,
    hs,
    font,
    item: {fontSize: 14 * s, paddingVertical: 6 * s, ...ff},
    page: {fontSize: 13 * s, paddingVertical: 4 * s, ...ff},
    chip: {fontSize: 13 * s, paddingVertical: 4 * s, paddingHorizontal: 11 * s, ...ff},
    head: {fontSize: 14 * s, marginTop: 6 * s, ...ff},
    app: {fontSize: 14 * s, paddingVertical: 6 * s, paddingHorizontal: 12 * s, ...ff},
  };
}

/** What other zones need, so the first scan can warm both dimensions in one pass. */
export interface Siblings {
  stars: boolean;
  keywords: boolean;
}

export function ZoneView({
  zone,
  scan,
  theme,
  ts,
  nonce,
  sib,
  index,
  onToggleCollapse,
  showIcons,
  columns,
}: {
  zone: Zone;
  scan: ScanSettings;
  theme: Theme;
  ts: TScale;
  nonce?: number;
  sib?: Siblings;
  index?: number;
  onToggleCollapse?: (i: number) => void;
  showIcons?: boolean;
  columns?: number;
}) {
  const inner = (() => {
    switch (zone.type) {
      case 'shortcuts':
        return <ShortcutsZone zone={zone} theme={theme} ts={ts} />;
      case 'stars':
        return <StarsZone zone={zone} scan={scan} theme={theme} ts={ts} sib={sib} nonce={nonce} />;
      case 'keywords':
        return <KeywordsZone zone={zone} scan={scan} theme={theme} ts={ts} sib={sib} nonce={nonce} />;
      case 'apps':
        return <AppsZone zone={zone} theme={theme} ts={ts} />;
      case 'recent':
        return <RecentZone zone={zone} theme={theme} ts={ts} nonce={nonce} />;
      case 'clock':
        return <ClockZone zone={zone} theme={theme} ts={ts} />;
      case 'search':
        return <SearchZone zone={zone} theme={theme} ts={ts} nonce={nonce} />;
      case 'status':
        return <StatusZone zone={zone} theme={theme} ts={ts} nonce={nonce} />;
      case 'nav':
        return <NavZone zone={zone} theme={theme} ts={ts} nonce={nonce} />;
      case 'clips':
        return <ClipsZone zone={zone} theme={theme} ts={ts} nonce={nonce} columns={columns} />;
      case 'spacer':
        return <View style={{height: BLOCK_HEIGHTS[zone.h ?? 'M']}} />;
    }
  })();
  return (
    <ZoneChromeContext.Provider
      value={{
        collapsed: zone.collapsed,
        onToggle: onToggleCollapse && index !== undefined && zone.type !== 'spacer' ? () => onToggleCollapse(index) : undefined,
        icon: showIcons ? ZONE_ICONS[zone.type] : undefined,
      }}>
      {inner}
    </ZoneChromeContext.Provider>
  );
}

// ---- Search (indexed name search: files, folders, keywords) ----------------
function SearchZone({zone, theme, ts, nonce}: {zone: Extract<Zone, {type: 'search'}>; theme: Theme; ts: TScale; nonce?: number}) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState<IndexData | null>(null);
  const [kws, setKws] = useState<KwEntry[]>([]);
  const [starred, setStarred] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Load the persisted snapshot (instant); loadIndex refreshes in the background.
    loadIndex().then(setIdx).catch(() => {});
    loadKeywords().then(setKws).catch(() => {});
    loadStarredFiles().then(setStarred).catch(() => {});
  }, [nonce]);

  const roots = zone.folders;
  const rootsKey = (roots ?? []).join('|');
  const res = useMemo(() => runSearch(idx, kws, q, {roots, starred}), [idx, kws, q, rootsKey, starred]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = res.folders.length + res.notes.length + res.pdfs.length + res.docs.length + res.keywords.length;

  const rebuild = async () => {
    setBusy(true);
    try {
      setIdx(await buildIndex());
      setKws(await loadKeywords());
      setStarred(await loadStarredFiles());
    } catch {
      /* ignore */
    }
    setBusy(false);
  };

  const s = ts.s;

  return (
    <ZoneFrame theme={theme} hs={ts.hs} font={ts.font} title={zoneTitle(zone.title, 'Search')}>
      <View style={ui.searchBar}>
        <Text style={{fontSize: 15 * s, color: '#555'}}>🔍</Text>
        <TextInput
          style={[ui.searchInput, {fontSize: 15 * s}]}
          value={q}
          onChangeText={setQ}
          placeholder="Files, folders, keywords…"
          placeholderTextColor="#9a9a9a"
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
        />
        {q.length > 0 && (
          <TouchableOpacity onPress={() => setQ('')} style={ui.searchClear}>
            <Text style={{fontSize: 16 * s, color: '#555'}}>✕</Text>
          </TouchableOpacity>
        )}
        <ThemedButton theme={theme} s={ts.s} font={ts.font} disabled={busy} label={busy ? '…' : '↻'} onPress={rebuild} />
      </View>

      <Text style={[ui.metaMono, {marginBottom: 6}]}>
        {roots && roots.length ? `scope: ${roots.length} folder${roots.length > 1 ? 's' : ''} · ` : ''}"phrase" =exact a|b !x f: kw: star: type: approx:
      </Text>

      {q.length > 0 && total === 0 && !busy && (
        <Text style={ui.empty}>No match{idx?.truncated ? ' (index is capped; try ↻ or a narrower name)' : ''}.</Text>
      )}

      {res.folders.length > 0 && (
        <View style={ui.searchGroup}>
          <Text style={[ui.searchGroupLabel, {fontSize: 11 * s}]}>Folders</Text>
          {res.folders.map((f, i) => (
            <SearchRow key={'d' + i} icon="📁" label={f.name} sub={parentFolder(f.path)} onPress={() => openFolder(f.path)} s={s} font={ts.font} />
          ))}
        </View>
      )}
      <FileGroup label="Notes" items={res.notes} s={s} font={ts.font} />
      <FileGroup label="PDFs" items={res.pdfs} s={s} font={ts.font} />
      <FileGroup label="Documents" items={res.docs} s={s} font={ts.font} />
      {res.keywords.length > 0 && (
        <View style={ui.searchGroup}>
          <Text style={[ui.searchGroupLabel, {fontSize: 11 * s}]}>Keywords</Text>
          {res.keywords.map((k, i) => (
            <SearchRow key={'k' + i} icon="#" label={k.keyword} sub={`${noteTitle(k.file)} · p.${k.page}`} onPress={() => openFile(k.file, k.page)} s={s} font={ts.font} />
          ))}
        </View>
      )}
    </ZoneFrame>
  );
}

/** One tappable search result row (folder / keyword). Module-level so it isn't
 *  re-created (hence remounting the whole result list) on every keystroke. */
function SearchRow({icon, label, sub, onPress, s, font}: {icon: string; label: string; sub?: string; onPress: () => void; s: number; font?: string}) {
  const ff = font ? {fontFamily: font} : null;
  return (
    <TouchableOpacity style={ui.searchRow} onPress={onPress}>
      <Text style={[ui.searchIcon, {fontSize: 15 * s}]}>{icon}</Text>
      <Text style={[ui.searchName, {fontSize: 14 * s}, ff]} numberOfLines={1}>
        {label}
      </Text>
      {sub ? (
        <Text style={[ui.searchPath, {fontSize: 11 * s}, ff]} numberOfLines={1}>
          {sub}
        </Text>
      ) : null}
    </TouchableOpacity>
  );
}

/** A titled group of file results (notes / pdfs / documents), each row opens the file. */
function FileGroup({label, items, s, font}: {label: string; items: IndexEntry[]; s: number; font?: string}) {
  if (!items.length) return null;
  const ff = font ? {fontFamily: font} : null;
  return (
    <View style={ui.searchGroup}>
      <Text style={[ui.searchGroupLabel, {fontSize: 11 * s}]}>{label}</Text>
      {items.map((f, i) => (
        <TouchableOpacity key={label + i} style={ui.searchRow} onPress={() => openFile(f.path, 0)}>
          <Text style={[ui.searchIcon, {fontSize: 15 * s}]}>{fileGlyph(f.path)}</Text>
          <Text style={[ui.searchName, {fontSize: 14 * s}, ff]} numberOfLines={1}>
            {f.name}
          </Text>
          <Text style={[ui.searchPath, {fontSize: 11 * s}, ff]} numberOfLines={1}>
            {parentFolder(f.path)}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ---- Clock (current time + date); face lives in clock.tsx (shared with Settings preview)
function ClockZone({zone, theme, ts}: {zone: Extract<Zone, {type: 'clock'}>; theme: Theme; ts: TScale}) {
  return (
    <ZoneFrame theme={theme} hs={ts.hs} font={ts.font} title={zoneTitle(zone.title, 'Clock')}>
      <ClockFace
        style={zone.style ?? 'large'}
        hour24={zone.hour24 !== false}
        s={ts.s}
        font={ts.font}
        locale={zone.locale}
        showDate={zone.showDate !== false}
        weekNum={zone.weekNum ?? 'off'}
        extras={zone.extras}
      />
    </ZoneFrame>
  );
}

// ---- Status device (battery / storage / device info / stats) --------------
function fmtGB(bytes: number): string {
  if (!bytes || bytes < 0) return '-';
  const gb = bytes / 1e9;
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}
function StatusZone({zone, theme, ts, nonce}: {zone: Extract<Zone, {type: 'status'}>; theme: Theme; ts: TScale; nonce?: number}) {
  const [bat, setBat] = useState<any>(null);
  const [sto, setSto] = useState<any>(null);
  const [stats, setStats] = useState<{notes: number; pdfs: number; stars: number; keywords: number} | null>(null);
  useEffect(() => {
    if (zone.battery) DashboardNative?.getBattery?.().then(setBat).catch(() => {});
    if (zone.storage) DashboardNative?.getStorage?.().then(setSto).catch(() => {});
    if (zone.stats) loadStats().then(setStats).catch(() => {});
  }, [nonce, zone.battery, zone.storage, zone.stats]);
  const s = ts.s;
  const ff = ts.font ? {fontFamily: ts.font} : null;
  const line = (txt: string, key: string) => <Text key={key} style={[ui.listItem, {fontSize: 14 * s}, ff]}>{txt}</Text>;
  const rows: React.ReactNode[] = [];
  if (zone.battery && bat) rows.push(line(`🔋 Battery: ${bat.level >= 0 ? bat.level + '%' : '-'}${bat.charging ? ' ⚡ charging' : ''}`, 'bat'));
  if (zone.storage && sto) {
    rows.push(line(`💾 Internal: ${fmtGB(sto.internalFree)} free / ${fmtGB(sto.internalTotal)}`, 'in'));
    if (sto.hasSd) rows.push(line(`💾 SD card: ${fmtGB(sto.sdFree)} free / ${fmtGB(sto.sdTotal)}`, 'sd'));
  }
  if (zone.stats && stats) rows.push(line(`📊 ${stats.notes} notes · ${stats.pdfs} pdf · ${stats.stars} ★ · ${stats.keywords} kw`, 'st'));
  return (
    <ZoneFrame theme={theme} hs={ts.hs} font={ts.font} title={zoneTitle(zone.title, 'Device')}>
      {rows.length ? rows : <Text style={ui.empty}>…</Text>}
    </ZoneFrame>
  );
}

// ---- Navigation (a mini file browser rooted at a folder) ------------------
interface NavEntry {
  name: string;
  path: string;
  isDir: boolean;
  mtime: number;
}
const NAV_EXT = /\.(note|pdf|epub|cbz|xps|fb2)$/i;
function NavZone({zone, theme, ts, nonce}: {zone: Extract<Zone, {type: 'nav'}>; theme: Theme; ts: TScale; nonce?: number}) {
  const root = zone.root || '/storage/emulated/0';
  const [dir, setDir] = useState(root);
  const [entries, setEntries] = useState<NavEntry[]>([]);
  useEffect(() => setDir(root), [root, nonce]);
  useEffect(() => {
    DashboardNative.listDir(dir)
      .then((x: NavEntry[]) => setEntries((x ?? []).filter(e => e.isDir || NAV_EXT.test(e.name))))
      .catch(() => setEntries([]));
  }, [dir]);
  const s = ts.s;
  const ff = ts.font ? {fontFamily: ts.font} : null;
  const atRoot = dir === root;
  const goUp = () => {
    if (atRoot) return;
    const p = dir.replace(/\/+$/, '');
    const parent = p.substring(0, p.lastIndexOf('/'));
    setDir(parent.length >= root.length ? parent : root);
  };
  const sorted = [...entries]
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
    .slice(0, 200);
  const rel = dir === root ? '/' : dir.slice(root.length) || '/';
  return (
    <ZoneFrame theme={theme} hs={ts.hs} font={ts.font} title={zoneTitle(zone.title, 'Files')}>
      <View style={ui.searchRow}>
        <TouchableOpacity onPress={goUp} style={[ui.miniBtn, {marginLeft: 0, opacity: atRoot ? 0.4 : 1}]}>
          <Text style={ui.miniBtnText}>⬆</Text>
        </TouchableOpacity>
        <Text style={[ui.searchPath, {fontSize: 11 * s, marginLeft: 8}, ff]} numberOfLines={1}>
          {rel}
        </Text>
      </View>
      {sorted.length === 0 && <Text style={ui.empty}>empty folder</Text>}
      {sorted.map((e, i) => (
        <TouchableOpacity key={i} style={ui.searchRow} onPress={() => (e.isDir ? setDir(e.path) : openFile(e.path, 0))}>
          <Text style={[ui.searchIcon, {fontSize: 15 * s}]}>{e.isDir ? '📁' : fileGlyph(e.path)}</Text>
          <Text style={[ui.searchName, {fontSize: 14 * s}, ff]} numberOfLines={1}>
            {e.name}
          </Text>
        </TouchableOpacity>
      ))}
    </ZoneFrame>
  );
}

// ---- Clips (snippets lassoed from notes → "Add to Dashboard") -------------
function ClipsZone({zone, theme, ts, nonce, columns}: {zone: Extract<Zone, {type: 'clips'}>; theme: Theme; ts: TScale; nonce?: number; columns?: number}) {
  const [clips, setClips] = useState<Clip[]>([]);
  const [editing, setEditing] = useState<Clip | null>(null);
  const reload = () => listClips().then(setClips).catch(() => {});
  useEffect(() => {
    reload();
    const sub = DeviceEventEmitter.addListener('dashboard_refresh_all', reload);
    return () => sub.remove();
  }, [nonce]);

  const folders = zone.folders ?? [];
  const labels = zone.labels ?? [];
  const filtered = clips.filter(
    c =>
      (!folders.length || folders.some(r => c.sourcePath === r || c.sourcePath.startsWith(r.endsWith('/') ? r : r + '/'))) &&
      (!labels.length || c.labels.some(l => labels.includes(l))),
  );
  // Sort (listClips already returns newest-first, so 'new' is the identity).
  const sort = zone.sort ?? 'new';
  const shown =
    sort === 'old'
      ? [...filtered].reverse()
      : sort === 'label'
      ? [...filtered].sort((a, b) => (a.labels[0] || '￿').localeCompare(b.labels[0] || '￿') || b.createdAt - a.createdAt)
      : sort === 'note'
      ? [...filtered].sort((a, b) => noteTitle(a.sourcePath).localeCompare(noteTitle(b.sourcePath)) || a.sourcePage - b.sourcePage)
      : filtered;

  const ff = ts.font ? {fontFamily: ts.font} : null;
  const size = zone.size ?? 'M';
  // Grid packs multiple per row only in a single-column dashboard; with 2/3
  // columns the block is already narrow, so clips stack. Size drives the
  // thumbnail scale: more per row (or a narrower cell) = smaller clips. Clips
  // never upscale past their original pixels (maxWidth on the image).
  const isGrid = (zone.display ?? 'grid') === 'grid' && (columns ?? 1) === 1;
  const perRow = isGrid ? {S: 3, M: 2, L: 1}[size] : 1;
  const cellW: any = perRow > 1 ? `${Math.floor(100 / perRow)}%` : {S: '55%', M: '80%', L: '100%'}[size];

  const del = async (id: string) => {
    const ok = await NativeUIUtils.showRattaDialog('Delete this clip?', 'Cancel', 'Delete', false).catch(() => false);
    if (ok) {
      await deleteClip(id);
      reload();
    }
  };
  const saveLabels = async (id: string, next: string[]) => {
    await setClipLabels(id, next);
    await reload();
    setEditing(e => (e && e.id === id ? {...e, labels: next} : e));
  };

  return (
    <ZoneFrame theme={theme} hs={ts.hs} font={ts.font} title={zoneTitle(zone.title, 'Clips')} meta={shown.length ? String(shown.length) : undefined}>
      {shown.length === 0 && <Text style={ui.empty}>No clips yet: lasso a note and tap “Add to Dashboard”.</Text>}
      <View style={{flexDirection: 'row', flexWrap: 'wrap'}}>
        {shown.map(c => (
          <View key={c.id} style={{width: cellW, padding: 4}}>
            {/* Fill the cell but never upscale past the original extract (maxWidth
                = the clip's own pixel width); height follows its aspect ratio. */}
            <TouchableOpacity onPress={() => openFileAtPage(c.sourcePath, c.sourcePage)} activeOpacity={0.7}>
              <Image
                source={{uri: 'file://' + c.png}}
                style={{
                  width: '100%',
                  maxWidth: c.w || 480,
                  aspectRatio: c.w && c.h ? c.w / c.h : 1.6,
                  borderWidth: 1,
                  borderColor: '#000000',
                  borderRadius: 6,
                  backgroundColor: '#ffffff',
                }}
                resizeMode="contain"
              />
            </TouchableOpacity>
            <View style={{flexDirection: 'row', alignItems: 'flex-start', marginTop: 3}}>
              {/* Left group (meta · labels · 🏷). Delete ✕ is pushed to the far
                  right by flex:1 so a label tap can't land on it by mistake. */}
              <View style={{flex: 1, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center'}}>
                <Text style={[ui.metaMono, ff, {marginRight: 6}]} numberOfLines={1}>
                  {noteTitle(c.sourcePath)}{c.sourcePage >= 0 ? ` · p.${c.sourcePage + 1}` : ''}
                </Text>
                {/* Labels are read-only here (no accidental removal); manage via 🏷. */}
                {c.labels.map(l => (
                  <Text key={l} style={[ui.clipChip, ff]}>{l}</Text>
                ))}
                <TouchableOpacity onPress={() => setEditing(c)} hitSlop={{top: 6, bottom: 6, left: 6, right: 6}}>
                  <Text style={[ui.clipAdd, ff]}>🏷</Text>
                </TouchableOpacity>
              </View>
              <TouchableOpacity onPress={() => del(c.id)} hitSlop={{top: 8, bottom: 8, left: 12, right: 8}} style={{paddingLeft: 14}}>
                <Text style={ui.clipDel}>✕</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))}
      </View>
      {editing && <ClipLabelEditor clip={editing} font={ts.font} onSave={saveLabels} onClose={() => setEditing(null)} />}
    </ZoneFrame>
  );
}

/** Deliberate label editor (SSN-style): toggle from the global label set so labels
 *  stay consistent across clips, plus a field to create a new one. A modal, so a
 *  tap can't silently drop a label off the card. */
function ClipLabelEditor({clip, font, onSave, onClose}: {clip: Clip; font?: string; onSave: (id: string, next: string[]) => void; onClose: () => void}) {
  const [all, setAll] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  useEffect(() => {
    allClipLabels().then(setAll).catch(() => {});
  }, []);
  const ff = font ? {fontFamily: font} : null;
  const sel = new Set(clip.labels);
  const toggle = (l: string) => onSave(clip.id, sel.has(l) ? clip.labels.filter(x => x !== l) : [...clip.labels, l]);
  const add = () => {
    const l = draft.trim();
    if (!l) return;
    if (!sel.has(l)) onSave(clip.id, [...clip.labels, l]);
    if (!all.includes(l)) setAll(a => [...a, l].sort((x, y) => x.localeCompare(y)));
    setDraft('');
  };
  // Union of the global set and this clip's own labels, so nothing is missing.
  const options = [...new Set([...all, ...clip.labels])].sort((a, b) => a.localeCompare(b));
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <TouchableOpacity style={ui.modalScrim} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={ui.modalCard}>
          <Text style={[ui.modalTitle, ff]}>Labels</Text>
          <View style={{flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8}}>
            {options.length === 0 && <Text style={[ui.empty, ff]}>No labels yet: add one below.</Text>}
            {options.map(l => (
              <TouchableOpacity key={l} onPress={() => toggle(l)}>
                <Text style={[sel.has(l) ? ui.clipChipOn : ui.clipChip, ff]}>{sel.has(l) ? '✓ ' : ''}{l}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={{flexDirection: 'row', alignItems: 'center'}}>
            <TextInput
              style={[ui.clipInput, ff, {flex: 1, marginTop: 0}]}
              value={draft}
              onChangeText={setDraft}
              autoCapitalize="none"
              placeholder="new label"
              placeholderTextColor="#9a9a9a"
              returnKeyType="done"
              onSubmitEditing={add}
            />
            <TouchableOpacity onPress={add}>
              <Text style={[ui.clipAdd, ff, {marginLeft: 10, marginRight: 4}]}>Add</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity onPress={onClose} style={{alignSelf: 'flex-end', marginTop: 12}}>
            <Text style={[ui.clipAdd, ff]}>Done</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

// ---- Recent (reads the device's own recently-opened list) -----------------
function RecentZone({zone, theme, ts, nonce}: {zone: Extract<Zone, {type: 'recent'}>; theme: Theme; ts: TScale; nonce?: number}) {
  const [paths, setPaths] = useState<string[] | null>(null);
  useEffect(() => {
    readRecent().then(setPaths);
    // re-read every time the dashboard is re-entered (nonce changes)
  }, [nonce]);
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('dashboard_refresh_all', () => readRecent().then(setPaths));
    return () => sub.remove();
  }, []);
  const items = (paths ?? []).slice(0, zone.count ?? RECENT_MAX); // normalize() clamps count
  const display = zone.display ?? 'list';
  return (
    <ZoneFrame theme={theme} hs={ts.hs} font={ts.font} title={zoneTitle(zone.title, 'Recent')}>
      {paths === null && <Text style={ui.empty}>loading…</Text>}
      {paths && items.length === 0 && <Text style={ui.empty}>No recent files.</Text>}
      <View style={display === 'list' ? undefined : ui.itemsWrap}>
        {items.map((p, i) => (
          <TouchableOpacity key={i} style={display === 'grid' ? ui.gridCell : undefined} onPress={() => openFile(p, 0)}>
            <Text style={[display === 'inline' ? ui.appTile : ui.listItem, ts.item]}>
              {fileGlyph(p)} {noteTitle(p)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </ZoneFrame>
  );
}

/** Themed shell around a zone's body. */
/** Section title: undefined -> the type's default label; '' -> no title (user cleared it). */
const zoneTitle = (t: string | undefined, fallback: string): string => (t === undefined ? fallback : t);

/** Per-zone chrome (collapse state + toggle + type icon), supplied by ZoneView so
 *  ZoneFrame doesn't need every zone component to thread these props. */
const ZoneChromeContext = React.createContext<{collapsed?: boolean; onToggle?: () => void; icon?: string}>({});

/** Per-theme style pieces so one render path covers all designs; cleanly
 *  supports the collapse arrow + type icon on every one. */
function frameSpec(theme: Theme, hs: number, tf: any): {frame: any; header: any; label: any; body: any; meta: any; line: string} {
  const H = {flexDirection: 'row' as const, justifyContent: 'space-between' as const, alignItems: 'center' as const};
  switch (theme) {
    case 'boxed':
      return {frame: ui.boxFrame, header: ui.boxCap, label: [ui.boxCapText, {fontSize: 13 * hs}, tf], body: ui.boxBody, meta: ui.boxCapMeta, line: '#ffffff'};
    case 'ledger':
      return {frame: ui.ledgerZone, header: ui.ledgerHead, label: [ui.ledgerLabel, {fontSize: 11 * hs}, tf], body: null, meta: ui.metaMono, line: '#000000'};
    case 'grid':
    case 'gridgray': {
      const line = theme === 'gridgray' ? '#888888' : '#000000';
      return {
        frame: {borderWidth: StyleSheet.hairlineWidth, borderColor: line, borderRadius: 3, marginBottom: 8},
        header: {...H, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: line, paddingVertical: 4, paddingHorizontal: 8},
        label: [{fontSize: 12 * hs, fontWeight: '700' as const, color: line}, tf],
        body: {paddingVertical: 6, paddingHorizontal: 8},
        meta: [ui.metaMono, {color: line}],
        line,
      };
    }
    case 'compact':
      return {frame: ui.cmpZone, header: ui.cmpHead, label: [ui.cmpLabel, {fontSize: 12 * hs}, tf], body: null, meta: ui.metaMono, line: '#000000'};
    case 'card':
      return {frame: ui.cardZone, header: ui.cardHead, label: [ui.cardLabel, {fontSize: 13 * hs}, tf], body: null, meta: ui.metaMono, line: '#000000'};
    case 'minimal':
      return {frame: ui.minZone, header: ui.minHead, label: [ui.minLabel, {fontSize: 12 * hs}, tf], body: null, meta: ui.metaMono, line: '#999999'};
    case 'underline':
      return {frame: ui.undZone, header: ui.undHead, label: [ui.undLabel, {fontSize: 14 * hs}, tf], body: null, meta: ui.metaMono, line: '#000000'};
    default: // airy
      return {frame: ui.airyZone, header: {...H, alignItems: 'baseline' as const, marginBottom: 5}, label: [ui.airyLabel, {fontSize: 12 * hs}, tf], body: null, meta: ui.metaMono, line: '#666666'};
  }
}

function ZoneFrame({
  theme,
  title,
  hs,
  font,
  meta,
  onRefresh,
  refreshing,
  children,
}: {
  theme: Theme;
  title: string;
  hs: number;
  font?: string;
  meta?: React.ReactNode;
  /** When set, a ↻ button appears in the header (left of the collapse arrow). */
  onRefresh?: () => void;
  refreshing?: boolean;
  children: React.ReactNode;
}) {
  const chrome = useContext(ZoneChromeContext);
  const tf = font ? {fontFamily: font} : null;
  const shownTitle = (chrome.icon ? chrome.icon + ' ' : '') + title;
  const collapsible = !!chrome.onToggle;
  const collapsed = !!chrome.collapsed;
  // An empty-title block still hides its header when expanded (the cleared-title
  // feature); a collapsed one always shows a header so it can be re-opened. A
  // refresh button also forces a header (nowhere else to put it).
  const hasHead = shownTitle.trim() !== '' || !!meta || collapsed || !!onRefresh;
  const sp = frameSpec(theme, hs, tf);
  const HeaderTag: any = collapsible ? TouchableOpacity : View;
  return (
    <View style={sp.frame}>
      {hasHead && (
        <HeaderTag style={sp.header} {...(collapsible ? {onPress: chrome.onToggle, activeOpacity: 0.6} : {})}>
          <Text style={sp.label} numberOfLines={1}>
            {shownTitle}
          </Text>
          <View style={{flexDirection: 'row', alignItems: 'center'}}>
            {meta ? <Text style={sp.meta}>{meta}</Text> : null}
            {onRefresh ? (
              // Its own touch target so tapping ↻ refreshes without toggling collapse.
              <TouchableOpacity onPress={onRefresh} disabled={refreshing} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                <Text style={{fontSize: 15 * hs, color: refreshing ? '#999999' : sp.line, marginLeft: 10}}>{refreshing ? '⏳' : '↻'}</Text>
              </TouchableOpacity>
            ) : null}
            {collapsible ? <Text style={{fontSize: 13 * hs, color: sp.line, marginLeft: 8}}>{collapsed ? '▸' : '▾'}</Text> : null}
          </View>
        </HeaderTag>
      )}
      {!collapsed && <View style={sp.body ?? undefined}>{children}</View>}
    </View>
  );
}

// ---- Shortcuts ------------------------------------------------------------
function ShortcutsZone({zone, theme, ts}: {zone: Extract<Zone, {type: 'shortcuts'}>; theme: Theme; ts: TScale}) {
  const display = zone.display ?? 'list';
  const open = (it: any) => {
    if (it.kind === 'folder') openFolder(it.path);
    else openFile(it.path, it.kind === 'note-page' ? it.page : 0);
  };
  const glyph = (it: any) => (it.kind === 'folder' ? '📁' : fileGlyph(it.path));
  const label = (it: any) => `${it.label}${it.kind === 'note-page' ? ` (p.${it.page})` : ''}`;
  return (
    <ZoneFrame theme={theme} hs={ts.hs} font={ts.font} title={zoneTitle(zone.title, 'Shortcuts')}>
      {zone.items.length === 0 && <Text style={ui.empty}>(no shortcut configured)</Text>}
      <View style={display === 'list' ? undefined : ui.itemsWrap}>
        {zone.items.map((it, i) => (
          <TouchableOpacity
            key={i}
            style={display === 'grid' ? ui.gridCell : undefined}
            onPress={() => open(it)}>
            <Text style={[display === 'inline' ? ui.appTile : ui.listItem, ts.item]}>
              {glyph(it)} {label(it)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </ZoneFrame>
  );
}

/** A clipped horizontal strip of the page PNG showing one star's handwritten line. */
function LineStrip({img}: {img: LineImg}) {
  const [w, setW] = useState(0);
  const dispH = img.aspect > 0 ? w / img.aspect : w * 1.333; // page shown at full width
  const stripH = img.hFrac * dispH;
  return (
    <View
      onLayout={e => setW(e.nativeEvent.layout.width)}
      style={{width: '100%', height: Math.round(stripH), overflow: 'hidden', backgroundColor: '#ffffff'}}>
      {w > 0 && (
        <Image
          source={{uri: 'file://' + img.png}}
          style={{width: w, height: dispH, marginTop: -img.yFrac * dispH}}
          resizeMode="stretch"
        />
      )}
    </View>
  );
}

/**
 * Shared scan lifecycle for the Stars/Keywords zones: busy/progress state, a
 * manual refresh, auto-scan re-evaluated on each dashboard (re)entry (nonce);
 * so autoOnOpen / staleness re-check works even when the view stays mounted and
 * the refresh closure stays current; and the global refresh-all listener.
 */
function useZoneScan(
  cachedAt: number | undefined,
  scan: ScanSettings,
  nonce: number | undefined,
  doScan: (setProgress: (p: string) => void, manual: boolean) => Promise<void>,
) {
  const [, force] = useState(0);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');

  // `manual` = a user-triggered refresh (button / Refresh all), which also
  // flushes the open note so its current-page edits are scanned. Auto-scan on
  // open never flushes (flushing there foregrounded the editor: the reverted
  // v0.20.2 regression).
  const refresh = async (manual = false) => {
    setBusy(true);
    setProgress('scan…');
    await doScan(setProgress, manual);
    setBusy(false);
    setProgress('');
    force(x => x + 1);
  };
  useEffect(() => {
    if (!busy && shouldAutoScan(cachedAt, scan.autoRefreshHours, scan.autoOnOpen)) refresh(false);
    const sub = DeviceEventEmitter.addListener('dashboard_refresh_all', () => refresh(true));
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);
  return {busy, progress, refresh, setProgress};
}

// ---- Stars ----------------------------------------------------------------
function StarsZone({zone, scan, theme, ts, sib, nonce}: {zone: Extract<Zone, {type: 'stars'}>; scan: ScanSettings; theme: Theme; ts: TScale; sib?: Siblings; nonce?: number}) {
  const folders = zone.folders ?? [];
  const lineMode = zone.lineMode ?? 'off';
  const cached = getStars(folders, lineMode);
  const {busy, progress, refresh, setProgress} = useZoneScan(cached?.at, scan, nonce, async (setP, manual) => {
    if (manual) await flushCurrentNote(folders); // catch stars on the page shown underneath
    const res = await scanStars(folders, lineMode, !!sib?.keywords, (d, t, phase) =>
      setP(`${phase === 'ocr' ? (lineMode === 'text' ? 'OCR' : 'render') : 'scan'} ${d}/${t}`),
    );
    setStars(folders, {at: Date.now(), notes: res.notes, truncated: res.truncated, total: res.total}, lineMode);
  });

  const canDelete = zone.canDelete ?? false;
  const removeStar = async (file: string, page: number, index: number) => {
    const ok = await NativeUIUtils.showRattaDialog(
      `Delete this ★ on p.${page} of "${noteTitle(file)}"? (the handwriting is kept)`,
      'Cancel',
      'Delete',
      false,
    );
    if (!ok) return;
    if (await deleteStarByIndex(file, page - 1, index)) {
      setProgress('deleting…');
      await refresh(); // the note's mtime changed → it re-scans, star gone
    } else {
      NativeUIUtils.showRattaDialog('Could not delete the star; is the note open elsewhere?', '', 'OK', false).catch(() => {});
    }
  };

  const meta = `${formatScanTime(cached?.at)}${cached?.truncated ? ' (trunc.)' : ''}`;
  // Memoized: progress ticks during a scan re-render the zone ~3×/s, and each
  // full-body rebuild is an expensive e-ink render of unchanged results.
  const body = useMemo(() => {
    // Cap how many handwriting strips render at once: each is a full-page
    // bitmap, so an unbounded list could exhaust memory. Beyond the cap we
    // fall back to "p.N".
    const IMG_CAP = 12;
    let shown = 0;
    const notes = (cached?.notes ?? [])
      .slice()
      .sort((a, b) =>
        (zone.noteSort ?? 'recent') === 'name'
          ? noteTitle(a.file).localeCompare(noteTitle(b.file))
          : b.mtime - a.mtime,
      );
    return notes.map((n, i) => (
          <View key={i}>
            <Text style={[ui.noteHead, ts.head]}>★ {noteTitle(n.file)}</Text>
            {n.pages.map((p, j) => {
              // one row per star (top→bottom), so delete can target a single star
              const n2 = Math.max(p.lines?.length ?? 0, p.texts?.length ?? 0, p.count);
              return Array.from({length: n2}).map((_, k) => {
                const txt = p.texts?.[k];
                const img = p.lines?.[k];
                const useImg = !!(img && img.png) && shown < IMG_CAP;
                if (useImg) shown++;
                return (
                  <View key={`${j}-${k}`} style={{flexDirection: 'row', alignItems: 'center'}}>
                    <TouchableOpacity style={{flex: 1}} onPress={() => openFile(n.file, p.page)}>
                      {useImg ? (
                        <View style={{flexDirection: 'row', alignItems: 'center'}}>
                          <Text style={[ui.pageNum, {marginRight: 6}]}>p.{p.page}</Text>
                          <View style={{flex: 1}}>
                            <LineStrip img={img!} />
                          </View>
                        </View>
                      ) : (
                        <Text style={[ui.pageLine, ts.page]}>
                          <Text style={ui.pageNum}>p.{p.page}</Text>
                          {txt ? `: ${txt}` : p.count > 1 ? ` ★${k + 1}` : ''}
                        </Text>
                      )}
                    </TouchableOpacity>
                    {canDelete && (
                      <TouchableOpacity style={ui.miniBtn} onPress={() => removeStar(n.file, p.page, k)}>
                        <Text style={ui.miniBtnText}>✕★</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                );
              });
            })}
          </View>
        ));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cached, zone, ts]);
  return (
    <ZoneFrame theme={theme} hs={ts.hs} font={ts.font} title={zoneTitle(zone.title, 'Stars')} meta={busy ? progress || 'scan…' : meta} onRefresh={() => refresh(true)} refreshing={busy}>
      {!cached && !busy && <Text style={ui.empty}>(↻ to list stars; first scan is slow, next are fast)</Text>}
      {cached && cached.notes.length === 0 && <Text style={ui.empty}>No stars found.</Text>}
      {body}
    </ZoneFrame>
  );
}

// ---- Keywords -------------------------------------------------------------
function KeywordsZone({zone, scan, theme, ts, sib, nonce}: {zone: Extract<Zone, {type: 'keywords'}>; scan: ScanSettings; theme: Theme; ts: TScale; sib?: Siblings; nonce?: number}) {
  const folders = zone.folders ?? [];
  const cached = getKeywords(folders);
  const {busy, progress, refresh} = useZoneScan(cached?.at, scan, nonce, async (setP, manual) => {
    if (manual) await flushCurrentNote(folders); // catch keywords on the page shown underneath
    // Only star DETECTION is shared here (cheap); the handwriting render runs
    // only when the Stars zone itself scans.
    const res = await scanKeywords(folders, !!sib?.stars, (d, t) => setP(`scan ${d}/${t}`));
    setKeywords(folders, {at: Date.now(), hits: res.hits, truncated: res.truncated, total: res.total});
  });

  const meta = `${zone.sort === 'note' ? 'by note' : 'by keyword'} · ${formatScanTime(cached?.at)}`;
  // Memoized: grouping/sorting hundreds of hits on every progress tick was a
  // full-zone e-ink re-render of unchanged results.
  const body = useMemo(
    () =>
      cached
        ? renderKeywords(
            filterHits(cached.hits, zone.keywords),
            zone.sort,
            zone.display ?? 'list',
            zone.noteSort ?? 'recent',
            ts,
          )
        : null,
    [cached, zone, ts],
  );
  return (
    <ZoneFrame theme={theme} hs={ts.hs} font={ts.font} title={zoneTitle(zone.title, 'Keywords')} meta={busy ? progress || 'scan…' : meta} onRefresh={() => refresh(true)} refreshing={busy}>
      {!cached && !busy && <Text style={ui.empty}>(↻ to list keywords; first scan is slow, next are fast)</Text>}
      {cached && cached.hits.length === 0 && <Text style={ui.empty}>No keywords found.</Text>}
      {body}
    </ZoneFrame>
  );
}

/** Keep only hits whose keyword is in the allowed set (empty/absent = all). */
function filterHits(hits: KeywordHit[], allowed?: string[]): KeywordHit[] {
  if (!allowed || allowed.length === 0) return hits;
  const set = new Set(allowed.map(k => k.toLowerCase()));
  return hits.filter(h => set.has(h.keyword.toLowerCase()));
}

function groupByKeyword(hits: KeywordHit[]): [string, KeywordHit[]][] {
  const g = new Map<string, KeywordHit[]>();
  for (const h of hits) (g.get(h.keyword) ?? g.set(h.keyword, []).get(h.keyword)!).push(h);
  return [...g.entries()];
}

function noteCmp(sort: 'recent' | 'name') {
  return (a: {file: string; mtime: number}, b: {file: string; mtime: number}) =>
    sort === 'name' ? noteTitle(a.file).localeCompare(noteTitle(b.file)) : b.mtime - a.mtime;
}

function renderKeywords(
  hits: KeywordHit[],
  sort: 'keyword' | 'note',
  display: KeywordDisplay,
  noteSort: 'recent' | 'name',
  ts: TScale,
) {
  if (display === 'inline') return renderInline(hits, noteSort, ts);
  if (display === 'byfolder') return renderByFolder(hits, noteSort, ts);
  return sort === 'note' ? renderListByNote(hits, noteSort, ts) : renderListByKeyword(hits, ts);
}

/** A tappable bordered keyword chip. Opens the exact note+page it refers to. */
function KwChip({label, onPress, ts}: {label: string; onPress: () => void; ts: TScale}) {
  return (
    <TouchableOpacity onPress={onPress}>
      <Text style={[ui.chip, ts.chip]}>{label}</Text>
    </TouchableOpacity>
  );
}

function groupByNote(hits: KeywordHit[]) {
  const g = new Map<string, {file: string; mtime: number; list: KeywordHit[]}>();
  for (const h of hits) {
    if (!g.has(h.file)) g.set(h.file, {file: h.file, mtime: h.mtime, list: []});
    g.get(h.file)!.list.push(h);
  }
  return [...g.values()];
}

// list · by keyword: bordered #keyword, then each occurrence as a tappable chip
function renderListByKeyword(hits: KeywordHit[], ts: TScale) {
  return groupByKeyword(hits).map(([kw, list], i) => (
    <View key={i} style={{marginTop: 6}}>
      <Text style={[ui.noteHead, ts.head]}>#{kw}</Text>
      <View style={ui.row}>
        {list
          .slice()
          .sort((a, b) => b.mtime - a.mtime)
          .map((h, j) => (
            <KwChip key={j} ts={ts} label={`${noteTitle(h.file)} p.${h.page}`} onPress={() => openFile(h.file, h.page)} />
          ))}
      </View>
    </View>
  ));
}

// list · by note: note title, then a tappable #keyword chip per occurrence
function renderListByNote(hits: KeywordHit[], noteSort: 'recent' | 'name', ts: TScale) {
  return groupByNote(hits)
    .sort(noteCmp(noteSort))
    .map(({file, list}, i) => (
      <View key={i} style={{marginTop: 6}}>
        <Text style={[ui.noteHead, ts.head]}>{noteTitle(file)}</Text>
        <View style={ui.row}>
          {list
            .slice()
            .sort((a, b) => a.page - b.page)
            .map((h, j) => (
              <KwChip key={j} ts={ts} label={`#${h.keyword} p.${h.page}`} onPress={() => openFile(h.file, h.page)} />
            ))}
        </View>
      </View>
    ));
}

// inline: compact; note title + wrapped keyword chips on the same block
function renderInline(hits: KeywordHit[], noteSort: 'recent' | 'name', ts: TScale) {
  return groupByNote(hits)
    .sort(noteCmp(noteSort))
    .map(({file, list}, i) => (
      <View key={i} style={[ui.row, {marginTop: 5, alignItems: 'center'}]}>
        <Text style={[ui.inlineKw, ts.head, {marginRight: 6}]}>{noteTitle(file)}</Text>
        {list
          .slice()
          .sort((a, b) => a.page - b.page)
          .map((h, j) => (
            <KwChip key={j} ts={ts} label={`#${h.keyword} p.${h.page}`} onPress={() => openFile(h.file, h.page)} />
          ))}
      </View>
    ));
}

// byfolder: parent folder → note → keyword chips
function renderByFolder(hits: KeywordHit[], noteSort: 'recent' | 'name', ts: TScale) {
  const g = new Map<string, KeywordHit[]>();
  for (const h of hits) {
    const f = parentFolder(h.file);
    (g.get(f) ?? g.set(f, []).get(f)!).push(h);
  }
  return [...g.entries()].map(([folder, list], i) => (
    <View key={i} style={{marginTop: 6}}>
      <Text style={[ui.noteHead, ts.head]}>📁 {folder}</Text>
      {groupByNote(list)
        .sort(noteCmp(noteSort))
        .map(({file, list: nl}, j) => (
          <View key={j} style={{marginLeft: 8}}>
            <Text style={[ui.pageLine, ts.page]}>{noteTitle(file)}</Text>
            <View style={ui.row}>
              {nl
                .slice()
                .sort((a, b) => a.page - b.page)
                .map((h, k) => (
                  <KwChip key={k} ts={ts} label={`#${h.keyword} p.${h.page}`} onPress={() => openFile(h.file, h.page)} />
                ))}
            </View>
          </View>
        ))}
    </View>
  ));
}

// ---- Apps -----------------------------------------------------------------
function AppsZone({zone, theme, ts}: {zone: Extract<Zone, {type: 'apps'}>; theme: Theme; ts: TScale}) {
  const display = zone.display ?? 'inline';
  // 'list' → plain full-width rows; grid/inline → tiles
  const appStyle =
    display === 'list' ? ui.appPlain : theme === 'ledger' ? ui.appUnderline : ui.appTile;
  return (
    <ZoneFrame theme={theme} hs={ts.hs} font={ts.font} title={zoneTitle(zone.title, 'Apps')}>
      {zone.apps.length === 0 && <Text style={ui.empty}>(no app configured)</Text>}
      <View style={display === 'list' ? undefined : ui.itemsWrap}>
        {zone.apps.map((a, i) => (
          <TouchableOpacity key={i} style={display === 'grid' ? ui.gridCell : undefined} onPress={() => launchApp(a.component)}>
            <Text style={[appStyle, ts.app]}>{a.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </ZoneFrame>
  );
}
