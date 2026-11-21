// Staff details: the fields from the Fun Fest "Application for Employment" form plus DBS.
// One definition drives the staff app form, the admin view/edit and the PDF in the staff folder.

import { esc } from './ui.js';

// [column, label, type, extra]   types: text | textarea | email | tel | date | yesno
export const SECTIONS = [
  { title: 'Personal details', fields: [
    ['full_name', 'Full name', 'text', { required: true, autocomplete: 'name' }],
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
  ] },
];

export const ALL_FIELDS = SECTIONS.flatMap(s => s.fields);
const BOOLS = new Set(ALL_FIELDS.filter(f => f[2] === 'yesno' || f[2] === 'check').map(f => f[0]));

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
export function detailsFormHTML(p = {}) {
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
  return SECTIONS.map(s => `<fieldset class="section"><legend>${esc(s.title)}</legend>${s.fields.map(field).join('')}</fieldset>`).join('');
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
export function readDetailsForm(form) {
  const fd = new FormData(form);
  const row = {};
  for (const [k, , type] of ALL_FIELDS) {
    const v = fd.get(k);
    if (BOOLS.has(k)) row[k] = type === 'check' ? v === 'true' : v === 'true' ? true : v === 'false' ? false : null;
    else row[k] = v == null || String(v).trim() === '' ? null : String(v).trim();
  }
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
  return out;
}

// Read-only HTML (admin view)
export function detailsViewHTML(p = {}) {
  return SECTIONS.map(s => {
    const rows = s.fields.filter(([k, , , x = {}]) => !x.showIf || p[x.showIf] === true)
      .map(([k, label, type]) => `<tr><th style="width:45%;font-weight:600">${esc(label)}</th><td style="white-space:pre-wrap">${esc(displayValue(type, p[k])) || '<span class="muted">—</span>'}</td></tr>`).join('');
    return `<h3>${esc(s.title)}</h3><table class="small">${rows}</table>`;
  }).join('');
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
