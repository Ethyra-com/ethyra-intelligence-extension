/**
 * The Ethyra session, held by the service worker.
 *
 * Original to this fork. Upstream has no server and no accounts.
 *
 * ── Headless WorkOS, matching the web app ─────────────────────────────
 *
 * The Intelligence backend runs AuthKit headlessly: credentials are POSTed to
 * `/api/auth/sign-in`, an access token comes back in the body, and every
 * subsequent call carries `Authorization: Bearer`. No hosted redirect, no PKCE
 * dance, no `chrome.identity`. The extension uses the same endpoints as the web
 * app, so there is one auth implementation to reason about rather than two.
 *
 * ── Why the refresh token is stored, and the access token is not ──────
 *
 * The web app keeps its access token in a React ref and its refresh token in an
 * httpOnly cookie. Neither is available here: an MV3 service worker is killed
 * aggressively — a few seconds of idle is enough — so in-memory state does not
 * survive between a student clicking Export and the upload finishing, and JS
 * cannot read an httpOnly cookie.
 *
 * So the refresh token lives in `chrome.storage.local`. That is a real widening
 * of the web app's posture and worth naming: anything with access to the
 * extension's storage can mint access tokens until the refresh token is
 * revoked. It is mitigated by scope — only this extension's own pages and
 * service worker can read it — and it is the price of working at all in MV3.
 *
 * The access token is cached in memory with its expiry, and refreshed on
 * demand. Losing it to a worker restart costs one round trip.
 *
 * ── This runs in the SERVICE WORKER, and that is load-bearing ─────────
 *
 * `auth.js` is `importScripts`'d by `background.js` and is deliberately absent
 * from the content-script list in `manifest.json`. Nothing here may ever run in
 * the Canvas page, and a future change that adds it to that list is a security
 * regression rather than a convenience.
 *
 * Two reasons, and the second is the important one:
 *
 * 1. A worker fetch to a host in `host_permissions` is exempt from CORS, so the
 *    backend does not have to admit any extension origin to serve these routes.
 *    `https://api.ethyra.com/*` is listed there for exactly this.
 *
 * 2. **A content script shares its origin with the page it runs in, for CORS
 *    purposes.** Anything the page's own scripts could be allowed to call, they
 *    could call too. Authenticating from the Canvas page would mean the backend
 *    admitting Canvas origins on `/api/auth/*` — and since the refresh cookie is
 *    `SameSite=None` and `/refresh` needs no bearer token, any script on any
 *    Canvas page could then trade that cookie for a readable access token.
 *
 * The backend enforces its half: Canvas origins are scoped to the upload route
 * only, and a refresh authenticated by the cookie never returns a token in the
 * body whatever header it carries. Both halves have to hold.
 *
 * ── The backend seam this depends on ──────────────────────────────────
 *
 * `POST /api/auth/refresh` accepts a refresh token from the JSON body as well as
 * from the cookie, and returns a rotated one in the body when `X-Client:
 * extension` is set AND the call authenticated from the body rather than a
 * cookie. Both conditions are needed; see `app/routers/auth.py`.
 */

const ETHYRA_STORAGE_KEY = "ethyra_session";

/** Refresh this far ahead of expiry, so a long upload does not 401 mid-flight. */
const TOKEN_SKEW_SECONDS = 120;

/** In-memory only; a worker restart drops it and costs one refresh. */
let accessToken = null;
let accessTokenExpiresAt = 0;

/** Concurrent callers share one refresh rather than racing to spend the token. */
let refreshInFlight = null;

async function readSession() {
  const stored = await chrome.storage.local.get(ETHYRA_STORAGE_KEY);
  return stored[ETHYRA_STORAGE_KEY] || null;
}

async function writeSession(session) {
  await chrome.storage.local.set({ [ETHYRA_STORAGE_KEY]: session });
}

async function clearSession() {
  accessToken = null;
  accessTokenExpiresAt = 0;
  refreshInFlight = null;
  await chrome.storage.local.remove(ETHYRA_STORAGE_KEY);
}

/** Seconds since the epoch, from a JWT's `exp`, or 0 when it cannot be read. */
function expiryOf(token) {
  try {
    const [, payload] = token.split(".");
    const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return Number(claims.exp) || 0;
  } catch {
    return 0;
  }
}

function cacheAccessToken(token) {
  accessToken = token || null;
  accessTokenExpiresAt = token ? expiryOf(token) : 0;
}

