// Payment reconciliation (admin › Payments): WooCommerce orders ↔ PonchoPay payments ↔
// PonchoPay payouts ↔ HSBC bank credits. Pure functions, no network: parsing + matching.
//
// Money flows that reach the bank:
//  • card / Apple Pay / Google Pay / pay-by-bank: PonchoPay pays these out in daily payouts
//    ("Poncho Care Limite PonchoPay payout" credits), minus PonchoPay's fee
//  • Tax-Free Childcare: HMRC pays the club direct ("NATIONAL SAVINGS A <child ref>")
//  • childcare vouchers / Childcare Grant: the voucher provider pays the club direct
//  • anything else (e.g. a parent's own bank transfer for an order not paid through PonchoPay)

export const SITES = { northrichmond: 'North Richmond', hounslow: 'Hounslow' };
export const siteFromUrl = u => (/hounslow/i.test(u || '') ? 'hounslow' : /northrichmond|north-richmond/i.test(u || '') ? 'northrichmond' : '');
const pounds = v => Math.round(Number(v || 0) * 100) / 100;
const pence = v => Math.round(Number(v || 0)) / 100;
const dayMs = 86400000;
const toDay = d => String(d || '').slice(0, 10);
const daysBetween = (a, b) => (new Date(toDay(b) + 'T12:00:00Z') - new Date(toDay(a) + 'T12:00:00Z')) / dayMs;
const same = (a, b) => Math.abs(a - b) < 0.005;

// ── HSBC CSV ──────────────────────────────────────────────────

