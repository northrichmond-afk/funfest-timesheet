// Admin › Forms: staff suitability (safeguarding) declarations and accident forms.
// Declarations: who has / hasn't completed one this year, manager sign-off with any follow-on
// action, a PDF, and filing it in iCloud Drive › FunFest › Staff › <person>.

import { sb } from '../shared/supabase.js';
import { esc, toast } from '../shared/ui.js';
import { signaturePad } from '../shared/signature.js';
import { matchFolder, safeName } from '../shared/staffdetails.js';
import { SUIT_TITLE, SUIT_INTRO, SUIT_QUESTIONS, SUIT_STATEMENTS, suitabilityFormHTML, readSuitabilityForm, suitabilityViewHTML,
  suitabilityStatus, suitabilityFileName, yesAnswers } from '../shared/suitability.js';
import { accidentsPane } from './today.js';
import { getRoot, permission } from './stafffiles.js';
import { loadJsPDF, imageData } from './invoice.js';

const FORM_TABS = [['suitability', 'Suitability declarations'], ['accidents', 'Accident forms']];
let formTab = 'suitability';
let suitFilter = 'all';
const canPick = () => typeof window.showDirectoryPicker === 'function';
const day = ts => (ts ? new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const LIST_COLS = 'id,staff_id,signed_at,signed_name,answers,further_info,completed_by,manager_name,manager_signed_at,follow_up_action,action_date,pdf_synced_at,pdf_path';

/** ctx = { view, dlg, me, staff, staffName } */
export function tabForms(ctx) {
  const { view } = ctx;
  view.innerHTML = `<div class="subtabs">${FORM_TABS.map(([k, l]) => `<button data-fm="${k}" class="${formTab === k ? 'active' : ''}">${l}</button>`).join('')}</div>
    <div id="formsPane"><p class="center muted">Loading…</p></div>`;
  view.querySelectorAll('[data-fm]').forEach(b => b.onclick = () => { formTab = b.dataset.fm; tabForms(ctx); });
  const pane = view.querySelector('#formsPane');
  return formTab === 'accidents' ? accidentsPane(pane, ctx) : suitabilityPane(pane, ctx);
}

// ═════════════════ Suitability declarations ═════════════════

const current = s => s.status === 'active' || s.status === 'invited';

export async function suitabilityPane(box, ctx) {
  const { data: rows, error } = await sb.from('suitability_declarations').select(LIST_COLS).order('signed_at', { ascending: false });
  if (error) {
    box.innerHTML = `<div class="card msg warn">${/suitability|schema cache/i.test(error.message)
      ? 'Suitability declarations aren’t set up in the database yet: run <code>supabase/008_suitability.sql</code> in Supabase.' : esc(error.message)}</div>`;
    return;
  }
  const latest = {};
  for (const r of rows) if (!latest[r.staff_id]) latest[r.staff_id] = r;
  const people = ctx.staff.filter(current).map(s => {
    const d = latest[s.id];
    return { s, d, st: suitabilityStatus(d?.signed_at), yes: d ? yesAnswers(d.answers).length : 0 };
  });
  const unsigned = rows.filter(r => !r.manager_signed_at);
  const counts = {
    due: people.filter(p => p.st.due).length,
    soon: people.filter(p => p.st.key === 'soon').length,
    signoff: unsigned.length,
    yes: people.filter(p => p.yes).length,
  };
  const FILTERS = [['all', `All (${people.length})`], ['due', `Due (${counts.due})`], ['signoff', `Needs sign-off (${counts.signoff})`], ['yes', `YES answers (${counts.yes})`]];
  const shown = people.filter(p => suitFilter === 'due' ? p.st.due || p.st.key === 'soon'
    : suitFilter === 'signoff' ? p.d && !p.d.manager_signed_at
    : suitFilter === 'yes' ? p.yes : true)
    .sort((a, b) => (b.st.due - a.st.due) || a.s.name.localeCompare(b.s.name));
  const pill = st => `<span class="pill ${st.key === 'ok' ? 'ok' : st.key === 'soon' ? 'warn' : 'bad'}">${st.label}</span>`;
  const root = canPick() ? await getRoot() : null;
  const toFile = rows.filter(needsFiling).length;

  box.innerHTML = `
    <div class="card">
      <h2>${SUIT_TITLE}</h2>
      <p class="small muted">${esc(SUIT_INTRO)} Staff complete it in the staff app under <b>Forms</b>; you can also fill it in with them here on the club device.</p>
      <div class="subtabs">${FILTERS.map(([k, l]) => `<button data-sf="${k}" class="${suitFilter === k ? 'active' : ''}">${l}</button>`).join('')}</div>
      ${shown.length ? `<div class="table-wrap"><table>
        <tr><th>Staff</th><th>Last signed</th><th>Status</th><th>Answers</th><th>Manager sign-off</th><th></th></tr>
        ${shown.map(({ s, d, st, yes }) => `<tr>
          <td><strong>${esc(s.name)}</strong>${s.status === 'invited' ? ' <span class="small muted">(invited)</span>' : ''}</td>
          <td class="small">${d ? day(d.signed_at) : '—'}${st.next ? `<div class="muted">next by ${day(st.next)}</div>` : ''}</td>
          <td>${pill(st)}</td>
          <td class="small">${d ? (yes ? `<span class="pill bad">${yes} YES</span>` : 'All “No”') : ''}</td>
          <td class="small">${d ? (d.manager_signed_at ? `✅ ${esc(d.manager_name || '')}<div class="muted">${day(d.manager_signed_at)}</div>` : '<span class="pill info">Waiting</span>') : ''}</td>
          <td><div class="actions">
            ${d ? `<button data-sview="${d.id}" class="${d.manager_signed_at ? '' : 'primary'}">${d.manager_signed_at ? 'View' : 'Review & sign'}</button><button data-spdf="${d.id}">PDF</button>` : ''}
            <button data-snew="${s.id}">Fill in now</button>
          </div></td></tr>`).join('')}
      </table></div>` : '<p class="muted">Nobody here.</p>'}
    </div>
    <div class="card">
      <h2>Filing in iCloud</h2>
      <p class="small muted">${!canPick() ? '⚠️ Filing PDFs in iCloud needs Chrome or Edge on the Mac.'
        : root ? `Signed declarations are saved as PDFs in each person’s folder in <b>${esc(root.name)}</b>. ${toFile ? `<b>${toFile}</b> to file.` : 'All filed.'}`
        : 'Choose the <b>Staff</b> folder on the Staff tab (Staff files → iCloud) first.'}
        ${root && toFile ? ' <button id="suitFile" class="small primary">File now</button>' : ''}</p>
    </div>`;

  const again = () => suitabilityPane(box, ctx);
  box.querySelectorAll('[data-sf]').forEach(b => b.onclick = () => { suitFilter = b.dataset.sf; again(); });
  box.querySelectorAll('[data-sview]').forEach(b => b.onclick = () => reviewDialog(ctx, b.dataset.sview, again));
  box.querySelectorAll('[data-spdf]').forEach(b => b.onclick = async () => {
    const d = await fullRow(b.dataset.spdf); if (!d) return;
    const doc = await suitabilityPdf(d, ctx.staffName(d.staff_id));
    window.open(doc.output('bloburl'), '_blank');
  });
  box.querySelectorAll('[data-snew]').forEach(b => b.onclick = () => recordDialog(ctx, ctx.staff.find(s => s.id === b.dataset.snew), again));
  box.querySelector('#suitFile')?.addEventListener('click', async () => { await fileDeclarations(ctx, true); again(); });
  if (root && toFile && !autoTried && (await root.queryPermission({ mode: 'readwrite' })) === 'granted') {
    autoTried = true;
    await fileDeclarations(ctx, false);
    again();
  }
}
let autoTried = false;

const needsFiling = r => !r.pdf_synced_at || (r.manager_signed_at && new Date(r.manager_signed_at) > new Date(r.pdf_synced_at));

async function fullRow(id) {
  const { data, error } = await sb.from('suitability_declarations').select('*').eq('id', id).single();
  if (error) { toast(error.message); return null; }
  return data;
}

function sigBlock(id) {
  return `<div><div class="small" style="font-weight:600;margin-bottom:.3rem">Signature</div>
    <canvas id="${id}" class="sigpad"></canvas><button type="button" id="${id}Clear" class="small">Clear</button></div>`;
}
function openWide(dlg, html, width = '760px') {
  dlg.innerHTML = html;
  dlg.style.maxWidth = width;
  dlg.addEventListener('close', () => { dlg.style.maxWidth = ''; }, { once: true });
  if (!dlg.open) dlg.showModal();
}

// Admin fills the form in with the staff member (club device)
function recordDialog(ctx, s, done) {
  const { dlg } = ctx;
  openWide(dlg, `<form class="stack">
    <h2>${SUIT_TITLE}</h2>
    <p class="small"><b>Name of staff member:</b> ${esc(s.name)}</p>
    ${suitabilityFormHTML()}
    <label>Staff member’s full name (as their signature)<input name="signed_name" required value="${esc(s.name)}"></label>
    ${sigBlock('sSig')}
    <label>Form completed by<input name="completed_by" value="${esc(ctx.me?.name || '')}"></label>
    <div class="msgs"></div>
    <div style="display:flex;gap:.5rem;flex-wrap:wrap"><button class="primary">✍️ Save signed declaration</button><button type="button" id="sX">Cancel</button></div>
  </form>`);
  const form = dlg.querySelector('form');
  const pad = signaturePad(dlg.querySelector('#sSig'));
  dlg.querySelector('#sSigClear').onclick = () => pad.clear();
  dlg.querySelector('#sX').onclick = () => dlg.close();
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const out = form.querySelector('.msgs');
    const { row, error: bad } = readSuitabilityForm(form);
    if (bad) { out.innerHTML = `<div class="msg bad">${esc(bad)}</div>`; return; }
    if (pad.isEmpty()) { out.innerHTML = '<div class="msg bad">The staff member needs to sign in the box.</div>'; return; }
    const { error } = await sb.from('suitability_declarations').insert({
      ...row, staff_id: s.id, signed_name: form.querySelector('[name=signed_name]').value.trim(), signature: pad.toDataURL(),
      completed_by: form.querySelector('[name=completed_by]').value.trim() || null,
    });
    if (error) { out.innerHTML = `<div class="msg bad">${esc(error.message)}</div>`; return; }
    dlg.close(); toast('Declaration saved ✓'); done();
  };
}

