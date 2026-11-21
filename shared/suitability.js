// Staff suitability (safeguarding) declaration: completed when staff start and every year.
// Wording from the club's "Safeguarding Declaration Form".

import { esc } from './ui.js';

export const SUIT_TITLE = 'Safeguarding Declaration Form';
export const SUIT_INTRO = 'This form is to be completed by all new staff when they commence employment AND completed by all staff on an annual basis.';
export const SUIT_GUIDE = 'Please answer the questions and sign the declaration below to demonstrate that you are safe to work with children. If there are any aspects of the declaration that you are not able to meet, you should disclose this immediately to the manager/senior responsible for your recruitment.';

export const SUIT_QUESTIONS = [
  ['since_dbs', 'Have you been cautioned, subject to a court order, bound over, received a reprimand or warning or found guilty of committing any offence since the date of your most recent enhanced DBS/PVG disclosure?'],
  ['ever_offence', 'Have you been cautioned, subject to a court order, bound over, received a reprimand or warning or found guilty of committing any offence either before or during your employment at this setting?'],
  ['disqualified', 'Are you ‘Disqualified for Caring for Children’?'],
  ['offence_child', 'Have you committed any offences against a child?'],
  ['offence_adult', 'Have you committed any offences against an adult (e.g. rape, murder, indecent assault, actual bodily harm etc.)?'],
  ['barred', 'Have you been barred from working with children (DBS/PVG)?'],
  ['living_barred', 'Are you living with someone who has been barred from working with children (DBS/PVG)?'],
  ['household_disqualified', 'Are you living in the same household as someone who has been disqualified from working with children under the Childcare Act 2006?'],
  ['children_care', 'Have your own children been taken into care?'],
  ['children_cpo', 'Have/are your own children the subject of a child protection order?'],
  ['barring_list', 'Has your name been placed on the DBS/PVG barring list?'],
  ['medical', 'Do you have any medical conditions that could affect your ability to care for children?'],
  ['medication', 'Are you taking any medication on a regular basis or any other substances?'],
];

export const SUIT_STATEMENTS = [
  'I understand my responsibility to safeguard children and am aware that I must notify my manager of anything that may affect my suitability.',
  'I will ensure I notify my employer of any convictions, cautions, court orders, reprimands or warnings I may receive.',
  'I am aware that if I am taking medication on a regular basis I must notify my employer, and must keep the medication in a safe place, out of reach of children.',
  'I will ensure I notify my manager if I experience any health concerns which could impact upon my ability to work with children.',
  'I give permission for you to contact any previous settings, local authority staff, the police, the DBS/PVG, or any medical professionals to share information about my suitability to care for children.',
];

/** Questions answered "yes". */
export const yesAnswers = (answers = {}) => SUIT_QUESTIONS.filter(([k]) => answers[k] === true);

/** The form's questions, further info and declaration (no signature: callers add that). */
export function suitabilityFormHTML(d = {}) {
  const a = d.answers || {};
  return `
    <p class="small muted">${esc(SUIT_INTRO)}</p>
    <p class="small">${esc(SUIT_GUIDE)}</p>
    <ol class="suit-q">
      ${SUIT_QUESTIONS.map(([k, q]) => `<li><div>${esc(q)}</div>
        <div class="yn">
          <label><input type="radio" name="q_${k}" value="no" required ${a[k] === false ? 'checked' : ''}> No</label>
          <label><input type="radio" name="q_${k}" value="yes" ${a[k] === true ? 'checked' : ''}> Yes</label>
        </div></li>`).join('')}
    </ol>
    <label>If you have answered YES to any of the questions, please provide further information
      <textarea name="further_info" rows="3">${esc(d.further_info || '')}</textarea></label>
    <div class="suit-decl">
      ${SUIT_STATEMENTS.map((s, i) => `<label class="check"><input type="checkbox" name="st_${i}" required> <span>${esc(s)}</span></label>`).join('')}
    </div>`;
}

/** Read the answers from the form. Returns { row, error }. */
export function readSuitabilityForm(form) {
  const v = n => form.querySelector(`[name="${n}"]:checked`)?.value;
  const answers = {};
  const missing = [];
  SUIT_QUESTIONS.forEach(([k], i) => {
    const x = v(`q_${k}`);
    if (!x) missing.push(i + 1); else answers[k] = x === 'yes';
  });
  if (missing.length) return { error: `Please answer question${missing.length > 1 ? 's' : ''} ${missing.join(', ')}.` };
  if (SUIT_STATEMENTS.some((_, i) => !form.querySelector(`[name="st_${i}"]`)?.checked)) return { error: 'Please tick each statement in the declaration.' };
  const further = form.querySelector('[name=further_info]')?.value.trim() || '';
  if (yesAnswers(answers).length && !further) return { error: 'You answered YES to a question: please give further information.' };
  return { row: { answers, further_info: further || null } };
}

/** Read-only view of a submitted declaration (admin). */
export function suitabilityViewHTML(d) {
  const a = d.answers || {};
  return `<table class="small suit-view">
    ${SUIT_QUESTIONS.map(([k, q], i) => `<tr><td>${i + 1}. ${esc(q)}</td>
      <td style="white-space:nowrap">${a[k] === true ? '<span class="pill bad">YES</span>' : a[k] === false ? 'No' : '—'}</td></tr>`).join('')}
    </table>
    ${d.further_info ? `<p><b>Further information:</b> ${esc(d.further_info)}</p>` : ''}`;
}

/**
 * Where a staff member stands. Due when there's never been one, or the last was signed more than
 * a year ago. "dueSoon" in the last month before that.
 */
export function suitabilityStatus(lastSignedAt, todayIso = new Date().toISOString().slice(0, 10)) {
  if (!lastSignedAt) return { key: 'never', label: 'Not completed', due: true };
  const signed = String(lastSignedAt).slice(0, 10);
  const next = new Date(signed + 'T12:00:00Z'); next.setUTCFullYear(next.getUTCFullYear() + 1);
  const nextIso = next.toISOString().slice(0, 10);
  if (nextIso <= todayIso) return { key: 'overdue', label: 'Annual renewal due', due: true, next: nextIso };
  const soon = new Date(next); soon.setUTCDate(soon.getUTCDate() - 30);
  if (soon.toISOString().slice(0, 10) <= todayIso) return { key: 'soon', label: 'Renewal due soon', due: false, next: nextIso };
  return { key: 'ok', label: 'Up to date', due: false, next: nextIso };
}

export const suitabilityFileName = (person, signedAt) =>
  `Suitability declaration - ${String(person || 'Staff').replace(/[/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim()} - ${String(signedAt).slice(0, 10)}.pdf`;
