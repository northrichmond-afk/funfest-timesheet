// Admin › Staff: each person's details and uploaded certificates, and copying them into
// iCloud Drive › FunFest › Staff › <person's folder> on this Mac (File System Access API,
// Chrome/Edge). Uploaded files are written with clear names; the details are written as
// "Staff details - <name>.pdf" and refreshed whenever the person changes them.

import { sb } from '../shared/supabase.js';
import { gmailToken, sendGmail, isEmail } from './gmail.js';
import { dbsStatusHTML, dbsCheckForm } from './dbscheck.js';
import { esc, toast } from '../shared/ui.js';
import { renewalRequestOpen, renewalRequestEmail, detailsViewHTML, detailsFormHTML, wireDetailsForm, readDetailsForm, checkDetails, SECTIONS, OFFICE_SECTIONS, OFFICE_FIELDS,
  displayValue, matchFolder, safeName, docFileName, detailsFileName, DOC_KINDS } from '../shared/staffdetails.js';
import { loadJsPDF, imageData } from './invoice.js';

const BUCKET = 'staff-docs';
const DB = 'ff-folders', STORE = 'handles', KEY = 'staffRoot';
const FOLDER_HINT = 'iCloud Drive › FunFest › Staff';
const canPick = () => typeof window.showDirectoryPicker === 'function';
const fmtDay = ts => new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

// ── Remembered folder (IndexedDB) ─────────────────────────────

function idb(mode, fn) {
  return new Promise((ok, fail) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => fail(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => ok(req?.result);
      tx.onerror = () => fail(tx.error);
    };
  });
}
export const getRoot = () => idb('readonly', s => s.get(KEY)).catch(() => null);

export async function pickRoot() {
  try {
    const h = await window.showDirectoryPicker({ id: 'ff-staff', mode: 'readwrite', startIn: 'documents' });
    await idb('readwrite', s => s.put(h, KEY));
    return h;
  } catch (e) { if (e.name !== 'AbortError') toast(e.message); return null; }
}

export async function permission(h, ask) {
  let p = await h.queryPermission({ mode: 'readwrite' });
  if (p !== 'granted' && ask) { try { p = await h.requestPermission({ mode: 'readwrite' }); } catch { /* needs a click */ } }
  return p === 'granted';
}

// ── What needs copying ────────────────────────────────────────

async function pending() {
  const [{ data: docs, error: e1 }, { data: profiles, error: e2 }] = await Promise.all([
    sb.from('staff_documents').select('*').is('synced_at', null).order('uploaded_at'),
    sb.from('staff_profiles').select('*'),
  ]);
  if (e1 || e2) throw e1 || e2;
  const stale = (profiles || []).filter(p => !p.details_synced_at || new Date(p.updated_at) > new Date(p.details_synced_at));
  return { docs: docs || [], profiles: stale, allProfiles: profiles || [] };
}

// ── Card on the Staff tab ─────────────────────────────────────

// Automatic copying runs at most once per page load, so a file that keeps failing can't loop.
let autoTried = false;
let running = false;

