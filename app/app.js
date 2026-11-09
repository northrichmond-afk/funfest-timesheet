import { sb, configured, signOut, registerLogin, rpc, isPasswordRecovery, listenForAuthLinks } from '../shared/supabase.js';
import { isNative, nativePosition } from '../shared/native.js';
import { renderLogin, renderNewPassword } from '../shared/login.js';
import { calcEntry, fmtHours, localDate, localTime, decimalHours, distanceM } from '../shared/hours.js';
import { esc, toast, setRoleTitle } from '../shared/ui.js';

const view = document.getElementById('view');
const dlg = document.getElementById('dlg');
const QUEUE_KEY = 'ff_offline_queue';

let me = null;          // staff row
let settings = {};
let timer = null;

if (!isNative && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
// iPhone app: sign-in / confirm / reset links come back into the app
listenForAuthLinks(({ recovery, error }) => {
  if (error) { toast(error, 6000); return; }
  if (recovery) { try { sessionStorage.setItem('ff_recovery', '1'); } catch {} }
  boot();
});
const recoveryPending = () => { try { return isPasswordRecovery || sessionStorage.getItem('ff_recovery') === '1'; } catch { return isPasswordRecovery; } };
document.getElementById('signout').onclick = signOut;
window.addEventListener('online', () => flushQueue().then(render));

boot();

async function boot() {
  if (!configured) {
    view.innerHTML = `<div class="card msg warn">The app isn't configured yet. Add the Supabase URL and key to <code>shared/config.js</code>.</div>`;
    return;
  }
  const { data: { session } } = await sb.auth.getSession();
  if (session && recoveryPending()) return renderNewPassword(view, () => location.replace(location.pathname));
  if (!session) return showLogin();

  try {
    me = await registerLogin();
  } catch (e) {
    view.innerHTML = `<div class="card msg bad">Couldn't connect: ${esc(e.message)}. Check your signal and try again.</div>`;
    return;
  }
  document.getElementById('signout').classList.remove('hidden');
  setRoleTitle(me);
  if (!me) return showNotRegistered(session.user.email);
  if (!me.consent_location_at) return showConsent();

  const { data } = await sb.from('settings').select('*').single();
  settings = data || {};
  await flushQueue();
  render();
}

function showLogin() {
  renderLogin(view, {
    title: 'Welcome to Fun Fest',
    intro: 'Sign in with the Google account or email address your manager registered for you.',
    footer: installHint(),
  });
}

function showNotRegistered(email) {
  view.innerHTML = `
    <div class="card stack">
      <h1>You're not registered with Fun Fest</h1>
      <p>You signed in as <strong>${esc(email)}</strong>, but this email isn't on the staff list.</p>
      <p class="muted">Ask your manager to add this email, or sign out and use a different account.</p>
      <button class="primary" id="so">Sign out</button>
    </div>`;
  document.getElementById('so').onclick = signOut;
}

function showConsent() {
  view.innerHTML = `
    <div class="card stack">
      <h1>Hi ${esc(me.name.split(' ')[0])} 👋</h1>
      <h2>How we use your location</h2>
      <ul>
        <li>Your location is recorded <strong>only when you tap Start shift or End shift</strong>. We never track you in between or outside work.</li>
        <li>When you open the app, it also checks your location to show which venue you're at. That check stays on your phone and isn't saved or sent to us.</li>
        <li>It's used to confirm you're at the Fun Fest venue, so your hours are recorded accurately for pay.</li>
        <li>We store the time, your position and its accuracy at those two moments. Exact positions are deleted after about 3 months; your hours are kept for payroll records (6 years).</li>
        <li>Only Fun Fest admins can see your records. You can ask to see them at any time.</li>
        <li>We also store your name and email from your Google account, to sign you in.</li>
      </ul>
      <p class="muted small">Your phone will ask for location permission next. Choose <em>Allow</em> (or <em>Allow while using the app</em>).</p>
      <button class="primary" id="ok">I understand. Continue</button>
      <div id="out"></div>
    </div>`;
  document.getElementById('ok').onclick = async (ev) => {
    ev.target.disabled = true;
    const out = document.getElementById('out');
    try {
      await getPosition();
      await rpc('give_location_consent');
      me.consent_location_at = new Date().toISOString();
      out.innerHTML = `<div class="msg ok">Location works. You're all set!</div>`;
      setTimeout(boot, 900);
    } catch (e) {
      ev.target.disabled = false;
      out.innerHTML = `<div class="msg bad">${esc(locationErrorText(e))}</div>`;
    }
  };
}

// ── Main screen ─────────────────────────────────────────────

let tab = 'today';

async function render() {
  clearInterval(timer);
  view.innerHTML = `
    <div class="tabs">
      <button data-t="today" class="${tab === 'today' ? 'active' : ''}">Today</button>
      <button data-t="hours" class="${tab === 'hours' ? 'active' : ''}">My hours</button>
    </div>
    <div id="pane"><p class="center muted">Loading…</p></div>
    ${installHint()}`;
  view.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { tab = b.dataset.t; render(); });
  if (tab === 'today') renderToday(); else renderHours();
}