// Review a declaration; manager / owner signs it off and records any follow-on action
async function reviewDialog(ctx, id, done) {
  const d = await fullRow(id); if (!d) return;
  const { dlg } = ctx;
  const signedOff = !!d.manager_signed_at;
  openWide(dlg, `<form class="stack">
    <h2>${SUIT_TITLE}: ${esc(ctx.staffName(d.staff_id))}</h2>
    <p class="small muted">Signed ${day(d.signed_at)} as <b>${esc(d.signed_name)}</b>${d.completed_by ? ` · form completed by ${esc(d.completed_by)}` : ''}</p>
    ${suitabilityViewHTML(d)}
    ${d.signature ? `<img src="${d.signature}" alt="Signature" style="max-width:260px;border:1px solid var(--line);border-radius:8px">` : ''}
    <h3>Manager / owner</h3>
    <label>Follow-on action taken, where relevant<textarea name="follow_up_action" rows="2" placeholder="N/A">${esc(d.follow_up_action || '')}</textarea></label>
    <label>Date action taken<input type="date" name="action_date" value="${esc(d.action_date || '')}"></label>
    ${signedOff ? `<p class="small">✅ Signed off by <b>${esc(d.manager_name || '')}</b> on ${day(d.manager_signed_at)}</p>
        ${d.manager_signature ? `<img src="${d.manager_signature}" alt="Manager signature" style="max-width:220px;border:1px solid var(--line);border-radius:8px">` : ''}`
      : `<label>Manager / senior name<input name="manager_name" required value="${esc(ctx.me?.name || '')}"></label>${sigBlock('mSig')}`}
    <div class="msgs"></div>
    <div style="display:flex;gap:.5rem;flex-wrap:wrap">
      <button class="primary">${signedOff ? '💾 Save' : '✍️ Sign off'}</button>
      <button type="button" id="rDel" class="danger">Delete</button>
      <button type="button" id="rX">Close</button></div>
  </form>`);
  const form = dlg.querySelector('form');
  const pad = signedOff ? null : signaturePad(dlg.querySelector('#mSig'));
  dlg.querySelector('#mSigClear')?.addEventListener('click', () => pad.clear());
  dlg.querySelector('#rX').onclick = () => dlg.close();
  dlg.querySelector('#rDel').onclick = async () => {
    if (!window.confirm(`Delete this declaration for ${ctx.staffName(d.staff_id)}? This can’t be undone.`)) return; // eslint-disable-line no-alert
    const { error } = await sb.from('suitability_declarations').delete().eq('id', d.id);
    dlg.close(); toast(error ? error.message : 'Deleted'); done();
  };
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const out = form.querySelector('.msgs');
    const upd = {
      follow_up_action: form.querySelector('[name=follow_up_action]').value.trim() || null,
      action_date: form.querySelector('[name=action_date]').value || null,
    };
    if (!signedOff) {
      if (pad.isEmpty()) { out.innerHTML = '<div class="msg bad">Please sign in the box.</div>'; return; }
      upd.manager_name = form.querySelector('[name=manager_name]').value.trim();
      upd.manager_signature = pad.toDataURL();
    }
    const { error } = await sb.from('suitability_declarations').update(upd).eq('id', d.id);
    if (error) { out.innerHTML = `<div class="msg bad">${esc(error.message)}</div>`; return; }
    dlg.close(); toast(signedOff ? 'Saved' : 'Signed off ✓');
    await fileDeclarations(ctx, false);
    done();
  };
}