async function ethyraFetch(apiUrl, path, options = {}) {
  return fetch(`${apiUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      // Asks the backend to return the refresh token in the body rather than
      // only as an httpOnly cookie a service worker cannot read.
      "X-Client": "extension",
      ...(options.headers || {}),
    },
  });
}

/**
 * Sign in with email and password.
 *
 * Throws with the backend's own message where there is one — "that password is
 * wrong" is more use to a student than "401".
 */
async function signIn(apiUrl, email, password) {
  const res = await ethyraFetch(apiUrl, "/api/auth/sign-in", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || data.message || `Sign-in failed (${res.status})`);

  cacheAccessToken(data.access_token);
  await writeSession({
    apiUrl,
    refreshToken: data.refresh_token || null,
    user: data.user || null,
  });
  return data.user || null;
}

/**
 * Create an account, and land signed in.
 *
 * ── Why this can exist without a single WorkOS credential here ────────
 *
 * The extension never holds `WORKOS_API_KEY` or `WORKOS_CLIENT_ID`, and must
 * never be changed so that it does. An extension bundle is world-readable —
 * anyone can unpack a published `.crx` and read every file in it — so a secret
 * shipped here is a secret published. The backend holds them and calls WorkOS
 * server-side; this sends an email and a password to `/api/auth/sign-up` and
 * gets tokens back, exactly as sign-in does.
 *
 * ── The backend signs the new user in for us ──────────────────────────
 *
 * `/api/auth/sign-up` creates the WorkOS user and then authenticates, returning
 * the same body `/sign-in` does. So there is no second round trip and no window
 * where an account exists that the student is not yet signed in to.
 *
 * Its failure modes are already worded for a person and are passed through
 * untouched — including the one that matters most, where the account WAS
 * created but the password did not register. That message routes them to
 * Forgot password, which works on an account in that state, where "try signing
 * up again" would dead-end on "already exists".
 *
 * ── `acceptTerms` is a parameter, never a default ─────────────────────
 *
 * The backend rejects a sign-up without it, and the honest reason is that it is
 * consent: it must come from a control the student actually ticked. Defaulting
 * it to `true` here would clear the check by asserting, on their behalf, a thing
 * only they can say.
 */
async function signUp(apiUrl, { email, password, acceptTerms, firstName, lastName }) {
  const res = await ethyraFetch(apiUrl, "/api/auth/sign-up", {
    method: "POST",
    body: JSON.stringify({
      email,
      password,
      accept_terms: acceptTerms === true,
      first_name: firstName || null,
      last_name: lastName || null,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || data.message || `Sign-up failed (${res.status})`);

  cacheAccessToken(data.access_token);
  await writeSession({
    apiUrl,
    refreshToken: data.refresh_token || null,
    user: data.user || null,
  });
  return data.user || null;
}

async function signOut(apiUrl) {
  const session = await readSession();
  try {
    await ethyraFetch(apiUrl || session?.apiUrl, "/api/auth/sign-out", {
      method: "POST",
      body: JSON.stringify({ refresh_token: session?.refreshToken || null }),
    });
  } catch {
    // A sign-out that cannot reach the server still has to clear the device.
  }
  await clearSession();
}

/**
 * A usable access token, refreshing when needed.
 *
 * Returns null when there is no session, which the popup reads as "show the
 * sign-in form" rather than as an error.
 */
async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (accessToken && accessTokenExpiresAt - TOKEN_SKEW_SECONDS > now) return accessToken;

  const session = await readSession();
  if (!session?.refreshToken) return null;

  // One refresh at a time. Two callers racing would spend the refresh token
  // twice, and a rotating-token backend invalidates the loser's session.
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const res = await ethyraFetch(session.apiUrl, "/api/auth/refresh", {
          method: "POST",
          body: JSON.stringify({ refresh_token: session.refreshToken }),
        });
        if (!res.ok) {
          // Expired or revoked. Clearing it is what puts the student back at a
          // sign-in form instead of a button that fails forever.
          await clearSession();
          return null;
        }
        const data = await res.json();
        cacheAccessToken(data.access_token);
        await writeSession({
          ...session,
          refreshToken: data.refresh_token || session.refreshToken,
          user: data.user || session.user,
        });
        return accessToken;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

/** Who is signed in, without a network call. Null when nobody is. */
async function currentUser() {
  const session = await readSession();
  return session?.user || null;
}
