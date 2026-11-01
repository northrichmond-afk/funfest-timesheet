import { sb, configured, signInWithGoogle, signOut, registerLogin, rpc } from '../shared/supabase.js';
import { calcEntry, fmtHours, decimalHours, localDate, localTime, londonDateTime, toCSV } from '../shared/hours.js';
import { GOOGLE_ICON, esc, toast, download } from '../shared/ui.js';

const view = document.getElementById('view');
const dlg = document.getElementById('dlg');
const APP_URL = new URL('../app/', location.href).href;

const state = { me: null, staff: [], sites: [], settings: {}, tab: 'today' };

// ── Date helpers (all dates are London-local YYYY-MM-DD strings) ──
const today = () => localDate(new Date());
const addDays = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const mondayOf = d => { const t = new Date(d + 'T12:00:00Z'); return addDays(d, -((t.getUTCDay() + 6) % 7)); };
const dayLabel = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const rangeTs = (from, to) => [londonDateTime(from, '00:00').toISOString(), londonDateTime(addDays(to, 1), '00:00').toISOString()];
const staffName = id => state.staff.find(s => s.id === id)?.name || '—';
const siteName = id => state.sites.find(s => s.id === id)?.name || '—';
const siteOptions = (sel, blank = false) =>
  (blank ? '<option value="">All venues</option>' : '') +
  state.sites.map(s => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)}${s.active ? '' : ' (inactive)'}</option>`).join('');
const staffOptions = (sel, blank = false) =>
  (blank ? '<option value="">All staff</option>' : '') +
  state.staff.filter(s => s.status !== 'left' || s.id === sel)
    .map(s => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)}</option>`).join('');

function statusPill(e) {
  const map = { open: 'info', closed: 'ok', approved: 'ok', flagged: 'warn' };
  const label = { open: 'On shift', closed: 'Closed', approved: 'Approved', flagged: 'Review' };
  return `<span class="pill ${map[e.status]}">${label[e.status]}</span>`;
}

function check(error) { if (error) { toast(error.message, 6000); throw error; } }

// ── Boot ──────────────────────────────────────────────────────

boot();

async function boot() {
  if (!configured) {
    view.innerHTML = `<div class="card msg warn">Not configured yet: add the Supabase URL and key to <code>shared/config.js</code>.</div>`;
    return;
  }
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    view.innerHTML = `
      <div class="card center stack" style="max-width:420px;margin:3rem auto">
        <h1>Admin sign in</h1>
        <p class="muted">Use the Fun Fest admin Google account.</p>
        <button class="google-btn" id="g">${GOOGLE_ICON} Sign in with Google</button>
      </div>`;
    document.getElementById('g').onclick = signInWithGoogle;
    return;
  }
  document.getElementById('signout').classList.remove('hidden');
  document.getElementById('signout').onclick = signOut;
  state.me = await registerLogin();
  if (!state.me || state.me.role !== 'admin') {
    view.innerHTML = `<div class="card msg bad">${esc(session.user.email)} doesn't have admin access. <a href="#" id="so">Sign out</a></div>`;
    document.getElementById('so').onclick = (e) => { e.preventDefault(); signOut(); };
    return;
  }
  document.getElementById('who').textContent = state.me.email;
  document.getElementById('nav').classList.remove('hidden');
  document.querySelectorAll('#nav button').forEach(b => b.onclick = () => go(b.dataset.tab));
  await loadRef();
  go(location.hash.slice(1) || 'today');
}

async function loadRef() {
  const [st, si, se, rq] = await Promise.all([
    sb.from('staff').select('*').order('name'),
    sb.from('sites').select('*').order('name'),
    sb.from('settings').select('*').single(),
    sb.from('correction_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
  ]);
  state.staff = st.data || []; state.sites = si.data || []; state.settings = se.data || {};
  const rc = document.getElementById('reqCount');
  rc.textContent = rq.count || ''; rc.classList.toggle('hidden', !rq.count);
}

function go(tab) {
  state.tab = tab;
  location.hash = tab;
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  view.innerHTML = '<p class="center muted">Loading…</p>';
  ({ today: tabToday, rota: tabRota, entries: tabEntries, requests: tabRequests, reports: tabReports,
     staff: tabStaff, sites: tabSites, settings: tabSettings }[tab] || tabToday)();
}

// ── Today ────────────────────────────────────────────────────

async function tabToday() {
  const d = today();
  const [from, to] = rangeTs(d, d);
  const [{ data: open }, { data: plans }, { data: done }] = await Promise.all([
    sb.from('time_entries').select('*').is('actual_end', null).order('actual_start'),
    sb.from('planned_shifts').select('*').eq('shift_date', d).order('expected_start'),
    sb.from('time_entries').select('*').gte('actual_start', from).lt('actual_start', to),
  ]);
  const startedIds = new Set((done || []).map(e => e.staff_id));
  const nowLocal = localTime(new Date());
  const notIn = (plans || []).filter(p => !startedIds.has(p.staff_id));

  view.innerHTML = `
    <div class="stats">
      <div class="stat"><div class="v">${open?.length || 0}</div><div class="k">On shift now</div></div>
      <div class="stat"><div class="v">${plans?.length || 0}</div><div class="k">Planned today</div></div>
      <div class="stat"><div class="v">${notIn.filter(p => p.expected_start.slice(0,5) < nowLocal).length}</div><div class="k">Late / not in yet</div></div>
    </div>
    <div class="card"><h2>On shift now</h2>
      ${open?.length ? `<table><tr><th>Staff</th><th>Venue</th><th>Started</th><th class="num">So far</th><th></th></tr>
        ${open.map(e => `<tr><td>${esc(staffName(e.staff_id))}</td><td>${esc(siteName(e.site_id))}</td>
          <td>${localDate(e.actual_start) === d ? '' : dayLabel(localDate(e.actual_start)) + ' '}${localTime(e.actual_start)}</td>
          <td class="num">${fmtHours(Math.round((Date.now() - new Date(e.actual_start)) / 60000))}</td>
          <td><div class="actions"><button data-edit="${e.id}">End / edit</button></div></td></tr>`).join('')}</table>`
        : '<p class="muted">Nobody is on shift.</p>'}
    </div>
    <div class="card"><h2>Planned but not started</h2>
      ${notIn.length ? `<table><tr><th>Staff</th><th>Venue</th><th>Expected</th><th></th></tr>
        ${notIn.map(p => `<tr><td>${esc(staffName(p.staff_id))}</td><td>${esc(siteName(p.site_id))}</td>
          <td>${p.expected_start.slice(0,5)}–${p.expected_end.slice(0,5)}</td>
          <td>${p.expected_start.slice(0,5) < nowLocal ? '<span class="pill bad">Late</span>' : ''}</td></tr>`).join('')}</table>`
        : '<p class="muted">Everyone planned today has started.</p>'}
    </div>`;
  view.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editEntry(open.find(e => e.id === b.dataset.edit), tabToday));
}

