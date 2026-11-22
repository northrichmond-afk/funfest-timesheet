// Admin › Reports › Critical info › "Send reminders": emails each staff member the list of things
// they need to update (the same notifications they see in the staff app), through Gmail.

import { sb } from '../shared/supabase.js';
import { esc, toast } from '../shared/ui.js';
import { staffNotifications, notificationsEmail } from '../shared/notifications.js';
import { gmailToken, sendGmail, isEmail } from './gmail.js';

const APP_URL = new URL('../app/', location.href).href;
function clubSender() {
  try { return JSON.parse(localStorage.getItem('ff.invoice.club.northrichmond'))?.sendFrom || ''; } catch { return ''; }
}

/** Notifications for each of these staff: [{ s, p, email, items }] (only people with something to do). */
export async function notificationsFor(staff) {
  const [{ data: profiles }, { data: decl }] = await Promise.all([
    sb.from('staff_profiles').select('*'),
    sb.from('suitability_declarations').select('staff_id,signed_at').order('signed_at', { ascending: false }),
  ]);
  const prof = Object.fromEntries((profiles || []).map(p => [p.staff_id, p]));
  const last = {};
  for (const d of decl || []) last[d.staff_id] ??= d.signed_at;
  return staff.map(s => {
    const p = prof[s.id] || null;
    const email = [s.email, p?.personal_email].find(e => isEmail(e) && !/\.invalid$/i.test(e)) || '';
    return { s, p, email, items: staffNotifications(p, { lastDeclarationAt: last[s.id] || null }) };
  }).filter(x => x.items.length);
}

export async function remindersForm(container, staff, done) {
  const list = await notificationsFor(staff);
  const from = clubSender();
  const box = document.createElement('div');
  box.className = 'card';
  const can = list.filter(x => x.email);
  box.innerHTML = `<form class="stack">
    <h3 style="margin:0">📨 Email reminders to update critical information</h3>
    <p class="small muted">Staff also see these as notifications in the staff app (Today tab, with a count on My details and Forms) until they’re sorted.
      Each person gets their own list${from ? `, sent from <b>${esc(from)}</b>` : ''} through Gmail.</p>
    ${list.length ? `<div class="table-wrap"><table>
      <tr><th><input type="checkbox" id="remAll" checked></th><th>Staff</th><th>Email</th><th>They’ll be asked to</th></tr>
      ${list.map((x, i) => `<tr>
        <td>${x.email ? `<input type="checkbox" name="who" value="${i}" checked>` : ''}</td>
        <td>${esc(x.s.name)}</td>
        <td class="small">${x.email ? esc(x.email) : '<span class="pill warn">No email</span>'}</td>
        <td class="small"><ul style="margin:0;padding-left:1rem">${x.items.map(n => `<li>${esc(n.text)}</li>`).join('')}</ul></td></tr>`).join('')}
    </table></div>` : '<p>✅ Nobody has anything to update.</p>'}
    <div class="msgs"></div>
    <div style="display:flex;gap:.5rem">${can.length ? '<button class="primary">Send reminders</button>' : ''}<button type="button" class="x">Close</button></div>
  </form>`;
  container.prepend(box);
  box.scrollIntoView?.({ block: 'nearest' });
  const form = box.querySelector('form');
  box.querySelector('.x').onclick = () => { box.remove(); done?.(); };
  box.querySelector('#remAll')?.addEventListener('change', e => form.querySelectorAll('[name=who]').forEach(c => { c.checked = e.target.checked; }));
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const picked = [...form.querySelectorAll('[name=who]:checked')].map(c => list[+c.value]);
    const out = form.querySelector('.msgs');
    if (!picked.length) { out.innerHTML = '<div class="msg bad">Tick at least one person.</div>'; return; }
    const btn = form.querySelector('button.primary'); btn.disabled = true;
    let token, sender;
    try { ({ token, email: sender } = await gmailToken(from || undefined)); } catch (e) { btn.disabled = false; out.innerHTML = `<div class="msg bad">${esc(e.message)}</div>`; return; }
    let ok = 0; const bad = [];
    for (const [i, x] of picked.entries()) {
      out.innerHTML = `<p class="small muted">Sending ${i + 1} of ${picked.length}: ${esc(x.s.name)}…</p>`;
      const m = notificationsEmail(x.p?.full_name || x.s.name, x.items, APP_URL);
      try { await sendGmail({ token, from: from || sender, fromName: 'Fun Fest', to: x.email, subject: m.subject, text: m.text }); ok++; }
      catch (e) { bad.push(`${x.s.name}: ${e.message}`); }
    }
    out.innerHTML = `<div class="msg ${bad.length ? 'warn' : 'ok'}">Sent ${ok} reminder${ok === 1 ? '' : 's'}.${bad.length ? `<br>${bad.map(esc).join('<br>')}` : ''}</div>`;
    btn.remove();
    toast(`Sent ${ok} reminder${ok === 1 ? '' : 's'}`);
  };
}
