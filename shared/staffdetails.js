// Staff details: the fields from the Fun Fest "Application for Employment" form plus DBS.
// One definition drives the staff app form, the admin view/edit and the PDF in the staff folder.

import { esc } from './ui.js';

// [column, label, type, extra]   types: text | textarea | email | tel | date | yesno
export const SECTIONS = [
  { title: 'Personal details', fields: [
    ['full_name', 'Full name', 'text', { required: true, autocomplete: 'name' }],
    ['date_of_birth', 'Date of birth (as on your DBS certificate)', 'date', { autocomplete: 'bday' }],
    ['address', 'Address', 'textarea', { rows: 3, autocomplete: 'street-address' }],
    ['personal_email', 'Email address', 'email', { autocomplete: 'email' }],
    ['phone', 'Phone number', 'tel', { autocomplete: 'tel' }],
    ['ni_number', 'National Insurance (NI) number', 'text', { placeholder: 'e.g. QQ 12 34 56 C' }],
    ['email_ok', 'Are you happy to receive correspondence via your email address?', 'yesno'],
  ] },
  { title: 'Qualifications and training', fields: [
    ['qualifications', 'Qualifications', 'textarea', { rows: 4 }],
    ['training', 'Training and CPD (e.g. paediatric first aid, child protection, with year and provider)', 'textarea', { rows: 4 }],
  ] },
  { title: 'DBS', fields: [
    ['dbs_certificate_number', 'DBS certificate number', 'text', { inputmode: 'numeric', placeholder: '12 digits, top right of the certificate' }],
    ['dbs_issue_date', 'DBS certificate date of issue', 'date'],
    ['dbs_update_service', 'Are you registered with the DBS Update Service?', 'yesno'],
    ['dbs_update_service_number', 'DBS Update Service ID number', 'text', { placeholder: 'e.g. C0A1B2C3D4E5', showIf: 'dbs_update_service' }],
    ['dbs_update_renewal_date', 'DBS Update Service renewal (expiry) date: shown when you sign in to your Update Service account', 'date', { showIf: 'dbs_update_service' }],
  ] },
];

// Office-only record (admin pages and the PDF in the staff folder; staff don't see these)
export const OFFICE_SECTIONS = [
  { title: 'Office checks', fields: [
    ['start_date', 'Start date', 'date'],
    ['ref1_received', 'Reference 1 received', 'date'],
    ['ref2_received', 'Reference 2 received', 'date'],
    ['ref3_received', 'Reference 3 received', 'date'],
    ['dbs_checked_on', 'DBS certificate seen / Update Service checked on', 'date'],
    ['dbs_expiry_date', 'DBS expiry / Update Service renewal date', 'date'],
    ['right_to_work_checked_on', 'Right to work checked on', 'date'],
    ['office_notes', 'Notes', 'textarea', { rows: 4 }],
  ] },
  { title: 'Current / most recent employment', fields: [
    ['current_employer', 'Name and full postal address of employer', 'textarea', { rows: 2 }],
    ['current_job_title', 'Job title', 'text'],
    ['current_salary', 'Salary', 'text'],
    ['current_from', 'Date from', 'text', { placeholder: 'MM/YYYY' }],
    ['current_to', 'Date to', 'text', { placeholder: 'MM/YYYY or Present' }],
    ['current_duties', 'Brief details of duties and responsibilities', 'textarea', { rows: 4 }],
    ['consult_before_references', 'Consult before previous employers are approached for references?', 'yesno'],
  ] },
  { title: 'Previous employment', fields: [
    ['previous_employment', 'Previous employment history', 'textarea', { rows: 8 }],
  ] },
  ...[1, 2].map(n => ({ title: `Referee ${n}`, fields: [
    [`ref${n}_name`, 'Referee name', 'text'],
    [`ref${n}_job_title`, 'Job title', 'text'],
    [`ref${n}_org`, 'Organisation', 'text'],
    [`ref${n}_address`, 'Full postal address', 'textarea', { rows: 2 }],
    [`ref${n}_phone`, 'Telephone number', 'tel'],
    [`ref${n}_email`, 'Email address', 'email'],
  ] })),
  { title: 'References and safeguarding', fields: [
    ['references_before_interview', 'References can be taken up prior to interview?', 'yesno'],
    ['has_convictions', 'Any caution, reprimand, final warning or conviction (received or pending)?', 'yesno'],
    ['conviction_details', 'Details', 'textarea', { rows: 3, showIf: 'has_convictions' }],
  ] },
];

