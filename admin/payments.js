// Admin › Payments: reconcile booking payments.
//   WooCommerce orders (both sites) ← the database fetches them daily; "Refresh orders" here too
//   PonchoPay payments + payouts    ← "Fun Fest sync" bookmark run on pay.ponchopay.com
//   HSBC bank transactions           ← CSVs in iCloud › FunFest › Accounts › Business Bank Account
// Matching rules: shared/recon.js.

import { sb } from '../shared/supabase.js';
import { esc, toast, download } from '../shared/ui.js';
import { toCSV } from '../shared/hours.js';
import { SITES, STATUS, csvRow, reconcile, parseHsbcCsv, mergeBank, compactPonchoPayment, compactPonchoPayout } from '../shared/recon.js';
import { conn, CLUBS } from './invoice.js';

const ADMIN_ORIGIN = location.origin;
const PP_ORIGIN = 'https://pay.ponchopay.com';
const DB = 'ff-folders', STORE = 'handles', KEY = 'bankRoot';
const BANK_HINT = 'iCloud Drive › FunFest › Accounts › Business Bank Account';
const canPick = () => typeof window.showDirectoryPicker === 'function';
const fmtD = d => (d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
const fmtWhen = ts => (ts ? new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never');
const gbp = v => '£' + Number(v || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const addDays = (iso, n) => { const d = new Date(String(iso).slice(0, 10) + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const SCHEME = { card: 'Card', 'tax-free-childcare': 'Tax-Free Childcare', 'childcare-voucher': 'Voucher' };

const filter = { site: '', status: 'problems', q: '', bank: '' };

// Bank search: plain text matches anywhere ("WIG" finds "NATIONAL SAVINGS A SWIG97510");
// * = any characters, ? = one character; a number also matches the amount
export function bankMatcher(q) {
  q = String(q || '').trim();
  if (!q) return null;
  const re = new RegExp(q.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.'), 'i');
  const num = /^£?-?\d+(\.\d{1,2})?$/.test(q) ? Math.abs(+q.replace('£', '')) : null;
  return t => re.test(t.description || '') || re.test(t.date || '') || (num != null && Math.abs(Math.abs(t.amount) - num) < 0.005);
}

// A PonchoPay payments export (CSV) to check against the bank: kept in this browser
const PP_EXPORT_KEY = 'ff-pp-export';
const loadExport = () => { try { return JSON.parse(localStorage.getItem(PP_EXPORT_KEY) || 'null'); } catch { return null; } };
function parsePonchoExport(text, name) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  const head = csvRow(lines[0] || '').map(h => h.trim().toLowerCase());
  const ix = k => head.indexOf(k);
  if (ix('reference') < 0) throw new Error('That file has no "reference" column: use PonchoPay’s payments export.');
  const payments = lines.slice(1).map(csvRow).map(c => ({
    reference: c[ix('reference')], email: c[ix('user')] || '', amount: +c[ix('amount')] || 0, location: c[ix('location')] || '',
    created: (c[ix('created_date')] || '').slice(0, 10), method: c[ix('payment_method')] || '', inBank: c[ix('in_bank_date')] || '',
  })).filter(p => /^PP-/.test(p.reference || ''));
  return { name, at: new Date().toISOString(), payments };
}
// Is each exported payment in the bank, going by the reconciliation?
function checkExport(exp, res) {
  const subsByRef = new Map(); const rowByRef = new Map();
  for (const r of res.rows) for (const s of r.subs) {
    if (!s.reference) continue;
    subsByRef.set(s.reference, [...(subsByRef.get(s.reference) || []), s]); rowByRef.set(s.reference, r);
  }
  return exp.payments.map(p => {
    const subs = subsByRef.get(p.reference);
    const row = rowByRef.get(p.reference);
    const inBank = !!subs && subs.every(s => s.state === 'received' || s.state === 'refunded');
    const credit = subs?.flatMap(s => s.credits || [])[0]?.credit;
    return { ...p, row, found: !!row, inBank, bankDate: credit?.date || null };
  });
}
let ctxRef = null;

// ── Remembered bank folder (IndexedDB) ────────────────────────
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
const getBankRoot = () => idb('readonly', s => s.get(KEY)).catch(() => null);
async function pickBankRoot() {
  try {
    const h = await window.showDirectoryPicker({ id: 'ff-bank', mode: 'read', startIn: 'documents' });
    await idb('readwrite', s => s.put(h, KEY));
    return h;
  } catch (e) { if (e.name !== 'AbortError') toast(e.message); return null; }
}
async function canRead(h, ask) {
  let p = await h.queryPermission({ mode: 'read' });
  if (p !== 'granted' && ask) { try { p = await h.requestPermission({ mode: 'read' }); } catch { /* needs a click */ } }
  return p === 'granted';
}
async function* csvFiles(dir, path = '') {
  for await (const [name, h] of dir.entries()) {
    if (h.kind === 'directory') yield* csvFiles(h, `${path}${name}/`);
    else if (/\.csv$/i.test(name)) yield [`${path}${name}`, h];
  }
}

// ── Saving in batches ─────────────────────────────────────────
async function upsertAll(table, rows, onConflict) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from(table).upsert(rows.slice(i, i + 500), { onConflict });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
  return rows.length;
}
// PostgREST returns at most 1000 rows a time
async function selectAll(table, cols, apply = q => q) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await apply(sb.from(table).select(cols)).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

// ── Sources ───────────────────────────────────────────────────

async function readBank(ask) {
  const root = canPick() ? await getBankRoot() : null;
  if (!root || !(await canRead(root, ask))) return null;
  const lists = []; const bad = [];
  for await (const [path, h] of csvFiles(root)) {
    try { lists.push(parseHsbcCsv(await (await h.getFile()).text(), path)); } catch (e) { bad.push(e.message); }
  }
  const rows = mergeBank(...lists).map(t => ({ id: t.id, date: t.date, type: t.type || null, description: t.description, amount: t.amount, source: t.source }));
  await upsertAll('bank_tx', rows, 'id');
  await sb.from('recon_settings').update({ bank_synced_at: new Date().toISOString() }).eq('id', 1);
  return { files: lists.length, rows: rows.length, bad };
}

async function refreshOrders(settings, onProgress) {
  const since = settings.woo_synced_at ? new Date(new Date(settings.woo_synced_at) - 3 * 86400000).toISOString() : null;
  const started = new Date().toISOString();
  let total = 0;
  for (const site of Object.keys(SITES)) {
    for (let page = 1; ; page++) {
      onProgress?.(`${SITES[site]}: page ${page}…`);
      const { data, error } = await sb.rpc('recon_sync_woo_page', { p_site: site, p_page: page, p_after: since });
      if (error) throw new Error(error.message);
      total += data.saved;
      if (page >= data.pages || !data.saved) break;
    }
  }
  await sb.from('recon_settings').update({ woo_synced_at: started, woo_last_error: null }).eq('id', 1);
  return total;
}

/** Called by admin.js on #payments-import: receive PonchoPay data from the bookmark. */
export function listenForPonchoPay(onSaved) {
  let done = false;
  window.addEventListener('message', async (e) => {
    if (e.origin !== PP_ORIGIN || done || e.data?.type !== 'ff-ponchopay') return;
    done = true;
    const box = document.getElementById('view');
    try {
      if (!Array.isArray(e.data.payments) || !Array.isArray(e.data.payouts)) throw new Error('Unexpected data from PonchoPay');
      box.innerHTML = `<div class="card"><p>Saving ${e.data.payments.length} PonchoPay payments and ${e.data.payouts.length} payouts…</p></div>`;
      const pays = e.data.payments.map(compactPonchoPayment).filter(p => p.uuid).map(p => ({ ...p, synced_at: new Date().toISOString() }));
      const outs = e.data.payouts.map(compactPonchoPayout).filter(p => p.id);
      await upsertAll('pp_payments', pays, 'uuid');
      await upsertAll('pp_payouts', outs, 'id');
      await sb.from('recon_settings').update({ pp_synced_at: new Date().toISOString() }).eq('id', 1);
      e.source?.postMessage({ type: 'ff-done', payments: pays.length, payouts: outs.length }, PP_ORIGIN);
      toast(`PonchoPay synced: ${pays.length} payments, ${outs.length} payouts ✓`, 6000);
    } catch (err) {
      e.source?.postMessage({ type: 'ff-error', message: err.message }, PP_ORIGIN);
      toast(`PonchoPay sync failed: ${err.message}`, 8000);
    }
    onSaved?.();
  });
  // tell the PonchoPay tab we're ready for the data (repeat until it arrives: PonchoPay may still be reading)
  const ping = () => { if (done) return; try { window.opener?.postMessage('ff-ready', PP_ORIGIN); } catch { /* opener gone */ } setTimeout(ping, 1500); };
  ping();
}

// The bookmark. Runs on pay.ponchopay.com (signed in): reads payments and payouts through
// PonchoPay's own pages' API, opens this page and hands the data over.
export function bookmarklet() {
  const target = `${ADMIN_ORIGIN}${location.pathname}#payments-import`;
  // Opens the admin page straight away (a pop-up needs the click), then reads PonchoPay and
  // hands the data over when the admin page says it's ready.
  const code = `(async()=>{const A=${JSON.stringify(target)},O=${JSON.stringify(ADMIN_ORIGIN)};if(location.origin!=='${PP_ORIGIN}'){document.title='Open PonchoPay first';return}`
    + `let ready=false,data=null,sent=false;const w=window.open(A,'ffsync');const send=()=>{if(ready&&data&&!sent&&w){sent=true;w.postMessage(data,O)}};`
    + `const h=e=>{if(e.origin!==O)return;if(e.data==='ff-ready'){ready=true;send()}if(e.data&&e.data.type==='ff-done'){document.title='Fun Fest sync done: '+e.data.payments+' payments';removeEventListener('message',h)}if(e.data&&e.data.type==='ff-error')document.title='Fun Fest sync failed: '+e.data.message};addEventListener('message',h);`
    + `const all=async p=>{const out=[];for(let o=0;;o+=100){const r=await fetch(p+(p.includes('?')?'&':'?')+'limit=100&offset='+o);if(!r.ok)throw new Error(p+' '+r.status);const j=await r.json();out.push(...j.results);document.title='Fun Fest sync '+out.length;if(out.length>=j.total||!j.results.length)break}return out};`
    + `try{const payments=await all('/api/payment/search?guaranteed=true');const payouts=await all('/api/payout/search');data={type:'ff-ponchopay',payments,payouts};send()}`
    + `catch(e){document.title='Fun Fest sync failed: '+e.message;console.error(e)}})()`;
  return 'javascript:' + encodeURIComponent(code);
}

// ── Page ──────────────────────────────────────────────────────

export async function tabPayments(ctx) {
  ctxRef = ctx;
  const { view } = ctx;
  view.innerHTML = '<p class="center muted">Loading payments…</p>';
  const { data: settings, error: se } = await sb.from('recon_settings').select('*').eq('id', 1).maybeSingle();
  if (se || !settings) {
    view.innerHTML = `<div class="card msg warn">${se && !/recon_settings|schema cache/i.test(se.message) ? esc(se.message)
      : 'Payments aren’t set up in the database yet: run <code>supabase/012_payments_recon.sql</code> in Supabase.'}</div>`;
    return;
  }
  const from = settings.start_date;
  let data;
  try {
    const [orders, payments, payouts, bank, overrides, wpSaved] = await Promise.all([
      selectAll('recon_orders', '*', q => q.gte('created_at', from).order('created_at')),
      selectAll('pp_payments', 'uuid,reference,site,order_id,email,children,amount,created_at,completed_at,subsidies', q => q.gte('created_at', addDays(from, -60)).order('created_at')),
      selectAll('pp_payouts', 'id,reference,amount,booked_at,payment_ids', q => q.gte('booked_at', addDays(from, -10)).order('booked_at')),
      selectAll('bank_tx', 'id,date,type,description,amount,source', q => q.gte('date', addDays(from, -10)).order('date')),
      selectAll('recon_overrides', '*'),
      sb.rpc('recon_wp_login_saved').then(r => r.data),
    ]);
    data = { orders: orders.map(o => ({ ...o, total: +o.total, refunded: +o.refunded })), payments: payments.map(p => ({ ...p, amount: +p.amount })),
      payouts: payouts.map(p => ({ ...p, amount: +p.amount })), bank: bank.map(t => ({ ...t, amount: +t.amount })), overrides, wpSaved };
  } catch (e) { view.innerHTML = `<div class="card msg bad">${esc(e.message)}</div>`; return; }

  const res = reconcile(data, { from, graceDays: settings.grace_days });
  render(view, settings, data, res);

  // read the bank folder automatically when Chrome still has permission
  const root = canPick() ? await getBankRoot() : null;
  if (root && !tabPayments.autoBank && (await root.queryPermission({ mode: 'read' })) === 'granted') {
    tabPayments.autoBank = true;
    const before = data.bank.length;
    try { const r = await readBank(false); if (r && r.rows > before) { toast(`Bank statements read: ${r.rows - before} new`); tabPayments(ctx); } } catch (e) { toast(e.message); }
  }
}

function render(view, settings, data, res) {
  const t = res.totals;
  const c = conn();
  const counts = {}; for (const r of res.rows) counts[r.status] = (counts[r.status] || 0) + 1;
  const problems = r => ['missing', 'part'].includes(r.status);
  const exp = loadExport();
  const expCheck = exp ? checkExport(exp, res) : [];
  const notInBankRefs = new Set(expCheck.filter(x => x.found && !x.inBank).map(x => x.reference));
  const hl = r => r.subs.some(s => notInBankRefs.has(s.reference));
  const expOutside = expCheck.filter(x => !x.found);
  const q = filter.q.trim().toLowerCase();
  const rows = res.rows.filter(r => (!filter.site || r.order.site === filter.site)
    && (filter.status === 'all' ? true : filter.status === 'problems' ? problems(r) : filter.status === 'export' ? hl(r) : filter.status === 'paid' ? ['paid', 'staff'].includes(r.status) : r.status === filter.status)
    && (!q || [r.order.number, r.order.parent, r.order.email, r.order.children, ...r.payments.map(p => p.reference)].join(' ').toLowerCase().includes(q)));
  const stale = d => !d || (Date.now() - new Date(d)) > 2 * 86400000;
  const orderLink = o => `${CLUBS[o.site]?.base || ''}/wp-admin/admin.php?page=wc-orders&action=edit&id=${o.order_id}`;
  const paidBy = r => [
    ...r.subs.map(s => {
      const bank = s.credits?.[0]?.credit;
      const how = s.scheme === 'card' ? (s.payout ? `${esc(s.payout.reference)} ${s.payout.bank ? '→ bank ' + fmtD(s.payout.bank.date) : '(not in bank yet)'}` : 'not paid out yet')
        : bank ? `bank ${fmtD(bank.date)}${s.credits.length > 1 ? ` +${s.credits.length - 1}` : ''}${/mryj/i.test(bank.description) ? ' (via MRYJ)' : ''}` : (s.inBank ? 'PonchoPay says paid, not found in bank' : 'not received');
      return `<div><span class="pill ${s.state === 'received' ? 'ok' : s.state === 'refunded' ? 'muted' : s.state === 'paidout' ? 'info' : 'warn'}">${esc(SCHEME[s.scheme] || s.scheme)} ${gbp(s.net)}</span> <b>${esc(s.reference || '')}</b> <span class="muted">${esc(s.childRef || s.provider || '')}</span> ${how}</div>`;
    }),
    ...(r.from.length ? [`<div class="muted">Paid on the earlier booking ${r.from.map(o => '#' + esc(o.number)).join(', ')} (changed booking)</div>`] : []),
    ...r.direct.map(u => `<div><span class="pill ok">Bank transfer ${gbp(u.amount)}</span> ${fmtD(u.credit.date)} <span class="muted">${esc(u.credit.description)}</span></div>`),
    ...(r.payments.length || r.direct.length ? [] : [`<span class="muted">${esc(r.order.payment_title || 'No payment found')}</span>`]),
  ].join('');
  const statusPill = r => `<span class="pill ${STATUS[r.status].cls}">${STATUS[r.status].label}</span>${r.override?.note ? `<div class="small muted">${esc(r.override.note)}</div>` : ''}`;
  const usedBy = new Map();   // bank credit → the bookings it paid
  for (const r of res.rows) {
    const label = `${SITES[r.order.site] || r.order.site} #${r.order.number}`;
    for (const s of r.subs) for (const c of [...(s.credits || []).map(u => u.credit), s.payout?.bank].filter(Boolean)) usedBy.set(c.id, [...new Set([...(usedBy.get(c.id) || []), label])]);
    for (const u of r.direct) usedBy.set(u.credit.id, [...new Set([...(usedBy.get(u.credit.id) || []), label])]);
  }
  function bankResults(q) {
    const m = bankMatcher(q);
    if (!m) return '';
    const hits = data.bank.filter(m).sort((a, b) => b.date.localeCompare(a.date));
    if (!hits.length) return '<p class="muted">No bank transactions match.</p>';
    const total = hits.reduce((a, t) => a + t.amount, 0);
    return `<p class="small"><b>${hits.length}</b> transaction${hits.length === 1 ? '' : 's'} · total ${gbp(total)}</p>
      <div class="table-wrap"><table><tr><th>Date</th><th>Description</th><th>Amount</th><th>Matched to</th></tr>
      ${hits.slice(0, 300).map(t => `<tr><td class="small" style="white-space:nowrap">${fmtD(t.date)}</td><td class="small">${esc(t.description)}</td>
        <td style="white-space:nowrap${t.amount < 0 ? ';color:#be123c' : ''}">${gbp(t.amount)}</td>
        <td class="small">${(usedBy.get(t.id) || []).map(esc).join(', ') || (t.amount > 0 ? '<span class="muted">not matched</span>' : '')}</td></tr>`).join('')}
      </table></div>${hits.length > 300 ? '<p class="small muted">Showing the latest 300.</p>' : ''}`;
  }
  const FILTERS = [['problems', `Missing / part paid (${(counts.missing || 0) + (counts.part || 0)})`], ['pending', `Waiting (${counts.pending || 0})`], ['transit', `In transit (${counts.transit || 0})`],
    ...(exp ? [['export', `⚠️ Not in bank, from export (${res.rows.filter(hl).length})`]] : []),
    ['paid', `Paid (${(counts.paid || 0) + (counts.staff || 0)})`], ['manual', `Marked paid (${counts.manual || 0})`], ['all', `All (${res.rows.length})`]];

  view.innerHTML = `
    <div class="card">
      <h2>Payments</h2>
      <div class="stats">
        <div class="stat"><div class="v">${gbp(t.expected)}</div><div class="k">Expected (${t.orders} orders)</div></div>
        <div class="stat"><div class="v">${gbp(t.received)}</div><div class="k">Received in bank</div></div>
        <div class="stat"><div class="v">${gbp(t.transit)}</div><div class="k">Paid out, not in bank yet</div></div>
        <div class="stat"><div class="v" style="color:#be123c">${t.missing}</div><div class="k">Missing · ${gbp(t.missingAmount)} outstanding</div></div>
        <div class="stat"><div class="v">${gbp(t.fees)}</div><div class="k">PonchoPay card fees</div></div>
      </div>
      <div class="toolbar">
        <label>From<input type="date" id="pmFrom" value="${esc(settings.start_date)}"></label>
        <label>Club<select id="pmSite"><option value="">Both</option>${Object.entries(SITES).map(([k, l]) => `<option value="${k}" ${filter.site === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>Search<input id="pmQ" value="${esc(filter.q)}" placeholder="order, PP- ref, parent, child"></label>
        <button id="pmCsv">⬇️ CSV</button>
        <button id="pmExp" title="Upload a PonchoPay payments export to see which of its payments aren’t in the bank">📄 Check PonchoPay export</button>
        <input type="file" id="pmExpFile" accept=".csv,text/csv" hidden>
      </div>
      ${exp ? `<div class="msg warn small">PonchoPay export <b>${esc(exp.name)}</b> (${expCheck.length} payments): <b>${expCheck.filter(x => x.inBank).length}</b> found in the bank,
        <b>${notInBankRefs.size}</b> not in the bank (highlighted below)${expOutside.length ? `, ${expOutside.length} not in this list (before ${fmtD(settings.start_date)} or no order)` : ''}.
        <button class="small" id="pmExpShow">Show not in bank</button> <button class="small" id="pmExpClear">Clear</button>
        ${expOutside.length ? `<details><summary>Not in this list (${expOutside.length})</summary>${expOutside.map(x => `${esc(x.reference)} · ${esc(x.location)} · ${fmtD(x.created)} · ${gbp(x.amount)} · ${esc(x.method)} · ${esc(x.email)}`).join('<br>')}</details>` : ''}</div>` : ''}
      <div class="subtabs">${FILTERS.map(([k, l]) => `<button data-pf="${k}" class="${filter.status === k ? 'active' : ''}">${l}</button>`).join('')}</div>
      ${rows.length ? `<div class="table-wrap"><table>
        <tr><th>Order</th><th>Date</th><th>Parent / child</th><th>Email</th><th>Due</th><th>Received</th><th>Paid by</th><th>Status</th><th></th></tr>
        ${rows.slice(0, 500).map(r => `<tr${hl(r) ? ' class="hl-export" title="In the PonchoPay export, not found in the bank"' : ''}>
          <td><a href="${esc(orderLink(r.order))}" target="_blank" rel="noopener">#${esc(r.order.number)}</a><div class="small muted">${esc(SITES[r.order.site] || r.order.site)}</div></td>
          <td class="small" style="white-space:nowrap">${fmtD(r.order.created_at)}</td>
          <td class="small">${esc(r.order.parent || '')}${r.order.children ? `<div class="muted">${esc(r.order.children)}</div>` : ''}</td>
          <td class="small">${r.order.email ? `<a href="mailto:${esc(r.order.email)}">${esc(r.order.email)}</a>` : ''}</td>
          <td>${gbp(r.due)}${r.order.refunded ? `<div class="small muted">refunded ${gbp(r.order.refunded)}</div>` : ''}</td>
          <td>${gbp(r.received)}</td>
          <td class="small">${paidBy(r)}</td>
          <td>${statusPill(r)}</td>
          <td>${r.status === 'manual' ? `<button class="small" data-undo="${r.order.site}|${r.order.order_id}">Undo</button>`
            : ['missing', 'part', 'pending', 'transit'].includes(r.status) ? `<button class="small" data-mark="${r.order.site}|${r.order.order_id}">Mark paid</button>` : ''}</td>
        </tr>`).join('')}
      </table></div>${rows.length > 500 ? `<p class="small muted">Showing the first 500 of ${rows.length}: narrow the search, or download the CSV.</p>` : ''}`
      : `<p>${filter.status === 'problems' ? '✅ Nothing missing.' : 'No orders here.'}</p>`}
      <p class="small muted">${STATUS.missing.label} = no payment found ${settings.grace_days} days after the order. Bank statements loaded: ${res.bankFrom ? `${fmtD(res.bankFrom)} to ${fmtD(res.bankTo)}` : 'none'}.
        Card payments go to the bank in PonchoPay’s daily payouts; Tax-Free Childcare and vouchers are paid to the bank directly (Hounslow’s also via MRYJ Ltd).</p>
    </div>

    <div class="card">
      <h2>Bank transactions</h2>
      <div class="toolbar">
        <label>Search<input id="pmBankQ" value="${esc(filter.bank)}" placeholder="e.g. WIG, SWIG*, NATIONAL*HUT, 40.00"></label>
      </div>
      <div id="pmBankRes">${bankResults(filter.bank)}</div>
      <p class="small muted">Text matches anywhere in the description. <b>*</b> = any characters, <b>?</b> = one character. A number also matches the amount.</p>
    </div>

    ${res.unmatchedBank.length || res.unmatchedPayments.length ? `<div class="card">
      <h2>Not matched to a booking</h2>
      ${res.unmatchedBank.length ? `<h3>Bank credits (${res.unmatchedBank.length})</h3><div class="table-wrap"><table>
        <tr><th>Date</th><th>From</th><th>Amount</th><th>Not yet allocated</th></tr>
        ${res.unmatchedBank.map(cr => `<tr><td class="small">${fmtD(cr.date)}</td><td class="small">${esc(cr.description)}</td><td>${gbp(cr.amount)}</td><td>${gbp(cr.left)}</td></tr>`).join('')}
      </table></div>` : ''}
      ${res.unmatchedPayments.length ? `<h3>PonchoPay payments with no order here (${res.unmatchedPayments.length})</h3>
        <p class="small muted">Their WooCommerce order isn’t in the list: refresh orders, or the order is before ${fmtD(settings.start_date)}.</p>
        <div class="table-wrap"><table><tr><th>Reference</th><th>Club / order</th><th>Date</th><th>Parent</th><th>Amount</th></tr>
        ${res.unmatchedPayments.slice(0, 100).map(p => `<tr><td class="small">${esc(p.reference)}</td><td class="small">${esc(SITES[p.site] || p.site)} #${esc(p.order_id)}</td><td class="small">${fmtD(p.created_at)}</td><td class="small">${esc(p.email || '')}</td><td>${gbp(p.amount)}</td></tr>`).join('')}
        </table></div>` : ''}
      ${res.otherCredits.length ? `<details><summary class="small">Other money in (${res.otherCredits.length}): not booking payments, or a transfer that couldn’t be matched</summary>
        <div class="table-wrap"><table>${res.otherCredits.map(cr => `<tr><td class="small">${fmtD(cr.date)}</td><td class="small">${esc(cr.description)}</td><td>${gbp(cr.amount)}</td></tr>`).join('')}</table></div></details>` : ''}
    </div>` : ''}

    <div class="card">
      <h2>Data sources</h2>
      <div class="table-wrap"><table>
        <tr><th>Source</th><th>Last updated</th><th></th></tr>
        <tr><td><b>Booking orders</b> (WooCommerce, both sites)<div class="small muted">${data.orders.length} orders from ${fmtD(settings.start_date)}. Fetched automatically every morning.</div>
            ${settings.woo_last_error ? `<div class="msg bad small">${esc(settings.woo_last_error)}</div>` : ''}
            ${data.wpSaved ? '' : `<div class="msg warn small">The daily fetch needs the WordPress login. ${c.user && c.pass ? 'Use the one saved on the Invoices tab:' : 'Add it on the Invoices tab (Website connection) first, then come back here.'}</div>`}</td>
          <td class="small ${stale(settings.woo_synced_at) ? 'bad' : ''}">${fmtWhen(settings.woo_synced_at)}</td>
          <td><div class="actions">${!data.wpSaved && c.user && c.pass ? '<button id="pmWp" class="primary">Save login for daily fetch</button>' : ''}
            ${data.wpSaved ? '<button id="pmOrders">🔄 Refresh orders</button>' : ''}</div><div id="pmOrdersMsg" class="small muted"></div></td></tr>
        <tr><td><b>PonchoPay</b> payments and payouts<div class="small muted">${data.payments.length} payments, ${data.payouts.length} payouts.
            To update: open <a href="${PP_ORIGIN}/provider/admin/payments" target="_blank" rel="noopener">PonchoPay</a> (signed in), then click the <b>Fun Fest sync</b> bookmark.
            Add it once by dragging this to your bookmarks bar: <a class="btn small" id="pmBm" href="#">⭐ Fun Fest sync</a></div></td>
          <td class="small ${stale(settings.pp_synced_at) ? 'bad' : ''}">${fmtWhen(settings.pp_synced_at)}</td>
          <td><a class="btn" href="${PP_ORIGIN}/provider/admin/payments" target="_blank" rel="noopener">Open PonchoPay</a></td></tr>
        <tr><td><b>HSBC</b> bank statements (CSV)<div class="small muted">${data.bank.length} transactions${res.bankTo ? `, up to ${fmtD(res.bankTo)}` : ''}. Folder: ${BANK_HINT}. Save each new HSBC CSV download there.</div>
            ${canPick() ? '' : '<div class="msg warn small">Reading the bank folder needs Chrome or Edge on the Mac.</div>'}</td>
          <td class="small">${fmtWhen(settings.bank_synced_at)}</td>
          <td>${canPick() ? '<button id="pmBank">📂 Read bank statements</button> <button id="pmBankPick" class="small">Change folder</button>' : ''}<div id="pmBankMsg" class="small muted"></div></td></tr>
      </table></div>
    </div>`;

  const again = () => tabPayments(ctxRef);
  const $ = id => document.getElementById(id);
  view.querySelectorAll('[data-pf]').forEach(b => b.onclick = () => { filter.status = b.dataset.pf; render(view, settings, data, res); });
  $('pmSite').onchange = () => { filter.site = $('pmSite').value; render(view, settings, data, res); };
  $('pmQ').onchange = () => { filter.q = $('pmQ').value; render(view, settings, data, res); };
  $('pmFrom').onchange = async () => {
    const { error } = await sb.from('recon_settings').update({ start_date: $('pmFrom').value || '2026-01-01' }).eq('id', 1);
    if (error) toast(error.message); else again();
  };
  $('pmBm').href = bookmarklet();
  $('pmBm').onclick = (e) => { e.preventDefault(); toast('Drag this button onto your bookmarks bar, then click it while PonchoPay is open.', 6000); };
  $('pmExp').onclick = () => $('pmExpFile').click();
  $('pmExpFile').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const x = parsePonchoExport(await f.text(), f.name);
      if (!x.payments.length) throw new Error('No PonchoPay payments (PP-…) in that file.');
      localStorage.setItem(PP_EXPORT_KEY, JSON.stringify(x));
      filter.status = 'export'; render(view, settings, data, res);
    } catch (err) { toast(err.message); }
  };
  $('pmExpShow')?.addEventListener('click', () => { filter.status = 'export'; render(view, settings, data, res); });
  $('pmExpClear')?.addEventListener('click', () => { localStorage.removeItem(PP_EXPORT_KEY); if (filter.status === 'export') filter.status = 'problems'; render(view, settings, data, res); });
  let bankTimer;
  $('pmBankQ').oninput = () => { clearTimeout(bankTimer); bankTimer = setTimeout(() => { filter.bank = $('pmBankQ').value; $('pmBankRes').innerHTML = bankResults(filter.bank); }, 200); };
  $('pmCsv').onclick = () => download(`funfest-payments-${new Date().toISOString().slice(0, 10)}.csv`, toCSV([
    ['Club', 'Order', 'PonchoPay reference', 'Order date', 'WooCommerce status', 'Parent', 'Email', 'Children', 'Due', 'Received', 'In transit', 'Card fees', 'Status', 'Paid by', 'Note'],
    ...rows.map(r => [SITES[r.order.site], r.order.number, r.payments.map(p => p.reference).join(', '), String(r.order.created_at).slice(0, 10), r.order.status, r.order.parent, r.order.email, r.order.children,
      r.due, r.received, r.transit, r.fees, STATUS[r.status].label,
      [...r.subs.map(s => `${SCHEME[s.scheme] || s.scheme} ${s.net} ${s.state}${s.payout ? ' ' + s.payout.reference : ''}${s.credits?.[0] ? ' bank ' + s.credits[0].credit.date : ''}`), ...r.direct.map(u => `bank transfer ${u.amount} ${u.credit.date}`)].join('; '),
      r.override?.note || '']),
  ]));
  $('pmWp')?.addEventListener('click', async () => {
    const { error } = await sb.rpc('recon_set_wp_login', { p_user: c.user, p_pass: c.pass });
    if (error) toast(error.message); else { toast('Saved: orders will be fetched every morning ✓'); again(); }
  });
  $('pmOrders')?.addEventListener('click', async (ev) => {
    ev.currentTarget.disabled = true;
    try { const n = await refreshOrders(settings, m => { $('pmOrdersMsg').textContent = m; }); toast(`${n} orders updated ✓`); again(); }
    catch (e) { $('pmOrdersMsg').textContent = ''; toast(e.message, 8000); ev.currentTarget.disabled = false; }
  });
  const bankGo = async (pick) => {
    if (pick && !(await pickBankRoot())) return;
    $('pmBankMsg').textContent = 'Reading…';
    try {
      const r = await readBank(true);
      if (!r) { $('pmBankMsg').textContent = ''; if (!pick) return bankGo(true); return; }
      toast(`Read ${r.files} CSV file${r.files === 1 ? '' : 's'}: ${r.rows} transactions ✓${r.bad.length ? ` (${r.bad.length} skipped)` : ''}`, 6000);
      again();
    } catch (e) { $('pmBankMsg').textContent = e.message; }
  };
  $('pmBank')?.addEventListener('click', () => bankGo(false));
  $('pmBankPick')?.addEventListener('click', () => bankGo(true));
  const mark = async (key, undo) => {
    const [site, id] = key.split('|');
    if (undo) { await sb.from('recon_overrides').delete().eq('site', site).eq('order_id', +id); return again(); }
    const note = window.prompt(`Mark ${SITES[site]} order #${id} as paid. Note (e.g. "paid in cash 3 Mar"):`); // eslint-disable-line no-alert
    if (note === null) return;
    const { error } = await sb.from('recon_overrides').upsert({ site, order_id: +id, status: 'paid', note: note.trim() || null, set_by: ctxRef.me?.id || null, set_at: new Date().toISOString() }, { onConflict: 'site,order_id' });
    if (error) toast(error.message); else again();
  };
  view.querySelectorAll('[data-mark]').forEach(b => b.onclick = () => mark(b.dataset.mark, false));
  view.querySelectorAll('[data-undo]').forEach(b => b.onclick = () => mark(b.dataset.undo, true));
}
