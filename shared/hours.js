// Hours calculation shared by the staff app and admin reports. Pure functions (unit-tested in tests/).
import { TIMEZONE } from './config.js';

const MIN = 60 * 1000;

// Combine a London-local date ('2026-11-02') and time ('08:00' or '08:00:00') into a Date.
export function londonDateTime(dateStr, timeStr, tz = TIMEZONE) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  // Start from the UTC interpretation, then correct by the zone offset at that moment.
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const offset = tzOffsetMinutes(new Date(guess), tz);
  let t = guess - offset * MIN;
  const offset2 = tzOffsetMinutes(new Date(t), tz); // handles DST boundaries
  if (offset2 !== offset) t = guess - offset2 * MIN;
  return new Date(t);
}

export function tzOffsetMinutes(date, tz = TIMEZONE) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).map(p => [p.type, p.value]));
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUTC - date.getTime()) / MIN);
}

// Local date string (YYYY-MM-DD) of a timestamp in the club's timezone
export function localDate(ts, tz = TIMEZONE) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(ts));
}

export function localTime(ts, tz = TIMEZONE) {
  if (!ts) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(ts));
}

export function roundMinutes(mins, step) {
  if (!step) return mins;
  return Math.round(mins / step) * step;
}

/**
 * Paid minutes for one time entry.
 * entry:   { actual_start, actual_end }
 * planned: { shift_date, expected_start, expected_end, unpaid_break_mins } | null
 * rules:   { rounding_mins, count_early_arrival, late_grace_mins }
 */
export function calcEntry(entry, planned, rules = {}, now = new Date()) {
  const start = new Date(entry.actual_start);
  const end = entry.actual_end ? new Date(entry.actual_end) : null;
  const out = { paidMins: 0, rawMins: 0, breakMins: 0, plannedMins: null, varianceMins: null,
                lateMins: 0, earlyFinishMins: 0, overtimeMins: 0, open: !end };
  if (!end) {
    out.rawMins = Math.max(0, Math.round((now - start) / MIN));
    return out;
  }

  let countedStart = start;
  let pStart = null, pEnd = null;
  if (planned) {
    pStart = londonDateTime(planned.shift_date, planned.expected_start);
    pEnd = londonDateTime(planned.shift_date, planned.expected_end);
    if (pEnd <= pStart) pEnd = new Date(pEnd.getTime() + 24 * 60 * MIN); // overnight shift
    out.plannedMins = Math.round((pEnd - pStart) / MIN) - (planned.unpaid_break_mins || 0);
    if (!rules.count_early_arrival && start < pStart) countedStart = pStart;
    const late = Math.round((start - pStart) / MIN);
    if (late > (rules.late_grace_mins ?? 0)) out.lateMins = late;
    const early = Math.round((pEnd - end) / MIN);
    if (early > 0) out.earlyFinishMins = early;
  }

  out.rawMins = Math.max(0, Math.round((end - countedStart) / MIN));
  out.breakMins = planned ? Math.min(planned.unpaid_break_mins || 0, out.rawMins) : 0;
  out.paidMins = Math.max(0, roundMinutes(out.rawMins - out.breakMins, rules.rounding_mins || 0));
  if (out.plannedMins != null) {
    out.varianceMins = out.paidMins - out.plannedMins;
    if (out.varianceMins > 0) out.overtimeMins = out.varianceMins;
  }
  return out;
}

export function fmtHours(mins) {
  if (mins == null) return '';
  const sign = mins < 0 ? '−' : '';
  const a = Math.abs(mins);
  return `${sign}${Math.floor(a / 60)}h ${String(a % 60).padStart(2, '0')}m`;
}

export const decimalHours = mins => (mins / 60).toFixed(2);

// Distance in metres between two lat/lng points (mirrors distance_m in SQL)
export function distanceM(lat1, lng1, lat2, lng2) {
  const r = x => (x * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 +
            Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

export function toCSV(rows) {
  const esc = v => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map(r => r.map(esc).join(',')).join('\r\n');
}
