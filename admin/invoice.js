// Admin tab: create an invoice / payment receipt PDF from a WooCommerce order number.
//
// • Order details come from the North Richmond WordPress site's WooCommerce REST API
//   (<site>/wp-json/wc/v3/orders/<number>), signed in with a WordPress Application Password
//   (or a read-only WooCommerce API key). Those credentials are kept only in this browser on
//   this computer (localStorage), never in the repo or Supabase.
// • The PDF is drawn in the browser with jsPDF (shared/vendor) and written straight into the
//   folder the admin picks once (iCloud Drive › FunFest › Invoice) using the File System Access
//   API (Chrome/Edge on a Mac). Browsers without it (Safari, iPhone) download or share the file.
// • Parent/child details are not stored anywhere except the PDF itself.

import { esc, toast } from '../shared/ui.js';
import { gmailConfigured, gmailToken, sendGmail, isEmail } from './gmail.js';
import { extractInvoice, mergeInvoices, parseOrderList, invoiceFileName, longDate, gbp } from '../shared/invoice.js';

const LS_CONN = 'ff.invoice.wc';      // { user, pass } – one WordPress login works for every club site
const LS_CLUB = 'ff.invoice.club.';   // + club id: overrides for CLUBS[id]
const LS_SEL = 'ff.invoice.selected'; // last club used
const DB = 'ff-invoice', STORE = 'handles', DIR_KEY = 'invoiceDir';
const FOLDER_HINT = 'iCloud Drive › FunFest › Invoice';

const COMMON = {
  phone: '07545 331344',
  email: '',
  sendFrom: '',
  settingRef: '',
  company: 'Vadivu Fun Fest Club Ltd',
  companyNo: '12924442',
  signName: 'Sugitha Mukunthan',
  signRole: 'Club Owner / Manager',
};
// Each club is its own WordPress site in the Fun Fest network (same login for all)
export const CLUBS = {
  northrichmond: {
    ...COMMON, label: 'North Richmond', base: 'https://fun-fest.co.uk/northrichmond', fileTag: 'NorthRichmond',
    name: 'Fun Fest North Richmond', premises: "King's C of E, Cumberland Road, Richmond, TW9 3HJ", ofsted: '2818035',
  },
  hounslow: {
    ...COMMON, label: 'Hounslow', base: 'https://fun-fest.co.uk/hounslow', fileTag: 'Hounslow',
    name: 'Fun Fest Hounslow', premises: 'The Rosary Catholic Primary School, 10 The Green, Heston, TW5 0RL', ofsted: '2909023',
  },
};
export const CLUB_DEFAULTS = CLUBS.northrichmond;

const getJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch { return d; } };
const setJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
const conn = () => ({ user: '', pass: '', ...getJSON(LS_CONN, {}) });
let clubId = (() => { try { return CLUBS[localStorage.getItem(LS_SEL)] ? localStorage.getItem(LS_SEL) : 'northrichmond'; } catch { return 'northrichmond'; } })();
const club = (id = clubId) => ({ ...CLUBS[id], ...getJSON(LS_CLUB + id, {}), id });

let current = null;           // invoice fields being edited
let dialog = null;            // the page's <dialog>, for the email box
let queue = [];               // further invoices waiting ("Separate invoices" mode)
const made = [];              // invoices created this session

// ── Tab ───────────────────────────────────────────────────────

