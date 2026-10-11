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

async function store(clientId, tok) {
  const expiresAt = Date.now() + (tok.expires_in || 3600) * 1000 - 60000; // 1-min skew
  await chrome.storage.local.set({
    [KEY]: { clientId, accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt },
  });
}

export function getRedirectUri() {
  return chrome.identity.getRedirectURL();
}

// Returns a valid Graph access token, acquiring/refreshing as needed. Only does
// an interactive sign-in (a Microsoft login popup) when `interactive` is true.
export async function getGraphToken(clientId, interactive) {
  if (!clientId) throw new Error("No Azure Client ID is set in Options.");
  const cached = (await chrome.storage.local.get(KEY))[KEY];
  if (cached && cached.clientId === clientId) {
    if (cached.accessToken && Date.now() < cached.expiresAt) return cached.accessToken;
    if (cached.refreshToken) {
      try {
        const t = await exchange({
          client_id: clientId, grant_type: "refresh_token",
          refresh_token: cached.refreshToken, scope: SCOPES,
        });
        await store(clientId, t);
        return t.access_token;
      } catch (e) {
        /* refresh expired/revoked — fall through to interactive */
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
      client_id: clientId, response_type: "code", redirect_uri: redirect, scope: SCOPES,
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
    redirect_uri: redirect, code_verifier: verifier, scope: SCOPES,
  });
  await store(clientId, tok);
  return tok.access_token;
}
