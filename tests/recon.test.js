import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHsbcCsv, mergeBank, bankKind, hsbcDate, compactPonchoPayment, compactPonchoPayout, compactOrder, reconcile } from '../shared/recon.js';

// Made-up data in the two HSBC layouts
const STATEMENT = `Date,Type,Description,Paid Out,Paid In,Balance
01 Mar 2026,CR,"Poncho Care Limite PonchoPay payout",,75.19,1075.19
02 Mar 2026,CR,"NATIONAL SAVINGS A ABCD12345",,24.00,
02 Mar 2026,DD,"SAGE UK LTD",8.4,,
03 Mar 2026,CR,"COMP VOUCHER SERV",,40.00,
04 Mar 2026,CR,"J SMITH 1234 bookings",,50.00,
04 Mar 2026,CR,"Poncho Care Limite PonchoPay payout",,99.00,`;
const LIST = `Date,Payment Description/Reference,Payee/Payer Name,"Transaction Type (DR/CR/BP, etc.)",Category,Sub category,Paid In Amount (GBP),Paid Out Amount (GBP)
01 Mar 2026,"PonchoPay payout  ","Poncho Care Limite",Incoming transaction,Sales & Contracts,Bank Transfer,75.19,
02 Mar 2026,"                  ","SAGE UK LTD       ",Direct Debit,Cash & Transfers ,Other Cash & Transfers,,8.4`;

test('HSBC CSV: both layouts, same ids, merged once', () => {
  assert.equal(hsbcDate('06 Oct 2026'), '2026-10-06');
  assert.equal(hsbcDate('6/10/2026'), '2026-10-06');
  const a = parseHsbcCsv(STATEMENT, 'statement.csv');
  const b = parseHsbcCsv(LIST, 'list.csv');
  assert.equal(a.length, 6);
  assert.deepEqual(a.map(t => t.amount), [75.19, 24, -8.4, 40, 50, 99]);
  assert.equal(b[0].id, a[0].id);
  assert.equal(b[1].id, a[2].id);
  const m = mergeBank(a, b);
  assert.equal(m.length, 6);
  assert.match(m[0].description, /Poncho Care Limite · PonchoPay payout/);   // richer description kept
  assert.deepEqual(m.map(bankKind), ['ponchopay', 'other', 'tfc', 'voucher', 'other', 'ponchopay']);
  assert.throws(() => parseHsbcCsv('a,b\n1,2', 'x.csv'), /not an HSBC/);
});

const ppCard = compactPonchoPayment({
  uuid: 'u1', reference: 'PP-card', amount: 7600, createdDate: '2026-02-26T10:00:00Z',
  user: { email: 'a@x.com' }, children: [{ name: 'Amy A' }],
  integration: { metadata: '101', location: 'https://fun-fest.co.uk/northrichmond' },
  subsidies: [{ scheme: 'card', amount: 7600, refunds: [], payments: [{ id: 'pay1', amount: { value: 7600 }, comission: { poncho: { value: 81 } }, paymentMethod: 'visa' }], paidOutDate: '2026-03-01T18:00:00Z' }],
});
const ppTfc = compactPonchoPayment({
  uuid: 'u2', reference: 'PP-tfc', amount: 2400, createdDate: '2026-02-27T10:00:00Z',
  integration: { metadata: '102', location: 'https://fun-fest.co.uk/hounslow' },
  subsidies: [{ scheme: 'tax-free-childcare', amount: 2400, refunds: [], payments: [], childReferenceCode: 'ABCD12345TFC' }],
});
const ppVoucher = compactPonchoPayment({
  uuid: 'u3', reference: 'PP-v', amount: 4000, createdDate: '2026-02-20T10:00:00Z',
  integration: { metadata: '103', location: 'https://fun-fest.co.uk/hounslow' },
  subsidies: [{ scheme: 'childcare-voucher', amount: 4000, refunds: [], payments: [], voucherProvider: { name: 'Computershare' } }],
});
const ppLate = compactPonchoPayment({
  uuid: 'u4', reference: 'PP-late', amount: 4000, createdDate: '2026-03-20T10:00:00Z',
  integration: { metadata: '104', location: 'https://fun-fest.co.uk/northrichmond' },
  subsidies: [{ scheme: 'card', amount: 4000, refunds: [], payments: [{ id: 'pay4', amount: { value: 4000 }, comission: { poncho: { value: 52 } } }], paidOutDate: '2026-03-23T18:00:00Z' }],
});
const ppRefund = compactPonchoPayment({
  uuid: 'u5', reference: 'PP-r', amount: 3600, createdDate: '2026-02-10T10:00:00Z',
  integration: { metadata: '105', location: 'https://fun-fest.co.uk/northrichmond' },
  subsidies: [{ scheme: 'card', amount: 3600, refunds: [{ amount: { value: 3600 }, refundedDate: '2026-02-11T10:00:00Z' }], payments: [{ id: 'pay5', amount: { value: 3600 } }] }],
});