export async function staffFilesCard(el, staffList) {
  el.innerHTML = `<h2>Staff files → iCloud</h2><p class="small muted">Checking…</p>`;
  let p;
  try { p = await pending(); }
  catch (e) {
    el.innerHTML = `<h2>Staff files → iCloud</h2><div class="msg warn small">${/staff_documents|staff_profiles|schema cache/i.test(e.message)
      ? 'Staff details aren’t set up in the database yet: run <code>supabase/004_staff_details.sql</code> in Supabase.' : esc(e.message)}</div>`;
    return;
  }
  const root = canPick() ? await getRoot() : null;
  const n = p.docs.length + p.profiles.length;
  el.innerHTML = `
    <h2>Staff files → iCloud</h2>
    <p class="small">${n ? `<b>${p.docs.length}</b> new upload${p.docs.length === 1 ? '' : 's'} and <b>${p.profiles.length}</b> updated detail${p.profiles.length === 1 ? '' : 's'} to copy.` : '✅ Everything is copied.'}</p>
    <p class="small muted">${!canPick() ? '⚠️ Copying into iCloud needs Chrome or Edge on the Mac.'
      : root ? `Folder: <b>${esc(root.name)}</b>${root.name === 'Staff' ? '' : ' <span class="pill warn">expected “Staff”</span>'}. Each person’s files go into their own folder (made if missing).`
      : `Choose <b>${FOLDER_HINT}</b> once.`}</p>
    <div style="display:flex;gap:.5rem;flex-wrap:wrap">
      ${canPick() ? `<button class="primary" id="sfSync" ${n ? '' : 'disabled'}>📁 Copy to iCloud now</button><button id="sfPick">${root ? 'Change folder…' : 'Choose folder…'}</button>` : ''}
    </div>
    <div id="sfLog" class="small"></div>`;
  const run = async (ask) => {
    if (running) return;
    let r = await getRoot();
    if (!r) { if (!ask) return; r = await pickRoot(); if (!r) return; }
    if (!(await permission(r, ask))) { if (ask) toast('Folder permission wasn’t given.'); return; }
    running = true;
    const log = el.querySelector('#sfLog');
    try { await syncAll(r, staffList, log); } finally { running = false; }
    const keep = log?.innerHTML || '';
    await staffFilesCard(el, staffList);
    const again = el.querySelector('#sfLog');
    if (again && keep) again.innerHTML = keep;   // keep the list of what was copied / what failed
  };
  el.querySelector('#sfPick')?.addEventListener('click', async () => { if (await pickRoot()) staffFilesCard(el, staffList); });
  el.querySelector('#sfSync')?.addEventListener('click', () => run(true));
  // Copy automatically when the folder is already allowed in this browser session
  if (n && !autoTried && !running && root && (await root.queryPermission({ mode: 'readwrite' })) === 'granted') {
    autoTried = true;
    run(false);
  }
}

async function syncAll(root, staffList, log) {
  const say = t => { if (log) log.insertAdjacentHTML('beforeend', `<div>${t}</div>`); };
  const { docs, profiles, allProfiles } = await pending();
  const dirs = [];
  for await (const [name, h] of root.entries()) if (h.kind === 'directory') dirs.push(name);
  const byId = Object.fromEntries(staffList.map(s => [s.id, s]));
  const profById = Object.fromEntries(allProfiles.map(p => [p.staff_id, p]));
  const folders = {};
  const folderFor = async (staffId) => {
    if (folders[staffId]) return folders[staffId];
    const s = byId[staffId], prof = profById[staffId];
    const name = prof?.folder_name || matchFolder(dirs, s?.name) || matchFolder(dirs, prof?.full_name) || safeName(s?.name || prof?.full_name || staffId);
    const h = await root.getDirectoryHandle(name, { create: true });
    if (!dirs.includes(name)) dirs.push(name);
    if (prof && prof.folder_name !== name) await sb.from('staff_profiles').update({ folder_name: name }).eq('staff_id', staffId);
    return (folders[staffId] = { h, name });
  };
  const exists = async (dir, n) => { try { await dir.getFileHandle(n); return true; } catch { return false; } };
  const write = async (dir, n, blob) => { const w = await (await dir.getFileHandle(n, { create: true })).createWritable(); await w.write(blob); await w.close(); };
  let ok = 0, bad = 0;

  for (const d of docs) {
    const person = byId[d.staff_id]?.name || profById[d.staff_id]?.full_name || 'Staff';
    try {
      const f = await folderFor(d.staff_id);
      const { data: blob, error } = await sb.storage.from(BUCKET).download(d.storage_path);
      if (error) throw error;
      let name = docFileName(d.kind, person, d.uploaded_at, d.file_name);
      for (let i = 2; await exists(f.h, name); i++) name = name.replace(/( \d+)?(\.[^.]+)$/, ` ${i}$2`);
      await write(f.h, name, blob);
      const { error: e2 } = await sb.from('staff_documents').update({ synced_at: new Date().toISOString(), synced_path: `${f.name}/${name}` }).eq('id', d.id);
      if (e2) throw e2;
      say(`✅ ${esc(f.name)}/${esc(name)}`); ok++;
    } catch (e) { say(`❌ ${esc(person)}: ${esc(d.kind)}: ${esc(e.message)}`); bad++; }
  }
  for (const p of profiles) {
    const person = byId[p.staff_id]?.name || p.full_name || 'Staff';
    try {
      const f = await folderFor(p.staff_id);
      const doc = await detailsPdf(p, person);
      const name = detailsFileName(person);
      await write(f.h, name, doc.output('blob'));
      const { error } = await sb.from('staff_profiles').update({ details_synced_at: new Date(Math.max(Date.now(), Date.parse(p.updated_at) || 0) + 1000).toISOString() }).eq('staff_id', p.staff_id);
      if (error) throw error;
      say(`✅ ${esc(f.name)}/${esc(name)}`); ok++;
    } catch (e) { say(`❌ ${esc(person)}: details: ${esc(e.message)}`); bad++; }
  }
  toast(bad ? `Copied ${ok}, ${bad} failed (see list)` : `Copied ${ok} file${ok === 1 ? '' : 's'} to iCloud ✓`, 6000);
}

