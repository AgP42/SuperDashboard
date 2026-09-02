/**
 * Shared clock face: used by the Clock zone on the dashboard and by the live
 * preview in Settings. Ticks on the minute only (never per-second: a per-second
 * refresh would thrash the e-ink display).
 */
import React, {useEffect, useState} from 'react';
import {Text, View} from 'react-native';

import {ClockExtra, ClockStyle, WeekNum} from './config';
import {DIGITAL_FONT} from './fonts/dseg7';

/** Format time/date in the given locale (BCP-47, '' = device default), with a
 *  plain-English fallback if Intl is unavailable. */
export function fmtClock(d: Date, hour24: boolean, locale?: string): {time: string; weekday: string; date: string} {
  const loc = locale || undefined;
  const pad = (n: number) => String(n).padStart(2, '0');
  let time: string;
  try {
    time = d.toLocaleTimeString(loc, {hour: '2-digit', minute: '2-digit', hour12: !hour24});
  } catch {
    if (hour24) time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    else {
      const h = d.getHours() % 12 || 12;
      time = `${h}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
    }
  }
  let weekday: string, date: string;
  try {
    weekday = d.toLocaleDateString(loc, {weekday: 'long'});
    date = d.toLocaleDateString(loc, {day: 'numeric', month: 'short', year: 'numeric'});
  } catch {
    const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    weekday = WD[d.getDay()];
    date = `${d.getDate()} ${MO[d.getMonth()]} ${d.getFullYear()}`;
  }
  return {time, weekday, date};
}

/** Just the HH:MM (no seconds) for the given date. */
function fmtTime(d: Date, hour24: boolean, locale?: string): string {
  return fmtClock(d, hour24, locale).time;
}

/** ISO-8601 week number: weeks start Monday; week 1 is the week with the year's
 *  first Thursday (equivalently, the week containing Jan 4). */
function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (t.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  t.setUTCDate(t.getUTCDate() - dayNum + 3); // move to this week's Thursday
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const fdn = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - fdn + 3);
  return 1 + Math.round((t.getTime() - firstThu.getTime()) / (7 * 86400000));
}

/** "US" week number: week 1 contains Jan 1, weeks start Sunday. */
function usWeek(d: Date): number {
  const start = new Date(d.getFullYear(), 0, 1);
  const days = Math.floor((d.getTime() - start.getTime()) / 86400000) + start.getDay();
  return Math.floor(days / 7) + 1;
}

function weekLabel(d: Date, mode: WeekNum): string {
  if (mode === 'iso') return `W${isoWeek(d)}`;
  if (mode === 'us') return `W${usWeek(d)}`;
  return '';
}

/** How many whole days a +offset lands ahead/behind the local day (for a "+1"
 *  marker on a foreign-timezone clock). */
function dayDelta(base: Date, other: Date): string {
  const b = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  const o = new Date(other.getFullYear(), other.getMonth(), other.getDate());
  const n = Math.round((o.getTime() - b.getTime()) / 86400000);
  return n > 0 ? ` +${n}` : n < 0 ? ` ${n}` : '';
}

export function ClockFace({
  style,
  hour24,
  s = 1,
  font,
  locale,
  showDate = true,
  weekNum = 'off',
  extras,
}: {
  style: ClockStyle;
  hour24: boolean;
  s?: number;
  font?: string;
  locale?: string;
  showDate?: boolean;
  weekNum?: WeekNum;
  extras?: ClockExtra[];
}): React.JSX.Element {
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    const align = setTimeout(() => {
      setNow(new Date());
      interval = setInterval(() => setNow(new Date()), 60000);
    }, (60 - new Date().getSeconds()) * 1000 + 50);
    return () => {
      clearTimeout(align);
      if (interval) clearInterval(interval);
    };
  }, []);

  const {time, weekday, date} = fmtClock(now, hour24, locale);
  const wk = weekLabel(now, weekNum);
  const ff = font ? {fontFamily: font} : {};
  const bigPx = style === 'compact' ? 30 : style === 'jumbo' ? 60 : 44;
  const timeStyle = {
    fontSize: bigPx * s,
    fontWeight: '700' as const,
    color: '#000000',
    fontVariant: ['tabular-nums' as const],
    ...ff,
  };
  const dateStyle = {fontSize: 14 * s, color: '#333333', ...ff};
  const wdStyle = {fontSize: 16 * s, color: '#000000', fontWeight: '600' as const, ...ff};
  // The date line, respecting the show-date toggle and appending the week number.
  const dateLine = (join: string) => {
    const parts = [showDate ? (join ? `${weekday}${join}${date}` : date) : '', wk].filter(Boolean);
    return parts.join(' · ');
  };

  // Extra time zones (label + offset from local). Rendered as compact rows.
  const extraRows =
    extras && extras.length ? (
      <View style={{marginTop: 8 * s}}>
        {extras.map((e, i) => {
          const d = new Date(now.getTime() + e.offset * 3600000);
          return (
            <View key={i} style={{flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 2 * s}}>
              <Text style={[{fontSize: 13 * s, color: '#333333', marginRight: 10}, ff]} numberOfLines={1}>
                {e.label || fmtOffset(e.offset)}
              </Text>
              <Text style={[{fontSize: 15 * s, color: '#000000', fontWeight: '600', fontVariant: ['tabular-nums']}, ff]}>
                {fmtTime(d, hour24, locale)}
                <Text style={{fontSize: 10 * s, color: '#888888'}}>{dayDelta(now, d)}</Text>
              </Text>
            </View>
          );
        })}
      </View>
    ) : null;

  let head: React.JSX.Element;
  if (style === 'compact') {
    head = (
      <View style={{flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 10 * s}}>
        <Text style={timeStyle}>{time}</Text>
        {(showDate || wk) && (
          <Text style={dateStyle}>{[showDate ? `${weekday.slice(0, 3)} ${date}` : '', wk].filter(Boolean).join(' · ')}</Text>
        )}
      </View>
    );
  } else if (style === 'jumbo') {
    head = (
      <View>
        <Text style={timeStyle}>{time}</Text>
        {(showDate || wk) && <Text style={dateStyle}>{dateLine(', ')}</Text>}
      </View>
    );
  } else if (style === 'mono') {
    // Digital look: a real 7-segment face (DSEG7). Only digits and the colon are
    // segment glyphs, so a trailing AM/PM is drawn beside it in the normal font.
    const m = time.match(/^([\d:.\s]+?)\s*([^\d:.\s].*)?$/);
    const digits = m ? m[1] : time;
    const suffix = m && m[2] ? m[2] : '';
    head = (
      <View>
        <View style={{alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'flex-end', borderWidth: 1, borderColor: '#000000', borderRadius: 6, paddingHorizontal: 12 * s, paddingVertical: 4 * s}}>
          <Text style={{fontSize: bigPx * s, color: '#000000', fontFamily: DIGITAL_FONT}}>{digits}</Text>
          {suffix ? <Text style={{fontSize: 16 * s, fontWeight: '700', color: '#000000', marginLeft: 6, marginBottom: 4 * s, ...ff}}>{suffix}</Text> : null}
        </View>
        {(showDate || wk) && <Text style={[dateStyle, {marginTop: 4 * s}]}>{dateLine(', ')}</Text>}
      </View>
    );
  } else if (style === 'stamp') {
    // Centred: weekday · date on top, big time below.
    head = (
      <View style={{alignItems: 'center'}}>
        {(showDate || wk) && <Text style={[dateStyle, {textTransform: 'uppercase', letterSpacing: 1}]}>{dateLine(', ')}</Text>}
        <Text style={[timeStyle, {marginTop: 2 * s}]}>{time}</Text>
      </View>
    );
  } else if (style === 'weekday') {
    head = (
      <View>
        <Text style={wdStyle}>{weekday}</Text>
        <Text style={timeStyle}>{time}</Text>
        {(showDate || wk) && <Text style={dateStyle}>{dateLine('')}</Text>}
      </View>
    );
  } else {
    // 'large' (default)
    head = (
      <View>
        <Text style={timeStyle}>{time}</Text>
        {(showDate || wk) && <Text style={dateStyle}>{dateLine(', ')}</Text>}
      </View>
    );
  }

  return (
    <View>
      {head}
      {extraRows}
    </View>
  );
}

/** A readable fallback label for an extra clock with no user label. */
function fmtOffset(offset: number): string {
  if (offset === 0) return 'Local';
  const sign = offset > 0 ? '+' : '-';
  const a = Math.abs(offset);
  const h = Math.floor(a);
  const m = Math.round((a - h) * 60);
  return `${sign}${h}${m ? ':' + String(m).padStart(2, '0') : ''}h`;
}
