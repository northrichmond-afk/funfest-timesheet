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
  assert.equal(checkDetails({ declaration_agreed: true }).length, 1);
});

test('form covers the application form fields plus DBS, and escapes values', () => {
  const keys = ALL_FIELDS.map(f => f[0]);
  for (const k of ['full_name', 'address', 'ni_number', 'current_employer', 'previous_employment', 'qualifications', 'training',
    'ref1_name', 'ref2_email', 'has_convictions', 'dbs_certificate_number', 'dbs_update_service_number', 'signature_name']) assert.ok(keys.includes(k), k);
  const html = detailsFormHTML({ full_name: '<b>x</b>', has_convictions: false });
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
  assert.match(html, /name="conviction_details"/);
  assert.match(html, /data-showif="has_convictions" hidden/);
  assert.ok(!detailsViewHTML({ has_convictions: false }).includes('If yes'));
});