export function tabAdmin(view, dlg) {
  dialog = dlg;
  const c = conn();
  const cl = club();
  view.innerHTML = `
    <div class="card">
      <h2>Create an invoice</h2>
      <p class="small muted">Choose the club and enter the booking (order) number, or paste the order's link from WordPress.
        The details are fetched from <a href="${esc(cl.base)}/wp-admin/admin.php?page=wc-orders" target="_blank" rel="noopener">the ${esc(cl.label)} WordPress admin</a>,
        you check them, and the PDF is saved to <b>${FOLDER_HINT}</b>.</p>
      ${c.user && c.pass ? '' : `<div class="msg warn">First connect to WordPress: see <b>Website connection</b> below.</div>`}
      <form id="invFind" class="toolbar">
        <label>Club<select name="club">${Object.entries(CLUBS).map(([id, k]) => `<option value="${id}" ${id === clubId ? 'selected' : ''}>${esc(k.label)}</option>`).join('')}</select></label>
        <label>Invoice / order number(s)<input name="num" required placeholder="e.g. 2930 or 2930, 2926" autocomplete="off" style="width:260px"></label>
        <label>Several numbers<select name="mode">
          <option value="combined">One invoice for all</option>
          <option value="separate">Separate invoices</option></select></label>
        <button class="primary">Get order details</button>
      </form>
      <div id="invForm"></div>
    </div>

    <div class="card">
      <h2>Save folder</h2>
      <p class="small" id="dirStatus">Checking…</p>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap">
        <button id="pickDir">Choose folder…</button>
      </div>
      <p class="small muted">In the folder picker choose <b>${FOLDER_HINT}</b> (in Finder: iCloud Drive, then FunFest, then Invoice).
        Works in Chrome or Edge on the Mac. In Safari or on a phone the PDF downloads instead, and you can move it to that folder.</p>
      <div id="madeList"></div>
    </div>

    <details class="card">
      <summary><b>Website connection</b> <span class="small muted">${c.user && c.pass ? `connected as ${esc(c.user)}` : 'not set up'}</span></summary>
      <form id="invConn" class="stack" style="max-width:520px;margin-top:.8rem">
        <p class="small muted">One login is used for all the club sites (${Object.values(CLUBS).map(k => esc(k.label)).join(', ')}).</p>
        <label>WordPress username (or WooCommerce consumer key <code>ck_…</code>)<input name="user" value="${esc(c.user)}" autocomplete="off" required></label>
        <label>Application password (or consumer secret <code>cs_…</code>)<input name="pass" type="password" value="${esc(c.pass)}" autocomplete="new-password" required></label>
        <p class="small muted">To get an application password: WordPress admin › <b>Users › Profile</b> › <b>Application Passwords</b>,
          name it “Fun Fest Timesheet”, click <i>Add</i> and paste the code here. It's saved only in this browser on this computer.
          Alternatively WooCommerce › Settings › Advanced › REST API › Add key with <b>Read</b> permission.</p>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap"><button class="primary">Save &amp; test</button><button type="button" id="connForget">Forget</button></div>
      </form>
    </details>

    <details class="card">
      <summary><b>Invoice letterhead details: ${esc(cl.label)}</b> <span class="small muted">(switch club above to edit the other)</span></summary>
      <form id="invClub" class="stack" style="max-width:520px;margin-top:.8rem">
        ${Object.entries({ name: 'Club name', premises: 'Premises address', phone: 'Phone', email: 'Email (optional)', ofsted: 'Ofsted registration number',
          settingRef: 'Setting reference / URN (optional)', company: 'Company name', companyNo: 'Company registration number',
          signName: 'Signed by', signRole: 'Role', sendFrom: 'Email invoices from (this club’s Google account)', fileTag: 'File name tag (INVOICE_<no>_<tag>.pdf)' })
          .map(([k, l]) => `<label>${esc(l)}<input name="${k}" value="${esc(cl[k])}"></label>`).join('')}
        <div style="display:flex;gap:.5rem"><button class="primary">Save</button><button type="button" id="clubReset">Reset to defaults</button></div>
      </form>
    </details>`;

  const setClub = (id) => { clubId = id; try { localStorage.setItem(LS_SEL, id); } catch { /* ignore */ } };
  view.querySelector('#invFind [name=club]').onchange = (ev) => { setClub(ev.target.value); current = null; tabAdmin(view, dlg); };
  view.querySelector('#invFind').onsubmit = (ev) => {
    ev.preventDefault();
    const raw = ev.target.num.value, mode = ev.target.mode.value;
    const p = parseOrderList(raw, Object.keys(CLUBS));
    if (!p) return toast('Enter the order number(s), separated by commas, or paste the order link.');
    if (p.error) return toast(p.error, 6000);
    if (p.club && p.club !== clubId) {
      setClub(p.club); current = null; queue = []; tabAdmin(view, dlg);
      view.querySelector('#invFind [name=num]').value = raw; view.querySelector('#invFind [name=mode]').value = mode;
    }
    fetchOrders(view, p.nums, mode);
  };
  view.querySelector('#invConn').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target));
    setJSON(LS_CONN, { user: f.user.trim(), pass: f.pass.trim() });
    try { await wc('/wp-json/wc/v3/orders?per_page=1'); toast('Connected to WordPress ✓'); tabAdmin(view, dlg); }
    catch (e) { toast(e.message, 8000); }
  };
  view.querySelector('#connForget').onclick = () => { localStorage.removeItem(LS_CONN); toast('Connection removed from this browser'); tabAdmin(view, dlg); };
  view.querySelector('#invClub').onsubmit = (ev) => {
    ev.preventDefault(); setJSON(LS_CLUB + clubId, Object.fromEntries(new FormData(ev.target))); toast('Saved');
  };
  view.querySelector('#clubReset').onclick = () => { localStorage.removeItem(LS_CLUB + clubId); tabAdmin(view, dlg); };
  view.querySelector('#pickDir').onclick = async () => { await pickFolder(); showDir(view); };
  showDir(view);
  showMade(view);
  if (current) renderForm(view);
}

