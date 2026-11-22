import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchFolder, docFileName, detailsFileName, checkDetails, detailsFormHTML, detailsViewHTML, ALL_FIELDS, safeName } from '../shared/staffdetails.js';

const dirs = ['_Archive', '_docs', 'Alice Sweeney', 'Catherine Culshaw career ', 'Tharshini  Premathas', 'Iman Alinour '];

test('finds the existing staff folder despite case, extra spaces and suffixes', () => {
  assert.equal(matchFolder(dirs, 'alice sweeney'), 'Alice Sweeney');
  assert.equal(matchFolder(dirs, 'Tharshini Premathas'), 'Tharshini  Premathas');
  assert.equal(matchFolder(dirs, 'Iman Alinour'), 'Iman Alinour ');
  assert.equal(matchFolder(dirs, 'Catherine Culshaw'), 'Catherine Culshaw career ');
  assert.equal(matchFolder(dirs, 'Alice'), null);
  assert.equal(matchFolder(dirs, 'New Person'), null);
  assert.equal(matchFolder(dirs, ''), null);
});

test('file names for the staff folder', () => {
  assert.equal(docFileName('DBS certificate', 'Alice Sweeney', '2026-11-21T10:00:00Z', 'IMG_1234.JPG'), 'DBS certificate - Alice Sweeney (2026-11-21).jpg');
  assert.equal(docFileName('Passport / ID', 'Jo Bloggs', '2026-11-21T10:00:00Z', 'scan'), 'Passport ID - Jo Bloggs (2026-11-21).pdf');
  assert.equal(detailsFileName('Alice Sweeney'), 'Staff details - Alice Sweeney.pdf');
  assert.equal(safeName(' a/b:c '), 'a b c');
});

test('checks NI, DBS and Update Service numbers', () => {
  assert.deepEqual(checkDetails({ ni_number: 'AB 12 34 56 C', dbs_certificate_number: '001234567890', dbs_update_service: true, dbs_update_service_number: 'C0A1B2C3D4E5', date_of_birth: '1990-05-01' }), []);
  assert.equal(checkDetails({ ni_number: 'XX123' }).length, 1);
  assert.equal(checkDetails({ dbs_certificate_number: '12345' }).length, 1);
  assert.equal(checkDetails({ dbs_update_service: true, date_of_birth: '1990-05-01' }).length, 1);
});

test('form has personal details, qualifications/training and DBS only, and escapes values', () => {
  const keys = ALL_FIELDS.map(f => f[0]);
  for (const k of ['full_name', 'address', 'ni_number', 'qualifications', 'training', 'dbs_certificate_number', 'dbs_issue_date', 'dbs_update_service_number']) assert.ok(keys.includes(k), k);
  for (const k of ['current_employer', 'previous_employment', 'ref1_name', 'references_before_interview', 'has_convictions', 'declaration_agreed']) assert.ok(!keys.includes(k), k);
  const html = detailsFormHTML({ full_name: '<b>x</b>', dbs_update_service: false });
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
  assert.match(html, /data-showif="dbs_update_service" hidden/);
  assert.ok(!detailsViewHTML({ dbs_update_service: false }).includes('Update Service ID'));
});