async function renderToday() {
  const pane = document.getElementById('pane');
  const today = localDate(new Date());
  const [{ data: planned }, { data: open }, { data: sites }] = await Promise.all([
    sb.from('planned_shifts').select('*, sites(name)').eq('staff_id', me.id).eq('shift_date', today).maybeSingle(),
    sb.from('time_entries').select('*, sites(name)').eq('staff_id', me.id).is('actual_end', null).maybeSingle(),
    sb.from('sites').select('id,name,address,lat,lng,geofence_radius_m').eq('active', true),
  ]);
  const queued = getQueue();
  const pendingIn = queued.find(q => q.action === 'clock_in');
  const pendingOut = queued.find(q => q.action === 'clock_out');
  const onShift = (open && !pendingOut) || (!open && pendingIn);
  const startedAt = open ? open.actual_start : pendingIn?.p_client_time;

  pane.innerHTML = `
    ${sites?.length ? `<div id="here" class="here card"><span class="muted">📍 Finding your location…</span></div>` : ''}
    <div class="card hero">
      <div class="muted">${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
      ${planned
        ? `<h2 style="margin-top:.4rem">Planned: ${planned.expected_start.slice(0,5)}–${planned.expected_end.slice(0,5)}</h2>
           <div class="muted">${esc(planned.sites?.name || '')}${planned.unpaid_break_mins ? ` · ${planned.unpaid_break_mins} min break` : ''}</div>`
        : `<h2 style="margin-top:.4rem">No shift planned today</h2>`}
      <button id="clock" class="clock-btn ${onShift ? 'end' : 'start'}">${onShift ? 'End shift' : 'Start shift'}</button>
      ${onShift ? `<div class="muted">On shift since ${localTime(startedAt)}${open?.sites ? ` at ${esc(open.sites.name)}` : ''}</div>
                   <div class="elapsed" id="elapsed"></div>` : ''}
      ${queued.length ? `<div class="msg warn small">${queued.length} action(s) saved offline. They'll sync when you have signal.</div>` : ''}
      ${!sites?.length ? `<div class="msg warn small">No venues have been set up yet. Ask your manager.</div>` : ''}
      <div id="out"></div>
    </div>`;

  if (sites?.length) showNearbyVenue(sites, planned);

  if (onShift) {
    const tick = () => {
      const m = Math.floor((Date.now() - new Date(startedAt)) / 60000);
      const el = document.getElementById('elapsed');
      if (el) el.textContent = fmtHours(m);
    };
    tick(); timer = setInterval(tick, 30000);
  }
  document.getElementById('clock').onclick = (ev) => clockAction(onShift ? 'clock_out' : 'clock_in', ev.target);
}

async function clockAction(action, btn) {
  const out = document.getElementById('out');
  btn.disabled = true;
  out.innerHTML = `<div class="msg">Getting your location…</div>`;
  let pos;
  try {
    pos = await getPosition();
  } catch (e) {
    btn.disabled = false;
    out.innerHTML = `<div class="msg bad">${esc(locationErrorText(e))}</div>`;
    return;
  }
  const args = { p_lat: pos.coords.latitude, p_lng: pos.coords.longitude,
                 p_accuracy: pos.coords.accuracy, p_client_time: new Date().toISOString() };

  if (!navigator.onLine) {
    queue({ action, ...args });
    toast('No signal: saved on your phone and will sync automatically.');
    return render();
  }
  try {
    const res = await rpc(action, args);
    if (!res.ok) {
      btn.disabled = false;
      out.innerHTML = `<div class="msg bad">${esc(clockErrorText(res))}</div>`;
      return;
    }
    toast(action === 'clock_in' ? `Shift started at ${res.site} ✔` :
          res.entry.status === 'flagged' ? 'Shift ended. Your manager will review it.' : 'Shift ended ✔');
    render();
  } catch (e) {
    if (isNetworkError(e)) {
      queue({ action, ...args });
      toast('Connection dropped: saved on your phone and will sync automatically.');
      return render();
    }
    btn.disabled = false;
    out.innerHTML = `<div class="msg bad">${esc(e.message)}</div>`;
  }
}

async function renderHours() {
  const pane = document.getElementById('pane');
  const since = new Date(Date.now() - 28 * 86400000).toISOString();
  const [{ data: entries }, { data: plans }] = await Promise.all([
    sb.from('time_entries').select('*, sites(name)').eq('staff_id', me.id).gte('actual_start', since).order('actual_start', { ascending: false }),
    sb.from('planned_shifts').select('*').eq('staff_id', me.id).gte('shift_date', since.slice(0, 10)),
  ]);
  const { data: requests } = await sb.from('correction_requests').select('time_entry_id,status').eq('staff_id', me.id);
  const planById = Object.fromEntries((plans || []).map(p => [p.id, p]));
  const reqByEntry = Object.fromEntries((requests || []).map(r => [r.time_entry_id, r.status]));

  // Week starting Monday
  const now = new Date();
  const monday = new Date(now); monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  let weekMins = 0;

  const rows = (entries || []).map(e => {
    const c = calcEntry(e, planById[e.planned_shift_id], settings);
    if (new Date(e.actual_start) >= monday) weekMins += c.paidMins;
    const status = reqByEntry[e.id] === 'pending' ? '<span class="pill info">Change requested</span>'
      : e.status === 'flagged' ? '<span class="pill warn">Under review</span>'
      : e.status === 'approved' ? '<span class="pill ok">Approved</span>'
      : e.status === 'open' ? '<span class="pill info">On shift</span>' : '';
    return `
      <div class="shift-line">
        <div>
          <strong>${new Date(e.actual_start).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</strong>
          <div class="small muted">${localTime(e.actual_start)}–${e.actual_end ? localTime(e.actual_end) : '…'} · ${esc(e.sites?.name || '')}</div>
          <div>${status}</div>
        </div>
        <div style="text-align:right">
          <div><strong>${c.open ? '—' : fmtHours(c.paidMins)}</strong></div>
          ${reqByEntry[e.id] === 'pending' ? '' : `<button class="small" data-req="${e.id}">Request change</button>`}
        </div>
      </div>`;
  }).join('');

  pane.innerHTML = `
    <div class="card">
      <div class="muted small">This week (from Monday)</div>
      <div class="elapsed">${fmtHours(weekMins)} <span class="muted small">(${decimalHours(weekMins)} hrs)</span></div>
    </div>
    <div class="card">
      <h2>Last 4 weeks</h2>
      ${rows || '<p class="muted">No shifts yet.</p>'}
    </div>`;
  pane.querySelectorAll('[data-req]').forEach(b => b.onclick = () =>
    requestChange((entries || []).find(e => e.id === b.dataset.req)));
}

function requestChange(entry) {
  const d = localDate(entry.actual_start);
  dlg.innerHTML = `
    <form method="dialog" class="stack">
      <h2>Request a change</h2>
      <p class="muted small">Tell your manager what the correct times should be. They'll review it.</p>
      <div class="row">
        <label>Correct start<input type="time" name="s" value="${localTime(entry.actual_start)}"></label>
        <label>Correct end<input type="time" name="e" value="${entry.actual_end ? localTime(entry.actual_end) : ''}"></label>
      </div>
      <label>Reason<textarea name="note" rows="3" required placeholder="e.g. Forgot to tap End shift, left at 17:30"></textarea></label>
      <div class="row"><button value="cancel" formnovalidate>Cancel</button><button class="primary" value="ok">Send</button></div>
    </form>`;
  dlg.showModal();
  dlg.querySelector('form').onsubmit = async (ev) => {
    if (ev.submitter?.value !== 'ok') return;
    const f = new FormData(ev.target);
    const { londonDateTime } = await import('../shared/hours.js');
    const s = f.get('s') ? londonDateTime(d, f.get('s')) : null;
    let e = f.get('e') ? londonDateTime(d, f.get('e')) : null;
    if (s && e && e <= s) e = new Date(e.getTime() + 86400000);
    const { error } = await sb.from('correction_requests').insert({
      time_entry_id: entry.id, staff_id: me.id, note: f.get('note'),
      requested_start: s?.toISOString() ?? null, requested_end: e?.toISOString() ?? null,
    });
    toast(error ? `Couldn't send: ${error.message}` : 'Request sent to your manager');
    render();
  };
}