test('PonchoPay and WooCommerce records are compacted', () => {
  assert.equal(ppCard.site, 'northrichmond');
  assert.equal(ppCard.order_id, 101);
  assert.equal(ppCard.subsidies[0].fee, 0.81);
  assert.equal(ppTfc.subsidies[0].childRef, 'ABCD12345TFC');
  assert.equal(ppRefund.subsidies[0].refunded, 36);
  const po = compactPonchoPayout({ id: 'po1', reference: 'PO-1', amount: { value: 7519 }, bookingDate: '2026-03-01T18:00:02Z', payments: [{ id: 'pay1' }] });
  assert.deepEqual(po, { id: 'po1', reference: 'PO-1', amount: 75.19, booked_at: '2026-03-01T18:00:02Z', payment_ids: ['pay1'] });
  const o = compactOrder({ id: 101, number: '101', status: 'processing', date_created_gmt: '2026-02-26T10:00:00', total: '76.00',
    billing: { first_name: 'Ann', last_name: 'Able', email: 'a@x.com' }, refunds: [{ total: '-10.00' }],
    line_items: [{ meta_data: [{ key: 'Child', value: 'Amy A' }] }, { meta_data: [{ key: 'Child', value: 'Amy A' }] }] }, 'northrichmond');
  assert.equal(o.refunded, 10);
  assert.equal(o.children, 'Amy A');
  assert.equal(o.created_at, '2026-02-26T10:00:00Z');
});

test('reconcile: card via payout, TFC, voucher, direct transfer, in transit, missing, refunded, manual', () => {
  const order = (site, id, total, created, extra = {}) => ({ site, order_id: id, number: String(id), status: 'processing', created_at: created, total, refunded: 0, ...extra });
  const orders = [
    order('northrichmond', 101, 76, '2026-02-26T10:00:00Z'),
    order('hounslow', 102, 24, '2026-02-27T10:00:00Z'),
    order('hounslow', 103, 40, '2026-02-20T10:00:00Z'),
    order('northrichmond', 104, 40, '2026-03-20T10:00:00Z'),                                  // payout after the statement ends
    order('northrichmond', 105, 36, '2026-02-10T10:00:00Z', { status: 'refunded' }),
    order('hounslow', 106, 50, '2026-02-28T10:00:00Z', { payment_method: 'bacs', parent: 'Jo Smith' }), // paid by own transfer
    order('hounslow', 107, 30, '2026-01-05T10:00:00Z'),                                      // nothing: missing
    order('hounslow', 108, 30, '2026-03-28T10:00:00Z'),                                      // nothing yet: within 14 days
    order('hounslow', 109, 30, '2026-01-06T10:00:00Z'),                                      // marked paid by hand
    order('hounslow', 110, 30, '2026-01-07T10:00:00Z', { status: 'pending' }),               // abandoned checkout
    order('hounslow', 99, 30, '2025-12-07T10:00:00Z'),                                       // before the start date
  ];
  const payouts = [
    { id: 'po1', reference: 'PO-1', amount: 75.19, booked_at: '2026-03-01T18:00:00Z', payment_ids: ['pay1'] },
    { id: 'po4', reference: 'PO-4', amount: 39.48, booked_at: '2026-03-23T18:00:00Z', payment_ids: ['pay4'] },
  ];
  const bank = parseHsbcCsv(STATEMENT, 's.csv');
  const r = reconcile({ orders, payments: [ppCard, ppTfc, ppVoucher, ppLate, ppRefund], payouts, bank, overrides: [{ site: 'hounslow', order_id: 109, status: 'paid', note: 'cash' }] },
    { from: '2026-01-01', graceDays: 14, today: '2026-04-01' });
  const st = Object.fromEntries(r.rows.map(x => [x.order.order_id, x.status]));
  assert.deepEqual(st, { 101: 'paid', 102: 'paid', 103: 'paid', 104: 'transit', 105: 'refunded', 106: 'paid', 107: 'missing', 108: 'pending', 109: 'manual', 110: 'notdue' });
  const row101 = r.rows.find(x => x.order.order_id === 101);
  assert.equal(row101.subs[0].payout.reference, 'PO-1');
  assert.equal(row101.subs[0].credits[0].credit.date, '2026-03-01');
  assert.equal(row101.fees, 0.81);
  assert.equal(r.rows.find(x => x.order.order_id === 106).direct[0].amount, 50);
  // the second PonchoPay credit (£99) isn't any payout's: left over
  assert.deepEqual(r.unmatchedBank.map(c => c.amount), [99]);
  assert.equal(r.bankTo, '2026-03-04');
  assert.equal(r.totals.missing, 1);
  assert.equal(r.totals.orders, 8);
});

