// Admin › Today: "Accident forms" (parent signs at collection, signed PDF filed in iCloud)
// and "Attending children" (register from the website bookings, arrival / departure,
// parent details).

import { sb } from '../shared/supabase.js';
import { esc, toast } from '../shared/ui.js';
import { accidentFormHTML, readAccidentForm, accidentViewHTML, accidentFile, fmtWhen, clubLabel, CLUB_OPTIONS } from '../shared/accidents.js';
import { childrenOnDay } from '../shared/bookings.js';
import { CLUBS, conn, wc, loadJsPDF, imageData } from './invoice.js';

const pad = n => String(n).padStart(2, '0');
const isoDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = ts => (ts ? new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '');
const canPick = () => typeof window.showDirectoryPicker === 'function';

// ═════════════════ Accident forms ═════════════════

export async function accidentsPane(box, ctx) {
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const [{ data: unsigned, error }, { data: signed }] = await Promise.all([
    sb.from('accident_reports').select('*').is('signed_at', null).order('occurred_at'),
    sb.from('accident_reports').select('*').not('signed_at', 'is', null).gte('signed_at', since).order('signed_at', { ascending: false }),
  ]);
  if (error) {
    box.innerHTML = `<div class="card msg warn">${/accident_reports|schema cache/i.test(error.message)
      ? 'Accident forms aren’t set up in the database yet: run <code>supabase/007_accidents_attendance.sql</code> in Supabase.' : esc(error.message)}</div>`;
    return;
  }
  const today = isoDay();
  const row = (a, signedList) => `<tr>
    <td><strong>${esc(a.child_name)}</strong>${a.child_age_group ? `<div class="small muted">${esc(a.child_age_group)}</div>` : ''}</td>
    <td class="small">${esc(clubLabel(a.club))}</td>
    <td class="small">${fmtWhen(a.occurred_at)}${isoDay(new Date(a.occurred_at)) !== today && !signedList ? ' <span class="pill warn">not today</span>' : ''}</td>
    <td class="small">${esc(a.injury || a.what_happened || '').slice(0, 80)}</td>
    <td class="small">${esc(ctx.staffName(a.reported_by))}</td>
    ${signedList ? `<td class="small">${esc(a.parent_name || '')}<div class="muted">${fmtWhen(a.signed_at)}</div></td>
      <td class="small">${a.pdf_synced_at ? '✅ ' + esc(a.pdf_path || '') : '<span class="pill info">Not filed yet</span>'}</td>` : ''}
    <td><div class="actions">
      ${signedList ? `<button data-pdf="${a.id}">PDF</button>` : `<button class="primary" data-sign="${a.id}">✍️ Parent signs</button><button data-aedit="${a.id}">Edit</button>`}
    </div></td></tr>`;
  const root = canPick() ? await getAccRoot() : null;
  const toFile = (signed || []).filter(a => !a.pdf_synced_at).length;
  box.innerHTML = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap">
        <h2 style="margin:0">Waiting for a parent’s signature</h2>
        <button id="accAdd">➕ Record an accident</button>
      </div>
      <p class="small muted">When the parent collects their child, open the form, let them read it, and ask them to sign on the screen.</p>
      ${(unsigned || []).length ? `<div class="table-wrap"><table>
        <tr><th>Child</th><th>Club</th><th>When</th><th>Injury</th><th>Recorded by</th><th></th></tr>
        ${unsigned.map(a => row(a, false)).join('')}</table></div>` : '<p>✅ No forms waiting to be signed.</p>'}
    </div>
    <div class="card">
      <h2>Signed in the last 30 days</h2>
      <p class="small muted">${!canPick() ? '⚠️ Filing PDFs in iCloud needs Chrome or Edge on the Mac.'
        : root ? `Signed PDFs are filed in <b>${esc(root.name)}</b> (a folder per month). ${toFile ? `<b>${toFile}</b> to file.` : 'All filed.'}`
        : 'Choose <b>iCloud Drive › FunFest</b> (or an <b>Accidents</b> folder inside it) once, to file signed PDFs automatically.'}
        ${canPick() ? `<button id="accFolder" class="small">${root ? 'Change folder…' : 'Choose folder…'}</button> ${root && toFile ? '<button id="accFile" class="small primary">File now</button>' : ''}` : ''}</p>
      ${(signed || []).length ? `<div class="table-wrap"><table>
        <tr><th>Child</th><th>Club</th><th>When</th><th>Injury</th><th>Recorded by</th><th>Signed by</th><th>iCloud</th><th></th></tr>
        ${signed.map(a => row(a, true)).join('')}</table></div>` : '<p class="muted small">None.</p>'}
    </div>`;
  const again = () => accidentsPane(box, ctx);
  box.querySelector('#accAdd').onclick = () => editAccident(ctx, null, again);
  box.querySelectorAll('[data-aedit]').forEach(b => b.onclick = () => editAccident(ctx, unsigned.find(a => a.id === b.dataset.aedit), again));
  box.querySelectorAll('[data-sign]').forEach(b => b.onclick = () => signAccident(ctx, unsigned.find(a => a.id === b.dataset.sign), again));
  box.querySelectorAll('[data-pdf]').forEach(b => b.onclick = async () => {
    const a = signed.find(x => x.id === b.dataset.pdf);
    const doc = await accidentPdf(a, ctx);
    window.open(doc.output('bloburl'), '_blank');
  });
  box.querySelector('#accFolder')?.addEventListener('click', async () => { if (await pickAccRoot()) again(); });
  box.querySelector('#accFile')?.addEventListener('click', async () => { await fileSigned(ctx, true); again(); });
  if (root && toFile && !accAutoTried && (await root.queryPermission({ mode: 'readwrite' })) === 'granted') {
    accAutoTried = true;
    await fileSigned(ctx, false);
    again();
  }
}
let accAutoTried = false;

function editAccident(ctx, a, done) {
  const dlg = ctx.dlg;
  dlg.innerHTML = `<form class="stack" style="min-width:min(560px,100%)">
    <h2>${a ? 'Edit accident form' : 'Record an accident'}</h2>
    ${accidentFormHTML(a || { club: 'northrichmond', parent_informed_how: 'At collection', treated_by: ctx.me?.name })}
    <div class="msgs"></div>
    <div style="display:flex;gap:.5rem;flex-wrap:wrap"><button class="primary">Save</button>
      ${a ? '<button type="button" class="danger" id="accDel">Delete</button>' : ''}
      <button type="button" id="accX">Cancel</button></div></form>`;
  dlg.showModal();
  const form = dlg.querySelector('form');
  dlg.querySelector('#accX').onclick = () => dlg.close();
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const row = readAccidentForm(form);
    const { error } = a ? await sb.from('accident_reports').update(row).eq('id', a.id) : await sb.from('accident_reports').insert(row);
    if (error) { form.querySelector('.msgs').innerHTML = `<div class="msg bad">${esc(error.message)}</div>`; return; }
    dlg.close(); toast('Saved'); done();
  };
  dlg.querySelector('#accDel')?.addEventListener('click', async () => {
    if (!window.confirm(`Delete the accident form for ${a.child_name}?`)) return; // eslint-disable-line no-alert
    const { error } = await sb.from('accident_reports').delete().eq('id', a.id);
    dlg.close(); toast(error ? error.message : 'Deleted'); done();
  });
}

// Signature pad on a canvas (finger, stylus or mouse)
function signaturePad(canvas) {
  const ctx2 = canvas.getContext('2d');
  const ratio = window.devicePixelRatio || 1;
  const size = () => { const r = canvas.getBoundingClientRect(); canvas.width = r.width * ratio; canvas.height = r.height * ratio; ctx2.scale(ratio, ratio); ctx2.lineWidth = 2.2; ctx2.lineCap = 'round'; ctx2.lineJoin = 'round'; ctx2.strokeStyle = '#1b1b1b'; };
  size();
  let drawing = false, empty = true, last = null;
  const pos = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', e => { drawing = true; last = pos(e); canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', e => {
    if (!drawing) return;
    const p = pos(e);
    ctx2.beginPath(); ctx2.moveTo(...last); ctx2.lineTo(...p); ctx2.stroke();
    last = p; empty = false;
  });
  const stop = () => { drawing = false; };
  canvas.addEventListener('pointerup', stop); canvas.addEventListener('pointercancel', stop);
  return {
    isEmpty: () => empty,
    clear: () => { ctx2.clearRect(0, 0, canvas.width, canvas.height); empty = true; },
    toDataURL: () => {
      // white background so the PDF shows it cleanly
      const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height;
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(canvas, 0, 0);
      return c.toDataURL('image/png');
    },
  };
}

function signAccident(ctx, a, done) {
  const dlg = ctx.dlg;
  dlg.innerHTML = `<form class="stack" style="min-width:min(640px,100%)">
    <h2>Accident form: ${esc(a.child_name)}</h2>
    <p class="small muted">${esc(clubLabel(a.club))} · recorded by ${esc(ctx.staffName(a.reported_by))}</p>
    ${accidentViewHTML(a)}
    <label>Parent / carer name<input name="parent_name" required autocomplete="off"></label>
    <label class="check"><input type="checkbox" name="ok" required> <span>I have been told about this accident and have read this report.</span></label>
    <div><div class="small" style="font-weight:600;margin-bottom:.3rem">Signature</div>
      <canvas id="sig" style="width:100%;height:180px;border:1.5px dashed var(--line);border-radius:10px;background:#fff"></canvas>
      <button type="button" id="sigClear" class="small">Clear</button></div>
    <div class="msgs"></div>
    <div style="display:flex;gap:.5rem;flex-wrap:wrap"><button class="primary">✍️ Sign</button><button type="button" id="sigX">Cancel</button></div>
  </form>`;
  dlg.style.maxWidth = '720px';
  dlg.addEventListener('close', () => { dlg.style.maxWidth = ''; }, { once: true });
  dlg.showModal();
  const pad2 = signaturePad(dlg.querySelector('#sig'));
  dlg.querySelector('#sigClear').onclick = () => pad2.clear();
  dlg.querySelector('#sigX').onclick = () => dlg.close();
  const form = dlg.querySelector('form');
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    if (pad2.isEmpty()) { form.querySelector('.msgs').innerHTML = '<div class="msg bad">Please sign in the box.</div>'; return; }
    const { error } = await sb.from('accident_reports').update({
      parent_name: form.querySelector('[name=parent_name]').value.trim(), parent_signature: pad2.toDataURL(), witnessed_by: ctx.me?.id || null,
    }).eq('id', a.id);
    if (error) { form.querySelector('.msgs').innerHTML = `<div class="msg bad">${esc(error.message)}</div>`; return; }
    dlg.close();
    toast('Signed ✓ Thank you');
    await fileSigned(ctx, false);
    done();
  };
}

// ── Signed PDF ──
const PINK = [237, 0, 140], PURPLE = [125, 76, 158], INK = [44, 44, 44], GREY = [107, 104, 112];

export async function accidentPdf(a, ctx, deps = {}) {
  const JsPDF = deps.JsPDF || await loadJsPDF();
  const logo = deps.logo || await imageData(new URL('../shared/brand/fun-fest-logo.png', import.meta.url).href);
  const club = CLUBS[a.club] || CLUBS.northrichmond;
  const doc = new JsPDF({ unit: 'mm', format: 'a4' });
  const L = 18, R = 192, LW = 52;
  doc.addImage(logo, 'PNG', L, 10, 30, 22);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.setTextColor(...PINK);
  doc.text('Accident / Injury Report', L + 36, 19);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...INK);
  doc.text(`${club.name} · ${club.premises}`, L + 36, 25);
  doc.text(`Ofsted Registration No: ${club.ofsted}`, L + 36, 30);
  doc.setDrawColor(...PINK); doc.setLineWidth(0.5); doc.line(L, 36, R, 36);
  let y = 45;
  const rows = [
    ['Child', a.child_name + (a.child_age_group ? ` (${a.child_age_group})` : '')],
    ['Date and time', fmtWhen(a.occurred_at)],
    ['Where', a.location], ['What happened', a.what_happened], ['Injury', a.injury],
    ['First aid / action taken', a.first_aid], ['Treated by', a.treated_by], ['Witnesses', a.witnesses],
    ['Recorded by', ctx.staffName(a.reported_by)], ['Parent told', a.parent_informed_how],
  ];
  for (const [k, v] of rows) {
    doc.setFontSize(10.5);
    const val = doc.splitTextToSize(String(v || '—'), R - L - LW);
    const h = val.length * 5 + 2.5;
    doc.setDrawColor(231, 227, 236); doc.setLineWidth(0.2); doc.line(L, y - 4, R, y - 4);
    doc.setFont('helvetica', 'bold'); doc.setTextColor(...GREY); doc.text(k, L, y);
    doc.setFont('helvetica', 'normal'); doc.setTextColor(...INK); doc.text(val, L + LW, y);
    y += h;
  }
  y += 6;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...PURPLE);
  doc.text('Parent / carer', L, y); y += 7;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5); doc.setTextColor(...INK);
  doc.text('I have been told about this accident and have read this report.', L, y); y += 7;
  doc.text(`Name: ${a.parent_name || ''}`, L, y);
  doc.text(`Signed: ${a.signed_at ? fmtWhen(a.signed_at) : ''}`, L + 95, y); y += 4;
  if (a.parent_signature) { doc.addImage(a.parent_signature, 'PNG', L, y, 80, 28); }
  doc.setDrawColor(...GREY); doc.line(L, y + 29, L + 80, y + 29);
  y += 36;
  if (a.witnessed_by) { doc.setFontSize(9.5); doc.setTextColor(...GREY); doc.text(`Signed in the presence of ${ctx.staffName(a.witnessed_by)}`, L, y); }
  doc.setFontSize(8); doc.setTextColor(...GREY);
  doc.text(`${club.company} · Company Registration Number ${club.companyNo}`, 105, 288, { align: 'center' });
  return doc;
}

// ── Filing in iCloud (FunFest › Accidents › YYYY-MM) ──
const DB = 'ff-folders', STORE = 'handles', KEY = 'accidentsRoot';
function idb(mode, fn) {
  return new Promise((ok, fail) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => fail(open.error);
    open.onsuccess = () => { const tx = open.result.transaction(STORE, mode); const req = fn(tx.objectStore(STORE)); tx.oncomplete = () => ok(req?.result); tx.onerror = () => fail(tx.error); };
  });
}
const getAccRoot = () => idb('readonly', s => s.get(KEY)).catch(() => null);
async function pickAccRoot() {
  try {
    let h = await window.showDirectoryPicker({ id: 'ff-accidents', mode: 'readwrite', startIn: 'documents' });
    if (h.name !== 'Accidents') h = await h.getDirectoryHandle('Accidents', { create: true });   // picked FunFest
    await idb('readwrite', s => s.put(h, KEY));
    toast(`Accident forms will be filed in “${h.name}”`);
    return h;
  } catch (e) { if (e.name !== 'AbortError') toast(e.message); return null; }
}

let filing = false;
async function fileSigned(ctx, ask) {
  if (filing || !canPick()) return;
  let root = await getAccRoot();
  if (!root) { if (!ask) return; root = await pickAccRoot(); if (!root) return; }
  let perm = await root.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted' && ask) { try { perm = await root.requestPermission({ mode: 'readwrite' }); } catch { /* needs a click */ } }
  if (perm !== 'granted') return;
  filing = true;
  try {
    const { data } = await sb.from('accident_reports').select('*').not('signed_at', 'is', null).is('pdf_synced_at', null);
    let ok = 0;
    for (const a of data || []) {
      try {
        const { folder, name } = accidentFile(a);
        const dir = await root.getDirectoryHandle(folder, { create: true });
        const doc = await accidentPdf(a, ctx);
        const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
        await w.write(doc.output('blob')); await w.close();
        await sb.from('accident_reports').update({ pdf_synced_at: new Date().toISOString(), pdf_path: `${folder}/${name}` }).eq('id', a.id);
        ok++;
      } catch (e) { toast(`Couldn't file ${a.child_name}: ${e.message}`, 6000); }
    }
    if (ok) toast(`Filed ${ok} signed accident form${ok === 1 ? '' : 's'} in iCloud`);
  } finally { filing = false; }
}