// ── PDF ──
const PINK = [237, 0, 140], PURPLE = [125, 76, 158], INK = [44, 44, 44], GREY = [107, 104, 112];

export async function suitabilityPdf(d, person, deps = {}) {
  const JsPDF = deps.JsPDF || await loadJsPDF();
  const logo = deps.logo || await imageData(new URL('../shared/brand/fun-fest-logo.png', import.meta.url).href);
  const doc = new JsPDF({ unit: 'mm', format: 'a4' });
  const L = 18, R = 192;
  let y;
  const need = h => { if (y + h > 280) { doc.addPage(); y = 18; } };
  const para = (t, size = 9.5, style = 'normal', color = INK, gap = 1.5) => {
    doc.setFont('helvetica', style); doc.setFontSize(size); doc.setTextColor(...color);
    const lines = doc.splitTextToSize(t, R - L);
    need(lines.length * size * 0.42 + gap);
    doc.text(lines, L, y); y += lines.length * size * 0.42 + gap;
  };
  doc.addImage(logo, 'PNG', L, 10, 26, 19);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(17); doc.setTextColor(...PINK);
  doc.text(SUIT_TITLE, L + 32, 19);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...GREY);
  doc.text(doc.splitTextToSize(SUIT_INTRO, R - L - 32), L + 32, 24);
  doc.setDrawColor(...PINK); doc.setLineWidth(0.5); doc.line(L, 34, R, 34);
  y = 41;
  para(`Name of staff member: ${person}`, 10.5, 'bold');
  para(`Form completed by: ${d.completed_by || d.signed_name}`, 10, 'normal', INK, 3);
  const a = d.answers || {};
  SUIT_QUESTIONS.forEach(([k, q], i) => {
    doc.setFontSize(9.3); doc.setFont('helvetica', 'normal');
    const lines = doc.splitTextToSize(`${i + 1}. ${q}`, R - L - 22);
    const h = lines.length * 4 + 2.2;
    need(h);
    doc.setDrawColor(231, 227, 236); doc.setLineWidth(0.2); doc.line(L, y - 3.4, R, y - 3.4);
    doc.setTextColor(...INK); doc.text(lines, L, y);
    doc.setFont('helvetica', 'bold'); doc.setTextColor(...(a[k] === true ? [190, 18, 60] : INK));
    doc.text(a[k] === true ? 'YES' : a[k] === false ? 'No' : '—', R, y, { align: 'right' });
    y += h;
  });
  y += 2;
  para('If you have answered YES to any of the questions, please provide further information:', 9.5, 'bold', PURPLE);
  para(d.further_info || 'N/A', 9.5, 'normal', INK, 4);
  para('Declaration', 11, 'bold', PURPLE);
  for (const s of SUIT_STATEMENTS) para(`-  ${s}`, 9.3, 'normal', INK, 1.2);
  // Signatures side by side: staff member (left), manager / owner (right)
  y += 3; need(58);
  const M = 108, top = y;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...PURPLE);
  doc.text('Staff member', L, y); doc.text('Manager / Owner', M, y); y += 5.5;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...INK);
  doc.text(`Signed: ${d.signed_name}`, L, y); doc.text(`Manager/senior: ${d.manager_name || ''}`, M, y); y += 4.5;
  doc.text(`Date: ${day(d.signed_at)}`, L, y); doc.text(`Date: ${day(d.manager_signed_at)}`, M, y); y += 2;
  if (d.signature) doc.addImage(d.signature, 'PNG', L, y, 60, 21);
  if (d.manager_signature) doc.addImage(d.manager_signature, 'PNG', M, y, 60, 21);
  doc.setDrawColor(...GREY); doc.setLineWidth(0.2); doc.line(L, y + 22, L + 70, y + 22); doc.line(M, y + 22, M + 70, y + 22);
  y = top + 40;
  para(`Follow-on action taken: ${d.follow_up_action || 'N/A'}`, 9.5);
  para(`Date action taken: ${d.action_date ? day(d.action_date) : 'N/A'}`, 9.5);
  return doc;
}

