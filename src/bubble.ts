/**
 * Bubble control and the single exit path out of the plugin view.
 * leavePlugin() is the ONLY caller of closePluginView in the plugin: every
 * exit (open a target, fold ⊖, Settings ✕) restores the bubble per config
 * before closing, so no path can strand a hidden bubble.
 */
import {AppState, NativeModules} from 'react-native';
import {PluginManager} from 'sn-plugin-lib';

import {loadConfig} from './config';

const {DashboardNative} = NativeModules;

/** Apply the saved bubble mode: show the house bubble, or remove it when 'off'.
 *  The bubble is icon-only now (just the house); no label/hint variants. */
export async function showBubbleFromConfig(): Promise<boolean> {
  try {
    const cfg = await loadConfig();
    if (cfg.bubble.mode === 'off') {
      await DashboardNative.hideBubble(); // no bubble; make sure none lingers
    } else {
      await DashboardNative.showBubble();
    }
    return true;
  } catch {
    return false;
  }
}

// Bumped each time the plugin view comes to the foreground. A deferred close
// must only ever close the view session that asked for it: opening a file makes
// the host hide the view on its own (schedulePendingHide), which pauses RN timers,
// so the 150 ms close below stayed frozen and fired on the NEXT bubble open,
// shutting the freshly opened dashboard ~1 s later (the "PARASITE close").
let viewGen = 0;
AppState.addEventListener('change', s => {
  if (s === 'active') viewGen++;
});

/** Restore the bubble, then close the plugin view, unless the host already hid
 *  it or the view was re-opened since (a stale close would kill the new one). */
export async function leavePlugin(): Promise<void> {
  const gen = viewGen;
  await showBubbleFromConfig();
  if (AppState.currentState !== 'active') {
    leaveLog(`skip close: view already ${AppState.currentState}`);
    return;
  }
  setTimeout(() => {
    if (viewGen !== gen || AppState.currentState !== 'active') {
      leaveLog('skip stale close (view re-opened or hidden since)');
      return;
    }
    PluginManager.closePluginView();
  }, 150);
}

function leaveLog(m: string) {
  DashboardNative?.appendLog?.(`[leave] ${m}`).catch(() => {});
}
