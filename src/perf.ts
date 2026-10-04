/**
 * Lightweight timing traces into the on-device log ([perf] lines), so a "search
 * feels slow" report can be read off dashboard-log.txt instead of guessed.
 */
import {NativeModules} from 'react-native';

const {DashboardNative} = NativeModules;

export function plog(m: string): void {
  try {
    DashboardNative?.appendLog?.('[perf] ' + m).catch(() => {});
  } catch {}
}

/** Time an async step and log `label Nms` (plus an optional size note). */
export async function timed<T>(label: string, fn: () => Promise<T>, note?: (v: T) => string): Promise<T> {
  const t0 = Date.now();
  try {
    const v = await fn();
    plog(`${label} ${Date.now() - t0}ms${note ? ' ' + note(v) : ''}`);
    return v;
  } catch (e) {
    plog(`${label} FAILED after ${Date.now() - t0}ms`);
    throw e;
  }
}