// ── Details PDF for the staff folder ──────────────────────────

const PINK = [237, 0, 140], PURPLE = [125, 76, 158], INK = [44, 44, 44], GREY = [107, 104, 112];

export async function detailsPdf(p, person, deps = {}) {
  const JsPDF = deps.JsPDF || await loadJsPDF();
  const logo = deps.logo || await imageData(new URL('../shared/brand/fun-fest-logo.png', import.meta.url).href);
  const doc = new JsPDF({ unit: 'mm', format: 'a4' });
  const L = 18, R = 192, LW = 70;
  let y = 16;
  doc.addImage(logo, 'PNG', L, 10, 26, 19);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.setTextColor(...PINK);
  doc.text('Staff details', L + 32, 19);
  doc.setFontSize(13); doc.setTextColor(...INK); doc.text(person, L + 32, 26);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...GREY);
  doc.text(`Last updated ${fmtDay(p.updated_at)}${p.declared_at ? ` · Declaration signed ${fmtDay(p.declared_at)}` : ''}`, L + 32, 31);
  doc.setDrawColor(...PINK); doc.setLineWidth(0.5); doc.line(L, 35, R, 35);
  y = 43;
  const need = h => { if (y + h > 285) { doc.addPage(); y = 18; } };
  const filled = sec => sec.fields.some(([k]) => p[k] != null && p[k] !== '');
  for (const s of [...SECTIONS, ...OFFICE_SECTIONS.filter(filled)]) {
    need(14);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...PURPLE);
    doc.text(s.title, L, y); y += 5.5;
    for (const [k, label, type, x = {}] of s.fields) {
      if (x.showIf && p[x.showIf] !== true) continue;
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      const lab = doc.splitTextToSize(label, LW - 3);
      doc.setFont('helvetica', 'normal');
      const val = doc.splitTextToSize(String(displayValue(type, p[k]) || '—'), R - L - LW);
      const h = Math.max(lab.length, val.length) * 4.1 + 1.8;
      need(h);
      doc.setDrawColor(231, 227, 236); doc.setLineWidth(0.2); doc.line(L, y - 3.4, R, y - 3.4);
      doc.setFont('helvetica', 'bold'); doc.setTextColor(...GREY); doc.text(lab, L, y);
      doc.setFont('helvetica', 'normal'); doc.setTextColor(...INK); doc.text(val, L + LW, y);
      y += h;
    }
    y += 3;
  }
  return doc;
}

// ── Files already in the person's iCloud folder ──────────────

