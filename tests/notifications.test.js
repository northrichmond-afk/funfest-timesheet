import { test } from 'node:test';
import assert from 'node:assert/strict';
import { staffNotifications, notificationsEmail } from '../shared/notifications.js';

const T = '2026-11-22';
const keys = (p, o = {}) => staffNotifications(p, { today: T, ...o }).map(i => i.key);

test('empty record asks for details, DBS, DOB and the declaration', () => {
  assert.deepEqual(keys(null), ['details', 'dbs', 'dob', 'suitability']);
});

test('complete record has nothing to do', () => {
  const p = { full_name: 'A B', phone: '1', date_of_birth: '1990-01-01', dbs_certificate_number: '001234567890',
    dbs_update_service: true, dbs_update_service_number: 'C1', dbs_update_renewal_date: '2027-06-01', dbs_status: 'BLANK_NO_NEW_INFO' };
  assert.deepEqual(keys(p, { lastDeclarationAt: '2026-06-01T10:00:00Z' }), []);
});

test('Update Service problems', () => {
  const base = { full_name: 'A', date_of_birth: '1990-01-01', dbs_certificate_number: '001', dbs_update_service: true };
  assert.deepEqual(keys(base, { lastDeclarationAt: '2026-06-01' }), ['dbs_update_id']);
  assert.deepEqual(keys({ ...base, dbs_update_service_number: 'C1' }, { lastDeclarationAt: '2026-06-01' }), ['renewal_date']);
  assert.deepEqual(keys({ ...base, dbs_update_service_number: 'C1', dbs_update_renewal_date: '2026-12-10' }, { lastDeclarationAt: '2026-06-01' }), ['renewal_soon']);
  assert.deepEqual(keys({ ...base, dbs_update_service_number: 'C1', dbs_update_renewal_date: '2026-10-10' }, { lastDeclarationAt: '2026-06-01' }), ['update_lapsed']);
  assert.deepEqual(keys({ ...base, dbs_update_service_number: 'C1', dbs_update_renewal_date: '2027-10-10', dbs_status: 'NO_MATCH' }, { lastDeclarationAt: '2026-06-01' }), ['dbs_status']);
});

test('old DBS without Update Service, overdue declaration', () => {
  const p = { full_name: 'A', date_of_birth: '1990-01-01', dbs_certificate_number: '001', dbs_issue_date: '2022-01-01' };
  assert.deepEqual(keys(p, { lastDeclarationAt: '2025-10-01T10:00:00Z' }), ['dbs_old', 'suitability']);
});

test('reminder email lists the items', () => {
  const m = notificationsEmail('Kaliya Hersi', staffNotifications(null, { today: T }), 'https://x/app/');
  assert.match(m.text, /^Hi Kaliya,/);
  assert.equal((m.text.match(/^- /gm) || []).length, 4);
});
