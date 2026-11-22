// Staff notifications: what a staff member needs to do about their own critical information.
// Worked out from their own record (staff_profiles + latest suitability declaration), so they
// update themselves and disappear as soon as the information is added.
//
// Each item: { key, level: 'bad' | 'warn' | 'info', text, go: 'details' | 'forms' | null }

import { suitabilityStatus } from './suitability.js';
import { esc } from './ui.js';

const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const addYears = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCFullYear(d.getUTCFullYear() + n); return d.toISOString().slice(0, 10); };
const nice = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

export function staffNotifications(p, { lastDeclarationAt = null, today = new Date().toISOString().slice(0, 10) } = {}) {
  const out = [];
  p = p || {};
  const add = (key, level, text, go = 'details') => out.push({ key, level, text, go });

  if (!p.full_name && !p.address && !p.phone) {
    add('details', 'bad', 'Please fill in your details (name, address, phone, DBS) under My details.');
  }
  // DBS reference
  if (!p.dbs_certificate_number && !p.dbs_update_service_number) {
    add('dbs', 'bad', 'Add your DBS certificate number, and your DBS Update Service ID if you have one.');
  } else if (p.dbs_update_service && !p.dbs_update_service_number) {
    add('dbs_update_id', 'bad', 'You said you’re on the DBS Update Service: please add your Update Service ID.');
  }
  // Date of birth (needed for DBS checks)
  if (!p.date_of_birth) add('dob', 'warn', 'Add your date of birth: the office needs it to check your DBS.');

  // DBS expired / lapsed
  const lapsed = p.dbs_update_service_number && p.dbs_update_renewal_date && p.dbs_update_renewal_date < today;
  if (lapsed) {
    add('update_lapsed', 'bad', `Your DBS Update Service subscription ran out on ${nice(p.dbs_update_renewal_date)}. Please renew it at gov.uk/dbs-update-service, then update the renewal date.`);
  } else if (p.dbs_expiry_date && p.dbs_expiry_date < today) {
    add('dbs_expired', 'bad', `Your DBS expired on ${nice(p.dbs_expiry_date)}. Please speak to the office about a new DBS check.`, null);
  } else if (!p.dbs_expiry_date && !p.dbs_update_service_number && p.dbs_issue_date && addYears(p.dbs_issue_date, 3) < today) {
    add('dbs_old', 'bad', `Your DBS certificate is over 3 years old and isn’t on the Update Service. Please speak to the office about a new DBS check.`, null);
  }
  // Update Service renewal date
  if (p.dbs_update_service_number && !lapsed) {
    if (!p.dbs_update_renewal_date) {
      add('renewal_date', p.dbs_renewal_requested_at ? 'warn' : 'info',
        `${p.dbs_renewal_requested_at ? 'The office has asked for' : 'Add'} your DBS Update Service renewal date (it’s in your Update Service account at gov.uk/dbs-update-service).`);
    } else if (p.dbs_update_renewal_date <= addDays(today, 30)) {
      add('renewal_soon', 'warn', `Your DBS Update Service subscription renews on ${nice(p.dbs_update_renewal_date)}. Please make sure it renews, then update the date.`);
    }
  }
  // Result of the office's DBS status check
  if (p.dbs_status === 'NEW_INFO' || p.dbs_status === 'NO_MATCH') {
    add('dbs_status', 'bad', 'Please contact the office about your DBS: the latest Update Service check needs following up.', null);
  }
  // Annual safeguarding (suitability) declaration
  const st = suitabilityStatus(lastDeclarationAt, today);
  if (st.key === 'never') add('suitability', 'bad', 'Please complete your Safeguarding (suitability) declaration under Forms.', 'forms');
  else if (st.key === 'overdue') add('suitability', 'bad', 'Your annual Safeguarding (suitability) declaration is due: please complete it under Forms.', 'forms');
  else if (st.key === 'soon') add('suitability', 'info', `Your annual Safeguarding declaration is due by ${nice(st.next)}.`, 'forms');

  return out;
}

/** Plain-text list for an email reminder. */
export function notificationsEmail(name, items, appUrl) {
  const first = String(name || '').split(' ')[0] || 'there';
  return {
    subject: 'Fun Fest: please update your staff details',
    text: `Hi ${first},

Please could you update the following in the Fun Fest Timesheet app:

${items.map(i => `- ${i.text}`).join('\n')}

Open the app here: ${appUrl}
(My details and Forms tabs.)

Thank you,
Fun Fest`,
  };
}

/** Notifications card (staff app). */
export function notificationsHTML(items, { buttons = true } = {}) {
  if (!items.length) return '';
  const worst = items.some(i => i.level === 'bad') ? 'bad' : items.some(i => i.level === 'warn') ? 'warn' : 'info';
  const label = { details: 'My details', forms: 'Forms' };
  return `<div class="card notif notif-${worst}">
    <h2>🔔 ${items.length === 1 ? '1 thing' : `${items.length} things`} to update</h2>
    <ul>${items.map(i => `<li class="lvl-${i.level}">${esc(i.text)}
      ${buttons && i.go ? ` <button type="button" class="small" data-go="${i.go}">Open ${label[i.go]}</button>` : ''}</li>`).join('')}</ul>
  </div>`;
}
