/**
 * Dashboard: root router. Bubble tap → Dashboard surface; toolbar button →
 * Settings surface. See docs/dashboard-spec.md.
 * @format
 */
import React, {useEffect, useMemo, useState} from 'react';
import {DeviceEventEmitter, NativeModules, ScrollView, Text, View} from 'react-native';

import {getRoute, setRoute, Route} from './src/route';
import {DashboardConfig, loadConfig, saveConfig, BLOCK_HEIGHTS} from './src/config';
import {leavePlugin} from './src/bubble';
import {tscale, ZoneView} from './src/zones';
import {ThemedButton, ui} from './src/ui';
import {SettingsScreen} from './src/settings';

const SCALE: Record<string, number> = {S: 1, M: 1.18, L: 1.4, XL: 1.7};

const {DashboardNative} = NativeModules;

/** Stable RN fontFamily name for a MyStyle font path (registered natively at boot). */
function fontFamilyFor(path: string): string {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) | 0;
  return 'udf' + (h >>> 0).toString(36);
}

function App(): React.JSX.Element {
  const [route, setRouteState] = useState<Route>(getRoute());
  useEffect(() => {
    setRouteState(getRoute());
    const sub = DeviceEventEmitter.addListener('dashboard_route', (r: Route) => setRouteState(r));
    return () => sub.remove();
  }, []);
  return route === 'dashboard' ? <DashboardScreen /> : <SettingsScreen />;
}

/** A fixed-height block whose inner scroll turns on ONLY when its content
 *  overflows. A block that fits stays non-scrolling, so a drag started on it
 *  scrolls the whole page; a drag on an overflowing block scrolls the block. */
function FixedBlock({height, children}: {height: number; children: React.ReactNode}) {
  const [overflow, setOverflow] = useState(false);
  return (
    <View style={{height}}>
      <ScrollView
        nestedScrollEnabled
        scrollEnabled={overflow}
        showsVerticalScrollIndicator={overflow}
        onContentSizeChange={(_w, h) => setOverflow(h > height + 1)}>
        {children}
      </ScrollView>
    </View>
  );
}