// ═════════════════ Attending children ═════════════════

const reg = { club: 'northrichmond', day: isoDay() };
const cache = {};   // `${club}|${day}` → { at, kids }

async function bookedChildren(club, day, force) {
  const k = `${club}|${day}`;
  if (!force && cache[k] && Date.now() - cache[k].at < 5 * 60000) return cache[k].kids;
  const base = CLUBS[club].base;
  const after = new Date(new Date(day + 'T00:00:00Z').getTime() - 180 * 864e5).toISOString().slice(0, 19);
  const orders = [];
  for (let page = 1; page <= 30; page++) {
    const list = await wc(`/wp-json/wc/v3/orders?per_page=100&page=${page}&after=${after}&status=processing,completed,on-hold`
      + '&_fields=id,number,status,billing,line_items,refunds', base);
    orders.push(...list);
    if (list.length < 100) break;
  }
  const kids = childrenOnDay(orders, day);
  cache[k] = { at: Date.now(), kids };
  return kids;
}

export async function attendancePane(box, ctx, force = false) {
  const head = `
    <div class="card">
      <div class="toolbar">
        <label>Club<select id="rgClub">${CLUB_OPTIONS.map(([k, l]) => `<option value="${k}" ${reg.club === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>Day<input type="date" id="rgDay" value="${reg.day}"></label>
        <button id="rgReload">↻ Refresh bookings</button>
      </div>
      <div id="rgBody"><p class="muted">Loading bookings from the website…</p></div>
    </div>`;
  box.innerHTML = head;
  box.querySelector('#rgClub').onchange = (e) => { reg.club = e.target.value; attendancePane(box, ctx); };
  box.querySelector('#rgDay').onchange = (e) => { reg.day = e.target.value || isoDay(); attendancePane(box, ctx); };
  box.querySelector('#rgReload').onclick = () => attendancePane(box, ctx, true);
  const body = box.querySelector('#rgBody');
  const c = conn();
  if (!c.user || !c.pass) {
    body.innerHTML = '<div class="msg warn">Connect this browser to the website first: <b>Invoices › Website connection</b> (the same login is used for both clubs).</div>';
    return;
  }
  let kids, att;
  try {
    [kids, { data: att }] = await Promise.all([
      bookedChildren(reg.club, reg.day, force),
      sb.from('attendance').select('*').eq('club', reg.club).eq('day', reg.day),
    ]);
  } catch (e) { body.innerHTML = `<div class="msg bad">${esc(e.message)}</div>`; return; }
  const A = Object.fromEntries((att || []).map(r => [r.child_key, r]));
  const arrived = kids.filter(k => A[k.key]?.arrived_at).length;
  const left = kids.filter(k => A[k.key]?.departed_at).length;
  const groups = ['All day', 'AM', 'PM', 'Day'].map(s => [s, kids.filter(k => k.session === s)]).filter(([, l]) => l.length);
  const label = { 'All day': 'All day (AM + PM)', AM: 'Morning only (AM)', PM: 'Afternoon only (PM)', Day: 'Booked' };
  body.innerHTML = kids.length ? `
    <div class="stats">
      <div class="stat"><div class="v">${kids.length}</div><div class="k">Booked</div></div>
      <div class="stat"><div class="v">${arrived - left}</div><div class="k">Here now</div></div>
      <div class="stat"><div class="v">${kids.length - arrived}</div><div class="k">Not arrived</div></div>
      <div class="stat"><div class="v">${left}</div><div class="k">Gone home</div></div>
    </div>
    ${groups.map(([g, list]) => `
      <h3>${label[g]} <span class="small muted">(${list.length})</span></h3>
      <div class="table-wrap"><table>
        <tr><th>Child</th><th>Age group</th><th>Activities</th><th>Arrived</th><th>Departed</th><th></th></tr>
        ${list.map(k => { const r = A[k.key] || {}; return `<tr>
          <td><strong>${esc(k.name)}</strong>${k.socialWorker ? ' <span class="pill warn">social worker</span>' : ''}</td>
          <td class="small">${esc(k.ageGroup)}</td>
          <td class="small">${k.activities.map(esc).join('<br>')}</td>
          <td>${r.arrived_at ? `<button class="small" data-unarr="${esc(k.key)}">✅ ${hm(r.arrived_at)}</button>` : `<button class="primary small" data-arr="${esc(k.key)}">Arrived</button>`}</td>
          <td>${r.departed_at ? `<button class="small" data-undep="${esc(k.key)}">✅ ${hm(r.departed_at)}${r.collected_by ? `<div class="muted">${esc(r.collected_by)}</div>` : ''}</button>`
            : `<button class="small" data-dep="${esc(k.key)}" ${r.arrived_at ? '' : 'disabled'}>Departed</button>`}</td>
          <td><button class="small" data-par="${esc(k.key)}">👪 Parent</button></td></tr>`; }).join('')}
      </table></div>`).join('')}` : `<p class="muted">No children booked at ${esc(clubLabel(reg.club))} on ${esc(reg.day)}.</p>`;

  const kid = key => kids.find(k => k.key === key);
  const save = async (k, patch) => {
    const { error } = await sb.from('attendance').upsert({ club: reg.club, day: reg.day, child_key: k.key, child_name: k.name, order_numbers: k.orders.join(', '), ...patch }, { onConflict: 'club,day,child_key' });
    if (error) toast(error.message, 6000);
    attendancePane(box, ctx);
  };
  body.querySelectorAll('[data-arr]').forEach(b => b.onclick = () => save(kid(b.dataset.arr), { arrived_at: new Date().toISOString() }));
  body.querySelectorAll('[data-unarr]').forEach(b => b.onclick = () => {
    const k = kid(b.dataset.unarr);
    if (window.confirm(`Undo ${k.name}'s arrival?`)) save(k, { arrived_at: null, departed_at: null, collected_by: null }); // eslint-disable-line no-alert
  });
  body.querySelectorAll('[data-undep]').forEach(b => b.onclick = () => {
    const k = kid(b.dataset.undep);
    if (window.confirm(`Undo ${k.name}'s departure?`)) save(k, { departed_at: null, collected_by: null }); // eslint-disable-line no-alert
  });
  body.querySelectorAll('[data-dep]').forEach(b => b.onclick = () => departDialog(ctx, kid(b.dataset.dep), (who) => save(kid(b.dataset.dep), { departed_at: new Date().toISOString(), collected_by: who || null })));
  body.querySelectorAll('[data-par]').forEach(b => b.onclick = () => parentDialog(ctx, kid(b.dataset.par)));
}

