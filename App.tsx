/**
 * Dashboard — root router. Bubble tap → Dashboard surface; toolbar button →
 * Settings surface. See docs/dashboard-spec.md.
 * @format
 */
import React, {useEffect, useMemo, useState} from 'react';
import {DeviceEventEmitter, ScrollView, Text, TouchableOpacity, View} from 'react-native';

import {getRoute, setRoute, Route} from './src/route';
import {DashboardConfig, loadConfig} from './src/config';
import {leavePlugin} from './src/bubble';
import {tscale, ZoneView} from './src/zones';
import {ui} from './src/ui';
import {SettingsScreen} from './src/settings';

const SCALE: Record<string, number> = {S: 1, M: 1.18, L: 1.4, XL: 1.7};

function App(): React.JSX.Element {
  const [route, setRouteState] = useState<Route>(getRoute());
  useEffect(() => {
    setRouteState(getRoute());
    const sub = DeviceEventEmitter.addListener('dashboard_route', (r: Route) => setRouteState(r));
    return () => sub.remove();
  }, []);
  return route === 'dashboard' ? <DashboardScreen /> : <SettingsScreen />;
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
      loadConfig().then(c => {
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
  const ts = useMemo(
    () => tscale(textScale ? SCALE[textScale] ?? 1.4 : 1.4, headingScale ? SCALE[headingScale] ?? 1 : 1),
    [textScale, headingScale],
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
  const zoneEl = (z: DashboardConfig['zones'][number], i: number) => (
    <ZoneView key={i} zone={z} scan={cfg!.scan} theme={cfg!.theme} ts={ts} nonce={nonce} sib={sib} />
  );

  return (
    <View style={ui.container}>
      <View style={ui.header}>
        <View style={ui.headerBtns}>
          <Text style={ui.title}>Dashboard</Text>
          {/* config link on the LEFT, away from the frequently-tapped right side */}
          <TouchableOpacity style={ui.iconBtn} onPress={() => setRoute('config')}>
            <Text style={ui.iconText}>⚙ Configuration</Text>
          </TouchableOpacity>
        </View>
        <View style={ui.headerBtns}>
          <TouchableOpacity style={ui.iconBtn} onPress={() => DeviceEventEmitter.emit('dashboard_refresh_all')}>
            <Text style={ui.iconText}>↻ Refresh all</Text>
          </TouchableOpacity>
          <TouchableOpacity style={ui.iconBtn} onPress={() => leavePlugin()}>
            <Text style={ui.iconText}>⊖</Text>
          </TouchableOpacity>
        </View>
      </View>
      {!cfg && <Text style={ui.hint}>loading…</Text>}
      {cfg && cfg.zones.length === 0 && (
        <Text style={ui.hint}>No zone. Configure the dashboard via ⚙ Settings.</Text>
      )}
      {cfg && (
        <ScrollView style={{flex: 1}}>
          {cfg.layout === 'grid' ? (
            // Masonry: two independent columns (even/odd) so a tall zone in one
            // column doesn't leave whitespace next to a short one.
            <View style={ui.zoneGrid}>
              <View style={ui.zoneCol}>{cfg.zones.filter((_, i) => i % 2 === 0).map((z, k) => zoneEl(z, k * 2))}</View>
              <View style={ui.zoneCol}>{cfg.zones.filter((_, i) => i % 2 === 1).map((z, k) => zoneEl(z, k * 2 + 1))}</View>
            </View>
          ) : (
            cfg.zones.map((z, i) => zoneEl(z, i))
          )}
        </ScrollView>
      )}
    </View>
  );
}

export default App;