// ── Rota (expected shift times) ──────────────────────────────

let rotaWeek = mondayOf(today());
let rotaSite = null;

async function tabRota() {
  if (!state.sites.length) { view.innerHTML = `<div class="card msg warn">Add a venue first (Venues tab).</div>`; return; }
  rotaSite = rotaSite || state.sites.find(s => s.active)?.id || state.sites[0].id;
  const days = [...Array(7)].map((_, i) => addDays(rotaWeek, i));
  const { data: plans } = await sb.from('planned_shifts').select('*').gte('shift_date', days[0]).lte('shift_date', days[6]);
  const people = state.staff.filter(s => s.status !== 'left');
  const planOf = (sid, d) => (plans || []).find(p => p.staff_id === sid && p.shift_date === d);
  const { data: locks } = await sb.from('locked_periods').select('*');
  const locked = d => (locks || []).some(l => d >= l.period_start && d <= l.period_end);

  view.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <label>Venue<select id="site">${siteOptions(rotaSite)}</select></label>
        <label>Week starting<input type="date" id="week" value="${rotaWeek}"></label>
        <button id="prev">← Prev</button><button id="next">Next →</button>
        <button id="copy">Copy last week</button>
      </div>
      <div class="toolbar">
        <label>Template start<input type="time" id="tS" value="08:00"></label>
        <label>Template end<input type="time" id="tE" value="18:00"></label>
        <label>Break (mins)<input type="number" id="tB" value="30" min="0" style="width:90px"></label>
        <button id="fill">Fill Mon–Fri for everyone</button>
        <button id="clear" class="danger">Clear this venue's week</button>
      </div>
      <p class="muted small">Leave both times empty for no shift. Cells planned at another venue are shown greyed out.</p>
      <div class="table-wrap"><table class="rota">
        <tr><th>Staff</th><th>Break</th>${days.map(d => `<th>${dayLabel(d)}${locked(d) ? ' 🔒' : ''}</th>`).join('')}</tr>
        ${people.map(p => {
          const anyBreak = days.map(d => planOf(p.id, d)).find(x => x && x.site_id === rotaSite)?.unpaid_break_mins;
          return `<tr data-staff="${p.id}"><td class="name">${esc(p.name)}</td>
            <td><input type="number" class="brk" min="0" value="${anyBreak ?? state.settings.default_break ?? 30}" style="width:64px"></td>
            ${days.map(d => {
              const pl = planOf(p.id, d);
              if (pl && pl.site_id !== rotaSite) return `<td><div class="other">${esc(siteName(pl.site_id))}<br>${pl.expected_start.slice(0,5)}–${pl.expected_end.slice(0,5)}</div></td>`;
              const dis = locked(d) ? 'disabled' : '';
              return `<td><div class="cell" data-day="${d}">
                <input type="time" class="s" value="${pl ? pl.expected_start.slice(0,5) : ''}" ${dis}>
                <input type="time" class="e" value="${pl ? pl.expected_end.slice(0,5) : ''}" ${dis}></div></td>`;
            }).join('')}</tr>`;
        }).join('')}
      </table></div>
      <p><button class="primary" id="save">Save rota</button></p>
    </div>`;

  const $ = id => document.getElementById(id);
  $('site').onchange = e => { rotaSite = e.target.value; tabRota(); };
  $('week').onchange = e => { rotaWeek = mondayOf(e.target.value); tabRota(); };
  $('prev').onclick = () => { rotaWeek = addDays(rotaWeek, -7); tabRota(); };
  $('next').onclick = () => { rotaWeek = addDays(rotaWeek, 7); tabRota(); };
  $('fill').onclick = () => {
    view.querySelectorAll('tr[data-staff]').forEach(tr => {
      tr.querySelector('.brk').value = $('tB').value;
      tr.querySelectorAll('.cell').forEach((c, i) => {
        const idx = days.indexOf(c.dataset.day);
        if (idx < 5 && !c.querySelector('.s').disabled) { c.querySelector('.s').value = $('tS').value; c.querySelector('.e').value = $('tE').value; }
      });
    });
    toast('Filled. Clear any days people aren\'t working, then Save.');
  };
  $('clear').onclick = () => view.querySelectorAll('.cell input:not(:disabled)').forEach(i => i.value = '');
  $('copy').onclick = async () => {
    const prev = days.map(d => addDays(d, -7));
    const { data: last } = await sb.from('planned_shifts').select('*').eq('site_id', rotaSite).gte('shift_date', prev[0]).lte('shift_date', prev[6]);
    (last || []).forEach(p => {
      const d = addDays(p.shift_date, 7);
      const c = view.querySelector(`tr[data-staff="${p.staff_id}"] .cell[data-day="${d}"]`);
      if (c && !c.querySelector('.s').disabled) {
        c.querySelector('.s').value = p.expected_start.slice(0,5); c.querySelector('.e').value = p.expected_end.slice(0,5);
        c.closest('tr').querySelector('.brk').value = p.unpaid_break_mins;
      }
    });
    toast(`Copied ${last?.length || 0} shifts from last week. Review, then Save.`);
  };
  $('save').onclick = async (ev) => {
    ev.target.disabled = true;
    const upserts = [], deletes = [];
    let bad = 0;
    view.querySelectorAll('tr[data-staff]').forEach(tr => {
      const sid = tr.dataset.staff, brk = +tr.querySelector('.brk').value || 0;
      tr.querySelectorAll('.cell').forEach(c => {
        if (c.querySelector('.s').disabled) return;
        const s = c.querySelector('.s').value, e = c.querySelector('.e').value, d = c.dataset.day;
        const existing = planOf(sid, d);
        if (s && e) upserts.push({ staff_id: sid, site_id: rotaSite, shift_date: d, expected_start: s, expected_end: e, unpaid_break_mins: brk });
        else if (!s && !e) { if (existing) deletes.push(existing.id); }
        else bad++;
      });
    });
    if (bad) { toast(`${bad} cell(s) have only a start or only an end time.`); ev.target.disabled = false; return; }
    try {
      if (upserts.length) check((await sb.from('planned_shifts').upsert(upserts, { onConflict: 'staff_id,shift_date' })).error);
      if (deletes.length) check((await sb.from('planned_shifts').delete().in('id', deletes)).error);
      toast(`Rota saved (${upserts.length} shifts)`);
      tabRota();
    } catch { ev.target.disabled = false; }
  };
}

// ── Timesheets (actual times) ────────────────────────────────

const entryFilter = { from: mondayOf(today()), to: today(), staff: '', site: '', status: '' };

async function fetchEntries(f) {
  const [from, to] = rangeTs(f.from, f.to);
  let q = sb.from('time_entries').select('*, planned_shifts(*)').gte('actual_start', from).lt('actual_start', to).order('actual_start');
  if (f.staff) q = q.eq('staff_id', f.staff);
  if (f.site) q = q.eq('site_id', f.site);
  if (f.status) q = q.eq('status', f.status);
  const { data, error } = await q; check(error);
  return data || [];
}

async function tabEntries() {
  const f = entryFilter;
  const entries = await fetchEntries(f);
  const ids = entries.map(e => e.id);
  const { data: adj } = ids.length ? await sb.from('adjustments').select('time_entry_id').in('time_entry_id', ids) : { data: [] };
  const edited = new Set((adj || []).map(a => a.time_entry_id));

  view.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <label>From<input type="date" id="from" value="${f.from}"></label>
        <label>To<input type="date" id="to" value="${f.to}"></label>
        <label>Staff<select id="fs">${staffOptions(f.staff, true)}</select></label>
        <label>Venue<select id="fv">${siteOptions(f.site, true)}</select></label>
        <label>Status<select id="fst">
          ${['', 'open', 'closed', 'flagged', 'approved'].map(s => `<option value="${s}" ${s === f.status ? 'selected' : ''}>${s ? s[0].toUpperCase() + s.slice(1) : 'Any status'}</option>`).join('')}
        </select></label>
        <button class="primary" id="add">+ Add manual entry</button>
      </div>
      <div class="table-wrap"><table>
        <tr><th>Date</th><th>Staff</th><th>Venue</th><th>Planned</th><th>Start</th><th>End</th><th class="num">Paid</th><th>Status</th><th>Notes</th><th></th></tr>
        ${entries.map(e => {
          const c = calcEntry(e, e.planned_shifts, state.settings);
          const p = e.planned_shifts;
          return `<tr>
            <td>${dayLabel(localDate(e.actual_start))}</td>
            <td>${esc(staffName(e.staff_id))}</td><td>${esc(siteName(e.site_id))}</td>
            <td class="small muted">${p ? `${p.expected_start.slice(0,5)}–${p.expected_end.slice(0,5)}` : '—'}</td>
            <td>${localTime(e.actual_start)}${c.lateMins ? ` <span class="pill bad">+${c.lateMins}m</span>` : ''}</td>
            <td>${e.actual_end ? localTime(e.actual_end) : '…'}${c.earlyFinishMins ? ` <span class="pill warn">−${c.earlyFinishMins}m</span>` : ''}</td>
            <td class="num">${c.open ? '—' : fmtHours(c.paidMins)}</td>
            <td>${statusPill(e)}</td>
            <td class="small">${esc(e.flag_reason || '')}${edited.has(e.id) ? ' <span class="pill info">Edited</span>' : ''}${e.source === 'admin' ? ' <span class="pill info">Manual</span>' : ''}</td>
            <td><div class="actions">
              <button data-edit="${e.id}">Edit</button>
              ${e.actual_end && e.status !== 'approved' ? `<button data-ok="${e.id}">Approve</button>` : ''}
              <button data-hist="${e.id}">History</button>
            </div></td></tr>`;
        }).join('') || '<tr><td colspan="10" class="muted">No entries for these filters.</td></tr>'}
      </table></div>
      ${entries.some(e => e.status !== 'approved' && e.actual_end) ? '<p><button id="okAll">Approve all closed entries shown</button></p>' : ''}
    </div>`;

  const $ = id => document.getElementById(id);
  const refilter = () => { Object.assign(f, { from: $('from').value, to: $('to').value, staff: $('fs').value, site: $('fv').value, status: $('fst').value }); tabEntries(); };
  ['from', 'to', 'fs', 'fv', 'fst'].forEach(id => $(id).onchange = refilter);
  $('add').onclick = () => addEntry();
  view.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editEntry(entries.find(e => e.id === b.dataset.edit), tabEntries));
  view.querySelectorAll('[data-hist]').forEach(b => b.onclick = () => history(b.dataset.hist));
  view.querySelectorAll('[data-ok]').forEach(b => b.onclick = async () => {
    try { await rpc('admin_set_status', { p_entry: b.dataset.ok, p_status: 'approved', p_reason: 'Approved' }); tabEntries(); }
    catch (e) { toast(e.message); }
  });
  if ($('okAll')) $('okAll').onclick = async () => {
    const todo = entries.filter(e => e.status !== 'approved' && e.actual_end);
    if (!confirmBox(`Approve ${todo.length} entries?`)) return;
    for (const e of todo) { try { await rpc('admin_set_status', { p_entry: e.id, p_status: 'approved', p_reason: 'Bulk approved' }); } catch (x) { toast(x.message); break; } }
    tabEntries();
  };
}