// ── Location ────────────────────────────────────────────────

// Shows which venue the person is at (or how far the nearest one is).
// Worked out on the phone only: this position is never sent to the server.
async function showNearbyVenue(sites, planned) {
  const box = document.getElementById('here');
  if (!box) return;
  let pos;
  try {
    pos = await getPosition({ maximumAge: 60000 });
  } catch (e) {
    if (box.isConnected) box.innerHTML = `<span class="muted small">📍 ${esc(locationErrorText(e))}</span>`;
    return;
  }
  if (!box.isConnected) return; // user switched tabs meanwhile
  const { latitude, longitude, accuracy } = pos.coords;
  const ranked = sites
    .map(s => ({ ...s, d: distanceM(latitude, longitude, s.lat, s.lng) }))
    .sort((a, b) => a.d - b.d);
  const near = ranked[0];
  const at = near.d <= near.geofence_radius_m;
  const fmtDist = m => m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
  const wrongVenue = at && planned && planned.site_id !== near.id;

  box.className = `here card ${at ? 'at' : 'away'}`;
  box.innerHTML = at
    ? `<div class="here-icon">📍</div>
       <div><div class="small muted">You're at</div>
         <div class="here-name">${esc(near.name)}</div>
         ${near.address ? `<div class="small muted">${esc(near.address)}</div>` : ''}
         ${wrongVenue ? `<div class="small" style="color:var(--warn)">Your planned shift today is at ${esc(planned.sites?.name || 'another venue')}.</div>` : ''}
       </div>`
    : `<div class="here-icon">🧭</div>
       <div><div class="small muted">Not at a Fun Fest venue</div>
         <div class="here-name">Nearest: ${esc(near.name)}</div>
         <div class="small muted">About ${fmtDist(near.d)} away${accuracy > 100 ? ` · GPS accuracy ±${Math.round(accuracy)} m` : ''}</div>
       </div>
       <button class="small here-refresh" aria-label="Check location again">↻</button>`;
  box.querySelector('.here-refresh')?.addEventListener('click', () => {
    box.innerHTML = `<span class="muted">📍 Finding your location…</span>`;
    showNearbyVenue(sites, planned);
  });
}