async function personFolder(s, prof, ask) {
  const root = canPick() ? await getRoot() : null;
  if (!root) return { error: canPick() ? 'Choose the Staff folder first (Staff tab › Staff files → iCloud).' : 'Needs Chrome or Edge on the Mac.' };
  if (!(await permission(root, ask))) return { error: 'Allow access to the Staff folder to list the files.', needsClick: true };
  const dirs = [];
  for await (const [name, h] of root.entries()) if (h.kind === 'directory') dirs.push(name);
  const name = prof?.folder_name || matchFolder(dirs, s.name) || matchFolder(dirs, prof?.full_name);
  if (!name || !dirs.includes(name)) return { error: `No folder for ${s.name} in ${root.name} yet.` };
  const dir = await root.getDirectoryHandle(name);
  const files = [];
  const walk = async (d, prefix, depth) => {
    for await (const [n, h] of d.entries()) {
      if (n.startsWith('.')) continue;
      if (h.kind === 'file') { const f = await h.getFile(); files.push({ path: prefix + n, h, size: f.size, modified: f.lastModified }); }
      else if (depth < 2) await walk(h, `${prefix}${n}/`, depth + 1);
    }
  };
  await walk(dir, '', 0);
  files.sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true }));
  return { name, files };
}

function folderHTML(r) {
  if (r.error) return `<p class="small muted">${esc(r.error)} ${r.needsClick ? '<button id="fAllow">Allow</button>' : ''}</p>`;
  if (!r.files.length) return `<p class="small muted">Folder <b>${esc(r.name)}</b> is empty.</p>`;
  const kb = b => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
  return `<p class="small muted">Staff › <b>${esc(r.name)}</b> · ${r.files.length} file${r.files.length === 1 ? '' : 's'}</p>
    <div class="table-wrap"><table class="small"><tr><th>File</th><th>Modified</th><th class="num">Size</th><th></th></tr>
    ${r.files.map((f, i) => `<tr><td>${esc(f.path)}</td><td>${fmtDay(f.modified)}</td><td class="num">${kb(f.size)}</td>
      <td><button data-fopen="${i}">Open</button></td></tr>`).join('')}</table></div>`;
}

const row = (k, v) => `<tr><th style="width:40%;font-weight:600">${esc(k)}</th><td>${v || '<span class="muted">—</span>'}</td></tr>`;

// ── Ask a staff member for their DBS Update Service renewal (expiry) date ──
// Sets dbs_renewal_requested_at (the staff app then shows a request on My details) and,
// optionally, emails them from the club's Google account through Gmail.
const APP_URL = new URL('../app/', location.href).href;
function clubSender() {
  try { return JSON.parse(localStorage.getItem('ff.invoice.club.northrichmond'))?.sendFrom || ''; } catch { return ''; }
}
function requestRenewal(dlg, s, p, done) {
  const to = [p?.personal_email, s.email].find(isEmail) || '';
  const from = clubSender();
  const m = renewalRequestEmail(p?.full_name || s.name, APP_URL);
  const box = document.createElement('div');
  box.className = 'card';
  box.innerHTML = `<form class="stack">
    <h3 style="margin:0">Request DBS Update Service renewal date from ${esc(s.name)}</h3>
    <p class="small muted">${esc(s.name.split(' ')[0])} will see the request on <b>My details</b> in the staff app until they add the date.</p>
    <label class="check"><input type="checkbox" name="mail" ${to ? 'checked' : ''}> <span>Also email it${from ? ` from <b>${esc(from)}</b>` : ''} through Gmail</span></label>
    <label>To<input name="to" type="email" value="${esc(to)}"></label>
    <label>Subject<input name="subject" value="${esc(m.subject)}"></label>
    <label>Message<textarea name="text" rows="11">${esc(m.text)}</textarea></label>
    <div class="msgs"></div>
    <div style="display:flex;gap:.5rem"><button class="primary">Send request</button><button type="button" id="rqX">Cancel</button></div>
  </form>`;
  const anchor = dlg.querySelector('#reqRenewal').closest('table');
  anchor.after(box);
  box.scrollIntoView({ block: 'nearest' });
  const form = box.querySelector('form');
  box.querySelector('#rqX').onclick = () => box.remove();
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const out = form.querySelector('.msgs');
    const btn = form.querySelector('button.primary');
    const mail = form.querySelector('[name=mail]').checked;
    const v = n => form.querySelector(`[name=${n}]`).value.trim();
    if (mail && !isEmail(v('to'))) { out.innerHTML = '<div class="msg bad">Enter a valid email address, or untick email.</div>'; return; }
    btn.disabled = true;
    try {
      if (mail) {
        const { token, email } = await gmailToken(from || undefined);   // first, while the click still counts (Google pop-up)
        await sendGmail({ token, from: from || email, fromName: 'Fun Fest', to: v('to'), subject: v('subject'), text: form.querySelector('[name=text]').value });
      }
      const { error } = await sb.from('staff_profiles').upsert(
        { staff_id: s.id, ...(p ? {} : { full_name: s.name }), dbs_renewal_requested_at: new Date().toISOString() }, { onConflict: 'staff_id' });
      if (error) throw error;
      toast(mail ? `Request emailed to ${v('to')} ✓` : 'Request added to their My details ✓', 5000);
      done();
    } catch (e) {
      btn.disabled = false;
      out.innerHTML = `<div class="msg bad">${esc(e.message)}</div>`;
    }
  };
}

