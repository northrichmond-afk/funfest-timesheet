import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractInvoice, mergeInvoices, parseOrderList, careDatesText, findDates, invoiceFileName, ordinal, longDate, shortDate } from '../shared/invoice.js';

// Shape of a real North Richmond WooCommerce order (names and contact details made up)
const item = (name, date, slot, child, total = '20.00') => ({
  name, quantity: 1, total, total_tax: '0.00',
  meta_data: [
    { key: 'Timeslot', display_key: 'Timeslot', value: slot, display_value: slot },
    { key: 'Date', display_key: 'Date', value: date, display_value: date },
    { key: 'Timetable', display_key: 'Timetable', value: '5-7 Years', display_value: '5-7 Years' },
    { key: 'Child', display_key: 'Child', value: child, display_value: child },
    { key: '_child_id', display_key: '_child_id', value: 'abc', display_value: 'abc' },
  ],
});
const order = {
  id: 2930, number: '2930', status: 'completed', total: '80.00', discount_total: '16.00', discount_tax: '0.00',
  date_created: '2026-11-19T20:48:25', date_paid: '2026-11-19T20:50:23', payment_method_title: 'Credit/Debit Card via PonchoPay',
  billing: { first_name: 'Alex', last_name: 'Parent', address_1: '22', address_2: 'Example Avenue', city: 'Richmond', state: '-- Select a State --', postcode: 'TW10 1AA', email: 'parent@example.com', phone: '07700 900000' },
  meta_data: [{ key: 'booking_id', value: 'X' }],
  refunds: [],
  line_items: [
    item('Nerf Challenge', '2026-12-22', 'AM', 'Sam Parent'),
    item('Crazy Golf', '2026-12-21', 'PM', 'Sam Parent'),
    item('Crafty Creations', '2026-12-21', 'AM', 'Sam Parent'),
    item('Bonkers Bingo!', '2026-12-22', 'PM', 'Sam Parent'),
  ],
};

test('extracts parent, children, dates and payment from a booking order', () => {
  const v = extractInvoice(order);
  assert.equal(v.number, '2930');
  assert.equal(v.parent, 'Alex Parent');
  assert.deepEqual(v.address, ['22 Example Avenue', 'Richmond', 'TW10 1AA']);
  assert.deepEqual(v.children, ['Sam Parent']);
  assert.equal(v.careDates, '21st – 22nd December 2026');
  assert.equal(v.total, 80);
  assert.equal(v.discount, 16);
  assert.equal(v.paidOn, '2026-11-19');
  assert.equal(v.paymentMethod, 'Credit/Debit Card via PonchoPay');
  assert.deepEqual(v.items.map(i => i.description), [
    'Mon 21 Dec 2026 (AM) – Crafty Creations',
    'Mon 21 Dec 2026 (PM) – Crazy Golf',
    'Tue 22 Dec 2026 (AM) – Nerf Challenge',
    'Tue 22 Dec 2026 (PM) – Bonkers Bingo!',
  ]);
});

test('names the child on each line when siblings share an order, and subtracts refunds', () => {
  const o = { ...order, refunds: [{ total: '-20.00' }], line_items: [item('Golf', '2026-12-21', 'AM', 'Sam Parent'), item('Golf', '2026-12-21', 'AM', 'Jo Parent')] };
  const v = extractInvoice(o);
  assert.deepEqual(v.children, ['Sam Parent', 'Jo Parent']);
  assert.equal(v.items[1].description, 'Mon 21 Dec 2026 (AM) – Golf – Jo Parent');
  assert.equal(v.total, 60);
  assert.equal(v.refunded, 20);
});

test('care dates text', () => {
  assert.equal(careDatesText(['2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21']), '18th – 21st August 2026');
  assert.equal(careDatesText(['2026-10-26']), '26th October 2026');
  assert.equal(careDatesText(['2026-10-26', '2026-10-28']), '26th, 28th October 2026');
  assert.equal(careDatesText(['2026-07-30', '2026-07-31', '2026-08-03']), '30th – 31st July, 3rd August 2026');
  assert.equal(careDatesText([]), '');
});

test('date helpers', () => {
  assert.deepEqual(findDates('18/08/2026 and 2026-08-19 and 20th Aug 2026'), ['2026-08-19', '2026-08-18', '2026-08-20']);
  assert.equal(ordinal(1) + ordinal(2) + ordinal(3) + ordinal(11) + ordinal(22), '1st2nd3rd11th22nd');
  assert.equal(longDate('2026-08-11T09:30:00'), '11 August 2026');
  assert.equal(shortDate('2026-12-21'), 'Mon 21 Dec 2026');
  assert.equal(invoiceFileName('2930'), 'INVOICE_2930_NorthRichmond.pdf');
});

