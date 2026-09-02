/**
 * Settings: a guided 3-step wizard; every change autosaves.
 *   1 Look (layout · design · bubble · text size)
 *   2 Sections (+ live preview, add/reorder/remove)
 *   3 Content (per-zone details, refresh, sorts, line preview)
 * The header has Reset all + Save/load config; a ✕ closes the plugin. No JSON
 * editor here; advanced users edit MyStyle/Plugins/Dashboard/config.json directly.
 */
import React, {useEffect, useState} from 'react';
import {Image, NativeModules, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View} from 'react-native';

const KOFI_QR = require('../assets/kofi-qr.png');

import {
  BlockHeight,
  BubbleMode,
  ClockStyle,
  DashboardConfig,
  DEFAULT_CONFIG,
  KeywordDisplay,
  loadConfig,
  NoteSort,
  RECENT_MAX,
  saveConfig,
  TextScale,
  Theme,
  THEMES,
  Zone,
  ZoneCommon,
  ZONE_ICONS,
  ZONE_LABELS,
  listProfiles,
  saveProfile,
  loadProfile,
  deleteProfile,
} from './config';
import {setRoute} from './route';
import {leavePlugin} from './bubble';
import {scanKeywords, basename, noteTitle} from './scanner';
import {APP_BLOCK, CURATED_APPS} from './apps';
import {Btn, fileGlyph as fileKindGlyph, ui} from './ui';
import {ClockFace} from './clock';
import {allClipLabels} from './clips';

const {DashboardNative} = NativeModules;
const clone = <T,>(o: T): T => JSON.parse(JSON.stringify(o));

interface Pick {
  kind: 'folder' | 'file';
  path: string;
}
type Modal =
  | null
  | {kind: 'shortcuts'; foldersOnly?: boolean; onDone: (picks: Pick[]) => void} // multi-select folders/notes/PDFs/EPUBs
  | {kind: 'apps'; onDone: (apps: {label: string; component: string}[]) => void}
  | {kind: 'kw'; folders: string[]; onPick: (kw: string) => void}
  | {kind: 'profiles'; cfg: DashboardConfig; onLoad: (c: DashboardConfig) => void};

const STEP_TITLES = ['Look', 'Sections'];
const LAST_STEP = STEP_TITLES.length;

export function SettingsScreen(): React.JSX.Element {
  const [cfg, setCfg] = useState<DashboardConfig | null>(null);
  const [step, setStep] = useState(1);
  const [modal, setModal] = useState<Modal>(null);

  useEffect(() => {
    loadConfig().then(setCfg);
  }, []);

  const update = (fn: (c: DashboardConfig) => void) => {
    if (!cfg) return;
    const next = clone(cfg);
    fn(next);
    setCfg(next);
    saveConfig(next); // autosave: nothing is lost on Back / ✕ / navigation
  };

  const goNext = () => setStep(s => Math.min(LAST_STEP, s + 1));
  const goBack = () => setStep(s => Math.max(1, s - 1));

  if (!cfg) return <View style={ui.container}><Text style={ui.hint}>loading…</Text></View>;
  if (modal) return <ModalHost modal={modal} close={() => setModal(null)} />;

  return (
    <View style={ui.container}>
      <View style={ui.header}>
        <View style={ui.headerBtns}>
          <TouchableOpacity style={ui.iconBtn} onPress={() => update(c => Object.assign(c, clone(DEFAULT_CONFIG)))}>
            <Text style={ui.iconText}>↺ Reset all</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={ui.iconBtn}
            onPress={() => setModal({kind: 'profiles', cfg, onLoad: c => update(x => Object.assign(x, c))})}>
            <Text style={ui.iconText}>▤ Save/load config</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity style={ui.iconBtn} onPress={() => leavePlugin()}>
          <Text style={ui.iconText}>✕</Text>
        </TouchableOpacity>
      </View>
      <Text style={ui.wizStepTag}>
        {step}/{LAST_STEP} · {STEP_TITLES[step - 1]}
      </Text>

      <ScrollView style={{flex: 1}}>
        {step === 1 && <StepLook cfg={cfg} update={update} />}
        {step === 2 && <StepSections cfg={cfg} update={update} openModal={setModal} />}
      </ScrollView>

      <View style={ui.navBar}>
        <View style={ui.navLeft}>
          {step > 1 && (
            <TouchableOpacity style={ui.navBtn} onPress={goBack}>
              <Text style={ui.navBtnText}>← Back</Text>
            </TouchableOpacity>
          )}
          {step < LAST_STEP && <GoDashboardBtn />}
        </View>
        {step < LAST_STEP ? (
          <TouchableOpacity style={[ui.navBtn, ui.navBtnPri]} onPress={goNext}>
            <Text style={[ui.navBtnText, ui.navBtnTextPri]}>Next →</Text>
          </TouchableOpacity>
        ) : (
          <GoDashboardBtn primary />
        )}
      </View>
      {/* Fixed footer on all 3 steps: nav row above, a rule, then the support blurb. */}
      <View style={ui.kofiRow}>
        <View style={{flex: 1}}>
          <Text style={ui.kofiText}>
            SuperDashboard is a personal project built by a Supernote user, for Supernote users. I built
            it with love, time, skills and expensive (AI) tokens ;-) If it saves you a few taps
            every day, please consider a small contribution:
          </Text>
          <Text selectable style={ui.kofiLink}>
            https://ko-fi.com/agp42
          </Text>
        </View>
        <Image source={KOFI_QR} style={ui.kofiQr} resizeMode="contain" />
      </View>
    </View>
  );
}

type UP = (fn: (c: DashboardConfig) => void) => void;

function GoDashboardBtn({primary}: {primary?: boolean}) {
  return (
    <TouchableOpacity style={[ui.navBtn, primary && ui.navBtnPri]} onPress={() => setRoute('dashboard')}>
      <Text style={[ui.navBtnText, primary && ui.navBtnTextPri]}>▦ Save & go to Dashboard</Text>
    </TouchableOpacity>
  );
}

// ===== Step 1: Look (Layout + Design + Bubble) ============================
/** Stable RN fontFamily name for a MyStyle font path (must match App.tsx's). */
function fontFam(path: string): string {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) | 0;
  return 'udf' + (h >>> 0).toString(36);
}