function parentDialog(ctx, k) {
  const dlg = ctx.dlg;
  const p = k.parent;
  const tel = (p.phone || '').replace(/[^\d+]/g, '');
  dlg.innerHTML = `<div class="stack" style="min-width:min(460px,100%)">
    <h2>${esc(k.name)}</h2>
    <table class="small">
      <tr><th style="width:38%">Parent / booker</th><td>${esc(p.name || '—')}</td></tr>
      <tr><th>Phone</th><td>${p.phone ? `<a href="tel:${esc(tel)}" style="font-size:1.15rem;font-weight:700">📞 ${esc(p.phone)}</a>` : '—'}</td></tr>
      <tr><th>Email</th><td>${p.email ? `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : '—'}</td></tr>
      <tr><th>Booking(s)</th><td>#${k.orders.map(esc).join(', #')}</td></tr>
      <tr><th>Collection password</th><td><span class="muted">Not set up yet: the source for collection details will be added.</span></td></tr>
      ${k.socialWorker ? `<tr><th>Social worker</th><td>${esc(k.socialWorker)}</td></tr>` : ''}
    </table>
    <form method="dialog"><button class="primary">Close</button></form>
  </div>`;
  dlg.showModal();
}

function departDialog(ctx, k, done) {
  const dlg = ctx.dlg;
  dlg.innerHTML = `<form class="stack" style="min-width:min(420px,100%)">
    <h2>${esc(k.name)} is going home</h2>
    <label>Collected by<input name="who" value="${esc(k.parent.name || '')}" autocomplete="off"></label>
    <p class="small muted">Check the person collecting is on the child’s collection list (👪 Parent shows the booking details).</p>
    <div style="display:flex;gap:.5rem"><button class="primary">Confirm departure</button><button type="button" id="dX">Cancel</button></div></form>`;
  dlg.showModal();
  dlg.querySelector('#dX').onclick = () => dlg.close();
  dlg.querySelector('form').onsubmit = (ev) => { ev.preventDefault(); const who = ev.target.querySelector('[name=who]').value.trim(); dlg.close(); done(who); };
}
