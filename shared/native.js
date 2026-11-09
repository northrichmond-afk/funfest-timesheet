// Helpers for running inside the iPhone app (Capacitor). On the website these are no-ops.
const Cap = typeof window !== 'undefined' ? window.Capacitor : undefined;

export const isNative = !!Cap?.isNativePlatform?.();
export const APP_SCHEME = 'uk.co.funfestholidayclub.timesheet';
export const NATIVE_REDIRECT = `${APP_SCHEME}://auth`;

const plugins = {};
export function plugin(name) {
  if (!isNative) return null;
  return (plugins[name] ??= Cap.registerPlugin(name));
}

// Where sign-in, confirmation and password-reset links should come back to
export function authRedirect() {
  return isNative ? NATIVE_REDIRECT : location.origin + location.pathname;
}

// Same shape as navigator.geolocation.getCurrentPosition, with the same error codes
// (1 = permission denied, 2 = unavailable, 3 = timeout)
export async function nativePosition({ enableHighAccuracy = true, timeout = 20000, maximumAge = 0 } = {}) {
  try {
    return await plugin('Geolocation').getCurrentPosition({ enableHighAccuracy, timeout, maximumAge });
  } catch (e) {
    const m = String(e?.message || e).toLowerCase();
    const code = /denied|permission|not authorized|disabled/.test(m) ? 1 : /time ?out/.test(m) ? 3 : 2;
    throw { code, message: e?.message };
  }
}

// Parses tokens from a deep link like uk.co...://auth#access_token=...&refresh_token=...&type=recovery
export function parseAuthLink(url) {
  if (!url || !url.startsWith(APP_SCHEME + '://')) return null;
  const i = url.search(/[#?]/);
  const params = new URLSearchParams(i >= 0 ? url.slice(i + 1).replace('?', '&').replace('#', '&') : '');
  return {
    access_token: params.get('access_token'),
    refresh_token: params.get('refresh_token'),
    type: params.get('type'),
    error: params.get('error_description') || params.get('error'),
  };
}
