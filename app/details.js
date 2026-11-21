// Staff app › "My details": staff keep their own details up to date and upload certificates.
// Details → staff_profiles; files → private Storage bucket "staff-docs" (<staff id>/…) + staff_documents.
// The office copies both into iCloud Drive › FunFest › Staff › <name> from the admin pages.

import { sb } from '../shared/supabase.js';
import { esc, toast } from '../shared/ui.js';
import { detailsFormHTML, wireDetailsForm, readDetailsForm, checkDetails, DOC_KINDS } from '../shared/staffdetails.js';

const BUCKET = 'staff-docs';
const MAX_MB = 15;

const fmtDay = ts => new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtSize = b => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');

export async function renderDetails(pane, me) {
  const [{ data: profile, error: e1 }, { data: docs, error: e2 }] = await Promise.all([
    sb.from('staff_profiles').select('*').eq('staff_id', me.id).maybeSingle(),
    sb.from('staff_documents').select('*').eq('staff_id', me.id).order('uploaded_at', { ascending: false }),
  ]);
  if (e1 || e2) {
    pane.innerHTML = `<div class="card msg bad">Couldn't load your details: ${esc((e1 || e2).message)}</div>`;
    return;
  }
  // First time: start from what the office already has
  const p = profile || { full_name: me.name, phone: me.phone, personal_email: me.email };

  pane.innerHTML = `
    <div class="card">
      <h2>Certificates &amp; documents</h2>
      <p class="small muted">Upload your DBS certificate, first aid, safeguarding and other certificates. Take a photo or choose a PDF. They go straight to the office.</p>
      <form id="up" class="stack">
        <label>What is it?<select name="kind" required>
          <option value="">Choose…</option>${DOC_KINDS.map(k => `<option>${esc(k)}</option>`).join('')}</select></label>
        <label>File or photo<input name="file" type="file" accept="application/pdf,image/*,.doc,.docx" required></label>
        <div><button class="primary">⬆️ Upload</button></div>
        <div id="upMsg"></div>
      </form>
      <div id="docList">${docListHTML(docs)}</div>
    </div>

    <div class="card">
      <h2>My details</h2>
      <p class="small muted">${profile ? `Last updated ${fmtDay(profile.updated_at)}.` : 'Please fill these in. You can save and come back later.'}
        Only you and the Fun Fest office can see them.</p>
      <form id="det" class="stack details-form">
        ${detailsFormHTML(p)}
        <div id="detMsg"></div>
        <div><button class="primary">💾 Save my details</button></div>
      </form>
    </div>`;

  // ── Upload ──
  const up = pane.querySelector('#up');
  up.onsubmit = async (ev) => {
    ev.preventDefault();
    const file = up.file.files[0];
    const kind = up.kind.value;
    const msg = up.querySelector('#upMsg');
    if (!file || !kind) return;
    if (file.size > MAX_MB * 1048576) { msg.innerHTML = `<div class="msg bad">That file is over ${MAX_MB} MB. Try a photo or a smaller PDF.</div>`; return; }
    const btn = up.querySelector('button');
    btn.disabled = true; msg.innerHTML = '<p class="small muted">Uploading…</p>';
    const clean = file.name.replace(/[^\w.-]+/g, '_').slice(-80) || 'file';
    const path = `${me.id}/${Date.now()}-${clean}`;
    try {
      const { error: upErr } = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || undefined, upsert: false });
      if (upErr) throw upErr;
      const { error: rowErr } = await sb.from('staff_documents').insert({
        staff_id: me.id, kind, file_name: file.name, storage_path: path, size_bytes: file.size, mime_type: file.type || null,
      });
      if (rowErr) { await sb.storage.from(BUCKET).remove([path]); throw rowErr; }
      toast('Uploaded ✓');
      renderDetails(pane, me);
    } catch (e) {
      btn.disabled = false;
      msg.innerHTML = `<div class="msg bad">Upload failed: ${esc(/mime|type/i.test(e.message) ? 'that type of file isn’t accepted. Use a PDF or a photo.' : e.message)}</div>`;
    }
  };
  wireDocList(pane, me, docs);

  // ── Details ──
  const form = pane.querySelector('#det');
  wireDetailsForm(form);
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const row = readDetailsForm(form);
    const warn = checkDetails(row);
    const out = form.querySelector('#detMsg');
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    const { error } = await sb.from('staff_profiles').upsert({ staff_id: me.id, ...row }, { onConflict: 'staff_id' });
    btn.disabled = false;
    if (error) { out.innerHTML = `<div class="msg bad">Couldn't save: ${esc(error.message)}</div>`; return; }
    out.innerHTML = warn.length
      ? `<div class="msg warn">Saved, but please check:<br>${warn.map(esc).join('<br>')}</div>`
      : '<div class="msg ok">Saved ✓ Thank you.</div>';
    toast('Details saved');
  };
}

function docListHTML(docs) {
  if (!docs?.length) return '<p class="muted small" style="margin-top:1rem">Nothing uploaded yet.</p>';
  return `<h3 style="margin-top:1rem">Uploaded</h3>` + docs.map(d => `
    <div class="shift-line">
      <div>
        <strong>${esc(d.kind)}</strong>
        <div class="small muted">${esc(d.file_name)} · ${fmtSize(d.size_bytes || 0)} · ${fmtDay(d.uploaded_at)}</div>
        <div>${d.synced_at ? '<span class="pill ok">Filed by the office</span>' : '<span class="pill info">Sent</span>'}</div>
      </div>
      <div style="text-align:right;display:flex;gap:.3rem;flex-direction:column">
        <button class="small" data-open="${d.id}">View</button>
        ${d.synced_at ? '' : `<button class="small" data-del="${d.id}">Remove</button>`}
      </div>
    </div>`).join('');
}

function wireDocList(pane, me, docs) {
  pane.querySelectorAll('[data-open]').forEach(b => b.onclick = async () => {
    const d = docs.find(x => x.id === b.dataset.open);
    const w = window.open('', '_blank');
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(d.storage_path, 300);
    if (error) { w?.close(); return toast(error.message); }
    if (w) w.location = data.signedUrl; else location.href = data.signedUrl;
  });
  pane.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    const d = docs.find(x => x.id === b.dataset.del);
    if (!window.confirm(`Remove “${d.kind}” (${d.file_name})?`)) return; // eslint-disable-line no-alert
    const { error: e1 } = await sb.storage.from(BUCKET).remove([d.storage_path]);
    if (e1) return toast(e1.message);
    const { error: e2 } = await sb.from('staff_documents').delete().eq('id', d.id);
    if (e2) return toast(e2.message);
    toast('Removed');
    renderDetails(pane, me);
  });
}
