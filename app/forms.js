// Staff app › "Forms": the suitability (safeguarding) declaration.

import { sb } from '../shared/supabase.js';
import { esc, toast } from '../shared/ui.js';
import { signaturePad } from '../shared/signature.js';
import { SUIT_TITLE, suitabilityFormHTML, readSuitabilityForm, suitabilityStatus, yesAnswers } from '../shared/suitability.js';

// Accident forms are recorded by admins (admin › Forms › Accident forms), not in the staff app.
export function renderForms(pane, me) {
  pane.innerHTML = '<div id="formPane"><p class="center muted">Loading…</p></div>';
  return renderSuitability(pane.querySelector('#formPane'), me);
}

const day = ts => new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export async function renderSuitability(box, me, filling = false) {
  const { data: mine, error } = await sb.from('suitability_declarations')
    .select('id,signed_at,signed_name,answers,manager_signed_at,manager_name').eq('staff_id', me.id).order('signed_at', { ascending: false });
  if (error) {
    box.innerHTML = `<div class="card msg bad">${/suitability|schema cache/i.test(error.message) ? 'This form isn’t available yet. Please try again later.' : `Couldn't load your forms: ${esc(error.message)}`}</div>`;
    return;
  }
  const st = suitabilityStatus(mine?.[0]?.signed_at);
  const history = (mine || []).length ? `<div class="card"><h2>My declarations</h2>
    ${mine.map(d => `<div class="shift-line"><div><strong>${day(d.signed_at)}</strong>
      <div class="small muted">Signed as ${esc(d.signed_name)}${yesAnswers(d.answers).length ? ' · includes a YES answer' : ''}</div></div>
      <div>${d.manager_signed_at ? `<span class="pill ok">Checked by ${esc(d.manager_name || 'manager')}</span>` : '<span class="pill info">Waiting for manager</span>'}</div></div>`).join('')}
    </div>` : '';

  if (!filling && !st.due) {
    box.innerHTML = `<div class="card">
      <h2>${SUIT_TITLE}</h2>
      <p><span class="pill ${st.key === 'soon' ? 'warn' : 'ok'}">${st.label}</span></p>
      <p class="small muted">Thank you. You signed it on ${day(mine[0].signed_at)}. The next one is due by ${day(st.next)}.
        If anything changes before then (for example a caution, a new medication or a health concern), tell your manager straight away and complete a new declaration.</p>
      <button id="suitNew">Complete a new declaration</button></div>${history}`;
    box.querySelector('#suitNew').onclick = () => renderSuitability(box, me, true);
    return;
  }

  box.innerHTML = `<div class="card">
    <h2>${SUIT_TITLE}</h2>
    ${st.key === 'overdue' ? '<p><span class="pill warn">Your annual declaration is due</span></p>' : ''}
    <form id="suit" class="stack">
      <p class="small"><b>Name of staff member:</b> ${esc(me.name || '')}</p>
      ${suitabilityFormHTML()}
      <label>Your full name (as your signature)<input name="signed_name" required autocomplete="name" value="${esc(me.name || '')}"></label>
      <div><div class="small" style="font-weight:600;margin-bottom:.3rem">Sign here</div>
        <canvas id="suitSig" class="sigpad"></canvas>
        <button type="button" id="suitClear" class="small">Clear</button></div>
      <div id="suitMsg"></div>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap">
        <button class="primary">✍️ Sign and submit</button>
        ${!st.due ? '<button type="button" id="suitX">Cancel</button>' : ''}
      </div>
    </form></div>${history}`;
  const form = box.querySelector('#suit');
  const pad = signaturePad(box.querySelector('#suitSig'));
  box.querySelector('#suitClear').onclick = () => pad.clear();
  box.querySelector('#suitX')?.addEventListener('click', () => renderSuitability(box, me));
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const msg = form.querySelector('#suitMsg');
    const { row, error: bad } = readSuitabilityForm(form);
    if (bad) { msg.innerHTML = `<div class="msg bad">${esc(bad)}</div>`; return; }
    if (pad.isEmpty()) { msg.innerHTML = '<div class="msg bad">Please sign in the box.</div>'; return; }
    const signed = form.querySelector('[name=signed_name]').value.trim();
    const btn = form.querySelector('button.primary'); btn.disabled = true;
    const { error: e } = await sb.from('suitability_declarations').insert({
      ...row, staff_id: me.id, signed_name: signed, signature: pad.toDataURL(), completed_by: me.name || signed,
    });
    btn.disabled = false;
    if (e) { msg.innerHTML = `<div class="msg bad">Couldn't submit: ${esc(e.message)}</div>`; return; }
    toast('Declaration submitted ✓ Thank you');
    window.scrollTo(0, 0);
    renderSuitability(box, me);
  };
}
