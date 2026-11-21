// Turns a WooCommerce order (REST API /wc/v3/orders/<id>) into the fields printed on a
// Fun Fest invoice / payment receipt. Pure functions, no browser APIs, so they can be unit-tested.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// "2026-08-11T09:30:00" → "11 August 2026"
export function longDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return String(iso);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

const pad = n => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

// Pull every date it can find out of free text: 2026-08-18, 18/08/2026, 18-08-26, "18th August 2026", "Mon 18 Aug 2026".
export function findDates(text) {
  const out = [];
  const t = String(text ?? '');
  for (const m of t.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) out.push(iso(+m[1], +m[2], +m[3]));
  for (const m of t.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/g)) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    if (+m[2] >= 1 && +m[2] <= 12) out.push(iso(y, +m[2], +m[1]));
  }
  const mon = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${mon}\\.?,?\\s+(\\d{4})\\b`, 'gi'))) {
    out.push(iso(+m[3], 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(m[2].toLowerCase().slice(0, 3)) / 3 + 1, +m[1]));
  }
  return out;
}

// ['2026-08-18','2026-08-19','2026-08-20','2026-08-21'] → "18th – 21st August 2026"
// Non-consecutive days are listed: "26th, 28th October 2026". Different months/years are spelled out.
export function careDatesText(dates) {
  const ds = [...new Set(dates)].sort();
  if (!ds.length) return '';
  const parts = ds.map(d => d.split('-').map(Number));
  // group consecutive days into runs
  const runs = [];
  for (const p of parts) {
    const last = runs.at(-1);
    const prev = last?.at(-1);
    const next = prev && new Date(Date.UTC(prev[0], prev[1] - 1, prev[2] + 1));
    if (prev && next.getUTCFullYear() === p[0] && next.getUTCMonth() === p[1] - 1 && next.getUTCDate() === p[2]) last.push(p);
    else runs.push([p]);
  }
  const fmt = (p, withMonth, withYear) => ordinal(p[2]) + (withMonth ? ` ${MONTHS[p[1] - 1]}` : '') + (withYear ? ` ${p[0]}` : '');
  const sameMonth = parts.every(p => p[0] === parts[0][0] && p[1] === parts[0][1]);
  const sameYear = parts.every(p => p[0] === parts[0][0]);
  const runText = runs.map(r => {
    const a = r[0], b = r.at(-1);
    if (sameMonth) return r.length === 1 ? fmt(a) : `${fmt(a)} – ${fmt(b)}`;
    if (r.length === 1) return fmt(a, true, !sameYear);
    const aMonth = a[1] !== b[1] || a[0] !== b[0];
    return `${fmt(a, aMonth, !sameYear && a[0] !== b[0])} – ${fmt(b, true, !sameYear)}`;
  });
  const y = parts[0][0];
  if (sameMonth) return `${runText.join(', ')} ${MONTHS[parts[0][1] - 1]} ${y}`;
  return runText.join(', ') + (sameYear ? ` ${y}` : '');
}

const stripTags = s => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#039;|&#39;/g, "'").replace(/\s+/g, ' ').trim();
const money = n => Math.round((Number(n) || 0) * 100) / 100;

// Visible meta on a line item (skips WooCommerce's hidden "_" keys)
function itemMeta(item) {
  return (item.meta_data || [])
    .filter(m => !String(m.key || '').startsWith('_'))
    .map(m => ({ key: stripTags(m.display_key ?? m.key), value: typeof (m.display_value ?? m.value) === 'object' ? JSON.stringify(m.display_value ?? m.value) : stripTags(m.display_value ?? m.value) }))
    .filter(m => m.value);
}

const CHILD_KEY = /child|attendee|participant|kid|pupil|camper/i;
const NAME_KEY = /name/i;
const DATE_KEY = /date|day|session|week|when/i;
const SKIP_CHILD_KEY = /age|dob|birth|allerg|medical|school|year|gender|note|consent|photo|date/i;

const SHORT_MONTHS = MONTHS.map(m => m.slice(0, 3));
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// "2026-12-21" → "Mon 21 Dec 2026"
export function shortDate(isoDate) {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  if (!y || !m || !d) return String(isoDate);
  return `${DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${SHORT_MONTHS[m - 1]} ${y}`;
}

const SLOT_ORDER = s => (/^am|morning/i.test(s) ? 0 : /^pm|afternoon/i.test(s) ? 1 : 2);

export function extractInvoice(order) {
  const b = order.billing || {};
  const parent = [b.first_name, b.last_name].filter(Boolean).join(' ').trim();
  let lines = [b.address_1, b.address_2].map(s => (s || '').trim()).filter(Boolean);
  // "22" + "Burdenshott Avenue" → "22 Burdenshott Avenue"
  if (lines.length === 2 && /^\d+[a-z]?$/i.test(lines[0])) lines = [`${lines[0]} ${lines[1]}`];
  const address = [...lines, b.city, /select/i.test(b.state || '') ? '' : b.state, b.postcode].map(s => (s || '').trim()).filter(Boolean);

  const children = [];
  const dates = [];
  let items = (order.line_items || []).map(it => {
    const meta = itemMeta(it);
    const kids = [];
    let date = '', slot = '';
    for (const m of meta) {
      if (CHILD_KEY.test(m.key) && (NAME_KEY.test(m.key) || !SKIP_CHILD_KEY.test(m.key))) {
        m.value.split(/\s*[,;\n]\s*/).filter(Boolean).forEach(n => kids.push(n.trim()));
      }
      if (DATE_KEY.test(m.key)) { const f = findDates(m.value); dates.push(...f); date ||= f[0] || ''; }
      if (/slot|time/i.test(m.key) && !/table/i.test(m.key)) slot ||= m.value;
    }
    const fromName = findDates(it.name);
    dates.push(...fromName);
    date ||= fromName[0] || '';
    children.push(...kids);
    return {
      name: stripTags(it.name), date, slot, kids,
      details: meta.filter(m => !CHILD_KEY.test(m.key)).map(m => `${m.key}: ${m.value}`).join(' · '),
      qty: Number(it.quantity) || 1,
      amount: money(Number(it.total) + Number(it.total_tax || 0)),
    };
  });
  // Child names can also be stored on the order itself (checkout fields)
  for (const m of order.meta_data || []) {
    if (String(m.key).startsWith('_') || typeof m.value !== 'string') continue;
    if (CHILD_KEY.test(m.key) && NAME_KEY.test(m.key)) children.push(stripTags(m.value));
  }
  const uniqueKids = [...new Set(children.map(c => c.trim()).filter(Boolean))];

  // Booking lines in date order (AM before PM): "Mon 21 Dec 2026 (AM) – Crafty Creations"
  items = items
    .map((it, i) => ({ ...it, i }))
    .sort((a, b) => (a.date || '9').localeCompare(b.date || '9') || SLOT_ORDER(a.slot) - SLOT_ORDER(b.slot) || a.i - b.i)
    .map(it => ({
      description: [it.date && shortDate(it.date) + (it.slot ? ` (${it.slot})` : ''), it.name, uniqueKids.length > 1 && it.kids.join(', ')].filter(Boolean).join(' – '),
      details: it.details, qty: it.qty, amount: it.amount, date: it.date, slot: it.slot, kids: it.kids,
    }));

  const refunded = (order.refunds || []).reduce((s, r) => s + Math.abs(Number(r.total) || 0), 0);
  const total = money(Number(order.total) - refunded);

  return {
    number: String(order.number ?? order.id ?? ''),
    status: order.status || '',
    parent,
    address,
    email: b.email || '',
    phone: b.phone || '',
    children: uniqueKids,
    items,
    discount: money(Number(order.discount_total || 0) + Number(order.discount_tax || 0)),
    refunded: money(refunded),
    total,
    currency: order.currency || 'GBP',
    paidOn: (order.date_paid || order.date_completed || order.date_created || '').slice(0, 10),
    paymentMethod: stripTags(order.payment_method_title || order.payment_method || ''),
    careDates: careDatesText(dates),
    dates: [...new Set(dates)].sort(),
    createdOn: (order.date_created || '').slice(0, 10),
  };
}

// One invoice covering several orders (e.g. a parent who booked twice).
// Numbers "5882, 5946"; sessions from all orders in date order; totals added up.
export function mergeInvoices(list) {
  if (list.length === 1) return { ...list[0], numbers: [list[0].number] };
  const uniq = a => [...new Set(a.filter(Boolean))];
  const children = uniq(list.flatMap(v => v.children));
  const items = list.flatMap((v, oi) => v.items.map((it, i) => ({ ...it, k: [it.date || '9', SLOT_ORDER(it.slot || ''), oi, i] })))
    .sort((a, b) => { for (let j = 0; j < 4; j++) { const c = a.k[j] < b.k[j] ? -1 : a.k[j] > b.k[j] ? 1 : 0; if (c) return c; } return 0; })
    .map(({ k, ...it }) => (children.length > 1 && it.kids?.length && !it.description.includes(it.kids.join(', '))
      ? { ...it, description: `${it.description} – ${it.kids.join(', ')}` } : it));
  const first = list[0];
  const dates = uniq(list.flatMap(v => v.dates || [])).sort();
  return {
    ...first,
    numbers: list.map(v => v.number),
    number: list.map(v => v.number).join(', '),
    status: list.every(v => v.status === first.status) ? first.status : list.map(v => `#${v.number} ${v.status}`).join(', '),
    children,
    items,
    discount: money(list.reduce((s, v) => s + v.discount, 0)),
    refunded: money(list.reduce((s, v) => s + v.refunded, 0)),
    total: money(list.reduce((s, v) => s + v.total, 0)),
    paidOnList: uniq(list.map(v => v.paidOn)).sort(),
    paidOn: uniq(list.map(v => v.paidOn)).sort().at(-1) || '',
    paymentMethod: uniq(list.map(v => v.paymentMethod)).join(' / '),
    careDates: careDatesText(dates) || uniq(list.map(v => v.careDates)).join(', '),
    dates,
    payers: uniq(list.map(v => v.parent.toLowerCase())).length,
  };
}

