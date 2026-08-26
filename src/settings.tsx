/**
 * Settings — a guided 3-step wizard; every change autosaves.
 *   1 Look (layout · design · bubble · text size)
 *   2 Sections (+ live preview, add/reorder/remove)
 *   3 Content (per-zone details, refresh, sorts, line preview)
 * The header has Reset all + Save/load config; a ✕ closes the plugin. No JSON
 * editor here — advanced users edit MyStyle/Plugins/Dashboard/config.json directly.
 */
import React, {useEffect, useState} from 'react';
import {Image, NativeModules, ScrollView, Text, TextInput, TouchableOpacity, View} from 'react-native';

const KOFI_QR = require('../assets/kofi-qr.png');

import {
  BubbleMode,
  DashboardConfig,
  DEFAULT_CONFIG,
  KeywordDisplay,
  loadConfig,
  NoteSort,
  RECENT_MAX,
  saveConfig,
  TextScale,
  Theme,
  Zone,
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

const STEP_TITLES = ['Look', 'Sections', 'Content'];
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
        {step === 2 && <StepSections cfg={cfg} update={update} />}
        {step === 3 && <StepContent cfg={cfg} update={update} openModal={setModal} />}
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
            Dashboard is a personal project built by a Supernote user, for Supernote users. I built
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

// ===== Step 1 — Look (Layout + Design + Bubble) ============================
function StepLook({cfg, update}: {cfg: DashboardConfig; update: UP}) {
  const cols = cfg.layout === 'grid' ? 2 : 1;
  return (
    <View>
      <Text style={ui.wizStepTag}>Layout</Text>
      <View style={ui.snapWrap}>
        <Snap width={210} on={cfg.layout === 'stack'} label="1 column" onPress={() => update(c => void (c.layout = 'stack'))}>
          <MiniPage theme={cfg.theme} cols={1} zones={sampleZones} width={210} />
        </Snap>
        <Snap width={210} on={cfg.layout === 'grid'} label="2 columns" onPress={() => update(c => void (c.layout = 'grid'))}>
          <MiniPage theme={cfg.theme} cols={2} zones={sampleZones} width={210} />
        </Snap>
      </View>

      <Text style={ui.wizStepTag}>Design — on your {cols === 2 ? '2-column' : '1-column'} layout</Text>
      <View style={ui.snapWrap}>
        {(['ledger', 'boxed', 'airy'] as Theme[]).map(t => (
          <Snap key={t} width={185} on={cfg.theme === t} label={t} onPress={() => update(c => void (c.theme = t))}>
            <MiniPage theme={t} cols={cols} zones={sampleZones} width={185} />
          </Snap>
        ))}
      </View>

      <Text style={ui.wizStepTag}>Bubble</Text>
      <Text style={ui.subLabel}>The house floats over every screen — tap to open the dashboard, drag to move. Set Off to use only the toolbar SuperDashboard button.</Text>
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
    </View>
  );
}

// ===== Step 2 — Sections ===================================================
function StepSections({cfg, update}: {cfg: DashboardConfig; update: UP}) {
  const cols = cfg.layout === 'grid' ? 2 : 1;
  return (
    <View>
      <Text style={ui.wizStepTag}>Live preview</Text>
      <View style={{alignItems: 'center', marginBottom: 14}}>
        <MiniPage theme={cfg.theme} cols={cols} zones={cfg.zones.map(z => ({type: z.type, title: z.title}))} width={270} />
      </View>

      <Text style={ui.wizStepTag}>Sections (fill the layout in order)</Text>
      {cfg.zones.map((z, i) => (
        <View key={i} style={ui.zoneRow}>
          <Text style={ui.zoneRowText}>
            {i + 1}. {z.type}
            {z.title ? ` — ${z.title}` : ''}
          </Text>
          <View style={ui.zoneRowBtns}>
            <Mini label="▲" onPress={() => update(c => moveZone(c, i, -1))} />
            <Mini label="▼" onPress={() => update(c => moveZone(c, i, 1))} />
            <Mini label="✕" onPress={() => update(c => void c.zones.splice(i, 1))} />
          </View>
        </View>
      ))}
      <Text style={ui.subLabel}>Add a section</Text>
      <View style={ui.row}>
        {(['shortcuts', 'stars', 'keywords', 'apps', 'recent'] as Zone['type'][]).map(t => (
          <Btn key={t} label={`＋ ${t}`} onPress={() => update(c => c.zones.push(newZone(t)))} small />
        ))}
      </View>
    </View>
  );
}

// ===== Step 3 — Content ====================================================
function StepContent({cfg, update, openModal}: {cfg: DashboardConfig; update: UP; openModal: (m: Modal) => void}) {
  return (
    <View>
      <Text style={ui.wizStepTag}>Refresh (Stars & Keywords)</Text>
      <View style={ui.row}>
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
              if (v === 'open') {c.scan.autoOnOpen = true;}
              else {c.scan.autoOnOpen = false; c.scan.autoRefreshHours = v === 'off' ? 0 : Number(v);}
            })
          }
        />
      </View>

      {cfg.zones.length === 0 && <Text style={ui.hint}>No section yet — add some in step 2 (Sections).</Text>}
      {cfg.zones.map((z, i) => (
        <View key={i} style={ui.contentCard}>
          <Text style={ui.zoneRowText}>
            Section {z.type} #{typeIndex(cfg.zones, i)}
          </Text>
          <EditableTitle
            value={z.title ?? z.type}
            onSave={t => update(c => void (c.zones[i].title = t || undefined))}
          />
          {z.type === 'shortcuts' && <ShortcutsEditor i={i} zone={z} update={update} openModal={openModal} />}
          {z.type === 'stars' && (
            <View>
              <FoldersEditor i={i} folders={z.folders} update={update} openModal={openModal} what="stars" />
              <NoteSortRow i={i} value={z.noteSort ?? 'recent'} update={update} />
              <Text style={ui.subLabel}>Line preview — show each star's line (slower scan)</Text>
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
        </View>
      ))}
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
          No folder selected — the whole device is scanned at each refresh.
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
type MiniZ = {type: Zone['type']; title?: string};
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
  zones.forEach((z, i) => columns[i % cols].push(z));
  return (
    <View style={[ui.miniPage, {width, height}]}>
      <Text style={ui.miniPageTitle}>Dashboard</Text>
      {zones.length === 0 && <Text style={{fontSize: 9, color: '#999', marginTop: 6}}>empty — add sections</Text>}
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

const Mini = ({label, onPress}: {label: string; onPress: () => void}) => (
  <TouchableOpacity style={ui.miniBtn} onPress={onPress}>
    <Text style={ui.miniBtnText}>{label}</Text>
  </TouchableOpacity>
);

/**
 * Inline title editor. ✎ turns the title into a field; committing happens on the
 * keyboard's Done key OR when the field loses focus — NOT via a button (on the
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
        <Text style={[ui.itemText, {fontWeight: '600', marginRight: 6}]}>{value}</Text>
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

/** 1-based index of a zone among zones of the same type. */
function typeIndex(zones: Zone[], i: number): number {
  let n = 0;
  for (let k = 0; k <= i; k++) if (zones[k].type === zones[i].type) n++;
  return n;
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
function moveZone(c: DashboardConfig, i: number, dir: number) {
  moveItem(c.zones, i, dir);
}
function moveItem(arr: any[], i: number, dir: number) {
  const j = i + dir;
  if (j < 0 || j >= arr.length) return;
  const [x] = arr.splice(i, 1);
  arr.splice(j, 0, x);
}
function RecentEditor({i, zone, update}: {i: number; zone: Extract<Zone, {type: 'recent'}>; update: UP}) {
  return (
    <View>
      <Text style={ui.subLabel}>How many (Supernote only tracks the last {RECENT_MAX} opened — {RECENT_MAX} max)</Text>
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
  return {type: 'apps', title: 'Apps', apps: []};
}
