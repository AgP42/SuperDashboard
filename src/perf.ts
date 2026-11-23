/**
 * Performance traces into the on-device log ([perf] lines), so a "the dashboard
 * feels slow" report can be read off SuperDashboard_log.txt instead of guessed.
 *
 * What gets logged (counts and timings only: never note text or file paths,
 * same privacy rule as the rest of the debug log, #6):
 *  - `open#N start (why)`: each dashboard entry (bubble tap, route, Refresh all)
 *    starts an "episode"; every later line carries `+ms` since that start, so
 *    one episode reads as a timeline (config loaded, view visible, each block's
 *    data ready, scans, search index...).
 *  - `timed()` spans: `label Nms` + a size note, with the episode offset.
 *  - native bridge totals: every DashboardNative / PluginFileAPI / PluginCommAPI
 *    / PluginNoteAPI call is counted and timed (see instrumentBridge); a summary
 *    of the busiest methods is logged once the episode goes quiet.
 *  - JS stalls: during an episode, a 100 ms ticker reports any gap > 300 ms
 *    (the JS thread was busy: parsing, sorting, rendering) and which spans were
 *    running at that moment.
 * Quiet by default: only what is slow gets a line (spans >= SLOW_MS, stalls
 * > 500 ms, bridge methods with >= 300 ms total), so a normal open costs a
 * handful of lines. Episode starts, "ready" marks and failures always log.
 * Logging follows the "debug log" setting (config.debugLog): off → nothing is
 * written to the file (the native side drops it), and the ticker never runs.
 */
import {NativeModules} from 'react-native';

const {DashboardNative} = NativeModules;