function confirmBox(msg) { return window.confirm(msg); } // eslint-disable-line no-alert

function entryForm(title, e = {}, withStaff = false) {
  const sd = e.actual_start ? localDate(e.actual_start) : today();
  const ed = e.actual_end ? localDate(e.actual_end) : sd;
  return `
    <form method="dialog" class="stack">
      <h2>${title}</h2>
      ${withStaff ? `<div class="row">
          <label>Staff<select name="staff" required>${staffOptions(null)}</select></label>
          <label>Venue<select name="site" required>${siteOptions(null)}</select></label></div>`
        : `<p class="muted">${esc(staffName(e.staff_id))} · ${esc(siteName(e.site_id))}</p>`}
      <div class="row">
        <label>Start date<input type="date" name="sd" value="${sd}" required></label>
        <label>Start time<input type="time" name="st" value="${e.actual_start ? localTime(e.actual_start) : ''}" required></label>
      </div>
      <div class="row">
        <label>End date<input type="date" name="ed" value="${ed}"></label>
        <label>End time<input type="time" name="et" value="${e.actual_end ? localTime(e.actual_end) : ''}" ${withStaff ? 'required' : ''}></label>
      </div>
      <label>Reason for change (required, kept in the audit trail)<textarea name="reason" rows="2" required></textarea></label>
      <div id="dlgErr"></div>
      <div class="row"><button value="cancel" formnovalidate>Cancel</button><button class="primary" value="ok">Save</button></div>
    </form>`;
}