// ── Per-person dialog (Staff tab › Details & files) ───────────

export async function openStaffDetails(dlg, s, ctx = {}) {
  dlg.innerHTML = '<p class="muted">Loading…</p>';
  dlg.style.maxWidth = '860px';
  dlg.addEventListener('close', () => { dlg.style.maxWidth = ''; }, { once: true });
  if (!dlg.open) dlg.showModal();
  const again = () => openStaffDetails(dlg, s, ctx);
  const [{ data: p, error: e1 }, { data: docs, error: e2 }] = await Promise.all([
    sb.from('staff_profiles').select('*').eq('staff_id', s.id).maybeSingle(),
    sb.from('staff_documents').select('*').eq('staff_id', s.id).order('uploaded_at', { ascending: false }),
  ]);
  if (e1 || e2) { dlg.innerHTML = `<div class="msg bad">${esc((e1 || e2).message)}</div><form method="dialog"><button>Close</button></form>`; return; }
  const status = { active: '<span class="pill ok">Active</span>', invited: '<span class="pill warn">Invited</span>', left: '<span class="pill bad">Left</span>' }[s.status] || '';
  const docRows = (docs || []).map(d => `<tr>
      <td>${esc(d.kind)}<div class="small muted">${esc(d.file_name)}</div></td>
      <td class="small">${fmtDay(d.uploaded_at)}</td>
      <td class="small">${d.synced_at ? '✅ ' + esc(d.synced_path || 'in iCloud') : '<span class="pill info">Not copied yet</span>'}</td>
      <td><div class="actions"><button data-open="${d.id}">View</button><button class="danger" data-del="${d.id}">Delete</button></div></td></tr>`).join('');
  const dbsLine = p?.dbs_certificate_number ? `${esc(p.dbs_certificate_number)}${p.dbs_issue_date ? ' · issued ' + esc(displayValue('date', p.dbs_issue_date)) : ''}` : '';
  dlg.innerHTML = `
    <div class="stack">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem">
        <h2 style="margin:0">${esc(s.name)} ${status}</h2>
        <form method="dialog" style="display:flex;gap:.4rem"><button type="button" id="pdf">⬇️ PDF</button><button>Close</button></form>
      </div>

      <h3>Summary</h3>
      <table class="small">
        ${row('Login email', esc(s.email))}
        ${row('Phone', esc(p?.phone || s.phone || ''))}
        ${row('Role', s.role === 'admin' ? 'Admin' : 'Staff')}
        ${row('Default venue', esc(ctx.siteName ? (s.default_site_id ? ctx.siteName(s.default_site_id) : '') : ''))}
        ${row('Hourly rate', s.hourly_rate ? '£' + Number(s.hourly_rate).toFixed(2) : '')}
        ${row('Date of birth', p?.date_of_birth ? esc(displayValue('date', p.date_of_birth)) : '<span class="muted">not given yet</span>')}
        ${row('Start date', p?.start_date ? esc(displayValue('date', p.start_date)) : '')}
        ${row('DBS certificate', dbsLine)}
        ${row('DBS Update Service', p?.dbs_update_service ? '✅ ' + esc(p.dbs_update_service_number || '') : p?.dbs_update_service === false ? 'Not registered' : '')}
        ${row('DBS status check', `${dbsStatusHTML(p || {})}<div style="margin-top:.3rem"><button type="button" id="dbsCheck" class="small">🔎 Check DBS status</button></div>`)}
        ${row('Update Service renewal date', `${p?.dbs_update_renewal_date ? esc(displayValue('date', p.dbs_update_renewal_date)) + (p.dbs_update_renewal_date < new Date().toISOString().slice(0, 10) ? ' <span class="pill bad">Lapsed</span>' : '') : '<span class="muted">not known</span>'}
          ${p?.dbs_renewal_requested_at ? `<div class="small muted">Requested ${fmtDay(p.dbs_renewal_requested_at)}${renewalRequestOpen(p) ? ' · waiting for reply' : ''}</div>` : ''}
          <div style="margin-top:.3rem"><button type="button" id="reqRenewal" class="small">📨 Request renewal date</button></div>`)}
        ${row('References received', [p?.ref1_received && '1: ' + displayValue('date', p.ref1_received), p?.ref2_received && '2: ' + displayValue('date', p.ref2_received)].filter(Boolean).map(esc).join(' · '))}
        ${row('Right to work checked', p?.right_to_work_checked_on ? esc(displayValue('date', p.right_to_work_checked_on)) : '')}
        ${row('Location consent', s.consent_location_at ? fmtDay(s.consent_location_at) : '')}
        ${row('Last sign-in', s.last_login_at ? fmtDay(s.last_login_at) : 'Never')}
        ${row('Details last updated', p ? fmtDay(p.updated_at) : 'Not filled in yet')}
      </table>

      <h3>Certificates uploaded in the app</h3>
      ${docRows ? `<div class="table-wrap"><table><tr><th>Document</th><th>Uploaded</th><th>iCloud</th><th></th></tr>${docRows}</table></div>` : '<p class="muted small">Nothing uploaded yet.</p>'}
      <details><summary class="small">Upload a document for ${esc(s.name)}</summary>
        <form id="aUp" class="row" style="margin-top:.6rem">
          <label>Type<select name="kind" required>${DOC_KINDS.map(k => `<option>${esc(k)}</option>`).join('')}</select></label>
          <label>File<input type="file" name="file" accept="application/pdf,image/*,.doc,.docx" required></label>
          <div><button class="primary">Upload</button></div>
        </form>
      </details>

      <h3>Staff file in iCloud</h3>
      <div id="fold">${canPick() ? '<p class="small muted">Loading…</p>' : '<p class="small muted">Needs Chrome or Edge on the Mac.</p>'}</div>
      <label class="small">iCloud folder name (under Staff)<input id="foldName" value="${esc(p?.folder_name || '')}" placeholder="${esc(s.name)} (found automatically)"></label>

      <div style="display:flex;justify-content:space-between;align-items:center"><h3 style="margin:0">Details from ${esc(s.name.split(' ')[0])}</h3><button id="editStaff">Edit</button></div>
      <div id="det">${p ? detailsViewHTML(p) : '<p class="muted small">Not filled in yet. They can do this in the staff app under <b>My details</b>.</p>'}</div>

      <div style="display:flex;justify-content:space-between;align-items:center"><h3 style="margin:0">Office record: references, employment, safeguarding</h3><button id="editOffice">Edit</button></div>
      <p class="small muted" style="margin-top:.2rem">Only admins can see and change these.</p>
      <div id="off">${detailsViewHTML(p || {}, OFFICE_SECTIONS)}</div>
    </div>`;

  // Files in iCloud
  const foldBox = dlg.querySelector('#fold');
  const showFolder = async (ask) => {
    if (!canPick()) return;
    let r;
    try { r = await personFolder(s, p, ask); } catch (e) { r = { error: e.message }; }
    foldBox.innerHTML = folderHTML(r);
    foldBox.querySelector('#fAllow')?.addEventListener('click', () => showFolder(true));
    foldBox.querySelectorAll('[data-fopen]').forEach(b => b.onclick = async () => {
      const f = await r.files[+b.dataset.fopen].h.getFile();
      const url = URL.createObjectURL(f);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    });
  };
  showFolder(false);

  dlg.querySelector('#reqRenewal').onclick = () => requestRenewal(dlg, s, p, again);
  dlg.querySelector('#dbsCheck').onclick = () => {
    const wrap = document.createElement('div');
    dlg.querySelector('#dbsCheck').closest('table').after(wrap);
    dbsCheckForm(wrap, [{ s, p: p || {} }], ctx.me, again);
  };

  dlg.querySelector('#pdf').onclick = async () => {
    const doc = await detailsPdf(p || { updated_at: new Date().toISOString() }, s.name);
    window.open(doc.output('bloburl'), '_blank');
  };
  dlg.querySelectorAll('[data-open]').forEach(b => b.onclick = async () => {
    const d = docs.find(x => x.id === b.dataset.open);
    const w = window.open('', '_blank');
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(d.storage_path, 300);
    if (error) { w?.close(); return toast(error.message); }
    if (w) w.location = data.signedUrl;
  });
  dlg.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    const d = docs.find(x => x.id === b.dataset.del);
    if (!window.confirm(`Delete “${d.kind}” from the app? ${d.synced_at ? 'The copy in iCloud is kept.' : 'It hasn’t been copied to iCloud yet.'}`)) return; // eslint-disable-line no-alert
    await sb.storage.from(BUCKET).remove([d.storage_path]);
    const { error } = await sb.from('staff_documents').delete().eq('id', d.id);
    toast(error ? error.message : 'Deleted'); again();
  });
  dlg.querySelector('#aUp').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target.file.files[0]; if (!f) return;
    const path = `${s.id}/${Date.now()}-${f.name.replace(/[^\w.-]+/g, '_').slice(-80)}`;
    const { error } = await sb.storage.from(BUCKET).upload(path, f, { contentType: f.type || undefined });
    if (error) return toast(error.message);
    const { error: e3 } = await sb.from('staff_documents').insert({ staff_id: s.id, kind: ev.target.kind.value, file_name: f.name, storage_path: path, size_bytes: f.size, mime_type: f.type || null });
    if (e3) { await sb.storage.from(BUCKET).remove([path]); return toast(e3.message); }
    toast('Uploaded'); again();
  };
  dlg.querySelector('#foldName').onchange = async (ev) => {
    const v = safeName(ev.target.value) || null;
    const { error } = await sb.from('staff_profiles').upsert({ staff_id: s.id, ...(p ? {} : { full_name: s.name }), folder_name: v }, { onConflict: 'staff_id' });
    toast(error ? error.message : 'Folder name saved');
    if (!error) again();
  };
  const editor = (boxSel, sections, fields) => () => {
    const box = dlg.querySelector(boxSel);
    box.innerHTML = `<form class="stack details-form">${detailsFormHTML(p || (fields ? {} : { full_name: s.name, phone: s.phone }), sections)}
      <div class="msgs"></div><div style="display:flex;gap:.5rem"><button class="primary">Save</button><button type="button" class="cancel">Cancel</button></div></form>`;
    const form = box.querySelector('form');
    wireDetailsForm(form);
    box.querySelector('.cancel').onclick = again;
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const data = readDetailsForm(form, fields);
      const { error } = await sb.from('staff_profiles').upsert({ staff_id: s.id, ...(p ? {} : { full_name: s.name }), ...data }, { onConflict: 'staff_id' });
      if (error) { box.querySelector('.msgs').innerHTML = `<div class="msg bad">${esc(error.message)}</div>`; return; }
      const warn = fields ? [] : checkDetails(data);
      toast(warn.length ? 'Saved. Check: ' + warn.join(' ') : 'Saved', 6000);
      again();
    };
  };
  dlg.querySelector('#editStaff').onclick = editor('#det', SECTIONS, undefined);
  dlg.querySelector('#editOffice').onclick = editor('#off', OFFICE_SECTIONS, OFFICE_FIELDS);
}
