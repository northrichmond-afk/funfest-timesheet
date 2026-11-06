// Staff search used by the admin Staff page (unit-tested in tests/search.test.js)
export function staffMatches(s, q, status, venueName = '') {
  if (status === 'current' && s.status === 'left') return false;
  if (status === 'admin' && s.role !== 'admin') return false;
  if (['active', 'invited', 'left'].includes(status) && s.status !== status) return false;
  const query = q.toLowerCase().trim();
  // A number-only search ("+44 7700 900") is one phone number, not separate words
  const terms = /^[\d\s+()-]+$/.test(query) ? [query] : query.split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const text = [s.name, s.email, s.phone, venueName, s.role, s.status].join(' ').toLowerCase();
  const digits = (s.phone || '').replace(/\D/g, '');
  // every word must match; phone numbers match ignoring spaces/dashes and a leading 0 vs +44
  return terms.every(t => {
    if (text.includes(t)) return true;
    const td = t.replace(/\D/g, '');
    if (td.length < 3) return false;
    const norm = d => d.replace(/^44/, '0');
    return norm(digits).includes(norm(td));
  });
}