/** Split one CSV line (quotes, doubled quotes). */
export function csvRow(line) {
  const out = []; let f = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(f); f = ''; } else f += c;
  }
  out.push(f);
  return out.map(x => x.trim());
}
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/** "06 Oct 2026" or "06/10/2026" → 2026-10-06 */
export function hsbcDate(s) {
  let m = String(s).trim().match(/^(\d{1,2})[ -]([A-Za-z]{3})[a-z]*[ -](\d{4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}
const num = s => { const v = String(s || '').replace(/[£,\s]/g, ''); return v === '' ? 0 : Number(v); };

/**
 * Parse an HSBC Business banking CSV. Two layouts are handled:
 *  • "Date,Type,Description,Paid Out,Paid In,Balance"   (statement download)
 *  • "Date,Payment Description/Reference,Payee/Payer Name,Transaction Type…,Paid In Amount (GBP),Paid Out Amount (GBP)"
 * Returns [{ id, date, type, description, amount (+ in, − out), source }]. The id is the date,
 * the amount and the occurrence number of that date+amount in the file, so the same
 * transaction gets the same id from either layout and re-imports don't duplicate.
 */
export function parseHsbcCsv(text, source = '') {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const head = csvRow(lines[0]).map(h => h.toLowerCase());
  const col = re => head.findIndex(h => re.test(h));
  const iDate = col(/^date/);
  const iIn = col(/paid in/), iOut = col(/paid out/);
  const iDesc = col(/^description|payment description/), iPayee = col(/payee|payer/), iType = col(/^type|transaction type/);
  if (iDate < 0 || (iIn < 0 && iOut < 0)) throw new Error(`${source || 'CSV'}: not an HSBC transaction list (no Date / Paid in columns)`);
  const seen = {};
  const out = [];
  for (const line of lines.slice(1)) {
    const r = csvRow(line);
    const date = hsbcDate(r[iDate]);
    if (!date) continue;
    const amount = pounds(num(r[iIn]) - num(r[iOut]));
    if (!amount) continue;
    const description = [iPayee >= 0 ? r[iPayee] : '', iDesc >= 0 ? r[iDesc] : ''].map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' · ');
    const k = `${date}|${amount.toFixed(2)}`;
    seen[k] = (seen[k] || 0) + 1;
    out.push({ id: `${k}|${seen[k]}`, date, type: iType >= 0 ? r[iType] : '', description, amount, source });
  }
  return out;
}

/** Merge transactions from several files: one per id (a later file doesn't add a second copy). */
export function mergeBank(...lists) {
  const by = new Map();
  for (const t of lists.flat()) {
    const prev = by.get(t.id);
    // keep the richer description (the "Transaction List" layout has the payer name and reference apart)
    if (!prev || (t.description || '').length > (prev.description || '').length) by.set(t.id, { ...prev, ...t });
  }
  return [...by.values()].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

// Childcare voucher providers: PonchoPay provider name ↔ how they appear on the HSBC statement
export const VOUCHER_PROVIDERS = [
  ['edenred', /edenred/i, /edenred|^\W*childcare vouchers\W*$/i],          // Edenred pays as plain "CHILDCARE VOUCHERS"
  ['computershare', /computershare/i, /comp ?voucher|computershare/i],
  ['pluxee', /pluxee|sodexo/i, /pluxee|sodexo/i],
  ['care4', /care ?4/i, /care ?4/i],
  ['brighthorizons', /bright ?horizons/i, /bright ?horizons/i],
  ['kiddivouchers', /kiddi/i, /kiddi/i],
  ['grant', /grant/i, /grant|student finance|sfe/i],
  ['other', /./, /childcare vouchers|voucher/i],
];
export const voucherKey = name => (VOUCHER_PROVIDERS.find(([, re]) => re.test(name || '')) || ['other'])[0];

export function bankKind(t) {
  const d = t.description || '';
  if (/poncho/i.test(d)) return 'ponchopay';
  if (/national savings/i.test(d) && !/reversal/i.test(d)) return 'tfc';
  if (/mryj/i.test(d)) return 'forwarded';                   // Hounslow TFC / vouchers passed on in bulk by MRYJ Ltd
  if (VOUCHER_PROVIDERS.some(([, , re]) => re.test(d))) return 'voucher';
  return 'other';
}
const bankVoucherKey = d => (VOUCHER_PROVIDERS.find(([, , re]) => re.test(d || '')) || ['other'])[0];
// A Tax-Free Childcare / Childcare Grant reference starts with the child's first initial and the
// first three letters of their surname (e.g. AHUT39574 for A… HUTsan): work those letters out from names.
export function refStems(names) {
  const out = new Set();
  for (const n of String(names || '').split(/[,;&]| and /i)) {
    const w = n.trim().toUpperCase().replace(/[^A-Z\s-]/g, '').split(/[\s-]+/).filter(Boolean);
    if (w.length < 2) continue;
    const sur = w.at(-1).slice(0, 3);
    if (sur.length === 3) out.add(w[0][0] + sur);
  }
  return [...out];
}
const tfcRefs = s => String(s || '').toUpperCase().split(/[,\s]+/).map(r => r.replace(/TFC$/, '')).filter(r => /^[A-Z]{4}\d{5}$/.test(r));

// ── PonchoPay ─────────────────────────────────────────────────

/** Compact a PonchoPay /api/payment/search result. */
export function compactPonchoPayment(x) {
  const subs = (x.subsidies || []).map(s => ({
    scheme: s.scheme,
    amount: pence(s.amount),
    refunded: pence((s.refunds || []).filter(r => r.refundedDate).reduce((a, r) => a + (r.amount?.value || 0), 0)),
    fee: pence((s.payments || []).reduce((a, p) => a + (p.comission?.poncho?.value || 0), 0)),
    charged: pence((s.payments || []).reduce((a, p) => a + (p.amount?.value || 0), 0)),
    payIds: (s.payments || []).map(p => p.id),
    method: (s.payments || []).map(p => p.paymentMethod).filter(Boolean)[0] || null,
    paidOut: s.paidOutDate || null,
    inBank: s.inBankDate || null,
    childRef: s.childReferenceCode || null,
    provider: s.voucherProvider?.name || null,
  }));
  return {
    uuid: x.uuid,
    reference: x.reference,
    site: siteFromUrl(x.integration?.location || x.providerLocation?.name),
    order_id: Number(x.integration?.metadata) || null,
    email: x.user?.email || null,
    children: (x.children || []).map(c => c.name).filter(Boolean).join(', ') || null,
    amount: pence(x.amount),
    created_at: x.createdDate || null,
    completed_at: x.completedDate || null,
    subsidies: subs,
  };
}
/** Compact a PonchoPay /api/payout/search result. */
export function compactPonchoPayout(p) {
  return {
    id: p.id,
    reference: p.reference,
    amount: pence(p.amount?.value),
    booked_at: p.bookingDate || p.valueDate || null,
    payment_ids: (p.payments || []).map(x => x.id),
  };
}

// ── WooCommerce ───────────────────────────────────────────────

/** Compact a WooCommerce REST order. */
export function compactOrder(o, site) {
  const kids = new Set();
  for (const li of o.line_items || []) for (const m of li.meta_data || []) {
    if (/^child$/i.test(m.key) || /^child name$/i.test(m.display_key || '')) kids.add(String(m.display_value ?? m.value).trim());
  }
  const refunded = (o.refunds || []).reduce((a, r) => a + Math.abs(Number(r.total || 0)), 0);
  const b = o.billing || {};
  return {
    site,
    order_id: o.id,
    number: String(o.number || o.id),
    status: o.status,
    created_at: o.date_created_gmt ? o.date_created_gmt + 'Z' : o.date_created,
    total: pounds(o.total),
    refunded: pounds(refunded),
    payment_method: o.payment_method || null,
    payment_title: o.payment_method_title || null,
    parent: [b.first_name, b.last_name].filter(Boolean).join(' ') || null,
    email: b.email || null,
    children: [...kids].filter(Boolean).join(', ') || null,
    booking_id: (o.meta_data || []).find(m => m.key === 'booking_id')?.value || null,
    previous_booking: (o.meta_data || []).find(m => m.key === 'previous_booking')?.value || null,
  };
}

// Orders in these WooCommerce statuses are not expected to be paid
export const NOT_DUE = new Set(['pending', 'failed', 'cancelled', 'checkout-draft', 'trash', 'draft']);

// ── Matching ──────────────────────────────────────────────────

export const STATUS = {
  paid: { label: 'Paid', cls: 'ok' },
  transit: { label: 'Paid out, not in bank yet', cls: 'info' },
  part: { label: 'Part paid', cls: 'warn' },
  pending: { label: 'Waiting (under 14 days)', cls: 'info' },
  missing: { label: 'Missing', cls: 'bad' },
  manual: { label: 'Marked paid', cls: 'ok' },
  staff: { label: 'Paid (staff member)', cls: 'ok' },
  refunded: { label: 'Refunded', cls: 'muted' },
  notdue: { label: 'Not due', cls: 'muted' },
};

/**
 * Reconcile. Inputs (all compact): orders, payments (PonchoPay), payouts, bank (HSBC rows),
 * overrides [{ site, order_id, status, note }]. opts: { from: 'YYYY-MM-DD', graceDays: 14, today }.
 * Returns { rows, payouts, unmatchedBank, otherCredits, unmatchedPayments, bankFrom, bankTo, totals }.
 */
export function reconcile({ orders = [], payments = [], payouts = [], bank = [], overrides = [] }, opts = {}) {
  const from = opts.from || '2026-01-01';
  const grace = opts.graceDays ?? 14;
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const credits = bank.filter(t => t.amount > 0).map(t => ({ ...t, kind: bankKind(t), used: null, left: t.amount }));
  const bankTo = bank.reduce((m, t) => (t.date > m ? t.date : m), '');
  const bankFrom = bank.reduce((m, t) => (!m || t.date < m ? t.date : m), '');

  // 1. payouts ↔ PonchoPay bank credits (same amount, bank date from the payout day up to 5 days later)
  const po = payouts.map(p => ({ ...p, date: toDay(p.booked_at), bank: null })).sort((a, b) => a.date.localeCompare(b.date));
  for (const p of po) {
    let best = null;
    for (const c of credits) {
      if (c.left <= 0.004 || c.kind !== 'ponchopay' || !same(c.amount, p.amount)) continue;
      const d = daysBetween(p.date, c.date);
      if (d < -1 || d > 5) continue;
      if (!best || Math.abs(d) < Math.abs(daysBetween(p.date, best.date))) best = c;
    }
    if (best) { best.used = { type: 'payout', ref: p.reference }; best.left = 0; p.bank = best; }
  }
  const payoutByPay = new Map();
  for (const p of po) for (const id of p.payment_ids || []) payoutByPay.set(id, p);

  // 2. each PonchoPay subsidy → bank. Tax-Free Childcare and vouchers are often paid in several
  //    credits, or one credit covers several bookings, so credits are shared out (oldest first)
  //    among the bookings with the same child reference / voucher provider.
  const addDays = (iso, n) => { const d = new Date(toDay(iso) + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  // before: latest credit date allowed (Tax-Free Childcare / vouchers arrive within weeks of the booking)
  const take = (pool, amount, after, before = '9999', exactFrom = pool) => {
    let need = amount; const used = [];
    const open = c => c.left > 0.004 && c.date >= after && c.date <= before;
    // one credit of exactly the amount wins; otherwise share credits out oldest first
    const exact = exactFrom.find(c => open(c) && same(c.left, amount));
    for (const c of exact ? [exact] : pool) {
      if (need <= 0.004) break;
      if (!open(c)) continue;
      const x = Math.min(c.left, need);
      c.left = pounds(c.left - x); need = pounds(need - x);
      used.push({ credit: c, amount: pounds(x) });
    }
    return { covered: pounds(amount - need), used };
  };
  const pays = payments.map(x => ({ ...x, subs: [] }));
  const allSubs = pays.flatMap(p => (p.subsidies || []).map(s => ({ p, s }))).sort((a, b) => String(a.p.created_at).localeCompare(String(b.p.created_at)));
  const tfcPool = refs => credits.filter(c => c.kind === 'tfc' && refs.some(r => c.description.toUpperCase().includes(r)));
  const stemPool = stems => credits.filter(c => c.kind === 'tfc' && stems.some(st => new RegExp(`\\b${st}\\d{5}\\b`).test(c.description.toUpperCase())));
  const voucherPool = key => credits.filter(c => c.kind === 'voucher' && [key, 'other'].includes(bankVoucherKey(c.description)));
  // Children we know by reference or name: a credit carrying one of their reference letters isn't
  // up for grabs by another family's booking just because the amount is the same
  const knownStems = new Set(payments.flatMap(p => [
    ...(p.subsidies || []).flatMap(s => tfcRefs(s.childRef).map(r => r.slice(0, 4))),
    ...refStems(p.children),
  ]));
  const creditStem = c => (c.description.toUpperCase().match(/\b([A-Z]{4})\d{5}\b/) || [])[1];
  const exactTfc = (amount, after, own = []) => credits.filter(c => c.kind === 'tfc' && c.left > 0.004 && same(c.left, amount) && c.date >= after
    && (!knownStems.has(creditStem(c)) || own.includes(creditStem(c)))).slice(0, 1);
  // Tax-Free Childcare without a child reference, and the Childcare Grant (paid through the same
  // government childcare service, so it also arrives as "NATIONAL SAVINGS …"), are matched by amount
  // after everything with a reference has had its pick of the credits.
  const viaNsi = s => (s.scheme === 'tax-free-childcare' && !tfcRefs(s.childRef).length) || (s.scheme === 'childcare-voucher' && voucherKey(s.provider) === 'grant');
  allSubs.sort((a, b) => viaNsi(a.s) - viaNsi(b.s));
  // Where each Tax-Free Childcare / voucher booking may find its money
  const poolFor = (p, s, net) => {
    const refs = tfcRefs(s.childRef);
    const stems = refStems(p.children);
    const named = viaNsi(s) && stems.length ? stemPool(stems) : null;   // credits carrying the child's letters come first
    const pool = viaNsi(s) ? (p.completed_at ? [...(named || []), ...exactTfc(net, addDays(p.created_at, -7), stems), ...(s.scheme === 'childcare-voucher' ? voucherPool('grant') : [])] : [])
      : s.scheme === 'tax-free-childcare' ? tfcPool(refs)
        : voucherPool(voucherKey(s.provider));
    return { pool, exactFrom: named?.length ? named : pool, after: addDays(p.created_at, -7), before: addDays(p.created_at, s.scheme === 'tax-free-childcare' ? 45 : 90) };
  };
  const nsiOrVoucher = (p, s) => s.scheme !== 'card' && toDay(p.created_at) >= addDays(from, -60) && pounds(s.amount - (s.refunded || 0)) > 0;
  // First pass: a credit of exactly a booking's amount goes to that booking, before any sharing out
  const exactClaim = new Map();
  for (const { p, s } of allSubs) {
    if (!nsiOrVoucher(p, s)) continue;
    const net = pounds(s.amount - (s.refunded || 0));
    const w = poolFor(p, s, net);
    const c = w.exactFrom.find(x => x.left > 0.004 && same(x.left, net) && x.date >= w.after && x.date <= w.before);
    if (c) { c.left = 0; exactClaim.set(s, c); }
  }
  // A booking paid straight from the parent's Tax-Free Childcare account (no PonchoPay record):
  // a credit with the child's letters and exactly the booking's amount, soon after it, is that booking's
  const paidVia = new Set(payments.map(p => `${p.site}|${p.order_id}`));
  const directTfc = new Map();
  for (const o of [...orders].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) {
    const k = `${o.site}|${o.order_id}`;
    const due = pounds(o.total - (o.refunded || 0));
    if (paidVia.has(k) || o.previous_booking || due <= 0 || NOT_DUE.has(o.status) || ['refunded', 'staff-member'].includes(o.status) || toDay(o.created_at) < from) continue;
    const stems = refStems(o.children);
    if (!stems.length) continue;
    const c = stemPool(stems).find(x => x.left > 0.004 && same(x.left, due) && x.date >= addDays(o.created_at, -7) && x.date <= addDays(o.created_at, 45));
    if (c) { c.left = 0; directTfc.set(k, c); }
  }
  const late = [];
  for (const { p, s } of allSubs) {
    const net = pounds(s.amount - (s.refunded || 0));
    const r = { ...s, reference: p.reference, net, state: 'awaiting', covered: 0, credits: [], payout: null };
    if (net <= 0) r.state = 'refunded';
    else if (s.scheme === 'card') {
      const payout = (s.payIds || []).map(id => payoutByPay.get(id)).find(Boolean);
      if (payout) {
        r.payout = payout;
        if (payout.bank) { r.state = 'received'; r.covered = net; r.credits = [{ credit: payout.bank, amount: net }]; }
        else r.state = 'paidout';
      }
    } else if (toDay(p.created_at) >= addDays(from, -60)) {
      const w = poolFor(p, s, net);
      const t = exactClaim.has(s) ? { covered: net, used: [{ credit: exactClaim.get(s), amount: net }] }
        : take(w.pool, net, w.after, w.before, w.exactFrom);
      // Hounslow Tax-Free Childcare / vouchers that went to the previous owner arrive in bulk from MRYJ Ltd
      if (t.covered < net - 0.01 && p.site === 'hounslow') {
        const f = take(credits.filter(c => c.kind === 'forwarded'), pounds(net - t.covered), addDays(p.created_at, -7));
        t.covered = pounds(t.covered + f.covered); t.used.push(...f.used);
      }
      r.covered = t.covered; r.credits = t.used;
      for (const u of t.used) u.credit.used = u.credit.used || { type: s.scheme, ref: p.reference };
      r.state = t.covered >= net - 0.01 ? 'received' : t.covered > 0 ? 'part' : 'awaiting';
      if (r.state !== 'received') late.push({ p, s, r, w });
    }
    // PonchoPay says it's in the bank, but the statements we have end before that date
    if (r.state !== 'received' && r.state !== 'refunded' && s.inBank && toDay(s.inBank) > bankTo) r.state = r.state === 'part' ? 'part' : 'paidout';
    p.subs.push(r);
  }
  // Second pass: money that arrived late (after the usual window) and that no other booking claimed
  for (const { p, s, r, w } of late) {
    const t = take(w.pool, pounds(r.net - r.covered), w.after, '9999', w.exactFrom);
    if (!t.covered) continue;
    for (const u of t.used) u.credit.used = u.credit.used || { type: s.scheme, ref: p.reference };
    r.covered = pounds(r.covered + t.covered); r.credits.push(...t.used);
    r.state = r.covered >= r.net - 0.01 ? 'received' : 'part';
  }
  const payByOrder = new Map();
  for (const p of pays) {
    const k = `${p.site}|${p.order_id}`;
    if (!payByOrder.has(k)) payByOrder.set(k, []);
    payByOrder.get(k).push(p);
  }
  const ov = new Map(overrides.map(o => [`${o.site}|${o.order_id}`, o]));

  // A changed booking: the website cancels the old order and makes a new one with
  // previous_booking = the old order's booking_id. The payment stays on the old order, so carry
  // it (following a chain of changes) to the new one.
  const byBooking = new Map(orders.filter(o => o.booking_id).map(o => [`${o.site}|${o.booking_id}`, o]));
  const carried = new Map();   // new order key → [old orders whose payments it took]
  const replaced = o => o.status === 'cancelled' || o.status === 'refunded' || o.status === 'failed' || o.status === 'trash';
  for (const o of [...orders].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) {
    let prev = o.previous_booking && byBooking.get(`${o.site}|${o.previous_booking}`);
    const k = `${o.site}|${o.order_id}`;
    const seen = new Set([k]);
    while (prev && !seen.has(`${prev.site}|${prev.order_id}`) && replaced(prev)) {
      const pk = `${prev.site}|${prev.order_id}`;
      seen.add(pk);
      const moved = payByOrder.get(pk);
      if (moved?.length) {
        payByOrder.set(k, [...(payByOrder.get(k) || []), ...moved]);
        payByOrder.delete(pk);
        carried.set(k, [...(carried.get(k) || []), prev]);
      }
      prev = prev.previous_booking && byBooking.get(`${prev.site}|${prev.previous_booking}`);
    }
  }

  // 3. orders
  const rows = [];
  const inRange = orders.filter(o => toDay(o.created_at) >= from).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const others = credits.filter(c => c.kind === 'other');
  for (const o of inRange) {
    const k = `${o.site}|${o.order_id}`;
    const linked = payByOrder.get(k) || [];
    payByOrder.delete(k);
    const subs = linked.flatMap(p => p.subs);
    const due = pounds(o.total - (o.refunded || 0));
    let received = pounds(subs.reduce((a, s) => a + (s.covered || 0), 0));
    const transit = pounds(subs.filter(s => s.state === 'paidout').reduce((a, s) => a + s.net - (s.covered || 0), 0));
    const fees = pounds(subs.reduce((a, s) => a + (s.fee || 0), 0));
    const direct = [];
    if (directTfc.has(k)) {
      const c = directTfc.get(k);
      c.used = { type: 'tax-free-childcare', ref: `${SITES[o.site] || o.site} #${o.number}` };
      direct.push({ credit: c, amount: due }); received = pounds(received + due);
    }
    // the parent's own bank transfer: the order number in the reference, or the surname and the exact amount
    if (due > 0 && received < due - 0.01 && !NOT_DUE.has(o.status)) {
      const numRe = new RegExp(`(^|\\D)${String(o.number).replace(/\D/g, '')}(\\D|$)`);
      const surname = String(o.parent || '').trim().split(/\s+/).at(-1)?.toUpperCase() || '';
      const window = c => c.date >= addDays(o.created_at, -7) && c.date <= addDays(o.created_at, 60) && c.left > 0.004;
      let pool = others.filter(c => window(c) && numRe.test(c.description));
      if (!pool.length && surname.length > 2) pool = others.filter(c => window(c) && same(c.left, due - received) && c.description.toUpperCase().includes(surname));
      const t = take(pool, pounds(due - received), '0000');
      for (const u of t.used) { u.credit.used = { type: 'order', ref: `${SITES[o.site] || o.site} #${o.number}` }; direct.push(u); }
      received = pounds(received + t.covered);
    }
    const age = daysBetween(o.created_at, today);
    const override = ov.get(k);
    let status;
    if (o.status === 'staff-member') status = 'staff';            // WordPress "Staff Member": a staff booking, counts as paid
    else if (o.status === 'refunded' || (due <= 0 && o.total > 0)) status = 'refunded';
    // cancelled / failed / unpaid orders aren't owed, even when PonchoPay has a payment record for them
    else if (NOT_DUE.has(o.status) && received < due - 0.01) status = 'notdue';
    else if (received >= due - 0.01) status = 'paid';
    else if (override?.status === 'paid') status = 'manual';
    else if (received + transit >= due - 0.01) status = 'transit';
    else if (received > 0) status = 'part';
    else status = age > grace ? 'missing' : 'pending';
    rows.push({ order: o, due, received, transit, fees, payments: linked, subs, direct, status, override, age, from: carried.get(k) || [] });
  }

  // PonchoPay / Tax-Free Childcare / voucher credits not tied to an order, and other money in
  const unmatchedBank = credits.filter(c => c.left > 0.004 && c.date >= from && c.kind !== 'other');   // incl. MRYJ money not yet tied to a booking
  const otherCredits = credits.filter(c => c.left > 0.004 && c.date >= from && c.kind === 'other');
  const unmatchedPayments = [...payByOrder.values()].flat().filter(p => toDay(p.created_at) >= from);
  const sum = (list, f) => pounds(list.reduce((a, x) => a + f(x), 0));
  const due = rows.filter(r => !['refunded', 'notdue', 'staff'].includes(r.status));
  const totals = {
    orders: due.length,
    expected: sum(due, r => r.due),
    received: sum(due, r => Math.min(r.received, r.due)),
    transit: sum(due, r => r.transit),
    fees: sum(due, r => r.fees),
    missing: due.filter(r => r.status === 'missing').length,
    missingAmount: sum(due.filter(r => r.status === 'missing' || r.status === 'part'), r => r.due - r.received - r.transit),
    pending: due.filter(r => r.status === 'pending').length,
  };
  return { rows, credits, payouts: po, unmatchedBank, otherCredits, unmatchedPayments, bankFrom, bankTo, totals };
}
