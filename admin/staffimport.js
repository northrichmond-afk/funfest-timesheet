// Admin › Staff › "Import from Staff folder": one-off import of existing staff files.
// Reads Staff/_Import/staff-import.json (prepared from the folder: names, login emails, details,
// and the list of files), lets the admin check it, then for each person: creates the staff
// record (status Invited, no email sent), fills in empty details, and uploads every listed file
// from their iCloud folder into the app, marked as already filed (so nothing is copied back).
// Running it again skips files that were already imported and never overwrites details.

import { sb } from '../shared/supabase.js';
import { esc, toast } from '../shared/ui.js';
import { getRoot, pickRoot, permission } from './stafffiles.js';

const BUCKET = 'staff-docs';
const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const isEmail = s => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(String(s || '').trim());

export function importCard(el, onDone) {
  el.innerHTML = `
    <details id="impBox"><summary><b>Import from Staff folder</b> <span class="small muted">(one-off: staff records, details and files from iCloud)</span></summary>
      <div class="stack" style="margin-top:.8rem">
        <p class="small muted">Reads <code>Staff/_Import/staff-import.json</code>, then creates each person (status <b>Invited</b>, no email sent),
          fills in their details where empty, and uploads every file from their folder into the app, marked as already in iCloud.</p>
        <div><button id="impLoad" class="primary">Load import file</button></div>
        <div id="impBody"></div>
      </div>
    </details>`;
  el.querySelector('#impLoad').onclick = () => load(el, onDone);
}

async function rootDir() {
  let root = await getRoot();
  if (!root) root = await pickRoot();
  if (!root) return null;
  if (!(await permission(root, true))) { toast('Folder permission wasn’t given.'); return null; }
  return root;
}

