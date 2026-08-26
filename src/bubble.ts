/**
 * Bubble control and the single exit path out of the plugin view.
 * leavePlugin() is the ONLY caller of closePluginView in the plugin: every
 * exit (open a target, fold ⊖, Settings ✕) restores the bubble per config
 * before closing, so no path can strand a hidden bubble.
 */
import {NativeModules} from 'react-native';
import {PluginManager} from 'sn-plugin-lib';

import {loadConfig} from './config';

const {DashboardNative} = NativeModules;

/** Apply the saved bubble mode: show the house bubble, or remove it when 'off'.
 *  The bubble is icon‑only now (just the house) — no label/hint variants. */
export async function showBubbleFromConfig(): Promise<boolean> {
  try {
    const cfg = await loadConfig();
    if (cfg.bubble.mode === 'off') {
      await DashboardNative.hideBubble(); // no bubble — make sure none lingers
    } else {
      await DashboardNative.showBubble();
    }
    return true;
  } catch {
    return false;
  }
}

/** Restore the bubble, then close the plugin view. */
export async function leavePlugin(): Promise<void> {
  await showBubbleFromConfig();
  setTimeout(() => PluginManager.closePluginView(), 150);
}
