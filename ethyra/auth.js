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
 * ── The backend seam this depends on ──────────────────────────────────
 *
 * `POST /api/auth/refresh` already accepts a refresh token from the JSON body
 * as well as from the cookie. What it does NOT yet do is RETURN one in the
 * body — it only ever sets the cookie. That is a small backend change gated on
 * an `X-Client: extension` header; until it lands, sign-in here will succeed and
 * the first refresh will fail.
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
