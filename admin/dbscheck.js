// DBS Update Service status checks (admin). The database function dbs_status_check() calls the DBS
// web service and records the result (migration 011). Used from the staff sheet and Reports › Critical info.

import { sb } from '../shared/supabase.js';
import { esc } from '../shared/ui.js';
import { DBS_STATUS, dbsCheckBlocker } from '../shared/staffdetails.js';

const LS = 'ff.dbscheck';
const settings = () => { try { return { organisation: 'Vadivu Fun Fest Club Ltd', forename: '', surname: '', ...JSON.parse(localStorage.getItem(LS) || '{}') }; } catch { return { organisation: 'Vadivu Fun Fest Club Ltd', forename: '', surname: '' }; } };
const save = v => { try { localStorage.setItem(LS, JSON.stringify(v)); } catch { /* private mode */ } };

const fmtWhen = ts => new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** Status pill + date for a profile, for tables. */
export function dbsStatusHTML(p = {}) {
  if (!p.dbs_status) return '<span class="muted">not checked</span>';
  const st = DBS_STATUS[p.dbs_status] || { label: p.dbs_status, cls: 'warn' };
  return `<span class="pill ${st.cls}">${esc(st.label)}</span><div class="small muted">checked ${fmtWhen(p.dbs_status_checked_at)}</div>
    ${p.dbs_status_detail && p.dbs_status !== 'NO_MATCH' ? `<div class="small muted">${esc(p.dbs_status_detail)}</div>` : ''}`;
}

const norm = x => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z\s-]/g, '').trim();
const fmtDate = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Name and print date the DBS returned on the last check, with mismatch warnings. */
export function dbsCheckDetailsHTML(check, p = {}, staffName = '') {
  if (!check || (!check.forename && !check.surname && !check.print_date)) return '';
  const ours = norm(p.full_name || staffName).split(/\s+/).filter(Boolean);
  const theirs = norm(`${check.forename || ''} ${check.surname || ''}`).split(/\s+/).filter(Boolean);
  const nameOk = !theirs.length || (ours[0] === theirs[0] && ours.at(-1) === theirs.at(-1));
  const dateOk = !check.print_date || !p.dbs_issue_date || check.print_date === p.dbs_issue_date;
  return `<div class="small" style="margin-top:.3rem">
    ${theirs.length ? `<div>Name on certificate: <b>${esc([check.forename, check.surname].filter(Boolean).join(' '))}</b>
      ${nameOk ? '' : ` <span class="pill warn">Doesn’t match ${esc(p.full_name || staffName)}</span>`}</div>` : ''}
    ${check.print_date ? `<div>Certificate print date: <b>${fmtDate(check.print_date)}</b>
      ${dateOk ? '' : ` <span class="pill warn">Details say issued ${fmtDate(p.dbs_issue_date)}</span>`}</div>` : ''}
    ${check.certificate_number ? `<div class="muted">Certificate ${esc(check.certificate_number)} · checked by ${esc(check.checker_name || '')}</div>` : ''}
  </div>`;
}

export async function runDbsCheck(staffId, cfg, surname) {
  const { data, error } = await sb.rpc('dbs_status_check', {
    p_staff: staffId, p_organisation: cfg.organisation, p_checker_forename: cfg.forename, p_checker_surname: cfg.surname,
    p_consent: true, p_surname: surname || null,
  });
  if (error) throw new Error(/function .*dbs_status_check|schema cache/i.test(error.message)
    ? 'DBS status checks aren’t set up in the database yet: run supabase/011_dbs_status_check.sql in Supabase.' : error.message);
  return data;
}

/**
 * Inline form: organisation, who is checking, consent, then runs the checks one by one.
 * people = [{ s, p }]. Calls done() when finished.
 */
