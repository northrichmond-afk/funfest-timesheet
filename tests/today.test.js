import { test } from 'node:test';
import assert from 'node:assert/strict';
import { childrenOnDay } from '../shared/bookings.js';
import { accidentFile, clubFromSiteName, toLocalInput } from '../shared/accidents.js';

const li = (id, name, date, slot, child, childId, tt = '5-7 Years') => ({
  id, name, meta_data: [
    { key: 'Timeslot', display_key: 'Timeslot', display_value: slot }, { key: 'Date', display_key: 'Date', display_value: date },
    { key: 'Timetable', display_key: 'Timetable', display_value: tt }, { key: 'Child', display_key: 'Child', display_value: child },
    { key: '_child_id', display_key: '_child_id', display_value: childId },
  ] });
const orders = [
  { id: 1, number: '2930', status: 'completed', billing: { first_name: 'Alex', last_name: 'Parent', phone: '07700 900000', email: 'a@example.com' },
    line_items: [li(1, 'Crafty Creations', '2026-12-21', 'AM', 'Sam Parent', 'c1'), li(2, 'Crazy Golf', '2026-12-21', 'PM', 'Sam Parent', 'c1'), li(3, 'Nerf', '2026-12-22', 'AM', 'Sam Parent', 'c1')] },
  { id: 2, number: '2931', status: 'processing', billing: { first_name: 'Bo', last_name: 'B' },
    line_items: [li(4, 'Lego', '2026-12-21', 'PM', 'Ann B', 'c2', '7-12 Years')] },
  { id: 3, number: '2932', status: 'cancelled', billing: {}, line_items: [li(5, 'Lego', '2026-12-21', 'AM', 'Cancelled Kid', 'c3')] },
];

test('children booked on a day: merged per child, AM+PM = all day, cancelled orders ignored', () => {
  const kids = childrenOnDay(orders, '2026-12-21');
  assert.deepEqual(kids.map(k => [k.name, k.session, k.ageGroup]), [['Sam Parent', 'All day', '5-7 Years'], ['Ann B', 'PM', '7-12 Years']]);
  assert.deepEqual(kids[0].activities, ['AM: Crafty Creations', 'PM: Crazy Golf']);
  assert.deepEqual(kids[0].orders, ['2930']);
  assert.equal(kids[0].parent.phone, '07700 900000');
  assert.equal(childrenOnDay(orders, '2026-12-22').length, 1);
  assert.equal(childrenOnDay(orders, '2026-12-25').length, 0);
});

test('accident file names and helpers', () => {
  const f = accidentFile({ child_name: 'Sam / Parent', occurred_at: new Date(2026, 11, 21, 10, 5).toISOString() });
  assert.deepEqual(f, { folder: '2026-12', name: 'Accident - Sam Parent - 2026-12-21 1005.pdf' });
  assert.equal(clubFromSiteName('Hounslow – Rosary'), 'hounslow');
  assert.equal(clubFromSiteName('North Richmond'), 'northrichmond');
  assert.match(toLocalInput('2026-12-21T10:05:00'), /^2026-12-21T10:05$/);
});
