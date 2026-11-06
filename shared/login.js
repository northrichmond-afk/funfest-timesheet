// Sign-in screen shared by the staff app and admin pages:
// Google, or email + password (create password, forgot password, set new password).
import { sb, signInWithGoogle } from './supabase.js';
import { GOOGLE_ICON, esc } from './ui.js';

const MIN_PASSWORD = 8;
const here = () => location.origin + location.pathname;

/**
 * Renders the sign-in card into `el`.
 * opts: { title, intro, footer }  footer = extra HTML under the card (e.g. install hint)
 */
export function renderLogin(el, opts = {}, mode = 'signin', notice = '') {
  const { title = 'Sign in', intro = '', footer = '' } = opts;
  const again = (m, n = '') => renderLogin(el, opts, m, n);
  const forms = {
    signin: `
      <form id="pw" class="stack" autocomplete="on">
        <label>Email<input name="email" type="email" required autocomplete="username"></label>
        <label>Password<input name="password" type="password" required autocomplete="current-password"></label>
        <button class="primary">Sign in</button>
      </form>
      <p class="small"><a href="#" data-go="forgot">Forgot password?</a></p>
      <p class="small muted">No password yet? <a href="#" data-go="signup">Create one</a></p>`,
    signup: `
      <h2>Create a password</h2>
      <p class="small muted">Use the email address your manager registered for you.</p>
      <form id="pw" class="stack">
        <label>Email<input name="email" type="email" required autocomplete="username"></label>
        <label>New password (at least ${MIN_PASSWORD} characters)<input name="password" type="password" required minlength="${MIN_PASSWORD}" autocomplete="new-password"></label>
        <label>Confirm password<input name="password2" type="password" required minlength="${MIN_PASSWORD}" autocomplete="new-password"></label>
        <button class="primary">Create password</button>
      </form>
      <p class="small"><a href="#" data-go="signin">Back to sign in</a></p>`,
    forgot: `
      <h2>Reset your password</h2>
      <p class="small muted">Enter your email and we'll send you a link to set a new password.</p>
      <form id="pw" class="stack">
        <label>Email<input name="email" type="email" required autocomplete="username"></label>
        <button class="primary">Send reset link</button>
      </form>
      <p class="small"><a href="#" data-go="signin">Back to sign in</a></p>`,
  };

  el.innerHTML = `
    <div class="card stack login">
      <h1 class="center">${esc(title)}</h1>
      ${intro ? `<p class="muted center">${intro}</p>` : ''}
      ${notice}
      ${mode === 'signin' ? `
        <div class="center"><button class="google-btn" id="g">${GOOGLE_ICON} Sign in with Google</button></div>
        <div class="divider"><span>or use email and password</span></div>` : ''}
      ${forms[mode]}
      <div id="loginMsg"></div>
    </div>
    ${footer}`;

  el.querySelector('#g')?.addEventListener('click', () => signInWithGoogle());
  el.querySelectorAll('[data-go]').forEach(a => a.onclick = (e) => { e.preventDefault(); again(a.dataset.go); });

  const msg = (cls, text) => { el.querySelector('#loginMsg').innerHTML = `<div class="msg ${cls}">${text}</div>`; };
  el.querySelector('#pw').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target));
    const email = (f.email || '').trim().toLowerCase();
    const btn = ev.target.querySelector('button');
    btn.disabled = true;
    try {
      if (mode === 'signin') {
        const { error } = await sb.auth.signInWithPassword({ email, password: f.password });
        if (error) throw error;
        location.reload();
        return;
      }
      if (mode === 'signup') {
        if (f.password !== f.password2) { msg('bad', "The passwords don't match."); btn.disabled = false; return; }
        const { data, error } = await sb.auth.signUp({ email, password: f.password, options: { emailRedirectTo: here() } });
        if (error) throw error;
        if (data.session) { location.reload(); return; } // email confirmation switched off
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          // Email already has an account (e.g. they signed in with Google before)
          again('forgot', `<div class="msg warn">This email already has an account. Enter it below and we'll email you a link to set a password.</div>`);
          return;
        }
        again('signin', `<div class="msg ok">Nearly done! We've sent an email to <strong>${esc(email)}</strong>. Open it and tap the link to confirm, then sign in here.</div>`);
        return;
      }
      if (mode === 'forgot') {
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: here() });
        if (error) throw error;
        again('signin', `<div class="msg ok">If <strong>${esc(email)}</strong> has a password set up, we've emailed a link to reset it. Check your inbox (and spam).</div>`);
        return;
      }
    } catch (e) {
      btn.disabled = false;
      msg('bad', esc(friendlyAuthError(e)));
    }
  };
}

/** "Set a new password" screen, shown after opening the reset link from the email. */
export function renderNewPassword(el, onDone) {
  el.innerHTML = `
    <div class="card stack login">
      <h1 class="center">Set a new password</h1>
      <form id="np" class="stack">
        <label>New password (at least ${MIN_PASSWORD} characters)<input name="password" type="password" required minlength="${MIN_PASSWORD}" autocomplete="new-password"></label>
        <label>Confirm password<input name="password2" type="password" required minlength="${MIN_PASSWORD}" autocomplete="new-password"></label>
        <button class="primary">Save new password</button>
      </form>
      <div id="loginMsg"></div>
    </div>`;
  el.querySelector('#np').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target));
    const out = el.querySelector('#loginMsg');
    if (f.password !== f.password2) { out.innerHTML = `<div class="msg bad">The passwords don't match.</div>`; return; }
    const { error } = await sb.auth.updateUser({ password: f.password });
    if (error) { out.innerHTML = `<div class="msg bad">${esc(friendlyAuthError(error))}</div>`; return; }
    history.replaceState(null, '', location.pathname);
    out.innerHTML = `<div class="msg ok">Password saved. You're signed in.</div>`;
    setTimeout(onDone, 900);
  };
}

export function friendlyAuthError(e) {
  const m = (e?.message || '').toLowerCase();
  if (m.includes('invalid login')) return 'Email or password is incorrect.';
  if (m.includes('not confirmed')) return "Your email isn't confirmed yet. Open the link we emailed you, then sign in.";
  if (m.includes('already registered') || m.includes('already been registered')) return 'This email already has a password. Sign in, or use "Forgot password?".';
  if (m.includes('not on the fun fest staff list') || m.includes('not registered')) return "This email isn't on the Fun Fest staff list. Ask your manager to add it.";
  if (m.includes('rate limit') || m.includes('too many') || e?.status === 429) return 'Too many attempts. Please wait a few minutes and try again.';
  if (m.includes('password') && (m.includes('short') || m.includes('at least') || m.includes('weak'))) return `Please choose a stronger password (at least ${MIN_PASSWORD} characters).`;
  if (m.includes('same') && m.includes('password')) return 'Your new password must be different from the old one.';
  if (m.includes('expired') || (m.includes('invalid') && m.includes('link'))) return 'This link has expired. Please request a new one.';
  return e?.message || 'Something went wrong. Please try again.';
}
