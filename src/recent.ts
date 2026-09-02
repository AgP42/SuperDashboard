/**
 * Recently-opened files. The Supernote's own tracker `/Recent/Recent.txt` is the
 * ideal source (recently OPENED, notes + PDFs, in order), but on the Chauvet
 * plugin-preview firmware `/Recent` is NOT in the set of dirs FILE:READ grants
 * (Note/Document/MyStyle/EXPORT/INBOX/SCREENSHOT): a direct read throws
 * AccessDeniedException, and probing it through the SDK's file ops HARD-CRASHES
 * the plugin. So when the direct read is blocked we fall back to the most-recently
 * MODIFIED notes/documents under the in-scope folders (a safe listDir walk).
 */
import {NativeModules} from 'react-native';

import {recentModifiedFiles} from './scanner';

const {DashboardNative} = NativeModules;
const RECENT_PATH = '/storage/emulated/0/Recent/Recent.txt';

function log(m: string): void {
  DashboardNative?.appendLog?.(`[recent] ${m}`).catch(() => {});
}

export async function readRecent(): Promise<string[]> {
  // 1) Direct read of the device's recent list: works on the old firmware and
  //    anywhere /Recent is in FILE:READ scope.
  try {
    const text: string = await DashboardNative.readTextFile(RECENT_PATH);
    const paths = text
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0);
    log(`direct ${paths.length} paths`);
    return paths;
  } catch (e: any) {
    log(`direct blocked (${e && e.message}); using recently-modified fallback`);
  }
  // 2) Chauvet: /Recent is unreachable. Show recently-modified notes/docs instead.
  try {
    const files = await recentModifiedFiles(16);
    log(`fallback recently-modified ${files.length}`);
    return files;
  } catch (e: any) {
    log(`fallback failed: ${e && e.message}`);
    return [];
  }
}
