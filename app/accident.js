// Staff app › "Accident": record an accident or injury. The parent signs it on the club
// device at collection (admin Today › Accident forms). Staff can correct or remove their
// own report until it has been signed.

import { sb } from '../shared/supabase.js';
import { esc, toast } from '../shared/ui.js';
import { accidentFormHTML, readAccidentForm, fmtWhen, clubLabel, clubFromSiteName } from '../shared/accidents.js';

export async function renderAccidents(pane, me, editing = null) {
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const [{ data: mine, error }, { data: site }] = await Promise.all([
    sb.from('accident_reports').select('*').eq('reported_by', me.id).gte('occurred_at', since).order('occurred_at', { ascending: false }),
    me.default_site_id ? sb.from('sites').select('name').eq('id', me.default_site_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  if (error) {
    pane.innerHTML = `<div class="card msg bad">Couldn't load accident forms: ${esc(error.message)}</div>`;
    return;
  }
  const r = editing || { club: clubFromSiteName(site?.name), treated_by: me.name, parent_informed_how: 'At collection' };
  pane.innerHTML = `
    <div class="card">
      <h2>${editing ? 'Edit accident form' : 'Record an accident'}</h2>
      <p class="small muted">Fill this in as soon as you can after any accident or injury. The parent signs it when they collect their child.</p>
      <form id="acc" class="stack">
        ${accidentFormHTML(r)}
        <div id="accMsg"></div>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap">
          <button class="primary">${editing ? '💾 Save changes' : '➕ Submit accident form'}</button>
          ${editing ? '<button type="button" id="accCancel">Cancel</button>' : ''}
        </div>
      </form>
    </div>
    <div class="card">
      <h2>My accident forms <span class="small muted">(last 30 days)</span></h2>
      ${(mine || []).length ? (mine || []).map(a => `
        <div class="shift-line">
          <div>
            <strong>${esc(a.child_name)}</strong> <span class="small muted">${esc(clubLabel(a.club))}</span>
            <div class="small muted">${fmtWhen(a.occurred_at)}${a.injury ? ' · ' + esc(a.injury) : ''}</div>
            <div>${a.signed_at ? `<span class="pill ok">Signed by ${esc(a.parent_name || 'parent')}</span>` : '<span class="pill warn">Waiting for parent’s signature</span>'}</div>
          </div>
          ${a.signed_at ? '' : `<div style="display:flex;flex-direction:column;gap:.3rem">
            <button class="small" data-edit="${a.id}">Edit</button>
            <button class="small" data-del="${a.id}">Remove</button></div>`}
        </div>`).join('') : '<p class="muted small">None.</p>'}
    </div>`;

  const form = pane.querySelector('#acc');
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const row = readAccidentForm(form);
    const msg = form.querySelector('#accMsg');
    if (new Date(row.occurred_at) > new Date(Date.now() + 5 * 60000)) { msg.innerHTML = '<div class="msg bad">The time is in the future.</div>'; return; }
    const btn = form.querySelector('button.primary'); btn.disabled = true;
    const q = editing ? sb.from('accident_reports').update(row).eq('id', editing.id) : sb.from('accident_reports').insert({ ...row, site_id: me.default_site_id || null });
    const { error: e } = await q;
    btn.disabled = false;
    if (e) { msg.innerHTML = `<div class="msg bad">Couldn't save: ${esc(e.message)}</div>`; return; }
    toast(editing ? 'Saved' : 'Accident form submitted ✓');
    renderAccidents(pane, me);
  };
  pane.querySelector('#accCancel')?.addEventListener('click', () => renderAccidents(pane, me));
  pane.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { renderAccidents(pane, me, mine.find(a => a.id === b.dataset.edit)); window.scrollTo(0, 0); });
  pane.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    const a = mine.find(x => x.id === b.dataset.del);
    if (!window.confirm(`Remove the accident form for ${a.child_name}?`)) return; // eslint-disable-line no-alert
    const { error: e } = await sb.from('accident_reports').delete().eq('id', a.id);
    toast(e ? e.message : 'Removed');
    renderAccidents(pane, me);
  });
}