function readTimes(f) {
  const start = londonDateTime(f.get('sd'), f.get('st'));
  const end = f.get('et') ? londonDateTime(f.get('ed') || f.get('sd'), f.get('et')) : null;
  return [start.toISOString(), end?.toISOString() ?? null];
}

function editEntry(e, after) {
  dlg.innerHTML = entryForm('Edit shift times', e);
  dlg.showModal();
  dlg.querySelector('form').onsubmit = async (ev) => {
    if (ev.submitter?.value !== 'ok') return;
    ev.preventDefault();
    const f = new FormData(ev.target);
    const [s, en] = readTimes(f);
    try {
      await rpc('admin_update_entry', { p_entry: e.id, p_start: s, p_end: en, p_reason: f.get('reason') });
      dlg.close(); toast('Saved'); after();
    } catch (x) { document.getElementById('dlgErr').innerHTML = `<div class="msg bad">${esc(x.message)}</div>`; }
  };
}

function addEntry() {
  dlg.innerHTML = entryForm('Add manual entry', {}, true);
  dlg.showModal();
  dlg.querySelector('form').onsubmit = async (ev) => {
    if (ev.submitter?.value !== 'ok') return;
    ev.preventDefault();
    const f = new FormData(ev.target);
    const [s, en] = readTimes(f);
    try {
      await rpc('admin_add_entry', { p_staff: f.get('staff'), p_site: f.get('site'), p_start: s, p_end: en, p_reason: f.get('reason') });
      dlg.close(); toast('Entry added'); tabEntries();
    } catch (x) { document.getElementById('dlgErr').innerHTML = `<div class="msg bad">${esc(x.message)}</div>`; }
  };
}

async function history(entryId) {
  const { data } = await sb.from('adjustments').select('*').eq('time_entry_id', entryId).order('changed_at');
  const fmt = v => { if (!v) return '—'; const d = new Date(v); return isNaN(d) ? esc(v) : `${dayLabel(localDate(d))} ${localTime(d)}`; };
  dlg.innerHTML = `
    <form method="dialog" class="stack">
      <h2>Change history</h2>
      ${data?.length ? `<table><tr><th>When</th><th>By</th><th>Change</th><th>Reason</th></tr>
        ${data.map(a => `<tr><td class="small">${fmt(a.changed_at)}</td><td class="small">${esc(staffName(a.changed_by))}</td>
          <td class="small">${esc(a.field_changed)}: ${a.field_changed.startsWith('actual') ? `${fmt(a.old_value)} → ${fmt(a.new_value)}` : `${esc(a.old_value || '')} → ${esc(a.new_value || '')}`}</td>
          <td class="small">${esc(a.reason)}</td></tr>`).join('')}</table>`
        : '<p class="muted">No changes. This is the original record from the app.</p>'}
      <button value="close">Close</button>
    </form>`;
  dlg.showModal();
}

// ── Correction requests ──────────────────────────────────────

async function tabRequests() {
  const { data } = await sb.from('correction_requests')
    .select('*, time_entries(*)').order('created_at', { ascending: false }).limit(200);
  const pending = (data || []).filter(r => r.status === 'pending');
  const done = (data || []).filter(r => r.status !== 'pending').slice(0, 30);
  const row = r => `<tr>
    <td>${esc(staffName(r.staff_id))}</td>
    <td>${r.time_entries ? dayLabel(localDate(r.time_entries.actual_start)) : ''}</td>
    <td>${r.time_entries ? `${localTime(r.time_entries.actual_start)}–${localTime(r.time_entries.actual_end) || '…'}` : ''}</td>
    <td><strong>${r.requested_start ? localTime(r.requested_start) : '(same)'}–${r.requested_end ? localTime(r.requested_end) : '(same)'}</strong></td>
    <td class="small">${esc(r.note)}</td>
    <td>${r.status === 'pending'
      ? `<div class="actions"><button class="primary" data-a="${r.id}">Approve</button><button class="danger" data-r="${r.id}">Reject</button></div>`
      : `<span class="pill ${r.status === 'approved' ? 'ok' : 'bad'}">${r.status}</span>`}</td></tr>`;
  const head = '<tr><th>Staff</th><th>Date</th><th>Recorded</th><th>Requested</th><th>Reason</th><th></th></tr>';
  view.innerHTML = `
    <div class="card"><h2>Pending</h2>
      ${pending.length ? `<div class="table-wrap"><table>${head}${pending.map(row).join('')}</table></div>` : '<p class="muted">No pending requests.</p>'}
    </div>
    <div class="card"><h2>Recently resolved</h2>
      ${done.length ? `<div class="table-wrap"><table>${head}${done.map(row).join('')}</table></div>` : '<p class="muted">None yet.</p>'}
    </div>`;
  const act = async (id, approve) => {
    try { await rpc('admin_resolve_request', { p_request: id, p_approve: approve }); toast(approve ? 'Approved and times updated' : 'Rejected'); await loadRef(); tabRequests(); }
    catch (e) { toast(e.message); }
  };
  view.querySelectorAll('[data-a]').forEach(b => b.onclick = () => act(b.dataset.a, true));
  view.querySelectorAll('[data-r]').forEach(b => b.onclick = () => act(b.dataset.r, false));
}

