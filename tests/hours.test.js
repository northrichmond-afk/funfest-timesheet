import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcEntry, londonDateTime, roundMinutes, distanceM, toCSV, localTime } from '../shared/hours.js';

const plan = { shift_date: '2026-11-02', expected_start: '08:00:00', expected_end: '18:00:00', unpaid_break_mins: 30 };

test('London time in winter (GMT) and summer (BST)', () => {
  assert.equal(londonDateTime('2026-11-02', '08:00').toISOString(), '2026-11-02T08:00:00.000Z');
  assert.equal(londonDateTime('2026-07-20', '08:00').toISOString(), '2026-07-20T07:00:00.000Z');
  assert.equal(localTime('2026-07-20T07:00:00Z'), '08:00');
});

test('on-time shift pays planned hours minus break', () => {
  const c = calcEntry({ actual_start: '2026-11-02T08:00:00Z', actual_end: '2026-11-02T18:00:00Z' }, plan, {});
  assert.equal(c.paidMins, 570);
  assert.equal(c.plannedMins, 570);
  assert.equal(c.varianceMins, 0);
});

test('early arrival not paid by default, paid when enabled', () => {
  const e = { actual_start: '2026-11-02T07:40:00Z', actual_end: '2026-11-02T18:00:00Z' };
  assert.equal(calcEntry(e, plan, { count_early_arrival: false }).paidMins, 570);
  assert.equal(calcEntry(e, plan, { count_early_arrival: true }).paidMins, 590);
});

test('lateness respects grace period; early finish detected', () => {
  const e = { actual_start: '2026-11-02T08:04:00Z', actual_end: '2026-11-02T17:30:00Z' };
  const c = calcEntry(e, plan, { late_grace_mins: 5 });
  assert.equal(c.lateMins, 0);
  assert.equal(c.earlyFinishMins, 30);
  assert.equal(c.paidMins, 566 - 30);
  assert.equal(calcEntry(e, plan, { late_grace_mins: 2 }).lateMins, 4);
});

test('rounding', () => {
  assert.equal(roundMinutes(487, 15), 480);
  assert.equal(roundMinutes(488, 15), 495);
  assert.equal(roundMinutes(487, 0), 487);
  const c = calcEntry({ actual_start: '2026-11-02T08:00:00Z', actual_end: '2026-11-02T16:07:00Z' }, null, { rounding_mins: 15 });
  assert.equal(c.paidMins, 480);
});

test('no plan: paid in full, no break', () => {
  const c = calcEntry({ actual_start: '2026-11-02T09:00:00Z', actual_end: '2026-11-02T12:00:00Z' }, null, {});
  assert.equal(c.paidMins, 180);
  assert.equal(c.plannedMins, null);
});

test('open shift reports elapsed time but no paid time', () => {
  const c = calcEntry({ actual_start: '2026-11-02T09:00:00Z', actual_end: null }, plan, {}, new Date('2026-11-02T10:00:00Z'));
  assert.equal(c.open, true);
  assert.equal(c.paidMins, 0);
  assert.equal(c.rawMins, 60);
});

test('distance matches known value (~111 m per 0.001° lat)', () => {
  const d = distanceM(51.4613, -0.3037, 51.4623, -0.3037);
  assert.ok(Math.abs(d - 111.2) < 1);
});

test('CSV escaping', () => {
  assert.equal(toCSV([['a,b', 'c"d', 'e']]), '"a,b","c""d",e');
});