// ── WooCommerce ───────────────────────────────────────────────

async function wc(path, base = club().base) {
  const c = conn();
  if (!c.user || !c.pass) throw new Error('Set up the website connection first (bottom of this page).');
  let r;
  try {
    r = await fetch(base + path, { headers: { Authorization: 'Basic ' + btoa(unescape(encodeURIComponent(`${c.user}:${c.pass}`))) }, cache: 'no-store' });
  } catch {
    throw new Error("Couldn't reach the website. Check your internet connection and the site address.");
  }
  const body = await r.json().catch(() => null);
  if (body?.message) body.message = String(body.message).replace(/<[^>]*>/g, '').trim();
  if (r.status === 401 || r.status === 403) throw new Error(`WordPress refused the login (${body?.message || r.status}). Check the username and application password.`);
  if (r.status === 404) throw new Error(body?.code === 'woocommerce_rest_shop_order_invalid_id' ? 'No order with that number.' : 'Not found on the website.');
  if (!r.ok) throw new Error(body?.message || `Website error ${r.status}`);
  return body;
}

async function getOrder(num) {
  try { return await wc(`/wp-json/wc/v3/orders/${num}`); }
  catch (e) {
    // Sequential-order-number plugins: the visible number can differ from the internal ID
    if (!/No order/.test(e.message)) throw e;
    const list = await wc(`/wp-json/wc/v3/orders?search=${num}&per_page=20`);
    const order = (list || []).find(o => String(o.number) === num);
    if (!order) throw e;
    return order;
  }
}

async function fetchOrders(view, nums, mode) {
  const box = view.querySelector('#invForm');
  box.innerHTML = `<p class="muted">Fetching ${nums.length > 1 ? nums.length + ' orders' : 'order'}…</p>`;
  const got = [], bad = [];
  for (const n of nums) {
    try { got.push(extractInvoice(await getOrder(n))); }
    catch (e) {
      if (/login|reach|connection/i.test(e.message)) { box.innerHTML = `<div class="msg bad">${esc(e.message)}</div>`; return; }
      bad.push(`#${n}: ${e.message}`);
    }
  }
  if (!got.length) { box.innerHTML = `<div class="msg bad">${esc(bad.join(' · '))}</div>`; return; }
  const stamp = v => ({ ...v, club: clubId, invoiceDate: new Date().toISOString().slice(0, 10), problems: bad });
  if (mode === 'separate') { queue = got.map(v => stamp(mergeInvoices([v]))); current = queue.shift(); }
  else { queue = []; current = stamp(mergeInvoices(got)); }
  current.batch = { total: got.length, done: 0 };
  renderForm(view);
}

// ── Review form ───────────────────────────────────────────────

const PAID = ['processing', 'completed'];