async function load(el, onDone) {
  const body = el.querySelector('#impBody');
  const root = await rootDir();
  if (!root) return;
  let data;
  try {
    const f = await (await (await root.getDirectoryHandle('_Import')).getFileHandle('staff-import.json')).getFile();
    data = JSON.parse(await f.text());
  } catch {
    body.innerHTML = `<div class="msg warn">No import file found at <b>${esc(root.name)}/_Import/staff-import.json</b>.</div>`;
    return;
  }
  const { data: staff } = await sb.from('staff').select('id,name,email,status');
  const { data: docs } = await sb.from('staff_documents').select('staff_id,synced_path');
  const done = new Set((docs || []).map(d => d.synced_path));
  const match = p => (staff || []).find(s => (p.email && norm(s.email) === norm(p.email)) || norm(s.name) === norm(p.name));
  const people = data.people || [];
  body.innerHTML = `
    <p class="small">${people.length} people, ${people.reduce((n, p) => n + p.files.length, 0)} files. ${esc(data.note || '')}</p>
    <div class="table-wrap"><table class="small" id="impT">
      <tr><th><input type="checkbox" id="impAll" checked></th><th>Name</th><th>Login email</th><th>Details</th><th class="num">Files</th><th>In the app</th></tr>
      ${people.map((p, i) => {
        const ex = match(p);
        const left = p.files.filter(f => !done.has(`${p.folder}/${f.path}`)).length;
        return `<tr data-i="${i}">
          <td><input type="checkbox" class="impSel" checked></td>
          <td>${esc(p.name)}${p.folder !== p.name ? `<div class="muted">folder: ${esc(p.folder)}</div>` : ''}</td>
          <td><input class="impEmail" type="email" value="${esc(ex?.email || p.email || '')}" ${ex ? 'disabled' : ''} placeholder="needed to create" style="min-width:220px"></td>
          <td>${Object.keys(p.profile || {}).length} fields</td>
          <td class="num">${left}${left !== p.files.length ? ` <span class="muted">of ${p.files.length}</span>` : ''}</td>
          <td>${ex ? `<span class="pill ok">Already added</span>` : '<span class="pill info">New</span>'}</td></tr>`;
      }).join('')}
    </table></div>
    <div style="display:flex;gap:.5rem;flex-wrap:wrap"><button class="primary" id="impGo">⬇️ Import selected</button>
      <button id="impDel">Delete the import file</button></div>
    <div id="impLog" class="small" style="max-height:320px;overflow:auto"></div>`;
  body.querySelector('#impAll').onchange = (ev) => body.querySelectorAll('.impSel').forEach(c => { c.checked = ev.target.checked; });
  body.querySelector('#impDel').onclick = async () => {
    if (!window.confirm('Delete _Import/staff-import.json from the Staff folder? It contains personal details.')) return; // eslint-disable-line no-alert
    try { await (await root.getDirectoryHandle('_Import')).removeEntry('staff-import.json'); toast('Import file deleted'); body.innerHTML = ''; }
    catch (e) { toast(e.message); }
  };
  body.querySelector('#impGo').onclick = async (ev) => {
    const btn = ev.target; btn.disabled = true;
    const log = body.querySelector('#impLog');
    const say = (t, cls = '') => { log.insertAdjacentHTML('beforeend', `<div class="${cls}">${t}</div>`); log.scrollTop = log.scrollHeight; };
    let made = 0, files = 0, failed = 0;
    for (const tr of body.querySelectorAll('#impT tr[data-i]')) {
      if (!tr.querySelector('.impSel').checked) continue;
      const p = people[+tr.dataset.i];
      const email = tr.querySelector('.impEmail').value.trim();
      try {
        // 1. Staff record
        let s = match({ ...p, email });
        if (!s) {
          if (!isEmail(email)) { say(`⏭ ${esc(p.name)}: skipped, no login email`); continue; }
          const { data: row, error } = await sb.from('staff').insert({ name: p.name, email, role: 'staff', status: 'invited' }).select().single();
          if (error) throw error;
          s = row; (staff || []).push(row); made++;
        }
        // 2. Details: only fill what is empty, never overwrite
        const { data: cur } = await sb.from('staff_profiles').select('*').eq('staff_id', s.id).maybeSingle();
        const fill = {};
        for (const [k, v] of Object.entries(p.profile || {})) if (cur?.[k] == null || cur?.[k] === '') fill[k] = v;
        if (!cur?.folder_name) fill.folder_name = p.folder;
        if (Object.keys(fill).length) {
          const { error } = await sb.from('staff_profiles').upsert({ staff_id: s.id, ...(cur ? {} : { full_name: p.name }), ...fill }, { onConflict: 'staff_id' });
          if (error) throw error;
        }
        // 3. Files, read from the person's iCloud folder
        let dir;
        try { dir = await root.getDirectoryHandle(p.folder); } catch { throw new Error(`folder “${p.folder}” not found`); }
        let n = 0;
        for (const f of p.files) {
          const synced = `${p.folder}/${f.path}`;
          if (done.has(synced)) continue;
          try {
            let d = dir;
            const parts = f.path.split('/');
            for (const seg of parts.slice(0, -1)) d = await d.getDirectoryHandle(seg);
            const file = await (await d.getFileHandle(parts.at(-1))).getFile();
            const clean = parts.at(-1).replace(/[^\w.-]+/g, '_').slice(-80) || 'file';
            const path = `${s.id}/imp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${clean}`;
            const { error: e1 } = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || 'application/octet-stream' });
            if (e1) throw e1;
            const { error: e2 } = await sb.from('staff_documents').insert({
              staff_id: s.id, kind: f.kind || 'Other', file_name: parts.at(-1), storage_path: path, size_bytes: file.size,
              mime_type: file.type || null, synced_at: new Date().toISOString(), synced_path: synced,
            });
            if (e2) { await sb.storage.from(BUCKET).remove([path]); throw e2; }
            done.add(synced); n++; files++;
          } catch (e) { failed++; say(`❌ ${esc(p.name)}: ${esc(f.path)}: ${esc(e.message)}`, 'bad'); }
        }
        say(`✅ ${esc(p.name)}: ${Object.keys(fill).length ? 'details filled, ' : ''}${n} file${n === 1 ? '' : 's'}`);
      } catch (e) { failed++; say(`❌ ${esc(p.name)}: ${esc(e.message)}`); }
    }
    say(`<b>Done: ${made} staff added, ${files} files uploaded${failed ? `, ${failed} problems (above)` : ''}.</b>`);
    toast(`Import finished: ${made} staff, ${files} files`, 7000);
    btn.disabled = false;
    onDone?.();
  };
}