// ── Reports ──────────────────────────────────────────────────

const repFilter = { from: addDays(mondayOf(today()), -7), to: addDays(mondayOf(today()), -1), site: '' };

async function tabReports() {
  const f = repFilter;
  const entries = await fetchEntries(f);
  const { data: plans } = await sb.from('planned_shifts').select('*').gte('shift_date', f.from).lte('shift_date', f.to);
  const { data: locks } = await sb.from('locked_periods').select('*').order('period_start', { ascending: false });
  const isLocked = (locks || []).some(l => l.period_start <= f.from && l.period_end >= f.to);

  const by = {};
  const get = id => (by[id] ??= { id, shifts: 0, planned: 0, paid: 0, late: 0, early: 0, flagged: 0, open: 0, unapproved: 0 });
  const detail = [];
  for (const e of entries) {
    const c = calcEntry(e, e.planned_shifts, state.settings);
    const r = get(e.staff_id);
    r.shifts++; r.paid += c.paidMins;
    if (c.lateMins) r.late++;
    if (c.earlyFinishMins) r.early++;
    if (e.status === 'flagged') r.flagged++;
    if (c.open) r.open++;
    if (e.status !== 'approved') r.unapproved++;
    detail.push({ e, c });
  }
  for (const p of plans || []) {
    if (f.site && p.site_id !== f.site) continue;
    get(p.staff_id).planned += (() => {
      const s = londonDateTime(p.shift_date, p.expected_start), en = londonDateTime(p.shift_date, p.expected_end);
      return Math.round((en - s) / 60000) - p.unpaid_break_mins;
    })();
  }
  // Planned shifts with no clock-in at all
  const noShows = (plans || []).filter(p => (!f.site || p.site_id === f.site) && p.shift_date < today() &&
    !entries.some(e => e.planned_shift_id === p.id));

  const rows = Object.values(by).sort((a, b) => staffName(a.id).localeCompare(staffName(b.id)));
  const totPaid = rows.reduce((s, r) => s + r.paid, 0);
  const rate = id => state.staff.find(s => s.id === id)?.hourly_rate;
  const totPay = rows.reduce((s, r) => s + (rate(r.id) ? (r.paid / 60) * rate(r.id) : 0), 0);
  const exceptions = detail.filter(({ e, c }) => e.status === 'flagged' || c.open || c.lateMins || c.earlyFinishMins);

  view.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <label>From<input type="date" id="from" value="${f.from}"></label>
        <label>To<input type="date" id="to" value="${f.to}"></label>
        <label>Venue<select id="fv">${siteOptions(f.site, true)}</select></label>
        <button id="thisw">This week</button><button id="lastw">Last week</button><button id="thism">This month</button>
      </div>
    </div>
    <div class="stats">
      <div class="stat"><div class="v">${decimalHours(totPaid)}</div><div class="k">Paid hours</div></div>
      <div class="stat"><div class="v">${entries.length}</div><div class="k">Shifts</div></div>
      <div class="stat"><div class="v">${exceptions.length + noShows.length}</div><div class="k">Exceptions</div></div>
      ${totPay ? `<div class="stat"><div class="v">£${totPay.toFixed(2)}</div><div class="k">Est. gross pay</div></div>` : ''}
    </div>
    <div class="card">
      <h2>Summary by staff</h2>
      <div class="table-wrap"><table>
        <tr><th>Staff</th><th class="num">Shifts</th><th class="num">Planned</th><th class="num">Paid</th><th class="num">Paid (dec)</th><th class="num">Variance</th><th class="num">Late</th><th class="num">Early finish</th><th class="num">To review</th>${totPay ? '<th class="num">Pay</th>' : ''}</tr>
        ${rows.map(r => `<tr><td>${esc(staffName(r.id))}</td><td class="num">${r.shifts}</td><td class="num">${fmtHours(r.planned)}</td>
          <td class="num"><strong>${fmtHours(r.paid)}</strong></td><td class="num">${decimalHours(r.paid)}</td>
          <td class="num">${r.planned ? fmtHours(r.paid - r.planned) : ''}</td><td class="num">${r.late || ''}</td><td class="num">${r.early || ''}</td>
          <td class="num">${r.unapproved ? `<span class="pill warn">${r.unapproved}</span>` : '<span class="pill ok">✓</span>'}</td>
          ${totPay ? `<td class="num">${rate(r.id) ? '£' + ((r.paid / 60) * rate(r.id)).toFixed(2) : ''}</td>` : ''}</tr>`).join('')
          || '<tr><td colspan="10" class="muted">No data for this period.</td></tr>'}
      </table></div>
      <p class="row" style="max-width:640px">
        <button id="csvSum">Download summary (CSV)</button>
        <button id="csvDet">Download all shifts (CSV)</button>
        <button id="print">Print</button>
      </p>
    </div>
    <div class="card">
      <h2>Exceptions</h2>
      ${exceptions.length || noShows.length ? `<div class="table-wrap"><table>
        <tr><th>Date</th><th>Staff</th><th>Issue</th></tr>
        ${exceptions.map(({ e, c }) => `<tr><td>${dayLabel(localDate(e.actual_start))}</td><td>${esc(staffName(e.staff_id))}</td><td class="small">${[
          c.open ? 'No end time' : '', c.lateMins ? `Late ${c.lateMins} min` : '', c.earlyFinishMins ? `Left ${c.earlyFinishMins} min early` : '',
          e.flag_reason || ''].filter(Boolean).map(esc).join(' · ')}</td></tr>`).join('')}
        ${noShows.map(p => `<tr><td>${dayLabel(p.shift_date)}</td><td>${esc(staffName(p.staff_id))}</td><td class="small">Planned ${p.expected_start.slice(0,5)}–${p.expected_end.slice(0,5)} but never clocked in</td></tr>`).join('')}
      </table></div>` : '<p class="muted">No exceptions.</p>'}
    </div>
    <div class="card">
      <h2>Lock pay period</h2>
      ${isLocked ? `<p class="msg ok">🔒 ${f.from} to ${f.to} is locked. Times can't be changed.</p>`
        : `<p class="muted">After payroll, lock this period so nobody can change its times or rota.</p>
           <button class="primary" id="lock" ${rows.some(r => r.unapproved) ? 'disabled title="Approve all entries first"' : ''}>Lock ${f.from} to ${f.to}</button>
           ${rows.some(r => r.unapproved) ? '<p class="small muted">Approve all entries in the Timesheets tab before locking.</p>' : ''}`}
    </div>`;

  const $ = id => document.getElementById(id);
  const set = (from, to) => { Object.assign(f, { from, to }); tabReports(); };
  $('from').onchange = () => set($('from').value, f.to);
  $('to').onchange = () => set(f.from, $('to').value);
  $('fv').onchange = () => { f.site = $('fv').value; tabReports(); };
  $('thisw').onclick = () => set(mondayOf(today()), addDays(mondayOf(today()), 6));
  $('lastw').onclick = () => set(addDays(mondayOf(today()), -7), addDays(mondayOf(today()), -1));
  $('thism').onclick = () => { const t = today(); const first = t.slice(0, 8) + '01';
    const next = new Date(first + 'T12:00:00Z'); next.setUTCMonth(next.getUTCMonth() + 1);
    set(first, addDays(next.toISOString().slice(0, 10), -1)); };
  $('print').onclick = () => window.print();
  $('csvSum').onclick = () => download(`funfest-hours-${f.from}-to-${f.to}.csv`, toCSV([
    ['Staff', 'Email', 'Shifts', 'Planned hours', 'Paid hours', 'Variance hours', 'Late count', 'Early finish count', 'Hourly rate', 'Gross pay'],
    ...rows.map(r => { const s = state.staff.find(x => x.id === r.id) || {};
      return [s.name, s.email, r.shifts, decimalHours(r.planned), decimalHours(r.paid), r.planned ? decimalHours(r.paid - r.planned) : '',
              r.late, r.early, s.hourly_rate ?? '', s.hourly_rate ? ((r.paid / 60) * s.hourly_rate).toFixed(2) : '']; }),
  ]));
  $('csvDet').onclick = () => download(`funfest-shifts-${f.from}-to-${f.to}.csv`, toCSV([
    ['Date', 'Staff', 'Email', 'Venue', 'Planned start', 'Planned end', 'Break mins', 'Actual start', 'Actual end', 'Paid hours', 'Status', 'Source', 'Notes'],
    ...detail.map(({ e, c }) => { const s = state.staff.find(x => x.id === e.staff_id) || {}; const p = e.planned_shifts;
      return [localDate(e.actual_start), s.name, s.email, siteName(e.site_id), p?.expected_start?.slice(0,5) ?? '', p?.expected_end?.slice(0,5) ?? '',
              c.breakMins, localTime(e.actual_start), localTime(e.actual_end), c.open ? '' : decimalHours(c.paidMins), e.status, e.source, e.flag_reason ?? '']; }),
  ]));
  if ($('lock')) $('lock').onclick = async () => {
    if (!confirmBox(`Lock ${f.from} to ${f.to}? Times in this period can no longer be edited.`)) return;
    const { error } = await sb.from('locked_periods').insert({ period_start: f.from, period_end: f.to, locked_by: state.me.id });
    if (error) toast(error.message); else { toast('Period locked'); tabReports(); }
  };
}

// ── Staff & onboarding ───────────────────────────────────────

async function tabStaff() {
  await loadRef();
  const pill = s => s.status === 'active' ? '<span class="pill ok">Active</span>' : s.status === 'invited' ? '<span class="pill warn">Invited</span>' : '<span class="pill bad">Left</span>';
  view.innerHTML = `
    <div class="card">
      <h2>Add staff</h2>
      <p class="muted small">Use the person's <strong>Google account email</strong>. Only emails on this list can sign in.</p>
      <form id="add" class="row">
        <label>Name<input name="name" required></label>
        <label>Google email<input name="email" type="email" required></label>
        <label>Phone<input name="phone"></label>
        <label>Default venue<select name="default_site_id"><option value="">—</option>${siteOptions(null)}</select></label>
        <label>Hourly rate £<input name="hourly_rate" type="number" step="0.01" min="0"></label>
        <label>Role<select name="role"><option value="staff">Staff</option><option value="admin">Admin</option></select></label>
        <div><button class="primary">Add</button></div>
      </form>
      <details><summary class="small">Bulk import (paste CSV)</summary>
        <p class="muted small">One person per line: <code>name,email,phone,hourly_rate</code></p>
        <textarea id="bulk" rows="5" placeholder="Jane Smith,jane@gmail.com,07700900000,12.50"></textarea>
        <p><button id="bulkGo">Import</button></p>
      </details>
    </div>
    <div class="card">
      <h2>Staff (${state.staff.filter(s => s.status !== 'left').length} current)</h2>
      <div class="table-wrap"><table>
        <tr><th>Name</th><th>Google email</th><th>Role</th><th>Venue</th><th class="num">Rate</th><th>Status</th><th>Location consent</th><th>Last sign-in</th><th></th></tr>
        ${state.staff.map(s => `<tr>
          <td>${esc(s.name)}</td><td class="small">${esc(s.email)}</td><td>${s.role === 'admin' ? '<span class="pill info">Admin</span>' : 'Staff'}</td>
          <td>${esc(s.default_site_id ? siteName(s.default_site_id) : '')}</td><td class="num">${s.hourly_rate ? '£' + s.hourly_rate : ''}</td>
          <td>${pill(s)}</td><td class="small">${s.consent_location_at ? '✓ ' + localDate(s.consent_location_at) : '—'}</td>
          <td class="small">${s.last_login_at ? dayLabel(localDate(s.last_login_at)) : 'Never'}</td>
          <td><div class="actions">
            ${s.status !== 'left' ? `<button data-inv="${s.id}">Invite</button>` : ''}
            <button data-ed="${s.id}">Edit</button>
          </div></td></tr>`).join('')}
      </table></div>
    </div>`;

  document.getElementById('add').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target));
    f.email = f.email.trim().toLowerCase();
    f.default_site_id ||= null; f.hourly_rate = f.hourly_rate ? +f.hourly_rate : null;
    const { data, error } = await sb.from('staff').insert(f).select().single();
    if (error) return toast(error.code === '23505' ? 'That email is already on the staff list' : error.message);
    toast(`${f.name} added`);
    await tabStaff();
    invite(data);
  };
  document.getElementById('bulkGo').onclick = async () => {
    const rows = document.getElementById('bulk').value.split('\n').map(l => l.split(',').map(x => x.trim())).filter(r => r[0] && r[1]);
    if (!rows.length) return;
    const { error } = await sb.from('staff').insert(rows.map(([name, email, phone, rate]) =>
      ({ name, email: email.toLowerCase(), phone: phone || null, hourly_rate: rate ? +rate : null })));
    toast(error ? error.message : `Imported ${rows.length} staff`);
    tabStaff();
  };
  view.querySelectorAll('[data-inv]').forEach(b => b.onclick = () => invite(state.staff.find(s => s.id === b.dataset.inv)));
  view.querySelectorAll('[data-ed]').forEach(b => b.onclick = () => editStaff(state.staff.find(s => s.id === b.dataset.ed)));
}

function inviteText(s) {
  return `Hi ${s.name.split(' ')[0]},

You've been added to the Fun Fest Timesheet app, which we use to record your shift times.

1. On your phone, open: ${APP_URL}
2. Tap "Sign in with Google" and choose ${s.email}
3. Read the location notice and tap Continue (allow location when asked)
4. Add the app to your home screen (instructions are on the page)

At work, tap Start shift when you arrive at the venue and End shift when you leave. Your location is only checked at those two moments.

Any problems, just let me know.

Fun Fest`;
}

function invite(s) {
  const text = inviteText(s);
  const mailto = `mailto:${encodeURIComponent(s.email)}?subject=${encodeURIComponent('Your Fun Fest Timesheet app')}&body=${encodeURIComponent(text)}`;
  const wa = s.phone ? `https://wa.me/${s.phone.replace(/\D/g, '').replace(/^0/, '44')}?text=${encodeURIComponent(text)}` : null;
  dlg.innerHTML = `
    <form method="dialog" class="stack">
      <h2>Invite ${esc(s.name)}</h2>
      <textarea rows="12" readonly>${esc(text)}</textarea>
      <div class="row">
        <a class="btn" href="${mailto}">Open in email</a>
        ${wa ? `<a class="btn" href="${wa}" target="_blank" rel="noopener">Send on WhatsApp</a>` : ''}
        <button type="button" id="cp">Copy text</button>
        <button value="close">Close</button>
      </div>
    </form>`;
  dlg.showModal();
  document.getElementById('cp').onclick = () => navigator.clipboard.writeText(text).then(() => toast('Copied'));
}

