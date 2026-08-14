/**
 * Open a target from the dashboard, then leave to the OS so it comes to the
 * foreground (a target launched behind the fullscreen plugin view looks dead).
 * The bubble is restored on the way out so the user can return. On failure we
 * stay and show a dialog instead of silently closing.
 */
import {NativeModules} from 'react-native';
import {NativeUIUtils} from 'sn-plugin-lib';

import {leavePlugin} from './bubble';

const {DashboardNative} = NativeModules;

async function go(fn: () => Promise<unknown>, what: string): Promise<void> {
  try {
    await fn();
    leavePlugin();
  } catch {
    try {
      await NativeUIUtils.showRattaDialog(`Couldn't ${what}.`, '', 'OK', false);
    } catch {
      /* ignore */
    }
  }
}

/** Open a note at a 1-based page (0/undefined → last-used page). */
function openNote(path: string, page = 0) {
  return go(() => DashboardNative.openNote(path, page), 'open the note');
}

/** Open a folder in the file manager. */
export function openFolder(path: string) {
  return go(() => DashboardNative.openFolder(path), 'open the folder');
}

/** Open a PDF/document in the Supernote Document viewer. */
function openDocument(path: string, page = 0) {
  return go(() => DashboardNative.openDocument(path, page), 'open the document');
}

/** Open a scan/shortcut file target (note editor for .note, Document viewer for .pdf/.epub). */
export function openFile(path: string, page = 0) {
  return /\.(pdf|epub)$/i.test(path) ? openDocument(path, page) : openNote(path, page);
}

/** Launch an app by "package/activity"; leaves to the OS. */
export function launchApp(component: string) {
  return go(() => DashboardNative.launchActivity(component), 'launch the app');
}
