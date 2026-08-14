/**
 * Dashboard zone rendering: shortcuts / stars / keywords / apps.
 * A `theme` (ledger / boxed / airy) controls the visual shell via ZoneFrame;
 * the list bodies are shared. Stars & keywords use a per-session cache.
 */
import React, {useEffect, useMemo, useState} from 'react';
import {DeviceEventEmitter, Image, Text, TouchableOpacity, View} from 'react-native';

import {KeywordDisplay, RECENT_MAX, ScanSettings, Theme, Zone} from './config';
import {openFile, openFolder, launchApp} from './open';
import {deleteStarByIndex, LineImg} from './starText';
import {NativeUIUtils} from 'sn-plugin-lib';
import {scanStars, scanKeywords, flushCurrentNote, noteTitle, parentFolder, KeywordHit} from './scanner';
import {readRecent} from './recent';
import {getStars, setStars, getKeywords, setKeywords, formatScanTime, shouldAutoScan} from './scancache';
import {Btn, fileGlyph, ui} from './ui';

/** Scaled style overrides for tappable text (bigger targets = fewer mis-taps). */
export interface TScale {
  s: number;
  /** Zone-title multiplier (1 = the historical look); applied to each theme's base size. */
  hs: number;
  item: object;
  page: object;
  chip: object;
  head: object;
  app: object;
}
export function tscale(s: number, hs = 1): TScale {
  return {
    s,
    hs,
    item: {fontSize: 14 * s, paddingVertical: 6 * s},
    page: {fontSize: 13 * s, paddingVertical: 4 * s},
    chip: {fontSize: 13 * s, paddingVertical: 4 * s, paddingHorizontal: 11 * s},
    head: {fontSize: 14 * s, marginTop: 6 * s},
    app: {fontSize: 14 * s, paddingVertical: 6 * s, paddingHorizontal: 12 * s},
  };
}

/** What other zones need, so the first scan can warm both dimensions in one pass. */
export interface Siblings {
  stars: boolean;
  keywords: boolean;
}

export function ZoneView({zone, scan, theme, ts, nonce, sib}: {zone: Zone; scan: ScanSettings; theme: Theme; ts: TScale; nonce?: number; sib?: Siblings}) {
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
  }
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
    <ZoneFrame theme={theme} hs={ts.hs} title={zone.title || 'Recent'}>
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
function ZoneFrame({
  theme,
  title,
  hs,
  meta,
  children,
}: {
  theme: Theme;
  title: string;
  hs: number;
  meta?: React.ReactNode;
  children: React.ReactNode;
}) {
  if (theme === 'boxed') {
    return (
      <View style={ui.boxFrame}>
        <View style={ui.boxCap}>
          <Text style={[ui.boxCapText, {fontSize: 13 * hs}]}>{title}</Text>
          {meta ? <Text style={ui.boxCapMeta}>{meta}</Text> : null}
        </View>
        <View style={ui.boxBody}>{children}</View>
      </View>
    );
  }
  if (theme === 'ledger') {
    return (
      <View style={ui.ledgerZone}>
        <View style={ui.ledgerHead}>
          <Text style={[ui.ledgerLabel, {fontSize: 11 * hs}]}>{title}</Text>
          {meta ? <Text style={ui.metaMono}>{meta}</Text> : null}
        </View>
        <View>{children}</View>
      </View>
    );
  }
  // airy
  return (
    <View style={ui.airyZone}>
      <Text style={[ui.airyLabel, {fontSize: 12 * hs}]}>
        {title}
        {meta ? '  ' : ''}
        {meta ? <Text style={ui.metaMono}>{meta}</Text> : null}
      </Text>
      <View>{children}</View>
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
    <ZoneFrame theme={theme} hs={ts.hs} title={zone.title || 'Shortcuts'}>
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

/** Refresh button inline with the last-scan info. */
function RefreshRow({busy, progress, meta, onPress}: {busy: boolean; progress: string; meta: string; onPress: () => void}) {
  return (
    <View style={ui.refreshRow}>
      <Btn label={busy ? progress || 'scan…' : '↻ Refresh'} onPress={onPress} disabled={busy} small />
      <Text style={[ui.zoneMeta, {marginLeft: 8}]}>{meta}</Text>
    </View>
  );
}

/**
 * Shared scan lifecycle for the Stars/Keywords zones: busy/progress state, a
 * manual refresh, auto-scan re-evaluated on each dashboard (re)entry (nonce) —
 * so autoOnOpen / staleness re-check works even when the view stays mounted and
 * the refresh closure stays current — and the global refresh-all listener.
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
  // open never flushes (flushing there foregrounded the editor — the reverted
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
      NativeUIUtils.showRattaDialog('Could not delete the star — is the note open elsewhere?', '', 'OK', false).catch(() => {});
    }
  };

  const meta = `last scan: ${formatScanTime(cached?.at)}${cached?.truncated ? ' (trunc.)' : ''}${
    !cached ? ' — 1st scan is slow, next are fast' : ''
  }`;
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
                          {txt ? ` — ${txt}` : p.count > 1 ? ` ★${k + 1}` : ''}
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
    <ZoneFrame theme={theme} hs={ts.hs} title={zone.title || 'Stars'}>
      <RefreshRow busy={busy} progress={progress} meta={meta} onPress={() => refresh(true)} />
      {!cached && !busy && <Text style={ui.empty}>(refresh to list stars)</Text>}
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

  const meta = `${zone.sort === 'note' ? 'by note' : 'by keyword'} · ${formatScanTime(cached?.at)}${
    !cached ? ' — 1st scan slow, next fast' : ''
  }`;
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
    <ZoneFrame theme={theme} hs={ts.hs} title={zone.title || 'Keywords'}>
      <RefreshRow busy={busy} progress={progress} meta={meta} onPress={() => refresh(true)} />
      {!cached && !busy && <Text style={ui.empty}>(refresh to list keywords)</Text>}
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

// inline: compact — note title + wrapped keyword chips on the same block
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
    <ZoneFrame theme={theme} hs={ts.hs} title={zone.title || 'Apps'}>
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
