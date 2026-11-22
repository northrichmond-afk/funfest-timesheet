// Admin › Payments: reconcile booking payments.
//   WooCommerce orders (both sites) ← the database fetches them daily; "Refresh orders" here too
//   PonchoPay payments + payouts    ← "Fun Fest sync" bookmark run on pay.ponchopay.com
//   HSBC bank transactions           ← CSVs in iCloud › FunFest › Accounts › Business Bank Account
// Matching rules: shared/recon.js.

import { sb } from '../shared/supabase.js';
import { esc, toast, download } from '../shared/ui.js';
import { toCSV } from '../shared/hours.js';
import { SITES, STATUS, reconcile, parseHsbcCsv, mergeBank, compactPonchoPayment, compactPonchoPayout } from '../shared/recon.js';
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

const filter = { site: '', status: 'problems', q: '' };
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
  const q = filter.q.trim().toLowerCase();
  const rows = res.rows.filter(r => (!filter.site || r.order.site === filter.site)
    && (filter.status === 'all' ? true : filter.status === 'problems' ? problems(r) : r.status === filter.status)
    && (!q || [r.order.number, r.order.parent, r.order.email, r.order.children].join(' ').toLowerCase().includes(q)));
  const stale = d => !d || (Date.now() - new Date(d)) > 2 * 86400000;
  const orderLink = o => `${CLUBS[o.site]?.base || ''}/wp-admin/admin.php?page=wc-orders&action=edit&id=${o.order_id}`;
  const paidBy = r => [
    ...r.subs.map(s => {
      const bank = s.credits?.[0]?.credit;
      const how = s.scheme === 'card' ? (s.payout ? `${esc(s.payout.reference)} ${s.payout.bank ? '→ bank ' + fmtD(s.payout.bank.date) : '(not in bank yet)'}` : 'not paid out yet')
        : bank ? `bank ${fmtD(bank.date)}${s.credits.length > 1 ? ` +${s.credits.length - 1}` : ''}${/mryj/i.test(bank.description) ? ' (via MRYJ)' : ''}` : (s.inBank ? 'PonchoPay says paid, not found in bank' : 'not received');
      return `<div><span class="pill ${s.state === 'received' ? 'ok' : s.state === 'refunded' ? 'muted' : s.state === 'paidout' ? 'info' : 'warn'}">${esc(SCHEME[s.scheme] || s.scheme)} ${gbp(s.net)}</span> <span class="muted">${esc(s.childRef || s.provider || '')}</span> ${how}</div>`;
    }),
    ...r.direct.map(u => `<div><span class="pill ok">Bank transfer ${gbp(u.amount)}</span> ${fmtD(u.credit.date)} <span class="muted">${esc(u.credit.description)}</span></div>`),
    ...(r.payments.length || r.direct.length ? [] : [`<span class="muted">${esc(r.order.payment_title || 'No payment found')}</span>`]),
  ].join('');
  const statusPill = r => `<span class="pill ${STATUS[r.status].cls}">${STATUS[r.status].label}</span>${r.override?.note ? `<div class="small muted">${esc(r.override.note)}</div>` : ''}`;
  const FILTERS = [['problems', `Missing / part paid (${(counts.missing || 0) + (counts.part || 0)})`], ['pending', `Waiting (${counts.pending || 0})`], ['transit', `In transit (${counts.transit || 0})`],
    ['paid', `Paid (${counts.paid || 0})`], ['manual', `Marked paid (${counts.manual || 0})`], ['all', `All (${res.rows.length})`]];

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
        <label>Search<input id="pmQ" value="${esc(filter.q)}" placeholder="order, parent, child"></label>
        <button id="pmCsv">⬇️ CSV</button>
      </div>
      <div class="subtabs">${FILTERS.map(([k, l]) => `<button data-pf="${k}" class="${filter.status === k ? 'active' : ''}">${l}</button>`).join('')}</div>
      ${rows.length ? `<div class="table-wrap"><table>
        <tr><th>Order</th><th>Date</th><th>Parent / child</th><th>Due</th><th>Received</th><th>Paid by</th><th>Status</th><th></th></tr>
        ${rows.slice(0, 500).map(r => `<tr>
          <td><a href="${esc(orderLink(r.order))}" target="_blank" rel="noopener">#${esc(r.order.number)}</a><div class="small muted">${esc(SITES[r.order.site] || r.order.site)}</div></td>
          <td class="small" style="white-space:nowrap">${fmtD(r.order.created_at)}</td>
          <td class="small">${esc(r.order.parent || '')}${r.order.children ? `<div class="muted">${esc(r.order.children)}</div>` : ''}</td>
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
  $('pmCsv').onclick = () => download(`funfest-payments-${new Date().toISOString().slice(0, 10)}.csv`, toCSV([
    ['Club', 'Order', 'Order date', 'WooCommerce status', 'Parent', 'Email', 'Children', 'Due', 'Received', 'In transit', 'Card fees', 'Status', 'Paid by', 'Note'],
    ...rows.map(r => [SITES[r.order.site], r.order.number, String(r.order.created_at).slice(0, 10), r.order.status, r.order.parent, r.order.email, r.order.children,
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