test('critical information rules', async () => {
  const { criticalIssues } = await import('../shared/staffdetails.js');
  const T = '2026-11-21';
  const keys = (p, d = 0) => criticalIssues(p, d, T).map(i => i.key);
  assert.deepEqual(keys({}), ['dbs']);
  assert.deepEqual(keys({ dbs_update_service_number: 'C1' }), []);
  assert.deepEqual(keys({ dbs_certificate_number: '001', dbs_expiry_date: '2025-08-04' }), ['expired']);
  assert.deepEqual(keys({ dbs_certificate_number: '001', dbs_expiry_date: '2027-01-01' }), []);
  assert.deepEqual(keys({ dbs_certificate_number: '001', dbs_issue_date: '2023-06-09' }), ['expired']);   // > 3 years, no Update Service
  assert.deepEqual(keys({ dbs_certificate_number: '001', dbs_issue_date: '2023-06-09', dbs_update_service_number: 'C1' }), []);
  assert.deepEqual(keys({ dbs_certificate_number: '001', dbs_issue_date: '2024-06-09' }), []);
  // references: only for starts on/after 1 Sep 2026
  assert.deepEqual(keys({ dbs_certificate_number: '001', start_date: '2026-08-31' }), []);
  assert.deepEqual(keys({ dbs_certificate_number: '001', start_date: '2026-09-01', ref1_received: '2026-08-01' }), ['refs']);
  assert.equal(criticalIssues({ dbs_certificate_number: '001', start_date: '2026-10-01', ref1_received: 'x', ref2_received: 'y' }, 2, T)[0].text, '2 of 3 references received (2 reference files uploaded)');
  assert.deepEqual(keys({ dbs_certificate_number: '001', start_date: '2026-10-01', ref1_received: 'x', ref2_received: 'y', ref3_received: 'z' }), []);
});

test('date of birth is a staff field with sanity checks', async () => {
  const { SECTIONS, checkDetails } = await import('../shared/staffdetails.js');
  assert.ok(SECTIONS[0].fields.some(f => f[0] === 'date_of_birth'));
  assert.deepEqual(checkDetails({ date_of_birth: '1995-04-02' }), []);
  assert.match(checkDetails({ date_of_birth: '2024-04-02' }).join(), /date of birth/);
  assert.match(checkDetails({ dbs_update_service: true, dbs_update_service_number: 'C1' }).join(), /date of birth/);
});

test('DBS Update Service renewal: request status and lapsed subscription', async () => {
  const { renewalRequestOpen, criticalIssues, renewalRequestEmail } = await import('../shared/staffdetails.js');
  assert.equal(renewalRequestOpen({}), false);
  assert.equal(renewalRequestOpen({ dbs_renewal_requested_at: '2026-11-22T10:00:00Z' }, '2026-11-22'), true);
  assert.equal(renewalRequestOpen({ dbs_renewal_requested_at: '2026-11-22T10:00:00Z', dbs_update_renewal_date: '2027-03-01' }, '2026-11-22'), false);
  assert.equal(renewalRequestOpen({ dbs_renewal_requested_at: '2026-11-22T10:00:00Z', dbs_update_renewal_date: '2026-01-01' }, '2026-11-22'), true);
  const lapsed = criticalIssues({ dbs_certificate_number: '001234567890', dbs_update_service_number: 'C1', dbs_update_renewal_date: '2026-10-01' }, 0, '2026-11-22');
  assert.match(lapsed.map(x => x.text).join(), /lapsed 2026-10-01/);
  assert.match(renewalRequestEmail('Kaliya Hersi', 'https://x/app/').text, /^Hi Kaliya,[\s\S]*https:\/\/x\/app\//);
});

test('DBS status check: blockers and critical issues', async () => {
  const { dbsCheckBlocker, criticalIssues } = await import('../shared/staffdetails.js');
  assert.match(dbsCheckBlocker({}), /certificate/);
  assert.match(dbsCheckBlocker({ dbs_certificate_number: '001234567890' }), /date of birth/);
  assert.equal(dbsCheckBlocker({ dbs_certificate_number: '0012 3456 7890', date_of_birth: '1990-01-01' }), null);
  const base = { dbs_certificate_number: '001234567890', dbs_update_service_number: 'C1' };
  assert.deepEqual(criticalIssues({ ...base, dbs_status: 'BLANK_NO_NEW_INFO' }, 0, '2026-11-22'), []);
  assert.equal(criticalIssues({ ...base, dbs_status: 'NEW_INFO' }, 0, '2026-11-22')[0].key, 'dbsstatus');
  assert.equal(criticalIssues({ ...base, dbs_status: 'NO_MATCH' }, 0, '2026-11-22')[0].key, 'dbsstatus');
});