function renderForm(view) {
  const v = current;
  const box = view.querySelector('#invForm');
  const itemRows = v.items.map((it, i) => `
    <tr><td><input name="desc${i}" value="${esc(it.description)}"><div class="small muted">${esc(it.details)}</div></td>
      <td class="num"><input name="amt${i}" type="number" step="0.01" value="${it.amount.toFixed(2)}" style="width:100px"></td></tr>`).join('');
  const many = v.numbers.length > 1;
  const step = queue.length || v.batch?.done ? `<span class="pill info">Invoice ${(v.batch?.done || 0) + 1} of ${(v.batch?.done || 0) + 1 + queue.length}</span> ` : '';
  box.innerHTML = `
    <hr>
    ${v.problems?.length ? `<div class="msg bad small">Skipped: ${esc(v.problems.join(' · '))}</div>` : ''}
    ${v.payers > 1 ? `<div class="msg warn small">These orders were booked by different parents. Check this should be one invoice.</div>` : ''}
    <h3>${step}${esc(CLUBS[v.club]?.label || '')} order${many ? 's' : ''} #${esc(v.numbers.join(', #'))} ${PAID.includes(v.status) ? `<span class="pill ok">${esc(v.status)}</span>` : `<span class="pill warn">${esc(v.status || 'unknown')}: not marked paid</span>`}</h3>
    <form id="invEdit" class="stack" style="max-width:760px">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:.6rem">
        <label>Invoice date<input name="invoiceDate" type="date" value="${esc(v.invoiceDate)}" required></label>
        <label>Invoice number${many ? 's' : ''}<input name="number" value="${esc(v.number)}" required></label>
        <label>Parent / payer<input name="parent" value="${esc(v.parent)}"></label>
        <label>Email<input name="email" value="${esc(v.email)}"></label>
        <label>Phone<input name="phone" value="${esc(v.phone)}"></label>
        <label>Address (one line per row)<textarea name="address" rows="3">${esc(v.address.join('\n'))}</textarea></label>
      </div>
      <label>Children's names (one per line)${v.children.length ? '' : ' <span class="pill warn">not found in the order, please type</span>'}
        <textarea name="children" rows="3">${esc(v.children.join('\n'))}</textarea></label>
      <label>Date(s) of care${v.careDates ? '' : ' <span class="pill warn">not found, please type</span>'}
        <input name="careDates" value="${esc(v.careDates)}" placeholder="e.g. 18th – 21st August 2026"></label>
      <table><tr><th>Booking</th><th class="num">Amount</th></tr>${itemRows}</table>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:.6rem">
        <label>Total paid (£)<input name="total" type="number" step="0.01" value="${v.total.toFixed(2)}" required></label>
        <label>Payment received on<input name="paidText" value="${esc(v.paidText ?? (v.paidOnList || [v.paidOn]).filter(Boolean).map(longDate).join(' and '))}"></label>
        <label>Payment method<input name="paymentMethod" value="${esc(v.paymentMethod)}"></label>
      </div>
      ${v.discount ? `<label class="small">Discount already taken off the amounts (£)<input name="discount" type="number" step="0.01" value="${v.discount.toFixed(2)}" style="width:120px"></label>` : ''}
      ${v.refunded ? `<p class="small msg warn">This order has ${gbp(v.refunded)} refunded; the total above is after the refund.</p>` : ''}
      <label>Note on invoice (optional)<textarea name="note" rows="2">${esc(v.note || '')}</textarea></label>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap">
        <button class="primary" name="go" value="save">💾 Create &amp; save PDF${queue.length ? ', then next' : ''}</button>
        <button name="go" value="email">✉️ Save &amp; email parent</button>
        <button name="go" value="preview">👁 Preview</button>
        ${queue.length ? '<button type="button" id="invSkip">Skip this one</button>' : ''}
        <button type="button" id="invClear">Clear</button>
      </div>
    </form>`;
  const form = box.querySelector('#invEdit');
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    readForm(form);
    const action = ev.submitter?.value || 'save';
    try {
      const cl = club(current.club);
      const doc = await buildPdf(current, cl);
      const name = invoiceFileName(current.number, cl.fileTag);
      if (action === 'preview') { window.open(doc.output('bloburl'), '_blank'); return; }
      if (action === 'email') { emailDialog(view, doc, name, cl); return; }
      const where = await savePdf(doc.output('blob'), name);
      if (!where) return;
      made.unshift({ name, where, parent: current.parent, total: current.total });
      showMade(view);
      toast(`Saved ${name}`, 5000);
      next(view);
    } catch (e) { console.error(e); toast(e.message || String(e), 8000); }
  };
  box.querySelector('#invClear').onclick = () => { current = null; queue = []; box.innerHTML = ''; };
  const skip = box.querySelector('#invSkip');
  if (skip) skip.onclick = () => next(view);
}