test('reconcile: TFC credit must carry the child reference when there is one', () => {
  const bank = parseHsbcCsv(`Date,Type,Description,Paid Out,Paid In,Balance
02 Mar 2026,CR,"NATIONAL SAVINGS A ZZZZ99999",,24.00,`, 's');
  const r = reconcile({ orders: [{ site: 'hounslow', order_id: 102, number: '102', status: 'completed', created_at: '2026-02-27T10:00:00Z', total: 24, refunded: 0 }], payments: [ppTfc], bank },
    { today: '2026-04-01' });
  assert.equal(r.rows[0].status, 'missing');
  assert.equal(r.unmatchedBank.length, 1);
});

test('reconcile: TFC split over several credits, and one credit shared by two bookings; order number in a transfer', () => {
  const bank = parseHsbcCsv(`Date,Type,Description,Paid Out,Paid In,Balance
02 Mar 2026,CR,"NATIONAL SAVINGS A ABCD12345",,20.00,
03 Mar 2026,CR,"NATIONAL SAVINGS A ABCD12345",,44.00,
05 Mar 2026,CR,"FUNFEST ORDER 1942 MARTIN",,292.00,`, 's');
  const tfc = (id, amount, day) => compactPonchoPayment({ uuid: 't' + id, reference: 'PP-' + id, amount: amount * 100, createdDate: `2026-03-0${day}T10:00:00Z`,
    integration: { metadata: String(id), location: 'https://fun-fest.co.uk/hounslow' },
    subsidies: [{ scheme: 'tax-free-childcare', amount: amount * 100, refunds: [], payments: [], childReferenceCode: 'ABCD12345TFC, WXYZ54321TFC' }] });
  const ord = (id, total, day, extra) => ({ site: 'hounslow', order_id: id, number: String(id), status: 'processing', created_at: `2026-03-0${day}T09:00:00Z`, total, refunded: 0, ...extra });
  const r = reconcile({ orders: [ord(201, 24, 1), ord(202, 40, 1), ord(1942, 292, 2, { site: 'northrichmond' })], payments: [tfc(201, 24, 1), tfc(202, 40, 1)], bank }, { today: '2026-03-10' });
  assert.deepEqual(r.rows.map(x => [x.order.order_id, x.status, x.received]), [[201, 'paid', 24], [202, 'paid', 40], [1942, 'paid', 292]]);
  assert.equal(r.unmatchedBank.length, 0);
});