// ── Filing in iCloud Drive › FunFest › Staff › <person> ──
async function fileDeclarations(ctx, ask) {
  const root = canPick() ? await getRoot() : null;
  if (!root || !(await permission(root, ask))) return;
  const { data: rows } = await sb.from('suitability_declarations').select(LIST_COLS);
  const todo = (rows || []).filter(needsFiling);
  if (!todo.length) return;
  const { data: profiles } = await sb.from('staff_profiles').select('staff_id,folder_name,full_name');
  const prof = Object.fromEntries((profiles || []).map(p => [p.staff_id, p]));
  const dirs = [];
  for await (const [n, h] of root.entries()) if (h.kind === 'directory') dirs.push(n);
  let ok = 0, bad = 0;
  for (const r of todo) {
    const person = ctx.staffName(r.staff_id);
    try {
      const p = prof[r.staff_id];
      const folder = p?.folder_name || matchFolder(dirs, person) || matchFolder(dirs, p?.full_name) || safeName(person);
      const dir = await root.getDirectoryHandle(folder, { create: true });
      const full = await fullRow(r.id);
      const name = suitabilityFileName(person, r.signed_at);
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await w.write((await suitabilityPdf(full, person)).output('blob')); await w.close();
      const { error } = await sb.from('suitability_declarations').update({ pdf_synced_at: new Date().toISOString(), pdf_path: `${folder}/${name}` }).eq('id', r.id);
      if (error) throw error;
      ok++;
    } catch (e) { bad++; console.warn('suitability filing', person, e); }
  }
  toast(bad ? `Filed ${ok}, ${bad} failed` : `Filed ${ok} declaration${ok === 1 ? '' : 's'} in iCloud ✓`, 5000);
}