// Separate-invoices mode: move on to the next order in the queue
function next(view) {
  if (!queue.length) return;
  const batch = { ...current.batch, done: (current.batch?.done || 0) + 1 };
  current = { ...queue.shift(), batch };
  renderForm(view);
  view.querySelector('#invForm')?.scrollIntoView({ behavior: 'smooth' });
}

function readForm(form) {
  const f = Object.fromEntries(new FormData(form));
  const lines = s => String(s || '').split('\n').map(x => x.trim()).filter(Boolean);
  Object.assign(current, {
    invoiceDate: f.invoiceDate, number: f.number.trim(), parent: f.parent.trim(), email: f.email.trim(), phone: f.phone.trim(),
    address: lines(f.address), children: lines(f.children), careDates: f.careDates.trim(),
    total: Number(f.total) || 0, paidText: f.paidText.trim(), paymentMethod: f.paymentMethod.trim(), note: f.note.trim(),
    discount: f.discount === undefined ? current.discount : Number(f.discount) || 0,
  });
  current.items = current.items.map((it, i) => ({ ...it, description: (f['desc' + i] ?? it.description).trim(), amount: Number(f['amt' + i] ?? it.amount) || 0 }));
}

// ── PDF ───────────────────────────────────────────────────────

let jsPDFLoad;
function loadJsPDF() {
  jsPDFLoad ||= new Promise((ok, fail) => {
    if (window.jspdf) return ok(window.jspdf.jsPDF);
    const s = document.createElement('script');
    s.src = new URL('../shared/vendor/jspdf.umd.min.js', import.meta.url).href;
    s.onload = () => ok(window.jspdf.jsPDF);
    s.onerror = () => { jsPDFLoad = null; fail(new Error("Couldn't load the PDF library")); };
    document.head.appendChild(s);
  });
  return jsPDFLoad;
}

async function imageData(url) {
  const blob = await (await fetch(url)).blob();
  return new Promise(ok => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(blob); });
}

const PINK = [237, 0, 140], PURPLE = [125, 76, 158], TURQ = [87, 196, 199], GREEN = [142, 195, 63], INK = [44, 44, 44], GREY = [107, 104, 112];

