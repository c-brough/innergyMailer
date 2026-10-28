/* InnerCider — background: Teams/Outlook meeting workflow via Microsoft Graph
 *
 * Reuses the per-person Azure Client ID through a dedicated meeting-scoped token
 * (getMeetingToken). All calls run here in the worker against graph.microsoft.com
 * with that bearer token — host-free, so it works on Mac/Windows/Linux.
 *
 * Capabilities:
 *   • peopleSearch  — 365 contacts autocomplete       (People.Read)
 *   • getSchedule   — attendee/room free-busy          (Calendars.ReadWrite)
 *   • listRooms     — Teams Rooms in the tenant         (Place.Read.All, admin consent)
 *   • createMeeting — Teams online meeting + invite     (Calendars.ReadWrite)
 *   • verify        — interactive sign-in, then probe each of the above so the
 *                     Options page can report exactly what the tenant allows
 *                     (surfacing the admin-consent requirement for rooms).
 *
 * Message types (router in background.js): MEETING_VERIFY, MEETING_PEOPLE_SEARCH,
 * MEETING_GET_SCHEDULE, MEETING_LIST_ROOMS, MEETING_CREATE.
 */

import { getMeetingToken } from "../shared/graph-identity.js";

const GRAPH = "https://graph.microsoft.com/v1.0";

function tz() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch (e) { return "UTC"; }
}

async function clientId() {
  const d = await chrome.storage.local.get("azureClientId");
  return d.azureClientId || "";
}

async function gfetch(token, path, init) {
  const r = await fetch(GRAPH + path, {
    ...init,
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", ...(init && init.headers) },
  });
  let body = null;
  try { body = await r.json(); } catch (e) { /* no body */ }
  if (!r.ok) {
    const msg = (body && body.error && (body.error.message || body.error.code)) || ("HTTP " + r.status);
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return body;
}

// ---- Graph helpers ----------------------------------------------------------
async function me(token) {
  const j = await gfetch(token, "/me?$select=displayName,mail,userPrincipalName");
  return { name: j.displayName || "", email: j.mail || j.userPrincipalName || "" };
}

async function peopleSearch(token, q) {
  const query = String(q || "").trim();
  if (!query) return [];
  const j = await gfetch(
    token,
    "/me/people?$search=" + encodeURIComponent('"' + query + '"') +
      "&$top=15&$select=displayName,scoredEmailAddresses,personType"
  );
  const out = [];
  for (const p of (j && j.value) || []) {
    const addr = (p.scoredEmailAddresses && p.scoredEmailAddresses[0] && p.scoredEmailAddresses[0].address) || "";
    if (!addr) continue;
    out.push({ name: p.displayName || addr, email: addr });
  }
  return out;
}

async function getSchedule(token, emails, startISO, endISO, intervalMin) {
  const list = (emails || []).filter(Boolean);
  if (!list.length) return [];
  const j = await gfetch(token, "/me/calendar/getSchedule", {
    method: "POST",
    body: JSON.stringify({
      schedules: list,
      startTime: { dateTime: startISO, timeZone: tz() },
      endTime: { dateTime: endISO, timeZone: tz() },
      availabilityViewInterval: intervalMin || 30,
    }),
  });
  // availabilityView is a string of digits: 0 free,1 tentative,2 busy,3 OOF,4 WElsewhere.
  return ((j && j.value) || []).map((s) => ({
    email: s.scheduleId,
    availabilityView: s.availabilityView || "",
    items: (s.scheduleItems || []).map((it) => ({ status: it.status, start: it.start, end: it.end })),
    error: s.error ? (s.error.message || "unavailable") : null,
  }));
}

async function listRooms(token) {
  const j = await gfetch(token, "/places/microsoft.graph.room?$top=100&$select=displayName,emailAddress,building,floorLabel,capacity");
  return ((j && j.value) || [])
    .filter((r) => r.emailAddress)
    .map((r) => ({
      name: r.displayName || r.emailAddress,
      email: r.emailAddress,
      building: r.building || "",
      floor: r.floorLabel || "",
      capacity: r.capacity || null,
    }));
}

async function createMeeting(token, m) {
  const attendees = [];
  for (const a of m.attendees || []) {
    if (a && a.email) attendees.push({ emailAddress: { address: a.email, name: a.name || a.email }, type: a.type || "required" });
  }
  if (m.roomEmail) {
    attendees.push({ emailAddress: { address: m.roomEmail, name: m.roomName || m.roomEmail }, type: "resource" });
  }
  const event = {
    subject: m.subject || "Meeting",
    body: { contentType: "HTML", content: m.bodyHtml || "" },
    start: { dateTime: m.startISO, timeZone: m.timeZone || tz() },
    end: { dateTime: m.endISO, timeZone: m.timeZone || tz() },
    attendees,
    isOnlineMeeting: true,
    onlineMeetingProvider: "teamsForBusiness",
  };
  if (m.roomEmail) event.location = { displayName: m.roomName || m.roomEmail, locationEmailAddress: m.roomEmail };
  const j = await gfetch(token, "/me/events", { method: "POST", body: JSON.stringify(event) });
  return {
    id: j.id,
    webLink: j.webLink || "",
    joinUrl: (j.onlineMeeting && j.onlineMeeting.joinUrl) || "",
  };
}

// ---- message handlers -------------------------------------------------------
function run(sendResponse, fn) {
  (async () => {
    try {
      const cid = await clientId();
      if (!cid) { sendResponse({ ok: false, error: "No Azure Client ID is set in Options." }); return; }
      sendResponse({ ok: true, ...(await fn(cid)) });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e), status: e && e.status });
    }
  })();
}

// Interactive sign-in, then probe each capability and report what works.
export function handleMeetingVerify(msg, sender, sendResponse) {
  run(sendResponse, async (cid) => {
    const token = await getMeetingToken(cid, true); // interactive — triggers consent
    const whoami = await me(token).catch((e) => ({ error: String(e.message || e) }));
    const probe = async (fn) => { try { await fn(); return { ok: true }; } catch (e) { return { ok: false, error: String(e.message || e) }; } };
    const now = new Date();
    const inHour = new Date(now.getTime() + 3600000);
    const result = {
      user: whoami,
      people: await probe(() => peopleSearch(token, "a")),
      freeBusy: await probe(() => getSchedule(token, [whoami.email].filter(Boolean), now.toISOString().slice(0, 19), inHour.toISOString().slice(0, 19), 30)),
      rooms: await probe(() => listRooms(token)),
    };
    // Creating a Teams meeting uses the same Calendars scope as free/busy.
    result.createMeeting = { ok: result.freeBusy.ok, error: result.freeBusy.ok ? undefined : "needs Calendars.ReadWrite consent" };
    return { result };
  });
}

export function handleMeetingPeopleSearch(msg, sender, sendResponse) {
  run(sendResponse, async (cid) => ({ people: await peopleSearch(await getMeetingToken(cid, false), msg.q) }));
}

export function handleMeetingGetSchedule(msg, sender, sendResponse) {
  run(sendResponse, async (cid) => ({
    schedules: await getSchedule(await getMeetingToken(cid, false), msg.emails, msg.start, msg.end, msg.interval),
  }));
}

export function handleMeetingListRooms(msg, sender, sendResponse) {
  run(sendResponse, async (cid) => ({ rooms: await listRooms(await getMeetingToken(cid, false)) }));
}

export function handleMeetingCreate(msg, sender, sendResponse) {
  run(sendResponse, async (cid) => ({ meeting: await createMeeting(await getMeetingToken(cid, false), msg.meeting || {}) }));
}
