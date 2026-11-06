import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const configured = !SUPABASE_URL.includes('YOUR-PROJECT-REF');

// Captured before the client reads (and clears) the URL: true when the page was
// opened from a "reset your password" email link.
export const isPasswordRecovery = /type=recovery/.test(location.hash + location.search);

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

// Google sign-in, returning to the current page
export function signInWithGoogle() {
  const redirectTo = location.origin + location.pathname;
  return sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo, queryParams: { prompt: 'select_account' } },
  });
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
