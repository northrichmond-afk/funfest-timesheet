// Admin › Staff: each person's details and uploaded certificates, and copying them into
// iCloud Drive › FunFest › Staff › <person's folder> on this Mac (File System Access API,
// Chrome/Edge). Uploaded files are written with clear names; the details are written as
// "Staff details - <name>.pdf" and refreshed whenever the person changes them.

import { sb } from '../shared/supabase.js';
import { esc, toast } from '../shared/ui.js';
import { detailsViewHTML, detailsFormHTML, wireDetailsForm, readDetailsForm, checkDetails, SECTIONS,
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
const getRoot = () => idb('readonly', s => s.get(KEY)).catch(() => null);

async function pickRoot() {
  try {
    const h = await window.showDirectoryPicker({ id: 'ff-staff', mode: 'readwrite', startIn: 'documents' });
    await idb('readwrite', s => s.put(h, KEY));
    return h;
  } catch (e) { if (e.name !== 'AbortError') toast(e.message); return null; }
}

async function permission(h, ask) {
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
    let r = await getRoot();
    if (!r) { if (!ask) return; r = await pickRoot(); if (!r) return; }
    if (!(await permission(r, ask))) { if (ask) toast('Folder permission wasn’t given.'); return; }
    await syncAll(r, staffList, el.querySelector('#sfLog'));
    staffFilesCard(el, staffList);
  };
  el.querySelector('#sfPick')?.addEventListener('click', async () => { if (await pickRoot()) staffFilesCard(el, staffList); });
  el.querySelector('#sfSync')?.addEventListener('click', () => run(true));
  // Copy automatically when the folder is already allowed in this browser session
  if (n && root && (await root.queryPermission({ mode: 'readwrite' })) === 'granted') run(false);
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
      const { error } = await sb.from('staff_profiles').update({ details_synced_at: new Date().toISOString() }).eq('staff_id', p.staff_id);
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
  for (const s of SECTIONS) {
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

// ── Per-person dialog (Staff tab › Details) ───────────────────

export async function openStaffDetails(dlg, s) {
  dlg.innerHTML = '<p class="muted">Loading…</p>';
  dlg.style.maxWidth = '760px';
  dlg.addEventListener('close', () => { dlg.style.maxWidth = ''; }, { once: true });
  if (!dlg.open) dlg.showModal();
  const [{ data: p, error: e1 }, { data: docs, error: e2 }] = await Promise.all([
    sb.from('staff_profiles').select('*').eq('staff_id', s.id).maybeSingle(),
    sb.from('staff_documents').select('*').eq('staff_id', s.id).order('uploaded_at', { ascending: false }),
  ]);
  if (e1 || e2) { dlg.innerHTML = `<div class="msg bad">${esc((e1 || e2).message)}</div><form method="dialog"><button>Close</button></form>`; return; }
  const docRows = (docs || []).map(d => `<tr>
      <td>${esc(d.kind)}<div class="small muted">${esc(d.file_name)}</div></td>
      <td class="small">${fmtDay(d.uploaded_at)}</td>
      <td class="small">${d.synced_at ? '✅ ' + esc(d.synced_path || 'in iCloud') : '<span class="pill info">Not copied yet</span>'}</td>
      <td><div class="actions"><button data-open="${d.id}">View</button><button class="danger" data-del="${d.id}">Delete</button></div></td></tr>`).join('');
  dlg.innerHTML = `
    <div class="stack">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem">
        <h2 style="margin:0">${esc(s.name)}</h2>
        <form method="dialog"><button>Close</button></form>
      </div>
      <h3>Certificates &amp; documents</h3>
      ${docRows ? `<div class="table-wrap"><table><tr><th>Document</th><th>Uploaded</th><th>iCloud</th><th></th></tr>${docRows}</table></div>` : '<p class="muted small">Nothing uploaded yet.</p>'}
      <details><summary class="small">Upload a document for ${esc(s.name)}</summary>
        <form id="aUp" class="row" style="margin-top:.6rem">
          <label>Type<select name="kind" required>${DOC_KINDS.map(k => `<option>${esc(k)}</option>`).join('')}</select></label>
          <label>File<input type="file" name="file" accept="application/pdf,image/*,.doc,.docx" required></label>
          <div><button class="primary">Upload</button></div>
        </form>
      </details>
      <label>iCloud folder name (under Staff)<input id="fold" value="${esc(p?.folder_name || '')}" placeholder="${esc(s.name)} (found automatically)"></label>
      <div style="display:flex;justify-content:space-between;align-items:center"><h3 style="margin:0">Details</h3>
        ${p ? `<span class="small muted">Updated ${fmtDay(p.updated_at)}</span>` : ''}<button id="edit">Edit</button></div>
      <div id="det">${p ? detailsViewHTML(p) : '<p class="muted">Not filled in yet. The person can do this in the staff app under <b>My details</b>.</p>'}</div>
    </div>`;
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
    toast(error ? error.message : 'Deleted'); openStaffDetails(dlg, s);
  });
  dlg.querySelector('#aUp').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target.file.files[0]; if (!f) return;
    const path = `${s.id}/${Date.now()}-${f.name.replace(/[^\w.-]+/g, '_').slice(-80)}`;
    const { error } = await sb.storage.from(BUCKET).upload(path, f, { contentType: f.type || undefined });
    if (error) return toast(error.message);
    const { error: e3 } = await sb.from('staff_documents').insert({ staff_id: s.id, kind: ev.target.kind.value, file_name: f.name, storage_path: path, size_bytes: f.size, mime_type: f.type || null });
    if (e3) { await sb.storage.from(BUCKET).remove([path]); return toast(e3.message); }
    toast('Uploaded'); openStaffDetails(dlg, s);
  };
  dlg.querySelector('#fold').onchange = async (ev) => {
    const v = safeName(ev.target.value) || null;
    const { error } = await sb.from('staff_profiles').upsert({ staff_id: s.id, ...(p ? {} : { full_name: s.name }), folder_name: v }, { onConflict: 'staff_id' });
    toast(error ? error.message : 'Folder name saved');
  };
  dlg.querySelector('#edit').onclick = () => {
    const box = dlg.querySelector('#det');
    box.innerHTML = `<form id="ef" class="stack details-form">${detailsFormHTML(p || { full_name: s.name, phone: s.phone })}
      <div id="efMsg"></div><div style="display:flex;gap:.5rem"><button class="primary">Save</button><button type="button" id="efCancel">Cancel</button></div></form>`;
    const form = box.querySelector('#ef');
    wireDetailsForm(form);
    box.querySelector('#efCancel').onclick = () => openStaffDetails(dlg, s);
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const row = readDetailsForm(form);
      const { error } = await sb.from('staff_profiles').upsert({ staff_id: s.id, ...row }, { onConflict: 'staff_id' });
      if (error) { box.querySelector('#efMsg').innerHTML = `<div class="msg bad">${esc(error.message)}</div>`; return; }
      const warn = checkDetails(row);
      toast(warn.length ? 'Saved. Check: ' + warn.join(' ') : 'Saved', 6000);
      openStaffDetails(dlg, s);
    };
  };
}