export async function buildPdf(v, c, deps = {}) {
  const JsPDF = deps.JsPDF || await loadJsPDF();
  const doc = new JsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, L = 20, R = W - 20, CW = R - L;
  const logo = deps.logo || await imageData(new URL('../shared/brand/fun-fest-logo.png', import.meta.url).href);
  doc.setProperties({ title: `Invoice ${v.number}`, author: c.name, subject: `Invoice / payment receipt #${v.number}` });

  // Letterhead
  doc.addImage(logo, 'PNG', L, 12, 38, 27.9);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(22); doc.setTextColor(...PINK);
  doc.text(c.name, L + 46, 24);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...INK);
  doc.text(doc.splitTextToSize(c.premises, 62), L + 46, 31);
  doc.text(c.phone, L + 112, 31);
  doc.text(`Ofsted Registration No: ${c.ofsted}`, L + 112, 35.5);
  if (c.email) doc.text(c.email, L + 112, 40);
  doc.setDrawColor(...PINK); doc.setLineWidth(0.6); doc.line(L, 45, R, 45);

  let y = 54;
  doc.setFontSize(11); doc.setFont('helvetica', 'bold');
  doc.text(longDate(v.invoiceDate), R, y, { align: 'right' });

  // Bill to
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5);
  const billTo = [v.parent, ...v.address, v.phone, v.email].filter(Boolean);
  if (billTo.length) {
    doc.setFont('helvetica', 'bold'); doc.text('Billed to:', L, y); doc.setFont('helvetica', 'normal');
    billTo.forEach((l, i) => doc.text(l, L, y + 5.5 + i * 5));
    y += 5.5 + billTo.length * 5;
  }

  // Title
  y += 8;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor(...PINK);
  const nums = String(v.number).split(/[\s,&#]+/).filter(Boolean);
  const titleLines = doc.splitTextToSize(`INVOICE / PAYMENT RECEIPT #${nums.join(', #')}`, CW);
  doc.setDrawColor(...PINK); doc.setLineWidth(0.4);
  titleLines.forEach((t, i) => {
    const ty = y + i * 7.5, tw = doc.getTextWidth(t);
    doc.text(t, W / 2, ty, { align: 'center' });
    doc.line(W / 2 - tw / 2, ty + 1.2, W / 2 + tw / 2, ty + 1.2);
  });
  y += 12 + (titleLines.length - 1) * 7.5;

  // Start a new page when the next block wouldn't fit above the footer
  const need = (h) => { if (y + h - 5 > 276) { doc.addPage(); y = 22; } };
  const heading = (t) => {
    need(14);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5); doc.setTextColor(...INK);
    doc.text(t, L, y); doc.setLineWidth(0.25); doc.setDrawColor(...INK); doc.line(L, y + 0.9, L + doc.getTextWidth(t), y + 0.9);
    y += 6.5;
  };
  const para = (t, opts = {}) => {
    doc.setFont('helvetica', opts.bold ? 'bold' : 'normal'); doc.setFontSize(opts.size || 10.5); doc.setTextColor(...(opts.color || INK));
    const lines = doc.splitTextToSize(t, CW - (opts.indent || 0));
    need(lines.length * 5);
    doc.text(lines, L + (opts.indent || 0), y); y += lines.length * 5 + (opts.after ?? 1.5);
  };

  // Children
  heading('Booked for:');
  if (v.children.length) {
    para("Children's names:", { bold: true, after: 0.5 });
    v.children.forEach(ch => para(ch, { bold: true, color: PINK, indent: 5, after: 0 }));
    y += 3;
  }

  // Booking lines
  if (v.items.length) {
    doc.setFillColor(...PURPLE); doc.rect(L, y - 4.2, CW, 6.5, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(255, 255, 255);
    doc.text('Booking', L + 2, y); doc.text('Amount', R - 2, y, { align: 'right' });
    y += 6.5;
    doc.setTextColor(...INK);
    v.items.forEach((it, i) => {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
      const d = doc.splitTextToSize(it.description + (it.qty > 1 ? ` (x${it.qty})` : ''), CW - 35);
      const h = d.length * 4.6 + 1.6;
      need(h);
      if (i % 2) { doc.setFillColor(250, 248, 252); doc.rect(L, y - 4, CW, h, 'F'); }
      doc.text(d, L + 2, y); doc.text(gbp(it.amount), R - 2, y, { align: 'right' });
      y += h;
    });
    if (v.discount) {
      doc.setFont('helvetica', 'italic'); doc.setFontSize(9); doc.setTextColor(...GREY);
      doc.text(`Amounts shown after a ${gbp(v.discount)} discount.`, R - 2, y, { align: 'right' });
      y += 5;
    }
    y += 1;
  }

  // Totals band
  const band = (label, value, fill, bold) => {
    doc.setFontSize(10.5); doc.setFont('helvetica', bold ? 'bold' : 'normal');
    const lines = doc.splitTextToSize(value, CW - 50);
    const h = 6.5 + (lines.length - 1) * 4.8;
    need(h);
    doc.setFillColor(...fill); doc.rect(L, y - 4.2, CW, h, 'F');
    doc.setTextColor(...INK); doc.text(lines, L + 48, y);
    doc.setFont('helvetica', 'bold'); doc.setTextColor(...PINK); doc.text(label, L + 2, y);
    y += h;
  };
  band('Total paid:', gbp(v.total), [253, 230, 243], true);
  const paid = v.paidText ?? (v.paidOnList || [v.paidOn]).filter(Boolean).map(longDate).join(' and ');
  if (paid || v.paymentMethod) {
    band('Payment received:', [paid, v.paymentMethod && (/^via\b/i.test(v.paymentMethod) ? v.paymentMethod : `by ${v.paymentMethod}`)].filter(Boolean).join(' '), [228, 245, 246]);
  }
  y += 5;

  if (v.careDates) { heading('Date of care:'); para(v.careDates, { after: 3 }); }
  heading('Premises:');
  para(`${c.name} – Children's Holiday Club`, { after: 0.5 });
  para(c.premises, { after: 3 });
  heading('Ofsted Registration Number:');
  para(c.ofsted, { after: 3 });
  if (c.settingRef) { heading('Setting Reference Number:'); para(c.settingRef, { after: 3 }); }
  para(`${c.company} · Company Registration Number: ${c.companyNo}`, { size: 9.5, color: GREY, after: 4 });
  if (v.note) para(v.note, { after: 3 });
  para('This receipt confirms payment for the childcare sessions listed above. Please do not hesitate to contact us if you require any further information.', { after: 4 });
  para('Kind regards,', { after: 3 });
  para(c.signName, { bold: true, color: PINK, after: 0 });
  para(c.signRole, { after: 0 });
  para(c.name, { after: 0 });

  // Footer: four brand-colour bars + contact line
  const fy = 280;
  for (let p = 1; p <= doc.getNumberOfPages(); p++) {
  doc.setPage(p);
  [PINK, TURQ, GREEN, PURPLE].forEach((col, i) => { doc.setDrawColor(...col); doc.setLineWidth(0.9); doc.line(L + i * CW / 4 + 0.5, fy, L + (i + 1) * CW / 4 - 0.5, fy); });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...PINK);
  doc.text(`${c.premises}   |   ${c.phone}   |   Ofsted No: ${c.ofsted}`, W / 2, fy + 6, { align: 'center' });
  }
  return doc;
}