let enabled = true;
/** Spans/steps shorter than this are not logged (fast = nothing to report). */
export const SLOW_MS = 150;
/** Mirrors config.debugLog (set from config.ts on load/save). */
export function setPerfEnabled(on: boolean): void {
  enabled = on;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
function stamp(): string {
  const t = new Date();
  return `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}.${pad(t.getMilliseconds(), 3)}`;
}

// Raw (un-instrumented) appendLog, captured before instrumentBridge wraps the
// module, so logging never counts itself in the bridge stats.
const rawAppend: ((s: string) => Promise<any>) | undefined = DashboardNative?.appendLog?.bind(DashboardNative);

export function plog(m: string): void {
  if (!enabled) return;
  try {
    rawAppend?.(`[perf] ${stamp()} ${m}${episodeTag()}`).catch(() => {});
  } catch {}
}

// ---- Episodes (one dashboard entry = one timeline) ------------------------

let episode = 0;
let episodeT0 = 0;
const EPISODE_MS = 120000; // after 2 min the "+ms" offset stops being useful

function episodeTag(): string {
  if (!episode || Date.now() - episodeT0 > EPISODE_MS) return '';
  return ` [#${episode} +${Date.now() - episodeT0}ms]`;
}

/** Start a new timeline. Called at the bubble tap (earliest point), on route
 *  entry (skipped if a tap just started one) and on Refresh all. */
export function markOpen(why: string): void {
  if (why === 'route' && episode && Date.now() - episodeT0 < 1500) return;
  episode++;
  episodeT0 = Date.now();
  resetBridgeStats();
  plog(`open#${episode} start (${why})`);
  startStallWatch(30000);
}

/** A block (or step) of the current episode has its data on screen. */
export function ready(label: string, note?: string): void {
  plog(`ready ${label}${note ? ' ' + note : ''}`);
}

// ---- Spans ----------------------------------------------------------------

const running = new Map<number, string>();
let spanSeq = 0;

/** Time an async step and log `label Nms` (plus an optional size note). */
export async function timed<T>(label: string, fn: () => Promise<T>, note?: (v: T) => string): Promise<T> {
  const t0 = Date.now();
  const id = ++spanSeq;
  running.set(id, label);
  try {
    const v = await fn();
    const ms = Date.now() - t0;
    if (ms >= SLOW_MS) plog(`${label} ${ms}ms${note ? ' ' + note(v) : ''}`);
    return v;
  } catch (e) {
    plog(`${label} FAILED after ${Date.now() - t0}ms`);
    throw e;
  } finally {
    running.delete(id);
  }
}

/** Synchronous variant, for CPU-bound steps (parse, sort, index fold). */
export function timedSync<T>(label: string, fn: () => T, note?: (v: T) => string): T {
  const t0 = Date.now();
  const v = fn();
  const ms = Date.now() - t0;
  if (ms >= 50) plog(`${label} ${ms}ms (sync)${note ? ' ' + note(v) : ''}`);
  return v;
}

// ---- JS stall watch -------------------------------------------------------

let stallTimer: ReturnType<typeof setInterval> | null = null;
let stallUntil = 0;
let lastTick = 0;
let stallTotal = 0;
let stallCount = 0;

function startStallWatch(ms: number): void {
  if (!enabled) return;
  stallUntil = Date.now() + ms;
  stallTotal = 0;
  stallCount = 0;
  lastTick = Date.now();
  if (stallTimer) return;
  stallTimer = setInterval(() => {
    const now = Date.now();
    const gap = now - lastTick - 100;
    lastTick = now;
    // A gap of many seconds is the view being suspended (timers pause while the
    // dashboard is hidden), not a busy JS thread: don't report it as a stall.
    if (gap > 500 && gap < 20000) {
      stallTotal += gap;
      stallCount++;
      const act = [...new Set(running.values())].join(', ');
      plog(`js-stall ${gap}ms${act ? ' during: ' + act : ''}`);
    }
    if (now > stallUntil) {
      if (stallTimer) clearInterval(stallTimer);
      stallTimer = null;
      if (stallCount) plog(`js-stall summary: ${stallCount} stalls, ${stallTotal}ms blocked in the first ${Math.round(ms / 1000)}s`);
    }
  }, 100);
}

// ---- Native bridge accounting ---------------------------------------------

interface Stat {
  n: number;
  total: number;
  max: number;
  fail: number;
}
const stats = new Map<string, Stat>();
let inflight = 0;
let peakInflight = 0;
let summaryTimer: ReturnType<typeof setTimeout> | null = null;
let windowStart = 0;

function resetBridgeStats(): void {
  stats.clear();
  peakInflight = inflight;
  windowStart = Date.now();
}

let lastCallAt = 0;
const QUIET_MS = 4000;

/** Logged once nothing has crossed the bridge for 4 s (the episode went quiet).
 *  One timer per quiet window, not one per call: a scan makes thousands. */
function scheduleSummary(): void {
  lastCallAt = Date.now();
  if (summaryTimer) return;
  const check = () => {
    const left = QUIET_MS - (Date.now() - lastCallAt);
    if (left > 0) {
      summaryTimer = setTimeout(check, left);
      return;
    }
    summaryTimer = null;
    logBridgeSummary();
  };
  summaryTimer = setTimeout(check, QUIET_MS);
}

/** One line per busiest method: calls, total and max ms. Totals overlap when
 *  calls run in parallel (peak in-flight is shown for that reason). */
export function logBridgeSummary(): void {
  if (!stats.size) return;
  const rows = [...stats.entries()].sort((a, b) => b[1].total - a[1].total);
  const calls = rows.reduce((s, [, v]) => s + v.n, 0);
  const slow = rows.filter(([, v]) => v.total >= 300).slice(0, 6);
  if (!slow.length) {
    stats.clear();
    windowStart = Date.now();
    return;
  }
  plog(`bridge summary: ${calls} native calls in ${Math.round((Date.now() - windowStart - 4000) / 100) / 10}s, peak ${peakInflight} in flight`);
  for (const [k, v] of slow) {
    plog(`  bridge ${k} n=${v.n} total=${v.total}ms avg=${Math.round(v.total / v.n)}ms max=${v.max}ms${v.fail ? ` fail=${v.fail}` : ''}`);
  }
  stats.clear();
  windowStart = Date.now();
}

function record(key: string, ms: number, failed: boolean): void {
  let s = stats.get(key);
  if (!s) stats.set(key, (s = {n: 0, total: 0, max: 0, fail: 0}));
  s.n++;
  s.total += ms;
  if (ms > s.max) s.max = ms;
  if (failed) s.fail++;
}

/** An SDK reply that is `{success:false}` counts as a failure too. */
const isFail = (v: any) => !!v && typeof v === 'object' && !Array.isArray(v) && v.success === false;

const SKIP = new Set(['appendLog', 'constructor', 'getConstants', 'addListener', 'removeListeners']);

function wrapAll(obj: any, prefix: string, names: string[]): number {
  let n = 0;
  for (const name of names) {
    if (SKIP.has(name)) continue;
    const orig = obj[name];
    if (typeof orig !== 'function' || orig.__perf) continue;
    const key = `${prefix}.${name}`;
    const wrapped = function (this: any, ...args: any[]) {
      const t0 = Date.now();
      inflight++;
      if (inflight > peakInflight) peakInflight = inflight;
      const done = (failed: boolean) => {
        inflight--;
        if (!enabled) return; // debug log off: no accounting, no timers
        record(key, Date.now() - t0, failed);
        scheduleSummary();
      };
      let r: any;
      try {
        r = orig.apply(this === undefined ? obj : this, args);
      } catch (e) {
        done(true);
        throw e;
      }
      if (r && typeof r.then === 'function') {
        return r.then(
          (v: any) => {
            done(isFail(v));
            return v;
          },
          (e: any) => {
            done(true);
            throw e;
          },
        );
      }
      done(false);
      return r;
    };
    (wrapped as any).__perf = true;
    try {
      obj[name] = wrapped;
      n++;
    } catch {
      /* read-only property: leave it */
    }
  }
  return n;
}

let instrumented = false;
/** Wrap every native entry point once, at load (index.js). Call sites resolve
 *  methods at call time (DashboardNative.x(...), PluginFileAPI.x(...)), so the
 *  wrappers see every call without touching them. */
export function instrumentBridge(sdk: Record<string, any>): void {
  if (instrumented) return;
  instrumented = true;
  const parts: string[] = [];
  try {
    if (DashboardNative) parts.push(`Native:${wrapAll(DashboardNative, 'Native', Object.keys(DashboardNative))}`);
  } catch {}
  for (const [name, cls] of Object.entries(sdk)) {
    try {
      if (cls) parts.push(`${name}:${wrapAll(cls, name, Object.getOwnPropertyNames(cls))}`);
    } catch {}
  }
  plog(`bridge instrumented ${parts.join(' ')}`);
}