export function dbsCheckForm(container, people, me, done) {
  const cfg = settings();
  if (!cfg.forename && me?.name) { const parts = me.name.trim().split(/\s+/); cfg.forename = parts[0]; cfg.surname = parts.length > 1 ? parts.at(-1) : ''; }
  const ready = people.filter(x => !dbsCheckBlocker(x.p));
  const blocked = people.filter(x => dbsCheckBlocker(x.p));
  const single = people.length === 1;
  const box = document.createElement('div');
  box.className = 'card';
  box.innerHTML = `<form class="stack">
    <h3 style="margin:0">🔎 DBS Update Service status check${single ? `: ${esc(people[0].s.name)}` : ''}</h3>
    <p class="small muted">Checks with the DBS whether ${single ? 'this certificate is' : 'each certificate is'} still current. The DBS doesn’t share the subscription renewal date.
      Each check is shown to the person in their Update Service account.</p>
    ${blocked.length ? `<div class="msg warn small">${single ? esc(dbsCheckBlocker(people[0].p)) + '. Add it first (date of birth: ask them to add it under My details).'
      : `Can’t check ${blocked.length}: ${blocked.map(x => `${esc(x.s.name)} (${esc(dbsCheckBlocker(x.p).toLowerCase())})`).join(', ')}.`}</div>` : ''}
    ${ready.length ? `
    <div class="row">
      <label>Organisation name<input name="organisation" required value="${esc(cfg.organisation)}"></label>
      <label>Your forename<input name="forename" required value="${esc(cfg.forename)}"></label>
      <label>Your surname<input name="surname" required value="${esc(cfg.surname)}"></label>
    </div>
    ${single ? `<label>Their surname as on the certificate<input name="their_surname" value="${esc(String(people[0].p.full_name || people[0].s.name).trim().split(/\s+/).at(-1))}"></label>` : ''}
    <label class="check"><input type="checkbox" name="consent" required> <span>${single ? `I have ${esc(people[0].s.name.split(' ')[0])}’s consent` : `I have the consent of ${ready.length === 1 ? 'this person' : `all ${ready.length} people`}`} to check their DBS status on the Update Service.</span></label>
    <div class="msgs"></div>
    <div style="display:flex;gap:.5rem"><button class="primary">Check ${single ? 'now' : `${ready.length} ${ready.length === 1 ? 'person' : 'people'}`}</button><button type="button" class="x">Cancel</button></div>`
    : '<div style="display:flex;gap:.5rem"><button type="button" class="x">Close</button></div>'}
  </form>`;
  container.prepend(box);
  box.scrollIntoView?.({ block: 'nearest' });
  const form = box.querySelector('form');
  box.querySelector('.x').onclick = () => box.remove();
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const v = n => form.querySelector(`[name=${n}]`)?.value.trim();
    const c = { organisation: v('organisation'), forename: v('forename'), surname: v('surname') };
    save(c);
    const out = form.querySelector('.msgs');
    const btn = form.querySelector('button.primary'); btn.disabled = true;
    const lines = [];
    for (const [i, x] of ready.entries()) {
      out.innerHTML = `<p class="small muted">Checking ${i + 1} of ${ready.length}: ${esc(x.s.name)}…</p>${lines.join('')}`;
      try {
        const r = await runDbsCheck(x.s.id, c, single ? v('their_surname') : null);
        const st = DBS_STATUS[r.status] || { label: r.status, cls: 'warn' };
        lines.push(`<div class="small">${esc(x.s.name)}: <span class="pill ${st.cls}">${esc(st.label)}</span>${r.detail ? ` <span class="muted">${esc(r.detail)}</span>` : ''}</div>`);
      } catch (e) {
        lines.push(`<div class="small">${esc(x.s.name)}: <span class="pill bad">${esc(e.message)}</span></div>`);
        if (/set up in the database|Only admins/.test(e.message)) break;
      }
    }
    out.innerHTML = `<p class="small"><b>Done.</b></p>${lines.join('')}`;
    btn.remove();
    box.querySelector('.x').textContent = 'Close';
    box.querySelector('.x').onclick = () => { box.remove(); done?.(); };
  };
}
