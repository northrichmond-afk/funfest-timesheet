import { test } from 'node:test';
import assert from 'node:assert/strict';
import { staffMatches } from '../shared/search.js';

const jane = { name: 'Jane Smith', email: 'jane.smith@gmail.com', phone: '07700 900123', role: 'staff', status: 'active' };
const tom = { name: 'Tom Brown', email: 'tom@gmail.com', phone: null, role: 'staff', status: 'left' };
const admin = { name: 'North Richmond Admin', email: 'northrichmond@funfestholidayclub.co.uk', role: 'admin', status: 'active' };

test('matches name, email and venue, case-insensitive', () => {
  assert.ok(staffMatches(jane, 'jane', 'current'));
  assert.ok(staffMatches(jane, 'SMITH@gmail', 'current'));
  assert.ok(staffMatches(jane, 'richmond', 'current', 'North Richmond'));
  assert.ok(!staffMatches(jane, 'bob', 'current'));
});

test('all words must match', () => {
  assert.ok(staffMatches(jane, 'jane smith', ''));
  assert.ok(!staffMatches(jane, 'jane brown', ''));
});

test('phone ignores spaces and +44', () => {
  assert.ok(staffMatches(jane, '07700900123', ''));
  assert.ok(staffMatches(jane, '+44 7700 900', ''));
  assert.ok(staffMatches(jane, '900123', ''));
  assert.ok(!staffMatches(jane, '555', ''));
});

test('status filters', () => {
  assert.ok(!staffMatches(tom, 'tom', 'current'));
  assert.ok(staffMatches(tom, 'tom', 'left'));
  assert.ok(staffMatches(tom, '', ''));
  assert.ok(staffMatches(admin, '', 'admin'));
  assert.ok(!staffMatches(jane, '', 'admin'));
  assert.ok(!staffMatches(jane, '', 'invited'));
});