function DashboardScreen(): React.JSX.Element {
  const [cfg, setCfg] = useState<DashboardConfig | null>(null);
  // `nonce` bumps every time the dashboard is (re)entered → live data (Recent)
  // and config re-read even though the view may be kept mounted across opens.
  const [nonce, setNonce] = useState(0);
  // Reload config + bump `nonce` on mount and every dashboard (re)entry, so
  // zones re-read their data against the fresh config in one render even though
  // the view is kept mounted across opens. The bubble is NO LONGER hidden here:
  // showing/hiding it is driven by AppState in index.js (the OS-level truth of
  // whether the view is really on screen), so a failed showPluginView can't hide
  // the bubble on a stale layout read anymore.
  useEffect(() => {
    let alive = true;
    const enter = () => {
      loadConfig().then(async c => {
        if (!alive) return;
        // Register the user's MyStyle font (if any) BEFORE showing the config, so the
        // fontFamily resolves on the first render (RN won't re-resolve a font added later).
        if (c.font) {
          try {
            await DashboardNative?.registerFont?.(c.font, fontFamilyFor(c.font));
          } catch (e) {}
        }
        if (!alive) return;
        setCfg(c);
        setNonce(n => n + 1);
      });
    };
    enter();
    const sub = DeviceEventEmitter.addListener('dashboard_route', (r: Route) => {
      if (r === 'dashboard') enter();
    });
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  const textScale = cfg?.textScale;
  const headingScale = cfg?.headingScale;
  const fontFamily = cfg?.font ? fontFamilyFor(cfg.font) : undefined;
  const ts = useMemo(
    () => tscale(textScale ? SCALE[textScale] ?? 1.4 : 1.4, headingScale ? SCALE[headingScale] ?? 1 : 1, fontFamily),
    [textScale, headingScale, fontFamily],
  );
  // If the page has both Stars and Keywords, the first scan warms both in one
  // pass (per-file cache) so the second zone's scan is instant.
  const sib = useMemo(
    () =>
      cfg
        ? {
            stars: cfg.zones.some(z => z.type === 'stars'),
            keywords: cfg.zones.some(z => z.type === 'keywords'),
          }
        : undefined,
    [cfg],
  );
  const columns = cfg?.layout.columns ?? 1;
  const vmode = cfg?.layout.vmode ?? 'masonry';
  // Collapse/expand a block (persisted in config so it sticks across opens).
  const toggleCollapse = (i: number) => {
    if (!cfg) return;
    const next = {...cfg, zones: cfg.zones.map((z, k) => (k === i ? {...z, collapsed: !z.collapsed} : z))};
    setCfg(next);
    saveConfig(next);
  };
  // One block. In 'fixed' mode a non-spacer, non-collapsed block gets a set height
  // and scrolls inside; otherwise it takes its natural height.
  const renderZone = (z: DashboardConfig['zones'][number], i: number) => {
    const el = (
      <ZoneView
        zone={z}
        scan={cfg!.scan}
        theme={cfg!.theme}
        ts={ts}
        nonce={nonce}
        sib={sib}
        index={i}
        onToggleCollapse={toggleCollapse}
        showIcons={cfg!.showIcons}
        columns={columns}
      />
    );
    // Fixed mode reserves each block's slot height; INCLUDING when collapsed, so
    // collapsing one block doesn't pull the blocks below it up off the grid.
    if (vmode === 'fixed' && z.type !== 'spacer') {
      return (
        <FixedBlock key={i} height={BLOCK_HEIGHTS[z.h ?? 'M']}>
          {el}
        </FixedBlock>
      );
    }
    return <View key={i}>{el}</View>;
  };
  const colOf = (z: DashboardConfig['zones'][number]) => Math.max(0, Math.min(columns - 1, z.col ?? 0));

  // Header chrome adopts the chosen design + font + text size (same ThemedButton as
  // the in-card Refresh buttons), so it stops looking like a heavy black box.
  const theme = cfg?.theme ?? 'boxed';
  const hbLine = theme === 'gridgray' ? '#888888' : '#000000';
  const ff = fontFamily ? {fontFamily} : null;

  return (
    <View style={ui.container}>
      <View style={ui.header}>
        {/* Configuration pinned far left; the name centred; refresh + fold on the right. */}
        <View style={ui.headerBtns}>
          <ThemedButton theme={theme} s={ts.s} font={fontFamily} label="⚙ Configuration" onPress={() => setRoute('config')} />
        </View>
        <Text style={[ui.title, {fontSize: 22 * ts.hs, color: hbLine, flex: 1, textAlign: 'center'}, ff]} numberOfLines={1}>
          SuperDashboard
        </Text>
        <View style={ui.headerBtns}>
          <ThemedButton theme={theme} s={ts.s} font={fontFamily} label="↻ Refresh all" onPress={() => DeviceEventEmitter.emit('dashboard_refresh_all')} />
          <ThemedButton theme={theme} s={ts.s} font={fontFamily} label="⊖ Fold" onPress={() => leavePlugin()} />
        </View>
      </View>
      {!cfg && <Text style={ui.hint}>loading…</Text>}
      {cfg && cfg.zones.length === 0 && (
        <Text style={ui.hint}>No zone. Configure the dashboard via ⚙ Settings.</Text>
      )}
      {cfg && (
        <ScrollView style={{flex: 1}}>
          {/* Each column is its own independent vertical stack (heights differ freely). */}
          <View style={ui.zoneGrid}>
            {Array.from({length: columns}).map((_, ci) => (
              <View key={ci} style={ui.zoneCol}>
                {cfg.zones.map((z, i) => ({z, i})).filter(({z}) => colOf(z) === ci).map(({z, i}) => renderZone(z, i))}
              </View>
            ))}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

export default App;