function editStaff(s) {
  dlg.innerHTML = `
    <form method="dialog" class="stack">
      <h2>Edit ${esc(s.name)}</h2>
      <label>Name<input name="name" value="${esc(s.name)}" required></label>
      <label>Google email<input name="email" type="email" value="${esc(s.email)}" required></label>
      <p class="small muted">Changing the email unlinks their current Google login; they'll sign in again with the new one.</p>
      <div class="row">
        <label>Phone<input name="phone" value="${esc(s.phone || '')}"></label>
        <label>Hourly rate £<input name="hourly_rate" type="number" step="0.01" value="${s.hourly_rate ?? ''}"></label>
      </div>
      <div class="row">
        <label>Default venue<select name="default_site_id"><option value="">—</option>${siteOptions(s.default_site_id)}</select></label>
        <label>Role<select name="role" ${s.id === state.me.id ? 'disabled' : ''}>
          <option value="staff" ${s.role === 'staff' ? 'selected' : ''}>Staff</option><option value="admin" ${s.role === 'admin' ? 'selected' : ''}>Admin</option></select></label>
        <label>Status<select name="status" ${s.id === state.me.id ? 'disabled' : ''}>
          ${['invited', 'active', 'left'].map(x => `<option value="${x}" ${s.status === x ? 'selected' : ''}>${x === 'left' ? 'Left (block sign-in)' : x[0].toUpperCase() + x.slice(1)}</option>`).join('')}</select></label>
      </div>
      <div class="row"><button value="cancel" formnovalidate>Cancel</button><button class="primary" value="ok">Save</button></div>
    </form>`;
  dlg.showModal();
  dlg.querySelector('form').onsubmit = async (ev) => {
    if (ev.submitter?.value !== 'ok') return;
    const f = Object.fromEntries(new FormData(ev.target));
    f.email = f.email.trim().toLowerCase();
    f.default_site_id ||= null; f.hourly_rate = f.hourly_rate ? +f.hourly_rate : null; f.phone ||= null;
    if (f.email !== s.email.toLowerCase()) f.auth_user_id = null;
    const { error } = await sb.from('staff').update(f).eq('id', s.id);
    toast(error ? error.message : 'Saved');
    tabStaff();
  };
}

