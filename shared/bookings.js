// Turns WooCommerce orders into the list of children booked on one day (for the register).
// Each booking line item carries meta: Date (YYYY-MM-DD), Timeslot (AM/PM), Timetable (age
// group), Child (name) and _child_id (the booking system's id for the child).

const meta = (li, key) => {
  const m = (li.meta_data || []).find(x => x.key === key || x.display_key === key);
  return m ? String(m.display_value ?? m.value ?? '').trim() : '';
};
const SLOT_ORDER = s => (/^am|morning/i.test(s) ? 0 : /^pm|afternoon/i.test(s) ? 1 : 2);

export function childrenOnDay(orders, day) {
  const kids = new Map();
  for (const o of orders || []) {
    if (['cancelled', 'refunded', 'failed', 'trash', 'pending'].includes(o.status)) continue;
    const refundedItems = new Set((o.refunds || []).flatMap(r => (r.line_items || []).map(l => l.id)));
    for (const li of o.line_items || []) {
      if (meta(li, 'Date') !== day || refundedItems.has(li.id)) continue;
      const name = meta(li, 'Child') || 'Unnamed child';
      const key = meta(li, '_child_id') || name.toLowerCase().replace(/\s+/g, ' ');
      const k = kids.get(key) || {
        key, name, ageGroups: new Set(), slots: new Set(), activities: [], orders: new Set(),
        parent: { name: [o.billing?.first_name, o.billing?.last_name].filter(Boolean).join(' '), phone: o.billing?.phone || '', email: o.billing?.email || '' },
        socialWorker: '',
      };
      const slot = meta(li, 'Timeslot');
      if (slot) k.slots.add(slot.toUpperCase());
      const tt = meta(li, 'Timetable'); if (tt) k.ageGroups.add(tt);
      k.activities.push({ slot, name: li.name });
      k.orders.add(String(o.number ?? o.id));
      const sw = meta(li, '_child_social_worker'); if (sw) k.socialWorker = sw;
      kids.set(key, k);
    }
  }
  return [...kids.values()].map(k => {
    const slots = [...k.slots].sort((a, b) => SLOT_ORDER(a) - SLOT_ORDER(b));
    return {
      key: k.key, name: k.name, parent: k.parent, socialWorker: k.socialWorker,
      ageGroup: [...k.ageGroups].join(', '),
      slots,
      session: slots.length > 1 ? 'All day' : slots[0] || 'Day',
      activities: k.activities.sort((a, b) => SLOT_ORDER(a.slot) - SLOT_ORDER(b.slot)).map(a => (a.slot ? `${a.slot}: ` : '') + a.name),
      orders: [...k.orders],
    };
  }).sort((a, b) => a.ageGroup.localeCompare(b.ageGroup, 'en', { numeric: true }) || a.name.localeCompare(b.name));
}
