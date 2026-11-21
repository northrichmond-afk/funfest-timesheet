// Accident / injury forms: fields shared by the staff app (record), the admin Today page (parent
// signs at collection) and the signed PDF filed in iCloud › FunFest › Accidents.

import { esc } from './ui.js';

export const CLUB_OPTIONS = [['northrichmond', 'North Richmond'], ['hounslow', 'Hounslow']];
export const clubLabel = k => (CLUB_OPTIONS.find(c => c[0] === k) || [k, k])[1];

// Guess the club from a venue name ("North Richmond – King's", "Hounslow")
export function clubFromSiteName(name) {
  const n = String(name || '').toLowerCase();
  return n.includes('hounslow') || n.includes('rosary') || n.includes('heston') ? 'hounslow' : 'northrichmond';
}

// [column, label, type, extra]
export const ACCIDENT_FIELDS = [
  ['child_name', 'Child’s full name', 'text', { required: true }],
  ['child_age_group', 'Age group', 'text', { placeholder: 'e.g. 5-7 Years', list: ['4-5 Years', '5-7 Years', '7-12 Years'] }],
  ['occurred_at', 'Date and time of the accident', 'datetime-local', { required: true }],
  ['location', 'Where did it happen?', 'text', { placeholder: 'e.g. playground, hall, toilets' }],
  ['what_happened', 'What happened?', 'textarea', { required: true, rows: 4 }],
  ['injury', 'Injury (what and where on the body)', 'textarea', { rows: 2, placeholder: 'e.g. small graze on left knee' }],
  ['first_aid', 'First aid / action taken', 'textarea', { rows: 3, placeholder: 'e.g. cleaned with water, plaster applied, ice pack 10 min' }],
  ['treated_by', 'Treated by', 'text'],
  ['witnesses', 'Witnesses', 'text'],
  ['parent_informed_how', 'How will the parent be told?', 'select', { options: ['At collection', 'By phone', 'Phoned and at collection'] }],
];

const pad = n => String(n).padStart(2, '0');
export function toLocalInput(ts) {
  const d = ts ? new Date(ts) : new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export const fmtWhen = ts => new Date(ts).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function accidentFormHTML(r = {}, { clubs = true } = {}) {
  const field = ([k, label, type, x = {}]) => {
    const v = k === 'occurred_at' ? toLocalInput(r.occurred_at) : (r[k] ?? '');
    const req = x.required ? ' required' : '';
    if (type === 'textarea') return `<label>${esc(label)}<textarea name="${k}" rows="${x.rows || 3}"${req} placeholder="${esc(x.placeholder || '')}">${esc(v)}</textarea></label>`;
    if (type === 'select') return `<label>${esc(label)}<select name="${k}"><option value="">—</option>${x.options.map(o => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
    const list = x.list ? ` list="dl_${k}"` : '';
    return `<label>${esc(label)}<input type="${type}" name="${k}" value="${esc(v)}"${req}${list} placeholder="${esc(x.placeholder || '')}">${x.list ? `<datalist id="dl_${k}">${x.list.map(o => `<option value="${esc(o)}">`).join('')}</datalist>` : ''}</label>`;
  };
  return `${clubs ? `<label>Club<select name="club">${CLUB_OPTIONS.map(([k, l]) => `<option value="${k}" ${r.club === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : ''}
    ${ACCIDENT_FIELDS.map(field).join('')}`;
}

export function readAccidentForm(form) {
  const f = new FormData(form);
  const row = {};
  if (f.has('club')) row.club = f.get('club');
  for (const [k] of ACCIDENT_FIELDS) {
    const v = String(f.get(k) ?? '').trim();
    row[k] = k === 'occurred_at' ? (v ? new Date(v).toISOString() : null) : (v || null);
  }
  return row;
}

// Read-only summary (what the parent reads before signing)
export function accidentViewHTML(r) {
  const rows = [
    ['Child', r.child_name + (r.child_age_group ? ` (${r.child_age_group})` : '')],
    ['When', fmtWhen(r.occurred_at)],
    ['Where', r.location], ['What happened', r.what_happened], ['Injury', r.injury],
    ['First aid / action taken', r.first_aid], ['Treated by', r.treated_by], ['Witnesses', r.witnesses],
  ];
  return `<table class="small">${rows.map(([k, v]) => `<tr><th style="width:34%;font-weight:600">${esc(k)}</th><td style="white-space:pre-wrap">${esc(v || '—')}</td></tr>`).join('')}</table>`;
}

// "Accident - Sam Example - 2026-11-21 1015.pdf" in "2026-11"
export function accidentFile(r) {
  const d = new Date(r.occurred_at);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const safe = s => String(s || '').replace(/[/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  return { folder: day.slice(0, 7), name: `Accident - ${safe(r.child_name)} - ${day} ${pad(d.getHours())}${pad(d.getMinutes())}.pdf` };
}