function getPosition(opts = {}) {
  if (isNative) return nativePosition(opts);
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject({ code: 'unsupported' });
    navigator.geolocation.getCurrentPosition(resolve, reject,
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0, ...opts });
  });
}

function locationErrorText(e) {
  if (e.code === 1) return isNative ? 'Location is switched off for Fun Fest. Go to Settings → Fun Fest → Location and choose "While Using the App", then try again.' : 'Location permission is blocked. Turn it on for this app in your phone settings (Settings → Privacy → Location), then try again.';
  if (e.code === 2) return "Your phone couldn't find your location. Step outside or near a window and try again.";
  if (e.code === 3) return 'Finding your location took too long. Please try again.';
  if (e.code === 'unsupported') return "This phone/browser doesn't support location.";
  return e.message || 'Location error';
}

function clockErrorText(res) {
  switch (res.error) {
    case 'outside_geofence': return `You're about ${res.distance_m} m from ${res.site}. You need to be at the venue to start your shift.`;
    case 'already_on_shift': return "You're already on shift.";
    case 'not_on_shift': return "You're not on shift.";
    case 'no_sites': return 'No venues have been set up yet. Ask your manager.';
    case 'no_consent': return 'Please accept the location notice first.';
    case 'not_registered': return "Your account isn't registered with Fun Fest.";
    default: return res.error || 'Something went wrong';
  }
}

// ── Offline queue ───────────────────────────────────────────

function getQueue() { try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; } catch { return []; } }
function setQueue(q) { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch {} }
function queue(item) { setQueue([...getQueue(), item]); }

async function flushQueue() {
  const q = getQueue();
  if (!q.length || !navigator.onLine) return;
  const remaining = [];
  for (const item of q) {
    const { action, ...args } = item;
    try {
      const res = await rpc(action, args);
      if (!res.ok) toast(`An offline ${action === 'clock_in' ? 'start' : 'end'} couldn't be saved: ${clockErrorText(res)}`);
    } catch (e) {
      if (isNetworkError(e)) { remaining.push(item); } else { toast(e.message); }
    }
  }
  setQueue(remaining);
}

function isNetworkError(e) {
  return !navigator.onLine || /fetch|network|load failed/i.test(e?.message || '');
}

// ── Install hint ────────────────────────────────────────────

function installHint() {
  if (isNative) return '';
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) return '';
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  return `
    <details class="card install">
      <summary><strong>Add Fun Fest to your home screen</strong></summary>
      ${ios
        ? `<ol><li>Open this page in <strong>Safari</strong>.</li><li>Tap the <strong>Share</strong> button (square with arrow).</li><li>Tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li></ol>`
        : `<ol><li>Open this page in <strong>Chrome</strong>.</li><li>Tap the <strong>⋮</strong> menu.</li><li>Tap <strong>Add to Home screen</strong> or <strong>Install app</strong>.</li></ol>`}
    </details>`;
}
