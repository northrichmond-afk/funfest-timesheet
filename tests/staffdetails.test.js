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
  assert.deepEqual(checkDetails({ ni_number: 'AB 12 34 56 C', dbs_certificate_number: '001234567890', dbs_update_service: true, dbs_update_service_number: 'C0A1B2C3D4E5' }), []);
  assert.equal(checkDetails({ ni_number: 'XX123' }).length, 1);
  assert.equal(checkDetails({ dbs_certificate_number: '12345' }).length, 1);
  assert.equal(checkDetails({ dbs_update_service: true }).length, 1);
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