export const ALL_FIELDS = SECTIONS.flatMap(s => s.fields);
export const OFFICE_FIELDS = OFFICE_SECTIONS.flatMap(s => s.fields);
const BOOLS = new Set([...ALL_FIELDS, ...OFFICE_FIELDS].filter(f => f[2] === 'yesno' || f[2] === 'check').map(f => f[0]));

// Certificates / documents staff can upload
export const DOC_KINDS = [
  'DBS certificate',
  'DBS Update Service confirmation',
  'Paediatric first aid certificate',
  'Safeguarding / child protection certificate',
  'Qualification certificate',
  'Training certificate',
  'Food hygiene certificate',
  'Passport / ID',
  'Right to work',
  'Proof of address',
  'CV',
  'Other',
];

const yesNo = v => (v === true ? 'Yes' : v === false ? 'No' : '');

// Read-only display of one value
export function displayValue(type, v) {
  if (type === 'yesno') return yesNo(v);
  if (type === 'check') return v ? 'Agreed' : 'Not agreed';
  if (type === 'date' && v) return new Date(v + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  return v ?? '';
}

// HTML form for the details. `p` is the staff_profiles row (or {}).
export function detailsFormHTML(p = {}, sections = SECTIONS) {
  const field = ([k, label, type, x = {}]) => {
    const show = x.showIf ? ` data-showif="${x.showIf}" ${p[x.showIf] === true ? '' : 'hidden'}` : '';
    const attrs = `name="${k}"${x.required ? ' required' : ''}${x.placeholder ? ` placeholder="${esc(x.placeholder)}"` : ''}${x.autocomplete ? ` autocomplete="${x.autocomplete}"` : ''}${x.inputmode ? ` inputmode="${x.inputmode}"` : ''}`;
    if (type === 'yesno') {
      return `<fieldset class="yesno"${show}><legend>${esc(label)}</legend>
        <label><input type="radio" name="${k}" value="true" ${p[k] === true ? 'checked' : ''}> Yes</label>
        <label><input type="radio" name="${k}" value="false" ${p[k] === false ? 'checked' : ''}> No</label></fieldset>`;
    }
    if (type === 'check') return `<label class="check"${show}><input type="checkbox" name="${k}" value="true" ${p[k] ? 'checked' : ''}> <span>${esc(label)}</span></label>`;
    if (type === 'textarea') return `<label${show}>${esc(label)}<textarea ${attrs} rows="${x.rows || 3}">${esc(p[k] ?? '')}</textarea></label>`;
    return `<label${show}>${esc(label)}<input type="${type}" ${attrs} value="${esc(p[k] ?? '')}"></label>`;
  };
  return sections.map(s => `<fieldset class="section"><legend>${esc(s.title)}</legend>${s.fields.map(field).join('')}</fieldset>`).join('');
}

// Show/hide "if yes" fields as answers change
export function wireDetailsForm(form) {
  const update = () => form.querySelectorAll('[data-showif]').forEach(el => {
    const on = form.querySelector(`[name="${el.dataset.showif}"]:checked`)?.value === 'true';
    el.hidden = !on;
  });
  form.addEventListener('change', update);
  update();
}

// FormData → row for staff_profiles (empty strings become null)
export function readDetailsForm(form, fields = ALL_FIELDS) {
  const fd = new FormData(form);
  const row = {};
  for (const [k, , type] of fields) {
    const v = fd.get(k);
    if (BOOLS.has(k)) row[k] = type === 'check' ? v === 'true' : v === 'true' ? true : v === 'false' ? false : null;
    else row[k] = v == null || String(v).trim() === '' ? null : String(v).trim();
  }
  if (row.has_convictions === false) row.conviction_details = null;
  if (row.ni_number) row.ni_number = row.ni_number.toUpperCase().replace(/\s+/g, ' ');
  if (row.dbs_certificate_number) row.dbs_certificate_number = row.dbs_certificate_number.replace(/\s+/g, '');
  if (row.dbs_update_service_number) row.dbs_update_service_number = row.dbs_update_service_number.toUpperCase().replace(/\s+/g, '');
  return row;
}

// Problems worth telling the person about before saving (not blocking unless `block`)
export function checkDetails(row) {
  const out = [];
  const nino = (row.ni_number || '').replace(/\s/g, '');
  if (nino && !/^[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\d{6}[A-D]$/.test(nino)) out.push('The NI number doesn’t look right (2 letters, 6 numbers, 1 letter).');
  if (row.dbs_certificate_number && !/^\d{12}$/.test(row.dbs_certificate_number)) out.push('A DBS certificate number is 12 digits.');
  if (row.dbs_update_service && !row.dbs_update_service_number) out.push('Add your DBS Update Service ID number.');
  if (row.date_of_birth) {
    const age = (Date.now() - new Date(row.date_of_birth + 'T12:00:00Z')) / 31557600000;
    if (!(age >= 14 && age <= 90)) out.push('Please check your date of birth.');
  } else if (row.dbs_update_service) out.push('Add your date of birth: the office needs it to check your DBS on the Update Service.');
  return out;
}

// Read-only HTML (admin view)
export function detailsViewHTML(p = {}, sections = SECTIONS) {
  return sections.map(s => {
    const rows = s.fields.filter(([k, , , x = {}]) => !x.showIf || p[x.showIf] === true)
      .map(([k, label, type]) => `<tr><th style="width:45%;font-weight:600">${esc(label)}</th><td style="white-space:pre-wrap">${esc(displayValue(type, p[k])) || '<span class="muted">—</span>'}</td></tr>`).join('');
    return `<h3>${esc(s.title)}</h3><table class="small">${rows}</table>`;
  }).join('');
}

// ── Critical information (Reports › Missing info) ─────────

export const REFS_RULE_FROM = '2026-09-01';
/** Last Update Service status check said the certificate is current (no new information). */
export const dbsCurrent = (p = {}) => p.dbs_status === 'BLANK_NO_NEW_INFO' || p.dbs_status === 'NON_BLANK_NO_NEW_INFO';

export function criticalIssues(p = {}, docs = 0, todayIso = new Date().toISOString().slice(0, 10)) {
  const out = [];
  if (!p.dbs_certificate_number && !p.dbs_update_service_number) out.push({ key: 'dbs', text: 'No DBS reference' });
  if (!p.date_of_birth) out.push({ key: 'dob', text: 'No date of birth' });
  if (!p.dbs_update_service_number) out.push({ key: 'noupdate', text: p.dbs_update_service ? 'Update Service ID not entered' : 'No DBS Update Service ID' });
  const threeYears = d => { const x = new Date(d + 'T12:00:00Z'); x.setUTCFullYear(x.getUTCFullYear() + 3); return x.toISOString().slice(0, 10); };
  if (p.dbs_status === 'NEW_INFO') out.push({ key: 'dbsstatus', text: 'DBS status check: new information, ask for a new DBS' });
  else if (p.dbs_status === 'NO_MATCH') out.push({ key: 'dbsstatus', text: 'DBS status check: no match on the Update Service' });
  // A "Current: no new information" Update Service check overrides the expiry dates
  const current = dbsCurrent(p);
  const checkedOn = String(p.dbs_status_checked_at || '').slice(0, 10);
  if (p.dbs_update_service_number && p.dbs_update_renewal_date && p.dbs_update_renewal_date < todayIso && !(current && checkedOn >= p.dbs_update_renewal_date)) {
    out.push({ key: 'expired', text: `DBS Update Service subscription lapsed ${p.dbs_update_renewal_date}` });
  }
  if (current) { /* expiry date ignored: the DBS has confirmed the certificate is current */ }
  else if (p.dbs_expiry_date && p.dbs_expiry_date < todayIso) out.push({ key: 'expired', text: `DBS expired ${p.dbs_expiry_date}` });
  else if (!p.dbs_expiry_date && !p.dbs_update_service_number && p.dbs_issue_date && threeYears(p.dbs_issue_date) < todayIso) {
    out.push({ key: 'expired', text: `DBS over 3 years old (issued ${p.dbs_issue_date}), not on Update Service` });
  }
  if (p.start_date && p.start_date >= REFS_RULE_FROM) {
    const got = [p.ref1_received, p.ref2_received, p.ref3_received].filter(Boolean).length;
    if (got < 3) out.push({ key: 'refs', text: `${got} of 3 references received${docs ? ` (${docs} reference file${docs === 1 ? '' : 's'} uploaded)` : ''}` });
  }
  return out;
}


// DBS Update Service status check results (stored in staff_profiles.dbs_status)
export const DBS_STATUS = {
  BLANK_NO_NEW_INFO: { label: 'Current: no new information', cls: 'ok' },
  NON_BLANK_NO_NEW_INFO: { label: 'Current: no new information since issue', cls: 'ok' },
  NEW_INFO: { label: 'New information: don’t rely on this certificate, ask for a new DBS', cls: 'bad' },
  NO_MATCH: { label: 'No match on the Update Service', cls: 'bad' },
  ERROR: { label: 'Check failed: try again', cls: 'warn' },
};
/** Why a status check can't be run for this person (null when it can). */
export function dbsCheckBlocker(p = {}) {
  if (!/^\d{12}$/.test(String(p.dbs_certificate_number || '').replace(/\s/g, ''))) return 'No 12-digit DBS certificate number';
  if (!p.date_of_birth) return 'No date of birth';
  return null;
}

/** Office asked for the Update Service renewal date and it's still missing or out of date. */
export const renewalRequestOpen = (p = {}, todayIso = new Date().toISOString().slice(0, 10)) =>
  !!p.dbs_renewal_requested_at && (!p.dbs_update_renewal_date || p.dbs_update_renewal_date < todayIso);

export function renewalRequestEmail(name, appUrl) {
  const first = String(name || '').split(' ')[0] || 'there';
  return {
    subject: 'Fun Fest: your DBS Update Service renewal date',
    text: `Hi ${first},

Please could you let us know when your DBS Update Service subscription is due for renewal (its expiry date)?

You can find it by signing in to your Update Service account at https://www.gov.uk/dbs-update-service. Then add it in the Fun Fest Timesheet app under My details › DBS:
${appUrl}

If your subscription has lapsed, please renew it, or tell us so we can arrange a new DBS check.

Thank you,
Fun Fest`,
  };
}

// ── iCloud file and folder names ─────────────────────────────

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
export const safeName = s => String(s || '').replace(/[/\\:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

// Pick the existing folder for a person: exact name (ignoring case/extra spaces), then one that starts
// with the name ("Catherine Culshaw career"). Returns null if none, so a new folder is made.
export function matchFolder(dirNames, wanted) {
  const w = norm(wanted);
  if (!w) return null;
  const exact = dirNames.find(d => norm(d) === w);
  if (exact || !w.includes(' ')) return exact || null;   // first name alone is too loose for a prefix match
  return dirNames.find(d => norm(d).startsWith(w + ' ')) || null;
}

// "DBS certificate - Alice Sweeney (2026-11-21).pdf"
export function docFileName(kind, person, uploadedAt, originalName) {
  const ext = (String(originalName || '').match(/\.([a-z0-9]{1,5})$/i)?.[1] || 'pdf').toLowerCase();
  const day = String(uploadedAt || '').slice(0, 10);
  return `${safeName(kind)} - ${safeName(person)}${day ? ` (${day})` : ''}.${ext}`;
}

export const detailsFileName = person => `Staff details - ${safeName(person)}.pdf`;