test('order input: one or several numbers, or pasted WordPress order links', () => {
  const clubs = ['northrichmond', 'hounslow'];
  assert.deepEqual(parseOrderList('2930', clubs), { club: null, nums: ['2930'] });
  assert.deepEqual(parseOrderList(' #2930, 2926 ,2925', clubs), { club: null, nums: ['2930', '2926', '2925'] });
  assert.deepEqual(parseOrderList('2930,2930', clubs), { club: null, nums: ['2930'] });
  assert.deepEqual(parseOrderList('https://fun-fest.co.uk/hounslow/wp-admin/admin.php?page=wc-orders&action=edit&id=5951, 5882', clubs), { club: 'hounslow', nums: ['5951', '5882'] });
  assert.deepEqual(parseOrderList('https://fun-fest.co.uk/northrichmond/wp-admin/post.php?post=2930&action=edit', clubs), { club: 'northrichmond', nums: ['2930'] });
  assert.ok(parseOrderList('https://fun-fest.co.uk/hounslow/x?id=1, https://fun-fest.co.uk/northrichmond/x?id=2', clubs).error);
  assert.ok(parseOrderList('2930, abc', clubs).error);
  assert.equal(parseOrderList('  ', clubs), null);
});

test('several orders combine into one invoice', () => {
  const a = extractInvoice(order);
  const b = extractInvoice({ ...order, number: '2950', total: '24.00', discount_total: '0.00', date_paid: '2026-11-24T10:00:00',
    line_items: [item('Lego Adventures', '2026-12-23', 'AM', 'Sam Parent', '24.00')] });
  const v = mergeInvoices([b, a]);
  assert.deepEqual(v.numbers, ['2950', '2930']);
  assert.equal(v.total, 104);
  assert.equal(v.discount, 16);
  assert.equal(v.careDates, '21st – 23rd December 2026');
  assert.deepEqual(v.paidOnList, ['2026-11-19', '2026-11-24']);
  assert.equal(v.items[0].description, 'Mon 21 Dec 2026 (AM) – Crafty Creations');
  assert.equal(v.items.at(-1).description, 'Wed 23 Dec 2026 (AM) – Lego Adventures');
  assert.equal(v.payers, 1);
  assert.equal(invoiceFileName(v.number, 'Hounslow'), 'INVOICE_2950_2930_Hounslow.pdf');
  assert.deepEqual(mergeInvoices([a]).numbers, ['2930']);
});

test('clubs have the right Ofsted numbers', async () => {
  globalThis.localStorage ??= { getItem: () => null, setItem() {} };
  const { CLUBS } = await import('../admin/invoice.js');
  assert.equal(CLUBS.hounslow.ofsted, '2909023');
  assert.equal(CLUBS.northrichmond.ofsted, '2818035');
});

test('email to parent: default wording and a valid MIME message with the PDF attached', async () => {
  globalThis.localStorage ??= { getItem: () => null, setItem() {} };
  const { emailText, CLUBS } = await import('../admin/invoice.js');
  const { buildMime, isEmail } = await import('../admin/gmail.js');
  const v = { ...extractInvoice(order), invoiceDate: '2026-11-21' };
  const t = emailText(v, CLUBS.northrichmond);
  assert.equal(t.subject, 'Invoice / payment receipt #2930 – Fun Fest North Richmond');
  assert.match(t.text, /^Dear Alex,/);
  assert.match(t.text, /for Sam Parent \(21st – 22nd December 2026\)\./);
  assert.match(t.text, /Total paid: £80\.00/);
  const pdf = new TextEncoder().encode('%PDF-1.4 test');
  const mime = buildMime({ from: 'club@example.com', fromName: 'Fun Fest North Richmond', to: 'parent@example.com', subject: t.subject, text: t.text, pdfBytes: pdf, filename: 'INVOICE_2930_NorthRichmond.pdf' });
  assert.match(mime, /^From: Fun Fest North Richmond <club@example\.com>\r\nTo: parent@example\.com\r\nSubject: =\?UTF-8\?B\?/);
  assert.match(mime, /Content-Disposition: attachment; filename="INVOICE_2930_NorthRichmond\.pdf"/);
  const att = mime.split('Content-Transfer-Encoding: base64\r\n\r\n')[2].split('\r\n--')[0].replace(/\r\n/g, '');
  assert.equal(Buffer.from(att, 'base64').toString(), '%PDF-1.4 test');
  const subj = mime.match(/Subject: =\?UTF-8\?B\?([^?]+)\?=/)[1];
  assert.equal(Buffer.from(subj, 'base64').toString(), t.subject);
  assert.ok(isEmail('a.b@example.co.uk'));
  assert.ok(!isEmail('a@b'));
  assert.ok(!isEmail('a@b.com, c@d.com'));
});

test('plain email without attachment', async () => {
  const { buildMime } = await import('../admin/gmail.js');
  const m = buildMime({ from: 'a@b.co', to: 'c@d.co', subject: 'Hi', text: 'Hello' });
  assert.match(m, /Content-Type: text\/plain/);
  assert.doesNotMatch(m, /multipart|application\/pdf/);
  assert.equal(Buffer.from(m.split('\r\n\r\n')[1].replace(/\s/g, ''), 'base64').toString(), 'Hello');
});
