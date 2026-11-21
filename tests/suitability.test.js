import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUIT_QUESTIONS, SUIT_STATEMENTS, suitabilityStatus, suitabilityFileName, yesAnswers } from '../shared/suitability.js';

test('suitability form has the 13 questions and 5 declaration statements', () => {
  assert.equal(SUIT_QUESTIONS.length, 13);
  assert.equal(SUIT_STATEMENTS.length, 5);
  assert.equal(new Set(SUIT_QUESTIONS.map(q => q[0])).size, 13);
});

test('annual renewal status', () => {
  assert.equal(suitabilityStatus(null, '2026-11-21').key, 'never');
  assert.equal(suitabilityStatus('2026-02-13T10:00:00Z', '2026-11-21').key, 'ok');
  assert.equal(suitabilityStatus('2025-12-10T10:00:00Z', '2026-11-21').key, 'soon');
  const o = suitabilityStatus('2025-11-21T10:00:00Z', '2026-11-21');
  assert.equal(o.key, 'overdue'); assert.equal(o.due, true); assert.equal(o.next, '2026-11-21');
});

test('yes answers and file name', () => {
  assert.deepEqual(yesAnswers({ medication: true, barred: false }).map(q => q[0]), ['medication']);
  assert.equal(suitabilityFileName('Kaliya / Hersi', '2026-02-13T10:00:00Z'), 'Suitability declaration - Kaliya Hersi - 2026-02-13.pdf');
});