// ── Saving to the Invoice folder ──────────────────────────────

const canPickFolder = () => typeof window.showDirectoryPicker === 'function';

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
const getDir = () => idb('readonly', s => s.get(DIR_KEY)).catch(() => null);
const setDir = (h) => idb('readwrite', s => s.put(h, DIR_KEY));

async function pickFolder() {
  if (!canPickFolder()) { toast('This browser can’t save into a folder. Use Chrome or Edge on the Mac, or the PDF will download.', 7000); return null; }
  try {
    const h = await window.showDirectoryPicker({ id: 'ff-invoices', mode: 'readwrite', startIn: 'documents' });
    await setDir(h);
    toast(`Invoices will be saved in “${h.name}”`);
    return h;
  } catch (e) { if (e.name !== 'AbortError') toast(e.message); return null; }
}

async function showDir(view) {
  const el = view.querySelector('#dirStatus');
  if (!el) return;
  if (!canPickFolder()) { el.innerHTML = '⚠️ This browser can’t write to a folder, so invoices will be <b>downloaded</b>. For direct saving use Chrome or Edge on the Mac.'; return; }
  const h = await getDir();
  el.innerHTML = h ? `✅ Saving to folder <b>${esc(h.name)}</b>${h.name === 'Invoice' ? '' : ' <span class="pill warn">expected “Invoice”</span>'}`
    : '⚠️ No folder chosen yet. Click <b>Choose folder…</b> and pick ' + FOLDER_HINT + '.';
}

