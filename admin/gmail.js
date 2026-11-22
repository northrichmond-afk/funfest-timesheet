// Send an email with a PDF attached through the Gmail API, from the Google account the admin
// approves in Google's pop-up. Uses Google Identity Services (token in memory only, ~1 hour).
//
// Google Cloud setup (once): Gmail API enabled on the project that owns GOOGLE_CLIENT_ID,
// scope https://www.googleapis.com/auth/gmail.send added to the OAuth consent screen, and
// https://northrichmond-afk.github.io listed under Authorised JavaScript origins.

import { GOOGLE_CLIENT_ID } from '../shared/config.js';

const SCOPES = 'https://www.googleapis.com/auth/gmail.send openid email';
const tokens = {};   // sender email (lower case) → { token, email, exp }

let gisLoad;
function loadGis() {
  gisLoad ||= new Promise((ok, fail) => {
    if (window.google?.accounts?.oauth2) return ok();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = () => ok();
    s.onerror = () => { gisLoad = null; fail(new Error("Couldn't load Google sign-in. Check your internet connection.")); };
    document.head.appendChild(s);
  });
  return gisLoad;
}

export const gmailConfigured = () => !!GOOGLE_CLIENT_ID;

// Must be called from a click (Google opens a pop-up). Returns { token, email }.
export async function gmailToken(sender) {
  if (!GOOGLE_CLIENT_ID) throw new Error('Email isn’t set up yet: GOOGLE_CLIENT_ID is missing in shared/config.js.');
  const key = (sender || '').toLowerCase();
  const cached = tokens[key];
  if (cached && cached.exp > Date.now() + 60_000) return cached;
  await loadGis();
  const resp = await new Promise((ok, fail) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPES,
      login_hint: sender || undefined,
      callback: r => (r.error ? fail(new Error(`Google: ${r.error_description || r.error}`)) : ok(r)),
      error_callback: e => fail(new Error(e.type === 'popup_closed' ? 'Google sign-in was closed.' : e.type === 'popup_failed_to_open' ? 'Allow pop-ups for this site, then try again.' : `Google sign-in failed (${e.type})`)),
    });
    client.requestAccessToken({ prompt: cached ? '' : 'consent' });
  });
  if (!window.google.accounts.oauth2.hasGrantedAllScopes(resp, 'https://www.googleapis.com/auth/gmail.send')) {
    throw new Error('Gmail permission wasn’t given. Tick “Send email on your behalf” when Google asks.');
  }
  const me = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${resp.access_token}` } }).then(r => r.json()).catch(() => ({}));
  const got = { token: resp.access_token, email: me.email || '', exp: Date.now() + (Number(resp.expires_in) || 3600) * 1000 };
  if (sender && got.email && got.email.toLowerCase() !== key) {
    throw new Error(`You signed in to Google as ${got.email}, but this club's email is sent from ${sender}. Try again and choose ${sender}.`);
  }
  tokens[key] = got;
  return got;
}

// RFC 2047 for non-ASCII headers (names with accents, the en dash in subjects)
const encHeader = s => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(new TextEncoder().encode(s))}?=`);
const wrap76 = s => s.replace(/.{1,76}/g, '$&\r\n');
function b64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const b64url = s => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Builds the raw MIME message (exported for tests)
export function buildMime({ from, fromName, to, subject, text, html, pdfBytes, filename }) {
  const boundary = 'ff_' + Math.random().toString(36).slice(2);
  const fromHdr = fromName ? `${encHeader(fromName)} <${from}>` : from;
  return [
    `From: ${fromHdr}`,
    `To: ${to}`,
    `Subject: ${encHeader(subject)}`,
    'MIME-Version: 1.0',
    ...(pdfBytes || html ? [] : ['Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', wrap76(b64(new TextEncoder().encode(text)))]),
  ].concat(html && !pdfBytes ? [
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(new TextEncoder().encode(text))),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(new TextEncoder().encode(html))),
    `--${boundary}--`,
    '',
  ] : pdfBytes ? [
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(new TextEncoder().encode(text))),
    `--${boundary}`,
    `Content-Type: application/pdf; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(pdfBytes)),
    `--${boundary}--`,
    '',
  ] : ['']).join('\r\n');
}

export async function sendGmail({ token, ...msg }) {
  const raw = b64url(b64(new TextEncoder().encode(buildMime(msg))));
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const m = body?.error?.message || `Gmail error ${r.status}`;
    if (/has not been used|is disabled/i.test(m)) throw new Error('The Gmail API isn’t switched on in Google Cloud for this app yet.');
    throw new Error(m);
  }
  return body; // { id, threadId }
}

export const isEmail = s => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(String(s || '').trim());
