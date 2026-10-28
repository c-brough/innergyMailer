/* InnerCider — Microsoft Graph auth via chrome.identity (host-free)
 *
 * The "Outlook on the web — compose & send here" option sends mail straight from
 * the extension through Microsoft Graph, so it needs its own access token (the
 * native-host device-code flow caches its token inside the host, out of reach).
 * This does the standard Authorization-Code-with-PKCE flow against the user's
 * Azure app using chrome.identity.launchWebAuthFlow, and caches the refresh
 * token in chrome.storage.local for silent reuse.
 *
 * Azure app setup (one-time, same Client ID as the device-code option):
 *   - Add a redirect URI under the "Single-page application" platform:
 *       https://<extension-id>.chromiumapp.org/   (shown on the Options page)
 *     It MUST be SPA, not "Mobile and desktop" — the token is redeemed
 *     cross-origin (the extension sends an Origin header), which Azure permits
 *     only for the SPA client type (else AADSTS9002326).
 *   - Add the delegated permission Mail.Send.
 */

const AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";
// offline_access → refresh token; Mail.Send → POST /me/sendMail.
const SCOPES = "offline_access openid https://graph.microsoft.com/Mail.Send";
const KEY = "graphIdentityToken";

// Meeting workflow (Teams/Outlook invites) — a SEPARATE token so its broader
// consent (incl. the admin-gated Place.Read.All for rooms) never blocks the
// mail-send users above. User.Read → /me (organizer email); Calendars.ReadWrite
// → create events + getSchedule free/busy; People.Read → 365 contacts
// autocomplete; Place.Read.All → list Teams Rooms (requires admin consent).
const G = "https://graph.microsoft.com/";
const MEETING_SCOPES =
  "offline_access openid " +
  G + "User.Read " + G + "Calendars.ReadWrite " + G + "People.Read " + G + "Place.Read.All";
const MEETING_KEY = "graphMeetingToken";

function b64url(bytes) {
  let s = "";
  const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sha256(str) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
}
function randomVerifier() {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  return b64url(a);
}

async function exchange(params) {
  const r = await fetch(AUTHORITY + "/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.error || "token HTTP " + r.status);
  return j;
}

async function store(key, clientId, tok) {
  const expiresAt = Date.now() + (tok.expires_in || 3600) * 1000 - 60000; // 1-min skew
  // A refresh response may omit refresh_token — keep the previous one then.
  const prev = (await chrome.storage.local.get(key))[key] || {};
  await chrome.storage.local.set({
    [key]: {
      clientId,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token || prev.refreshToken,
      expiresAt,
    },
  });
}

export function getRedirectUri() {
  return chrome.identity.getRedirectURL();
}

// Core acquire/refresh/interactive flow, parameterized by scope set + cache key
// so the mail-send and meeting features keep independent tokens.
async function acquireToken(clientId, interactive, scopes, key) {
  if (!clientId) throw new Error("No Azure Client ID is set in Options.");
  const cached = (await chrome.storage.local.get(key))[key];
  if (cached && cached.clientId === clientId) {
    if (cached.accessToken && Date.now() < cached.expiresAt) return cached.accessToken;
    if (cached.refreshToken) {
      try {
        const t = await exchange({
          client_id: clientId, grant_type: "refresh_token",
          refresh_token: cached.refreshToken, scope: scopes,
        });
        await store(key, clientId, t);
        return t.access_token;
      } catch (e) {
        /* refresh expired/revoked/scope-changed — fall through to interactive */
      }
    }
  }
  if (!interactive) throw new Error("Not signed in to Microsoft.");

  const redirect = chrome.identity.getRedirectURL();
  const verifier = randomVerifier();
  const challenge = b64url(await sha256(verifier));
  const authUrl =
    AUTHORITY + "/authorize?" +
    new URLSearchParams({
      client_id: clientId, response_type: "code", redirect_uri: redirect, scope: scopes,
      code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account",
    });
  const redirectResp = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, (r) => {
      if (chrome.runtime.lastError || !r) {
        reject(new Error(chrome.runtime.lastError ? chrome.runtime.lastError.message : "Sign-in was cancelled."));
      } else resolve(r);
    });
  });
  const code = new URL(redirectResp).searchParams.get("code");
  if (!code) {
    const err = new URL(redirectResp).searchParams.get("error_description");
    throw new Error(err || "No authorization code returned.");
  }
  const tok = await exchange({
    client_id: clientId, grant_type: "authorization_code", code,
    redirect_uri: redirect, code_verifier: verifier, scope: scopes,
  });
  await store(key, clientId, tok);
  return tok.access_token;
}

// Mail.Send token (Outlook-on-the-web compose & send).
export function getGraphToken(clientId, interactive) {
  return acquireToken(clientId, interactive, SCOPES, KEY);
}

// Meeting-workflow token (calendar/people/rooms). Separate consent + cache.
export function getMeetingToken(clientId, interactive) {
  return acquireToken(clientId, interactive, MEETING_SCOPES, MEETING_KEY);
}