// ── Venues (sites + geofences) ───────────────────────────────

async function tabSites() {
  await loadRef();
  view.innerHTML = `
    <div class="card">
      <h2>Venues</h2>
      <p class="muted small">Staff can only start a shift within the venue's radius. 150 m suits most schools and halls; increase it for large sites or poor GPS.</p>
      <div class="table-wrap"><table>
        <tr><th>Name</th><th>Address</th><th>Location</th><th class="num">Radius</th><th>Status</th><th></th></tr>
        ${state.sites.map(s => `<tr><td>${esc(s.name)}</td><td class="small">${esc(s.address || '')}</td>
          <td class="small"><a href="https://www.google.com/maps?q=${s.lat},${s.lng}" target="_blank" rel="noopener">${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}</a></td>
          <td class="num">${s.geofence_radius_m} m</td><td>${s.active ? '<span class="pill ok">Active</span>' : '<span class="pill bad">Inactive</span>'}</td>
          <td><button data-ed="${s.id}">Edit</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">No venues yet.</td></tr>'}
      </table></div>
      <p><button class="primary" id="add">+ Add venue</button></p>
    </div>`;
  document.getElementById('add').onclick = () => editSite({ geofence_radius_m: 150, active: true });
  view.querySelectorAll('[data-ed]').forEach(b => b.onclick = () => editSite(state.sites.find(s => s.id === b.dataset.ed)));
}

function editSite(s) {
  dlg.innerHTML = `
    <form method="dialog" class="stack">
      <h2>${s.id ? 'Edit venue' : 'Add venue'}</h2>
      <label>Name<input name="name" value="${esc(s.name || '')}" required placeholder="e.g. North Richmond"></label>
      <label>Address<input name="address" value="${esc(s.address || '')}"></label>
      <div class="row">
        <label>Latitude<input name="lat" type="number" step="any" value="${s.lat ?? ''}" required></label>
        <label>Longitude<input name="lng" type="number" step="any" value="${s.lng ?? ''}" required></label>
      </div>
      <p class="small muted">Stand at the venue entrance and tap <em>Use my location</em>, or in Google Maps right-click the spot and click the coordinates to copy them, then paste "lat, lng" into Latitude.</p>
      <div class="row">
        <button type="button" id="here">📍 Use my location</button>
        <label>Radius (m)<input name="geofence_radius_m" type="number" min="20" max="2000" value="${s.geofence_radius_m}" required></label>
        <label>Status<select name="active"><option value="true" ${s.active ? 'selected' : ''}>Active</option><option value="false" ${!s.active ? 'selected' : ''}>Inactive</option></select></label>
      </div>
      <div class="row"><button value="cancel" formnovalidate>Cancel</button><button class="primary" value="ok">Save</button></div>
    </form>`;
  dlg.showModal();
  const form = dlg.querySelector('form');
  form.lat.addEventListener('input', () => { // allow pasting "51.47, -0.30"
    const m = form.lat.value.match(/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/);
    if (m) { form.lat.value = m[1]; form.lng.value = m[2]; }
  });
  form.lat.type = 'text';
  document.getElementById('here').onclick = () => navigator.geolocation.getCurrentPosition(
    p => { form.lat.value = p.coords.latitude.toFixed(6); form.lng.value = p.coords.longitude.toFixed(6);
           toast(`Location set (accuracy ±${Math.round(p.coords.accuracy)} m)`); },
    e => toast(e.message), { enableHighAccuracy: true, timeout: 20000 });
  form.onsubmit = async (ev) => {
    if (ev.submitter?.value !== 'ok') return;
    const f = Object.fromEntries(new FormData(form));
    const row = { name: f.name, address: f.address || null, lat: +f.lat, lng: +f.lng,
                  geofence_radius_m: +f.geofence_radius_m, active: f.active === 'true' };
    if (isNaN(row.lat) || isNaN(row.lng)) return toast('Latitude/longitude must be numbers');
    const { error } = s.id ? await sb.from('sites').update(row).eq('id', s.id) : await sb.from('sites').insert(row);
    toast(error ? error.message : 'Venue saved');
    tabSites();
  };
}

// ── Settings ─────────────────────────────────────────────────

async function tabSettings() {
  const s = state.settings;
  const { data: locks } = await sb.from('locked_periods').select('*').order('period_start', { ascending: false });
  view.innerHTML = `
    <div class="card">
      <h2>Hours rules</h2>
      <form id="f" class="stack" style="max-width:480px">
        <label>Round paid time to nearest
          <select name="rounding_mins">${[0, 5, 10, 15, 30].map(m => `<option value="${m}" ${s.rounding_mins === m ? 'selected' : ''}>${m ? m + ' minutes' : 'No rounding (exact minutes)'}</option>`).join('')}</select></label>
        <label>Early arrival
          <select name="count_early_arrival">
            <option value="false" ${!s.count_early_arrival ? 'selected' : ''}>Pay from planned start time</option>
            <option value="true" ${s.count_early_arrival ? 'selected' : ''}>Pay from actual arrival time</option></select></label>
        <label>Count as late after (minutes)<input name="late_grace_mins" type="number" min="0" value="${s.late_grace_mins}"></label>
        <p class="small muted">Unpaid breaks come from each person's rota. Shifts with no rota entry are paid in full, actual start to end.</p>
        <div><button class="primary">Save rules</button></div>
      </form>
    </div>
    <div class="card">
      <h2>Locked pay periods</h2>
      ${locks?.length ? `<table><tr><th>From</th><th>To</th><th>Locked by</th><th>When</th><th></th></tr>
        ${locks.map(l => `<tr><td>${l.period_start}</td><td>${l.period_end}</td><td>${esc(staffName(l.locked_by))}</td><td class="small">${localDate(l.locked_at)}</td>
          <td><button class="danger" data-un="${l.id}">Unlock</button></td></tr>`).join('')}</table>`
        : '<p class="muted">None. Lock periods from the Reports tab after payroll.</p>'}
    </div>
    <div class="card small muted">
      Staff app link to share: <a href="${APP_URL}">${APP_URL}</a>
    </div>`;
  document.getElementById('f').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target));
    const row = { rounding_mins: +f.rounding_mins, count_early_arrival: f.count_early_arrival === 'true', late_grace_mins: +f.late_grace_mins };
    const { error } = await sb.from('settings').update(row).eq('id', 1);
    if (error) return toast(error.message);
    Object.assign(state.settings, row); toast('Saved');
  };
  view.querySelectorAll('[data-un]').forEach(b => b.onclick = async () => {
    if (!confirmBox('Unlock this period? Times will become editable again.')) return;
    const { error } = await sb.from('locked_periods').delete().eq('id', b.dataset.un);
    toast(error ? error.message : 'Unlocked'); tabSettings();
  });
}