function StepLook({cfg, update}: {cfg: DashboardConfig; update: UP}) {
  const cols = cfg.layout.columns;
  const setCols = (n: 1 | 2 | 3) =>
    update(c => {
      c.layout.columns = n;
      // A block that lived in a now-removed column falls back into the last one.
      for (const z of c.zones) if ((z.col ?? 0) > n - 1) z.col = n - 1;
    });
  const [fonts, setFonts] = useState<{name: string; path: string}[]>([]);
  useEffect(() => {
    DashboardNative.listFonts?.()
      .then((fs: {name: string; path: string}[]) => {
        setFonts(fs ?? []);
        // Register each so its choice below can preview in its own typeface.
        for (const f of fs ?? []) DashboardNative.registerFont?.(f.path, fontFam(f.path)).catch(() => {});
      })
      .catch(() => {});
  }, []);
  return (
    <View>
      <Text style={ui.wizStepTag}>Layout: columns</Text>
      <View style={ui.snapWrap}>
        {([1, 2, 3] as const).map(n => (
          <Snap key={n} width={150} on={cols === n} label={`${n} column${n > 1 ? 's' : ''}`} onPress={() => setCols(n)}>
            <MiniPage theme={cfg.theme} cols={n} zones={sampleZones} width={150} />
          </Snap>
        ))}
      </View>

      <Text style={ui.wizStepTag}>Vertical flow</Text>
      <Text style={ui.subLabel}>How blocks fill a column: natural height, or a set height that scrolls inside.</Text>
      <Seg
        options={[{v: 'masonry', label: 'Masonry'}, {v: 'fixed', label: 'Fixed height'}]}
        value={cfg.layout.vmode}
        onChange={v => update(c => void (c.layout.vmode = v as 'masonry' | 'fixed'))}
      />

      <Text style={ui.wizStepTag}>Design: on your {cols}-column layout</Text>
      <View style={ui.snapWrap}>
        {THEMES.map(t => (
          <Snap key={t} width={150} on={cfg.theme === t} label={t === 'gridgray' ? 'grid (grey)' : t === 'grid' ? 'grid (black)' : t} onPress={() => update(c => void (c.theme = t))}>
            <MiniPage theme={t} cols={cols} zones={sampleZones} width={150} />
          </Snap>
        ))}
      </View>

      <Text style={ui.wizStepTag}>Bubble</Text>
      <Text style={ui.subLabel}>The house floats over every screen: tap to open the dashboard, drag to move. Set Off to use only the toolbar SuperDashboard button.</Text>
      <View style={ui.snapWrap}>
        {(['icon', 'off'] as BubbleMode[]).map(m => (
          <Snap
            key={m}
            width={130}
            on={cfg.bubble.mode === m}
            label={m === 'icon' ? 'House' : 'Off'}
            onPress={() => {
              update(c => void (c.bubble.mode = m));
              if (m === 'off') DashboardNative.hideBubble?.().catch(() => {});
            }}>
            <View style={{height: 120, width: 130, alignItems: 'center', justifyContent: 'center'}}>
              {m === 'off' ? (
                <Text style={{fontSize: 30, color: '#999999'}}>⊘</Text>
              ) : (
                <View
                  style={{
                    width: 58,
                    height: 58,
                    borderRadius: 16,
                    borderWidth: 2,
                    borderColor: '#000',
                    backgroundColor: '#fff',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}>
                  <Image source={require('../assets/icon.png')} style={{width: 34, height: 34}} resizeMode="contain" />
                </View>
              )}
            </View>
          </Snap>
        ))}
      </View>

      <Text style={ui.wizStepTag}>Text size (bigger = easier finger taps)</Text>
      <View style={ui.row}>
        {(['S', 'M', 'L', 'XL'] as TextScale[]).map(sz => (
          <TouchableOpacity
            key={sz}
            style={[ui.choice, cfg.textScale === sz && ui.choiceOn]}
            onPress={() => update(c => void (c.textScale = sz))}>
            <Text style={[ui.choiceText, {fontSize: sz === 'S' ? 13 : sz === 'M' ? 15 : sz === 'L' ? 18 : 22}, cfg.textScale === sz && ui.choiceTextOn]}>
              {sz}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={ui.wizStepTag}>Heading size (section titles)</Text>
      <View style={ui.row}>
        {(['S', 'M', 'L', 'XL'] as TextScale[]).map(sz => (
          <TouchableOpacity
            key={sz}
            style={[ui.choice, cfg.headingScale === sz && ui.choiceOn]}
            onPress={() => update(c => void (c.headingScale = sz))}>
            <Text style={[ui.choiceText, {fontSize: sz === 'S' ? 13 : sz === 'M' ? 15 : sz === 'L' ? 18 : 22}, cfg.headingScale === sz && ui.choiceTextOn]}>
              {sz}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={ui.wizStepTag}>Font</Text>
      <Text style={ui.subLabel}>Drop .ttf/.otf files into MyStyle/fonts to use your own. Applies to the dashboard text.</Text>
      <View style={ui.row}>
        <TouchableOpacity style={[ui.choice, !cfg.font && ui.choiceOn]} onPress={() => update(c => void (c.font = undefined))}>
          <Text style={[ui.choiceText, !cfg.font && ui.choiceTextOn]}>System default</Text>
        </TouchableOpacity>
        {fonts.map(f => (
          <TouchableOpacity key={f.path} style={[ui.choice, cfg.font === f.path && ui.choiceOn]} onPress={() => update(c => void (c.font = f.path))}>
            <Text style={[ui.choiceText, {fontFamily: fontFam(f.path)}, cfg.font === f.path && ui.choiceTextOn]}>
              {f.name.replace(/\.(ttf|otf)$/i, '')}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      {fonts.length === 0 && <Text style={ui.subLabel}>No fonts found in MyStyle/fonts.</Text>}

      <Text style={ui.wizStepTag}>Block icons</Text>
      <Text style={ui.subLabel}>Show each block's type icon (★ # 🕑 …) on its dashboard title.</Text>
      <Seg
        options={[{v: 'on', label: 'Show'}, {v: 'off', label: 'Hide'}]}
        value={cfg.showIcons ? 'on' : 'off'}
        onChange={v => update(c => void (c.showIcons = v === 'on'))}
      />

      <Text style={ui.wizStepTag}>Note clips</Text>
      <Text style={ui.subLabel}>In a note, lasso something and tap “Add to Dashboard” to send it to a Clips block. Optionally mark the captured area on the note.</Text>
      <Seg
        options={[{v: 'off', label: 'No frame'}, {v: 'grey', label: 'Grey frame'}, {v: 'black', label: 'Black frame'}]}
        value={cfg.clipFrame ?? 'off'}
        onChange={v => update(c => void (c.clipFrame = v as 'off' | 'grey' | 'black'))}
      />

      <Text style={ui.wizStepTag}>Scanning (Stars &amp; Keywords)</Text>
      <Seg
        options={[
          {v: 'open', label: 'On open'},
          {v: '6', label: 'Stale > 6h'},
          {v: '24', label: 'Stale > 24h'},
          {v: 'off', label: 'Manual'},
        ]}
        value={cfg.scan.autoOnOpen ? 'open' : cfg.scan.autoRefreshHours === 0 ? 'off' : String(cfg.scan.autoRefreshHours)}
        onChange={v =>
          update(c => {
            if (v === 'open') {
              c.scan.autoOnOpen = true;
            } else {
              c.scan.autoOnOpen = false;
              c.scan.autoRefreshHours = v === 'off' ? 0 : Number(v);
            }
          })
        }
      />
    </View>
  );
}

const ADDABLE: Zone['type'][] = ['shortcuts', 'stars', 'keywords', 'apps', 'recent', 'clock', 'search', 'status', 'nav', 'clips'];

/** Icon + name for a placed block in the canvas. */
function blockLabel(z: Zone): string {
  if (z.type === 'spacer') return '▢ empty';
  const ic = ZONE_ICONS[z.type] ?? '•';
  return `${ic} ${z.title && z.title !== '' ? z.title : ZONE_LABELS[z.type] ?? z.type}`;
}

// ===== Step 2: Sections (per-column placement + 🔧 per-block config) =======
function StepSections({cfg, update, openModal}: {cfg: DashboardConfig; update: UP; openModal: (m: Modal) => void}) {
  const columns = cfg.layout.columns;
  const [openCfg, setOpenCfg] = useState<number | null>(null); // zone index whose 🔧 panel is open
  const [addingCol, setAddingCol] = useState<number | null>(null); // column whose add-menu is open
  const colOf = (z: Zone) => Math.max(0, Math.min(columns - 1, z.col ?? 0));

  return (
    <View>
      <Text style={ui.wizStepTag}>Live preview</Text>
      <View style={{alignItems: 'center', marginBottom: 14}}>
        <MiniPage
          theme={cfg.theme}
          cols={columns}
          zones={cfg.zones.map(z => ({type: z.type, title: z.title, col: colOf(z)}))}
          width={270}
        />
      </View>

      <Text style={ui.wizStepTag}>Sections: place blocks per column, 🔧 to configure</Text>
      <View style={ui.zoneGrid}>
        {Array.from({length: columns}).map((_, ci) => {
          const items = cfg.zones.map((z, i) => ({z, i})).filter(({z}) => colOf(z) === ci);
          return (
            <View key={ci} style={[ui.zoneCol, ui.colBox, {flex: columns === 3 && ci === 1 ? 1.5 : 1}]}>
              <Text style={ui.colHead}>Column {ci + 1}</Text>
              {items.length === 0 && <Text style={ui.empty}>empty</Text>}
              {items.map(({z, i}) => {
                // With 1-2 columns each block is wide enough to fit the name and
                // its controls on one row; with 3 columns keep them stacked.
                const oneLine = columns <= 2;
                const ctrls = (
                  <View style={ui.secCtrls}>
                    <Mini big label="▲" onPress={() => update(c => moveWithinColumn(c, i, -1))} />
                    <Mini big label="▼" onPress={() => update(c => moveWithinColumn(c, i, 1))} />
                    {ci > 0 && <Mini big label="◀" onPress={() => update(c => void ((c.zones[i] as ZoneCommon).col = ci - 1))} />}
                    {ci < columns - 1 && <Mini big label="▶" onPress={() => update(c => void ((c.zones[i] as ZoneCommon).col = ci + 1))} />}
                    <Mini big label="🔧" onPress={() => setOpenCfg(openCfg === i ? null : i)} />
                    <Mini big label="✕" onPress={() => { setOpenCfg(null); update(c => void c.zones.splice(i, 1)); }} />
                  </View>
                );
                return (
                  <View key={i} style={ui.secItem}>
                    {oneLine ? (
                      <View style={{flexDirection: 'row', alignItems: 'center'}}>
                        <Text style={[ui.secName, {flex: 1, marginBottom: 0, marginRight: 8}]} numberOfLines={1}>{blockLabel(z)}</Text>
                        {ctrls}
                      </View>
                    ) : (
                      <>
                        <Text style={ui.secName} numberOfLines={1}>{blockLabel(z)}</Text>
                        {ctrls}
                      </>
                    )}
                    {openCfg === i && (
                      <View style={ui.cfgExpander}>
                        <ZoneContentEditor i={i} zone={z} update={update} openModal={openModal} vmode={cfg.layout.vmode} />
                      </View>
                    )}
                  </View>
                );
              })}
              {addingCol === ci ? (
                <View style={ui.addMenu}>
                  {ADDABLE.map(t => (
                    <TouchableOpacity key={t} style={ui.addItem} onPress={() => { setAddingCol(null); update(c => c.zones.push({...newZone(t), col: ci})); }}>
                      <Text style={ui.addItemIcon}>{ZONE_ICONS[t]}</Text>
                      <Text style={ui.addItemText}>{ZONE_LABELS[t] ?? t}</Text>
                    </TouchableOpacity>
                  ))}
                  <TouchableOpacity style={ui.addItem} onPress={() => { setAddingCol(null); update(c => c.zones.push({type: 'spacer', col: ci, h: 'M'} as Zone)); }}>
                    <Text style={ui.addItemIcon}>▢</Text>
                    <Text style={ui.addItemText}>empty spacer</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[ui.addItem, {borderBottomWidth: 0}]} onPress={() => setAddingCol(null)}>
                    <Text style={ui.addItemIcon}>✕</Text>
                    <Text style={[ui.addItemText, {color: '#888888'}]}>cancel</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <Mini big label="＋ add block" onPress={() => setAddingCol(ci)} />
              )}
            </View>
          );
        })}
      </View>
    </View>
  );
}

/** Reorder a block up/down WITHIN its own column (swaps with the nearest block
 *  in the same column, ignoring blocks that live in other columns). */
function moveWithinColumn(c: DashboardConfig, i: number, dir: number) {
  const col = c.zones[i].col ?? 0;
  const step = dir < 0 ? -1 : 1;
  for (let j = i + step; j >= 0 && j < c.zones.length; j += step) {
    if ((c.zones[j].col ?? 0) === col) {
      const tmp = c.zones[i];
      c.zones[i] = c.zones[j];
      c.zones[j] = tmp;
      return;
    }
  }
}

// ===== Per-block config (opened by the 🔧 in Step 2) =======================
function ZoneContentEditor({
  i,
  zone: z,
  update,
  openModal,
  vmode,
}: {
  i: number;
  zone: Zone;
  update: UP;
  openModal: (m: Modal) => void;
  vmode: 'masonry' | 'fixed';
}) {
  const showHeight = vmode === 'fixed' || z.type === 'spacer';
  return (
    <View>
      {z.type !== 'spacer' && (
        <EditableTitle value={z.title ?? z.type} onSave={t => update(c => void (c.zones[i].title = t))} />
      )}
      {z.type === 'spacer' && (
        <Text style={ui.subLabel}>An empty block: reserves vertical space and helps line up columns.</Text>
      )}
      {z.type === 'shortcuts' && <ShortcutsEditor i={i} zone={z} update={update} openModal={openModal} />}
      {z.type === 'stars' && (
        <View>
          <FoldersEditor i={i} folders={z.folders} update={update} openModal={openModal} what="stars" />
          <NoteSortRow i={i} value={z.noteSort ?? 'recent'} update={update} />
          <Text style={ui.subLabel}>Line preview: show each star's line (slower scan)</Text>
          <Seg
            options={[
              {v: 'off', label: 'Off'},
              {v: 'image', label: 'Image'},
              {v: 'text', label: 'Text (OCR, image if it fails)'},
            ]}
            value={z.lineMode ?? 'off'}
            onChange={v => update(c => void ((c.zones[i] as any).lineMode = v))}
          />
          <Text style={ui.subLabel}>Allow deleting a star from the dashboard (✕★, keeps the text)</Text>
          <Seg
            options={[{v: 'off', label: 'Off'}, {v: 'on', label: 'On'}]}
            value={z.canDelete ? 'on' : 'off'}
            onChange={v => update(c => void ((c.zones[i] as any).canDelete = v === 'on'))}
          />
        </View>
      )}
      {z.type === 'keywords' && <KeywordsEditor i={i} zone={z} update={update} openModal={openModal} />}
      {z.type === 'apps' && <AppsEditor i={i} zone={z} update={update} openModal={openModal} />}
      {z.type === 'recent' && <RecentEditor i={i} zone={z} update={update} />}
      {z.type === 'clock' && <ClockEditor i={i} zone={z} update={update} />}
      {z.type === 'search' && <SearchEditor i={i} zone={z} update={update} openModal={openModal} />}
      {z.type === 'status' && <StatusEditor i={i} zone={z} update={update} />}
      {z.type === 'nav' && <NavEditor i={i} zone={z} update={update} openModal={openModal} />}
      {z.type === 'clips' && <ClipsEditor i={i} zone={z} update={update} openModal={openModal} />}
      {showHeight && (
        <View>
          <Text style={ui.subLabel}>Height{vmode === 'masonry' ? ' (empty block)' : ' (Fixed mode: content scrolls inside)'}</Text>
          <Seg
            options={[{v: 'S', label: 'Short'}, {v: 'M', label: 'Medium'}, {v: 'L', label: 'Tall'}]}
            value={z.h ?? 'M'}
            onChange={v => update(c => void ((c.zones[i] as ZoneCommon).h = v as BlockHeight))}
          />
        </View>
      )}
    </View>
  );
}

// ===== per-zone editors ====================================================
type EditorProps<T extends Zone['type']> = {i: number; zone: Extract<Zone, {type: T}>; update: UP; openModal: (m: Modal) => void};

function ShortcutsEditor({i, zone, update, openModal}: EditorProps<'shortcuts'>) {
  return (
    <View>
      {zone.items.map((it, j) => (
        <View key={j} style={ui.itemRow}>
          <Text style={ui.itemText}>
            {it.kind === 'folder' ? '📁' : fileKindGlyph(it.path)} {it.label}
          </Text>
          <View style={ui.zoneRowBtns}>
            <Mini label="▲" onPress={() => update(c => moveItem((c.zones[i] as any).items, j, -1))} />
            <Mini label="▼" onPress={() => update(c => moveItem((c.zones[i] as any).items, j, 1))} />
            <Mini label="✕" onPress={() => update(c => void (c.zones[i] as any).items.splice(j, 1))} />
          </View>
        </View>
      ))}
      <Text style={ui.subLabel}>Layout</Text>
      <Seg
        options={[{v: 'list', label: 'List'}, {v: 'grid', label: 'Grid'}, {v: 'inline', label: 'Inline'}]}
        value={zone.display ?? 'list'}
        onChange={v => update(c => void ((c.zones[i] as any).display = v))}
      />
      <Btn
        label="＋ Add folder / note / PDF"
        small
        onPress={() =>
          openModal({
            kind: 'shortcuts',
            onDone: picks =>
              update(c => {
                const items = (c.zones[i] as any).items;
                for (const p of picks) {
                  if (p.kind === 'folder') items.push({kind: 'folder', label: basename(p.path), path: p.path});
                  else items.push({kind: 'note-last', label: noteTitle(p.path), path: p.path});
                }
              }),
          })
        }
      />
    </View>
  );
}

function FoldersEditor({i, folders, update, openModal, what}: {i: number; folders: string[]; update: UP; openModal: (m: Modal) => void; what: string}) {
  const empty = (folders ?? []).length === 0;
  return (
    <View>
      <Text style={ui.subLabel}>Folders to scan for {what}</Text>
      {empty && (
        <Text style={ui.empty}>
          No folder selected; the whole device is scanned at each refresh.
        </Text>
      )}
      {(folders ?? []).map((f, j) => (
        <View key={j} style={ui.itemRow}>
          <Text style={ui.itemText}>📁 {basename(f) || f}</Text>
          <Mini label="✕" onPress={() => update(c => void (c.zones[i] as any).folders.splice(j, 1))} />
        </View>
      ))}
      <Btn label="＋ Folders" onPress={() => openModal({kind: 'shortcuts', foldersOnly: true, onDone: picks => update(c => {const z = c.zones[i] as any; z.folders = z.folders ?? []; for (const p of picks) {if (!z.folders.includes(p.path)) z.folders.push(p.path);}})})} small />
    </View>
  );
}

function NoteSortRow({i, value, update}: {i: number; value: NoteSort; update: UP}) {
  return (
    <View style={{marginTop: 6}}>
      <Text style={ui.subLabel}>Note order</Text>
      <Seg
        options={[{v: 'recent', label: 'By date'}, {v: 'name', label: 'By name'}]}
        value={value}
        onChange={v => update(c => void ((c.zones[i] as any).noteSort = v))}
      />
    </View>
  );
}

function KeywordsEditor({i, zone, update, openModal}: EditorProps<'keywords'>) {
  const specific = (zone.keywords?.length ?? 0) > 0;
  return (
    <View>
      <FoldersEditor i={i} folders={zone.folders} update={update} openModal={openModal} what="keywords" />
      <NoteSortRow i={i} value={zone.noteSort ?? 'recent'} update={update} />
      <View style={{marginTop: 6}}>
        <Text style={ui.subLabel}>Group by</Text>
        <Seg options={[{v: 'keyword', label: 'Keyword'}, {v: 'note', label: 'Note'}]} value={zone.sort} onChange={v => update(c => void ((c.zones[i] as any).sort = v))} />
        <Text style={ui.subLabel}>View</Text>
        <Seg
          options={[{v: 'list', label: 'List'}, {v: 'inline', label: 'Inline'}, {v: 'byfolder', label: 'By folder'}]}
          value={zone.display ?? 'list'}
          onChange={v => update(c => void ((c.zones[i] as any).display = v as KeywordDisplay))}
        />
      </View>
      <Text style={ui.subLabel}>Keywords: {specific ? 'selected' : 'all'}</Text>
      {(zone.keywords ?? []).map((kw, j) => (
        <View key={j} style={ui.itemRow}>
          <Text style={ui.itemText}>#{kw}</Text>
          <Mini label="✕" onPress={() => update(c => void (c.zones[i] as any).keywords.splice(j, 1))} />
        </View>
      ))}
      <View style={ui.row}>
        <Btn label="＋ Keyword" onPress={() => openModal({kind: 'kw', folders: zone.folders ?? [], onPick: kw => update(c => {const z = c.zones[i] as any; z.keywords = z.keywords ?? []; if (!z.keywords.includes(kw)) z.keywords.push(kw);})})} small />
        {specific && <Btn label="Show all" onPress={() => update(c => void ((c.zones[i] as any).keywords = []))} small />}
      </View>
    </View>
  );
}

function AppsEditor({i, zone, update, openModal}: EditorProps<'apps'>) {
  return (
    <View>
      <Text style={ui.subLabel}>Layout</Text>
      <Seg
        options={[{v: 'inline', label: 'Inline'}, {v: 'grid', label: 'Grid'}, {v: 'list', label: 'List'}]}
        value={zone.display ?? 'inline'}
        onChange={v => update(c => void ((c.zones[i] as any).display = v))}
      />
      {zone.apps.map((a, j) => (
        <View key={j} style={ui.itemRow}>
          <Text style={ui.itemText}>{a.label}</Text>
          <View style={ui.zoneRowBtns}>
            <Mini label="▲" onPress={() => update(c => moveItem((c.zones[i] as any).apps, j, -1))} />
            <Mini label="▼" onPress={() => update(c => moveItem((c.zones[i] as any).apps, j, 1))} />
            <Mini label="✕" onPress={() => update(c => void (c.zones[i] as any).apps.splice(j, 1))} />
          </View>
        </View>
      ))}
      <Btn label="＋ Apps" onPress={() => openModal({kind: 'apps', onDone: as => update(c => {const z = c.zones[i] as any; for (const a of as) {if (!z.apps.some((x: any) => x.component === a.component)) z.apps.push(a);}})})} small />
    </View>
  );
}

// ===== schematic snapshot / preview ========================================
type MiniZ = {type: Zone['type']; title?: string; col?: number};
const sampleZones: MiniZ[] = [
  {type: 'shortcuts', title: 'Shortcuts'},
  {type: 'stars', title: 'Stars'},
  {type: 'keywords', title: 'Keywords'},
  {type: 'apps', title: 'Apps'},
];

function Snap({on, label, width, onPress, children}: {on: boolean; label: string; width: number; onPress: () => void; children: React.ReactNode}) {
  return (
    <TouchableOpacity style={[ui.snap, {width: width + 16}, on && ui.snapOn]} onPress={onPress}>
      <View style={{alignItems: 'center'}}>{children}</View>
      <Text style={[ui.snapLabel, on && ui.snapLabelOn]}>{label}</Text>
    </TouchableOpacity>
  );
}

/** A schematic portrait mini-page: real page shape, labelled zone boxes. */
function MiniPage({theme, cols, zones, width}: {theme: Theme; cols: number; zones: MiniZ[]; width: number}) {
  const height = Math.round((width * 4) / 3);
  const columns: MiniZ[][] = Array.from({length: cols}, () => []);
  zones.forEach((z, i) => {
    const c = typeof z.col === 'number' ? Math.max(0, Math.min(cols - 1, z.col)) : i % cols;
    columns[c].push(z);
  });
  return (
    <View style={[ui.miniPage, {width, height}]}>
      <Text style={ui.miniPageTitle}>SuperDashboard</Text>
      {zones.length === 0 && <Text style={{fontSize: 9, color: '#999', marginTop: 6}}>empty: add sections</Text>}
      <View style={{flexDirection: 'row', flex: 1}}>
        {columns.map((col, ci) => (
          <View key={ci} style={{flex: 1, marginRight: ci < cols - 1 ? 4 : 0}}>
            {col.map((z, zi) => (
              <MiniZone key={zi} theme={theme} label={z.title || z.type} />
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}

function MiniZone({theme, label}: {theme: Theme; label: string}) {
  const lines = (
    <>
      <View style={ui.mzLine} />
      <View style={[ui.mzLine, {width: '65%'}]} />
    </>
  );
  if (theme === 'boxed') {
    return (
      <View style={ui.mzBoxed}>
        <View style={ui.mzCap}>
          <Text style={ui.mzCapText} numberOfLines={1}>{label}</Text>
        </View>
        <View style={ui.mzBody}>{lines}</View>
      </View>
    );
  }
  if (theme === 'ledger') {
    return (
      <View style={ui.mzLedger}>
        <View style={ui.mzRule} />
        <Text style={ui.mzLabelText} numberOfLines={1}>{label.toUpperCase()}</Text>
        {lines}
      </View>
    );
  }
  if (theme === 'grid' || theme === 'gridgray') {
    const line = theme === 'gridgray' ? '#888888' : '#000000';
    return (
      <View style={{borderWidth: StyleSheet.hairlineWidth, borderColor: line, borderRadius: 3, marginBottom: 6}}>
        <View style={{borderBottomWidth: StyleSheet.hairlineWidth, borderColor: line, paddingHorizontal: 4, paddingVertical: 2}}>
          <Text style={{fontSize: 8, fontWeight: '700', color: line}} numberOfLines={1}>{label.toUpperCase()}</Text>
        </View>
        <View style={{padding: 4}}>{lines}</View>
      </View>
    );
  }
  if (theme === 'compact') {
    return (
      <View style={{marginBottom: 6}}>
        <Text style={[ui.mzLabelText, {borderBottomWidth: 1, borderColor: '#000', paddingBottom: 1, marginBottom: 3}]} numberOfLines={1}>{label}</Text>
        {lines}
      </View>
    );
  }
  if (theme === 'card') {
    return (
      <View style={{borderWidth: 1, borderColor: '#000', borderRadius: 6, backgroundColor: '#eeeeec', padding: 5, marginBottom: 6}}>
        <Text style={ui.mzLabelText} numberOfLines={1}>{label}</Text>
        {lines}
      </View>
    );
  }
  if (theme === 'minimal') {
    return (
      <View style={{marginBottom: 9}}>
        <Text style={[ui.mzLabelText, {color: '#aaaaaa', fontWeight: '400'}]} numberOfLines={1}>{label}</Text>
        {lines}
      </View>
    );
  }
  if (theme === 'underline') {
    return (
      <View style={{marginBottom: 8}}>
        <Text style={[ui.mzLabelText, {borderBottomWidth: 2.5, borderColor: '#000', paddingBottom: 2, marginBottom: 4}]} numberOfLines={1}>{label.toUpperCase()}</Text>
        {lines}
      </View>
    );
  }
  return (
    <View style={ui.mzAiry}>
      <Text style={[ui.mzLabelText, {color: '#666666'}]} numberOfLines={1}>{label.toUpperCase()}</Text>
      {lines}
    </View>
  );
}

// ===== segmented control ===================================================
function Seg({options, value, onChange}: {options: {v: string; label: string}[]; value: string; onChange: (v: string) => void}) {
  return (
    <View style={ui.row}>
      {options.map(o => (
        <TouchableOpacity key={o.v} style={[ui.choice, {marginRight: 6, marginBottom: 6, paddingVertical: 7, paddingHorizontal: 11}, value === o.v && ui.choiceOn]} onPress={() => onChange(o.v)}>
          <Text style={[ui.choiceText, {fontSize: 13}, value === o.v && ui.choiceTextOn]}>{o.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const Mini = ({label, onPress, big}: {label: string; onPress: () => void; big?: boolean}) => (
  <TouchableOpacity style={[ui.miniBtn, big && ui.miniBtnBig]} onPress={onPress}>
    <Text style={[ui.miniBtnText, big && ui.miniBtnTextBig]}>{label}</Text>
  </TouchableOpacity>
);

/**
 * Inline title editor. ✎ turns the title into a field; committing happens on the
 * keyboard's Done key OR when the field loses focus; NOT via a button (on the
 * Supernote the on-screen keyboard covers an inline button, which looked frozen).
 */
function EditableTitle({value, onSave}: {value: string; onSave: (t: string) => void}) {
  const [editing, setEditing] = useState(false);
  const [t, setT] = useState(value);
  useEffect(() => setT(value), [value]);

  const commit = () => {
    onSave(t.trim());
    setEditing(false);
  };

  if (!editing) {
    return (
      <View style={[ui.row, {alignItems: 'center', marginTop: 2, marginBottom: 4}]}>
        <Text style={ui.subLabel}>Title to display: </Text>
        <Text style={[ui.itemText, {fontWeight: '600', marginRight: 6, color: value ? '#000000' : '#999999'}]}>
          {value || '(no title: hidden)'}
        </Text>
        <Mini label="✎ edit" onPress={() => {setT(value); setEditing(true);}} />
      </View>
    );
  }
  return (
    <View style={{marginTop: 2, marginBottom: 4}}>
      <Text style={ui.subLabel}>Title (press Done or tap away to save)</Text>
      <TextInput
        style={ui.titleInput}
        value={t}
        onChangeText={setT}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="done"
        blurOnSubmit
        onSubmitEditing={commit}
        onEndEditing={commit}
      />
    </View>
  );
}


// ===== modals ==============================================================
function ModalHost({modal, close}: {modal: NonNullable<Modal>; close: () => void}) {
  if (modal.kind === 'shortcuts') return <ShortcutBrowser foldersOnly={modal.foldersOnly} onDone={p => {modal.onDone(p); close();}} onClose={close} />;
  if (modal.kind === 'apps') return <AppPickerModal onDone={as => {modal.onDone(as); close();}} onClose={close} />;
  if (modal.kind === 'kw') return <KeywordPicker folders={modal.folders} onPick={k => {modal.onPick(k); close();}} onClose={close} />;
  return <ProfilesModal cfg={modal.cfg} onLoad={c => {modal.onLoad(c); close();}} onClose={close} />;
}

/** Save the current config under a name, or reload a saved one. Guards against
 *  an accidental Reset wiping a setup you liked. */
function ProfilesModal({cfg, onLoad, onClose}: {cfg: DashboardConfig; onLoad: (c: DashboardConfig) => void; onClose: () => void}) {
  const [names, setNames] = useState<string[]>([]);
  const [newName, setNewName] = useState('');
  const [status, setStatus] = useState('');
  const reload = () => listProfiles().then(setNames);
  useEffect(() => {reload();}, []);

  const doSave = async () => {
    const n = newName.trim();
    if (!n) return;
    await saveProfile(n, cfg);
    setNewName('');
    setStatus(`saved “${n}”`);
    reload();
  };
  const doLoad = async (n: string) => {
    const c = await loadProfile(n);
    if (c) onLoad(c);
  };
  const doDelete = async (n: string) => {
    await deleteProfile(n);
    setStatus(`deleted “${n}”`);
    reload();
  };

  return (
    <View style={ui.container}>
      <View style={ui.header}>
        <Text style={ui.wizTitle}>Save / load configuration</Text>
        <TouchableOpacity style={ui.iconBtn} onPress={onClose}>
          <Text style={ui.iconText}>✕</Text>
        </TouchableOpacity>
      </View>
      <Text style={ui.hint}>Save the current dashboard under a name, then reload it anytime (e.g. after a Reset).</Text>

      <Text style={ui.subLabel}>Save current as…</Text>
      <View style={ui.row}>
        <TextInput
          style={[ui.titleInput, {flex: 1, minWidth: 160}]}
          value={newName}
          placeholder="profile name"
          placeholderTextColor="#999999"
          onChangeText={setNewName}
          onSubmitEditing={doSave}
          returnKeyType="done"
        />
        <Btn label="Save" onPress={doSave} small />
      </View>

      <Text style={ui.subLabel}>Saved profiles</Text>
      {names.length === 0 && <Text style={ui.empty}>(none yet)</Text>}
      <ScrollView style={ui.pickerFull}>
        {names.map(n => (
          <View key={n} style={ui.pickerRow}>
            <Text style={ui.pickerRowText}>{n}</Text>
            <View style={ui.zoneRowBtns}>
              <Mini label="Load" onPress={() => doLoad(n)} />
              <Mini label="✕" onPress={() => doDelete(n)} />
            </View>
          </View>
        ))}
      </ScrollView>
      {status ? <Text style={ui.status}>{status}</Text> : null}
    </View>
  );
}

const STORAGE_ROOT = '/storage/emulated/0';
const NOTE_START = STORAGE_ROOT + '/Note';

async function listDirSorted(d: string): Promise<any[]> {
  try {
    const list: any[] = (await DashboardNative.listDir(d)) ?? [];
    list.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    return list;
  } catch {
    return [];
  }
}
const isOpenableFile = (name: string) => /\.(note|pdf|epub)$/i.test(name);
const fileGlyph = (name: string) =>
  /\.pdf$/i.test(name) ? '📕 ' : /\.epub$/i.test(name) ? '📗 ' : /\.note$/i.test(name) ? '📄 ' : '   ';

/** Directory-navigation state for the browser modal. */
function useDirBrowser() {
  const [dir, setDir] = useState(NOTE_START);
  const [entries, setEntries] = useState<any[]>([]);
  const load = async (d: string) => {setEntries(await listDirSorted(d)); setDir(d);};
  useEffect(() => {load(NOTE_START);}, []); // eslint-disable-line react-hooks/exhaustive-deps
  const parent = dir.substring(0, dir.lastIndexOf('/'));
  const up = () => load(parent || STORAGE_ROOT);
  return {dir, entries, load, up, atRoot: dir === STORAGE_ROOT};
}

/**
 * Multi-select browser for shortcuts and scan folders. Navigate anywhere; tap
 * notes/PDFs/EPUBs to (de)select (foldersOnly greys them out), tap ＋ to add a
 * folder, then Save adds them all at once.
 */
function ShortcutBrowser({foldersOnly, onDone, onClose}: {foldersOnly?: boolean; onDone: (picks: Pick[]) => void; onClose: () => void}) {
  const {dir, entries, load, up, atRoot} = useDirBrowser();
  const [picks, setPicks] = useState<Pick[]>([]);
  const has = (path: string) => picks.some(p => p.path === path);
  const toggle = (kind: 'folder' | 'file', path: string) =>
    setPicks(ps => (ps.some(p => p.path === path) ? ps.filter(p => p.path !== path) : [...ps, {kind, path}]));

  return (
    <View style={ui.container}>
      <View style={ui.header}>
        <Text style={ui.wizTitle}>{foldersOnly ? 'Add folders' : 'Add shortcuts'}</Text>
        <View style={ui.headerBtns}>
          <TouchableOpacity style={ui.navBtn} onPress={onClose}>
            <Text style={ui.navBtnText}>✕ Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[ui.navBtn, ui.navBtnPri, {marginLeft: 8}]} onPress={() => onDone(picks)}>
            <Text style={[ui.navBtnText, ui.navBtnTextPri]}>Save ({picks.length})</Text>
          </TouchableOpacity>
        </View>
      </View>
      <View style={ui.row}>
        <Btn label="⬆" onPress={up} disabled={atRoot} small />
        <Btn label={has(dir) ? '✓ this folder added' : '＋ Add this folder'} onPress={() => toggle('folder', dir)} small />
      </View>
      <Text style={ui.zoneMeta}>{dir}</Text>
      <ScrollView style={ui.pickerFull}>
        {entries.map((e, i) => {
          const selectable = !foldersOnly && !e.isDir && isOpenableFile(e.name);
          const selected = has(e.path);
          return (
            <View key={i} style={[ui.pickerRow, selected && ui.pickerRowSel]}>
              <TouchableOpacity
                style={{flex: 1}}
                onPress={() => (e.isDir ? load(e.path) : selectable ? toggle('file', e.path) : undefined)}>
                <Text style={[ui.pickerRowText, !e.isDir && !selectable && {color: '#aaa'}]}>
                  {selected ? '✓ ' : e.isDir ? '📁 ' : fileGlyph(e.name)}
                  {e.name}
                </Text>
              </TouchableOpacity>
              {e.isDir && (
                <TouchableOpacity style={ui.pickerAdd} onPress={() => toggle('folder', e.path)}>
                  <Text style={ui.miniBtnText}>{selected ? '✓' : '＋'}</Text>
                </TouchableOpacity>
              )}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

function AppPickerModal({onDone, onClose}: {onDone: (apps: {label: string; component: string}[]) => void; onClose: () => void}) {
  const [all, setAll] = useState<{label: string; component: string}[] | null>(null);
  const [picks, setPicks] = useState<{label: string; component: string}[]>([]);
  const has = (component: string) => picks.some(p => p.component === component);
  const toggle = (a: {label: string; component: string}) =>
    setPicks(ps => (ps.some(p => p.component === a.component) ? ps.filter(p => p.component !== a.component) : [...ps, a]));
  const showAll = async () => {
    try {
      const list: any[] = await DashboardNative.listLaunchableApps();
      const parsed = list
        .map((s: any) => ({label: s.label ?? String(s), component: s.component as string}))
        .filter(a => a.component && !APP_BLOCK.test(a.component));
      parsed.sort((a, b) => a.label.localeCompare(b.label));
      setAll(parsed);
    } catch {
      setAll([]);
    }
  };
  const appRow = (a: {label: string; component: string}, key: string) => (
    <TouchableOpacity key={key} style={has(a.component) ? ui.pickerRowSel : undefined} onPress={() => toggle(a)}>
      <Text style={ui.pickerItem}>
        {has(a.component) ? '✓ ' : '   '}
        {a.label}
      </Text>
    </TouchableOpacity>
  );
  return (
    <View style={ui.container}>
      <View style={ui.header}>
        <Text style={ui.wizTitle}>Add apps</Text>
        <View style={ui.headerBtns}>
          <TouchableOpacity style={ui.navBtn} onPress={onClose}>
            <Text style={ui.navBtnText}>✕ Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[ui.navBtn, ui.navBtnPri, {marginLeft: 8}]} onPress={() => onDone(picks)}>
            <Text style={[ui.navBtnText, ui.navBtnTextPri]}>Save ({picks.length})</Text>
          </TouchableOpacity>
        </View>
      </View>
      {!all && (
        <View style={ui.row}>
          <Btn label="Show all apps" onPress={showAll} small />
        </View>
      )}
      <ScrollView style={ui.pickerFull}>
        <Text style={ui.subLabel}>Supernote apps</Text>
        {CURATED_APPS.map((a, i) => appRow(a, String(i)))}
        {all && <Text style={ui.subLabel}>All apps</Text>}
        {all?.map((a, i) => appRow(a, 'a' + i))}
      </ScrollView>
    </View>
  );
}

function KeywordPicker({folders, onPick, onClose}: {folders: string[]; onPick: (k: string) => void; onClose: () => void}) {
  const [kws, setKws] = useState<string[] | null>(null);
  useEffect(() => {
    scanKeywords(folders)
      .then(r => setKws([...new Set(r.hits.map(h => h.keyword))].sort()))
      .catch(() => setKws([]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <View style={ui.container}>
      <Text style={ui.wizTitle}>Pick a keyword</Text>
      <Btn label="✕ cancel" onPress={onClose} small />
      {!kws && <Text style={ui.hint}>scanning…</Text>}
      <ScrollView style={ui.pickerFull}>
        {kws?.length === 0 && <Text style={ui.empty}>No keyword found in these folders.</Text>}
        {kws?.map((k, i) => (
          <TouchableOpacity key={i} onPress={() => onPick(k)}>
            <Text style={ui.pickerItem}>#{k}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

// ===== helpers =============================================================
function moveItem(arr: any[], i: number, dir: number) {
  const j = i + dir;
  if (j < 0 || j >= arr.length) return;
  const [x] = arr.splice(i, 1);
  arr.splice(j, 0, x);
}
function RecentEditor({i, zone, update}: {i: number; zone: Extract<Zone, {type: 'recent'}>; update: UP}) {
  return (
    <View>
      <Text style={ui.subLabel}>How many (Supernote only tracks the last {RECENT_MAX} opened; {RECENT_MAX} max)</Text>
      <Seg
        options={[{v: '3', label: '3'}, {v: '5', label: '5'}, {v: String(RECENT_MAX), label: String(RECENT_MAX)}]}
        value={String(zone.count ?? RECENT_MAX)}
        onChange={v => update(c => void ((c.zones[i] as any).count = Number(v)))}
      />
      <Text style={ui.subLabel}>Layout</Text>
      <Seg
        options={[{v: 'list', label: 'List'}, {v: 'grid', label: 'Grid'}, {v: 'inline', label: 'Inline'}]}
        value={zone.display ?? 'list'}
        onChange={v => update(c => void ((c.zones[i] as any).display = v))}
      />
    </View>
  );
}

function newZone(type: Zone['type']): Zone {
  if (type === 'shortcuts') return {type, title: 'Shortcuts', items: []};
  if (type === 'stars') return {type, title: 'Stars', folders: [], noteSort: 'recent'};
  if (type === 'keywords') return {type, title: 'Keywords', folders: [], sort: 'keyword', display: 'list', noteSort: 'recent'};
  if (type === 'recent') return {type, title: 'Recent', count: RECENT_MAX, display: 'list'};
  if (type === 'clock') return {type, title: 'Clock', style: 'large', hour24: true};
  if (type === 'search') return {type, title: 'Search'};
  if (type === 'status') return {type, title: 'Device', battery: true, storage: true, stats: true};
  if (type === 'nav') return {type, title: 'Files', root: '/storage/emulated/0/Note'};
  if (type === 'clips') return {type, title: 'Clips', folders: [], labels: [], display: 'grid'};
  return {type: 'apps', title: 'Apps', apps: []};
}

/** Signed hour offset → a readable label, e.g. "+5:30" / "-4" / "0". */
function offsetLabel(offset: number): string {
  if (!offset) return '0';
  const sign = offset > 0 ? '+' : '-';
  const a = Math.abs(offset);
  const h = Math.floor(a);
  const m = Math.round((a - h) * 60);
  return `${sign}${h}${m ? ':' + String(m).padStart(2, '0') : ''}`;
}

function ClockEditor({i, zone, update}: {i: number; zone: Extract<Zone, {type: 'clock'}>; update: UP}) {
  const extras = zone.extras ?? [];
  const patchExtras = (fn: (arr: {label: string; offset: number}[]) => void) =>
    update(c => {
      const z = c.zones[i] as any;
      const arr = Array.isArray(z.extras) ? z.extras.slice() : [];
      fn(arr);
      z.extras = arr;
    });
  const clampOff = (n: number) => Math.max(-23.5, Math.min(23.5, Math.round(n * 2) / 2));
  return (
    <View style={{flexDirection: 'row', alignItems: 'flex-start', flexWrap: 'wrap'}}>
      <View style={{flex: 1, minWidth: 220}}>
        <Text style={ui.subLabel}>Style</Text>
        <View style={ui.row}>
          {CLOCK_STYLES.map(o => {
            const on = (zone.style ?? 'large') === o.v;
            return (
              <TouchableOpacity
                key={o.v}
                style={[ui.choice, {marginRight: 6, marginBottom: 6, paddingVertical: 6, paddingHorizontal: 10}, on && ui.choiceOn]}
                onPress={() => update(c => void ((c.zones[i] as any).style = o.v))}>
                <Text style={[ui.choiceText, {fontSize: 13}, on && ui.choiceTextOn]}>{o.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <Text style={ui.subLabel}>Time format</Text>
        <Seg
          options={[{v: '24', label: '24-hour'}, {v: '12', label: '12-hour'}]}
          value={zone.hour24 === false ? '12' : '24'}
          onChange={v => update(c => void ((c.zones[i] as any).hour24 = v === '24'))}
        />
        <Text style={ui.subLabel}>Date</Text>
        <Seg
          options={[{v: 'on', label: 'Show'}, {v: 'off', label: 'Hide'}]}
          value={zone.showDate === false ? 'off' : 'on'}
          onChange={v => update(c => void ((c.zones[i] as any).showDate = v === 'on'))}
        />
        <Text style={ui.subLabel}>Week number</Text>
        <Seg
          options={[{v: 'off', label: 'Off'}, {v: 'iso', label: 'ISO (Mon)'}, {v: 'us', label: 'US (Sun)'}]}
          value={zone.weekNum ?? 'off'}
          onChange={v => update(c => void ((c.zones[i] as any).weekNum = v))}
        />
        <Text style={ui.subLabel}>Region format (date order &amp; month/day names)</Text>
        <View style={ui.row}>
          {CLOCK_LOCALES.map(l => {
            const on = (zone.locale ?? '') === l.v;
            return (
              <TouchableOpacity
                key={l.v || 'sys'}
                style={[ui.choice, {marginRight: 6, marginBottom: 6, paddingVertical: 6, paddingHorizontal: 10}, on && ui.choiceOn]}
                onPress={() => update(c => void ((c.zones[i] as any).locale = l.v || undefined))}>
                <Text style={[ui.choiceText, {fontSize: 13}, on && ui.choiceTextOn]}>{l.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <Text style={ui.subLabel}>Extra time zones: offset from this device's local time (± hours; ½ adds 30 min)</Text>
        {extras.map((e, idx) => (
          <View key={idx} style={{flexDirection: 'row', alignItems: 'center', marginBottom: 6}}>
            <TextInput
              style={[ui.clipInput, {flex: 1, marginTop: 0, marginRight: 6}]}
              value={e.label}
              onChangeText={t => patchExtras(a => void (a[idx] = {...a[idx], label: t}))}
              autoCapitalize="none"
              placeholder="e.g. New York"
              placeholderTextColor="#9a9a9a"
            />
            <Mini big label="-" onPress={() => patchExtras(a => void (a[idx] = {...a[idx], offset: clampOff(a[idx].offset - 1)}))} />
            <Text style={{minWidth: 44, textAlign: 'center', fontSize: 14, fontWeight: '700', color: '#000000', fontVariant: ['tabular-nums']}}>{offsetLabel(e.offset)}</Text>
            <Mini big label="+" onPress={() => patchExtras(a => void (a[idx] = {...a[idx], offset: clampOff(a[idx].offset + 1)}))} />
            <Mini big label="½" onPress={() => patchExtras(a => void (a[idx] = {...a[idx], offset: clampOff((a[idx].offset % 1 ? Math.trunc(a[idx].offset) : a[idx].offset + (a[idx].offset < 0 ? -0.5 : 0.5)))}))} />
            <Mini big label="✕" onPress={() => patchExtras(a => void a.splice(idx, 1))} />
          </View>
        ))}
        {extras.length < 6 && (
          <Mini big label="＋ add time zone" onPress={() => patchExtras(a => void a.push({label: '', offset: 1}))} />
        )}
      </View>
      <View style={ui.clockPreview}>
        <Text style={[ui.subLabel, {marginTop: 0}]}>Preview</Text>
        <ClockFace
          style={zone.style ?? 'large'}
          hour24={zone.hour24 !== false}
          s={0.85}
          locale={zone.locale}
          showDate={zone.showDate !== false}
          weekNum={zone.weekNum ?? 'off'}
          extras={extras}
        />
      </View>
    </View>
  );
}

/** Clock face presets (item labels shown in Settings). */
const CLOCK_STYLES: {v: ClockStyle; label: string}[] = [
  {v: 'large', label: 'Large'},
  {v: 'compact', label: 'Compact'},
  {v: 'weekday', label: 'Weekday'},
  {v: 'jumbo', label: 'Jumbo'},
  {v: 'mono', label: 'Digital'},
  {v: 'stamp', label: 'Stamp'},
];

/** Region presets for the clock (BCP-47). '' = follow the device. */
const CLOCK_LOCALES: {v: string; label: string}[] = [
  {v: '', label: 'System'},
  {v: 'en-US', label: 'US'},
  {v: 'en-GB', label: 'UK'},
  {v: 'fr-FR', label: 'FR'},
  {v: 'de-DE', label: 'DE'},
  {v: 'es-ES', label: 'ES'},
  {v: 'it-IT', label: 'IT'},
  {v: 'pt-BR', label: 'BR'},
  {v: 'nl-NL', label: 'NL'},
  {v: 'ja-JP', label: 'JP'},
  {v: 'zh-CN', label: 'CN'},
  {v: 'ko-KR', label: 'KR'},
];

function SearchEditor({i, zone, update, openModal}: EditorProps<'search'>) {
  return (
    <View>
      <Text style={ui.subLabel}>
        Searches file &amp; folder names + keywords from scanned notes. Grammar: "phrase" · =exact · a|b · !exclude ·
        f:folder · kw:only · star: · type:note|pdf|doc|folder · approx:
      </Text>
      <Text style={ui.subLabel}>Scope: folders to include (leave empty to search the whole device)</Text>
      <FoldersEditor i={i} folders={zone.folders ?? []} update={update} openModal={openModal} what="search" />
    </View>
  );
}

function StatusEditor({i, zone, update}: {i: number; zone: Extract<Zone, {type: 'status'}>; update: UP}) {
  const toggle = (key: 'battery' | 'storage' | 'stats', label: string) => (
    <View>
      <Text style={ui.subLabel}>{label}</Text>
      <Seg
        options={[{v: 'on', label: 'Show'}, {v: 'off', label: 'Hide'}]}
        value={zone[key] ? 'on' : 'off'}
        onChange={v => update(c => void ((c.zones[i] as any)[key] = v === 'on'))}
      />
    </View>
  );
  return (
    <View>
      {toggle('battery', 'Battery')}
      {toggle('storage', 'Free storage (internal + SD card)')}
      {toggle('stats', 'Stats (notes · stars · keywords)')}
    </View>
  );
}

function NavEditor({i, zone, update, openModal}: EditorProps<'nav'>) {
  return (
    <View>
      <Text style={ui.subLabel}>Root folder: the browser starts here</Text>
      <View style={ui.itemRow}>
        <Text style={ui.itemText} numberOfLines={1}>{zone.root || '/storage/emulated/0'}</Text>
        <Mini
          label="✎ set"
          onPress={() =>
            openModal({
              kind: 'shortcuts',
              foldersOnly: true,
              onDone: picks => {
                const p = picks[0];
                if (p) update(c => void ((c.zones[i] as any).root = p.path));
              },
            })
          }
        />
      </View>
    </View>
  );
}

function ClipsEditor({i, zone, update, openModal}: EditorProps<'clips'>) {
  const [labels, setLabels] = useState<string[]>([]);
  useEffect(() => {
    allClipLabels().then(setLabels).catch(() => {});
  }, []);
  const sel = zone.labels ?? [];
  const toggleLabel = (l: string) =>
    update(c => {
      const z = c.zones[i] as any;
      const set = new Set<string>(z.labels ?? []);
      if (set.has(l)) set.delete(l);
      else set.add(l);
      z.labels = [...set];
    });
  return (
    <View>
      <Text style={ui.subLabel}>Layout</Text>
      <Seg
        options={[{v: 'grid', label: 'Grid'}, {v: 'list', label: 'List'}]}
        value={zone.display ?? 'grid'}
        onChange={v => update(c => void ((c.zones[i] as any).display = v))}
      />
      <Text style={ui.subLabel}>Thumbnail size</Text>
      <Seg
        options={[{v: 'S', label: 'Small'}, {v: 'M', label: 'Medium'}, {v: 'L', label: 'Large'}]}
        value={zone.size ?? 'M'}
        onChange={v => update(c => void ((c.zones[i] as any).size = v))}
      />
      <Text style={ui.subLabel}>Sort</Text>
      <Seg
        options={[{v: 'new', label: 'Newest'}, {v: 'old', label: 'Oldest'}, {v: 'label', label: 'Label'}, {v: 'note', label: 'Note'}]}
        value={zone.sort ?? 'new'}
        onChange={v => update(c => void ((c.zones[i] as any).sort = v))}
      />
      <Text style={ui.subLabel}>Filter: source folders (empty = all)</Text>
      <FoldersEditor i={i} folders={zone.folders ?? []} update={update} openModal={openModal} what="clips" />
      <Text style={ui.subLabel}>Filter: labels (empty = all)</Text>
      {labels.length === 0 ? (
        <Text style={ui.subLabel}>No labels yet: add labels to clips on the dashboard.</Text>
      ) : (
        <View style={ui.row}>
          {labels.map(l => {
            const on = sel.includes(l);
            return (
              <TouchableOpacity
                key={l}
                style={[ui.choice, {marginRight: 6, marginBottom: 6, paddingVertical: 6, paddingHorizontal: 10}, on && ui.choiceOn]}
                onPress={() => toggleLabel(l)}>
                <Text style={[ui.choiceText, {fontSize: 13}, on && ui.choiceTextOn]}>{l}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}
    </View>
  );
}
