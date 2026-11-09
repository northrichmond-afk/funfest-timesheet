import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { isNative, plugin, authRedirect, parseAuthLink } from './native.js';

export const configured = !SUPABASE_URL.includes('YOUR-PROJECT-REF');

// Captured before the client reads (and clears) the URL: true when the page was
// opened from a "reset your password" email link.
export const isPasswordRecovery = /type=recovery/.test(location.hash + location.search);

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

// Google sign-in. On the website it redirects this page; in the iPhone app it opens
// a Safari sheet (Google blocks sign-in inside embedded web views) and comes back by deep link.
export async function signInWithGoogle() {
  const options = { redirectTo: authRedirect(), queryParams: { prompt: 'select_account' } };
  if (!isNative) return sb.auth.signInWithOAuth({ provider: 'google', options });
  const { data, error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { ...options, skipBrowserRedirect: true } });
  if (error) throw error;
  await plugin('Browser').open({ url: data.url, presentationStyle: 'popover' });
}

// iPhone app only: handle sign-in / email-confirmation / password-reset links that open the app.
// onDone({ recovery, error }) is called after the session has been stored.
export function listenForAuthLinks(onDone) {
  if (!isNative) return;
  const handle = async (url) => {
    const link = parseAuthLink(url);
    if (!link) return;
    try { await plugin('Browser').close(); } catch {}
    if (link.error) return onDone({ error: link.error });
    if (link.access_token && link.refresh_token) {
      const { error } = await sb.auth.setSession({ access_token: link.access_token, refresh_token: link.refresh_token });
      onDone({ recovery: link.type === 'recovery', error: error?.message });
    }
  };
  const App = plugin('App');
  App.addListener('appUrlOpen', e => handle(e.url));
  App.getLaunchUrl().then(r => r?.url && handle(r.url)).catch(() => {});
}

export async function signOut() {
  await sb.auth.signOut();
  location.reload();
}

// Links the Google login to the allow-listed staff record. Returns the staff row or null.
export async function registerLogin() {
  const { data, error } = await sb.rpc('register_login');
  if (error) throw error;
  return data.ok ? data.staff : null;
}

// Calls an RPC that returns {ok, ...}; throws Error on transport/database errors.
export async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}