// "2930", "#2930", "2930, 2926" or pasted WordPress order links → { club, nums: [...] }
export function parseOrderList(text, clubIds = []) {
  const parts = String(text || '').split(/[\s,;]+/).map(p => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  let club = null;
  const nums = [];
  for (const p of parts) {
    const m = p.match(/fun-fest\.co\.uk\/([a-z0-9-]+)\/.*?[?&](?:id|post)=(\d+)/i);
    if (m) {
      const c = clubIds.includes(m[1].toLowerCase()) ? m[1].toLowerCase() : null;
      if (c && club && c !== club) return { error: 'Those links are from different clubs. Make one invoice per club.' };
      club = c || club; nums.push(m[2]); continue;
    }
    const n = p.replace(/^#/, '');
    if (!/^\d+$/.test(n)) return { error: `“${p}” isn't an order number.` };
    nums.push(n);
  }
  return { club, nums: [...new Set(nums)] };
}

// "INVOICE_5735_NorthRichmond.pdf" (same pattern as the existing invoices in the FunFest/Invoice folder)
export function invoiceFileName(number, club = 'NorthRichmond') {
  const n = String(number).split(/[^\w-]+/).filter(Boolean).join('_');
  return `INVOICE_${n}_${club.replace(/[^\w-]+/g, '')}.pdf`;
}

export const gbp = n => '£' + (Number(n) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