async function savePdf(blob, name, { quiet = false } = {}) {
  if (canPickFolder()) {
    let dir = await getDir();
    if (!dir && !quiet) dir = await pickFolder();
    if (dir) {
      let perm = await dir.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') { try { perm = await dir.requestPermission({ mode: 'readwrite' }); } catch { perm = 'denied'; } }
      if (perm === 'granted') {
        let exists = false;
        try { await dir.getFileHandle(name); exists = true; } catch { /* new file */ }
        if (exists && !quiet && !window.confirm(`${name} already exists in ${dir.name}. Replace it?`)) return null; // eslint-disable-line no-alert
        const fh = await dir.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        await w.write(blob); await w.close();
        return `${dir.name}/${name}`;
      }
      toast('Folder permission not given, so downloading instead.');
    }
  }
  // Phones: offer the share sheet (Save to Files › iCloud Drive › FunFest › Invoice)
  const file = new File([blob], name, { type: 'application/pdf' });
  if (navigator.canShare?.({ files: [file] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
    try { await navigator.share({ files: [file], title: name }); return 'shared'; } catch (e) { if (e.name === 'AbortError') return null; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return 'Downloads (move it to ' + FOLDER_HINT + ')';
}

function showMade(view) {
  const el = view.querySelector('#madeList');
  if (!el) return;
  el.innerHTML = made.length ? `<h3>Created this session</h3><table><tr><th>File</th><th>Parent</th><th class="num">Total</th><th>Saved to</th><th>Emailed</th></tr>
    ${made.map(m => `<tr><td>${esc(m.name)}</td><td>${esc(m.parent)}</td><td class="num">${gbp(m.total)}</td><td class="small">${esc(m.where)}</td><td class="small">${m.emailed ? '✅ ' + esc(m.emailed) : ''}</td></tr>`).join('')}</table>` : '';
}

// ── Email to the parent (Gmail) ───────────────────────────────

export function emailText(v, c) {
  const first = (v.parent || '').trim().split(/\s+/)[0];
  const nums = String(v.number).split(/[\s,&#]+/).filter(Boolean).map(n => '#' + n).join(', ');
  const kids = v.children.length > 1 ? v.children.slice(0, -1).join(', ') + ' and ' + v.children.at(-1) : v.children[0];
  return {
    subject: `Invoice / payment receipt ${nums} – ${c.name}`,
    text: [
      `Dear ${first || 'Parent'},`,
      '',
      `Please find attached your invoice / payment receipt ${nums} from ${c.name}` +
        (kids ? ` for ${kids}` : '') + (v.careDates ? ` (${v.careDates})` : '') + '.',
      '',
      `Total paid: ${gbp(v.total)}`,
      '',
      'If you need anything else, just reply to this email.',
      '',
      'Kind regards,',
      '',
      c.signName,
      c.signRole,
      c.name,
      c.phone,
    ].join('\n'),
  };
}

function emailDialog(view, doc, name, cl) {
  if (!gmailConfigured()) return toast('Email isn’t set up yet (Google client ID missing).', 7000);
  if (!cl.sendFrom) return toast(`Set “Email invoices from” for ${cl.label} under Invoice letterhead details first.`, 7000);
  const v = current;
  const t = emailText(v, cl);
  dialog.innerHTML = `
    <form method="dialog" class="stack" style="min-width:min(560px,100%)">
      <h2>Email invoice to parent</h2>
      <p class="small muted">Sent from <b>${esc(cl.sendFrom)}</b> through Gmail, with <b>${esc(name)}</b> attached. The PDF is also saved to your Invoice folder.</p>
      <label>To<input name="to" type="email" value="${esc(v.email)}" required></label>
      <label>Subject<input name="subject" value="${esc(t.subject)}" required></label>
      <label>Message<textarea name="text" rows="14">${esc(t.text)}</textarea></label>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap">
        <button class="primary" value="send">✉️ Send</button>
        <button value="cancel" formnovalidate>Cancel</button>
      </div>
      <p class="small muted" id="mailStatus"></p>
    </form>`;
  dialog.style.maxWidth = '640px';
  dialog.showModal();
  dialog.addEventListener('close', () => { dialog.style.maxWidth = ''; }, { once: true });
  const form = dialog.querySelector('form');
  const status = dialog.querySelector('#mailStatus');
  form.onsubmit = async (ev) => {
    if (ev.submitter?.value !== 'send') return;          // Cancel closes the dialog
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    if (!isEmail(f.to)) { status.textContent = 'Enter a valid email address.'; return; }
    const btn = form.querySelector('[value=send]');
    btn.disabled = true;
    try {
      status.textContent = 'Signing in to Google…';
      const { token } = await gmailToken(cl.sendFrom);    // first, while the click still counts (Google pop-up)
      status.textContent = 'Sending…';
      await sendGmail({ token, from: cl.sendFrom, fromName: cl.name, to: f.to.trim(), subject: f.subject.trim(), text: f.text,
        pdfBytes: new Uint8Array(doc.output('arraybuffer')), filename: name });
      status.textContent = 'Sent. Saving a copy…';
      let where = '';
      try { where = await savePdf(doc.output('blob'), name, { quiet: true }) || 'not saved'; }
      catch (e) { where = 'not saved (' + e.message + ')'; }
      dialog.close();
      made.unshift({ name, where, parent: v.parent, total: v.total, emailed: f.to.trim() });
      showMade(view);
      toast(`Emailed ${name} to ${f.to.trim()}`, 6000);
      next(view);
    } catch (e) {
      console.error(e);
      status.textContent = e.message || String(e);
      btn.disabled = false;
    }
  };
}
