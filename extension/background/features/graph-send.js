/* InnerCider — background: send a PO email via Microsoft Graph (host-free)
 *
 * Used by the "Outlook on the web — compose & send here" option. The compose
 * modal's content goes through the normal export/arm pipeline so the PO PDF URL
 * is captured; draft-email.js then calls sendPoEmail() with the fetched
 * attachment bytes. Sends via POST /me/sendMail (saveToSentItems:true).
 */

import { getGraphToken } from "../shared/graph-identity.js";

// attachments: [{ name, bytesBase64, contentType }]
// bodyHtml (optional): when present the message is sent as HTML (used to render
// the rich signature); otherwise it's sent as plain text.
export async function sendPoEmail({ clientId, subject, body, bodyHtml, recipients, attachments }) {
  const token = await getGraphToken(clientId, true);
  const message = {
    subject: subject || "",
    body: bodyHtml ? { contentType: "HTML", content: bodyHtml } : { contentType: "Text", content: body || "" },
    toRecipients: (recipients || []).map((a) => ({ emailAddress: { address: a } })),
    attachments: (attachments || []).map((a) => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: a.name,
      contentType: a.contentType || "application/octet-stream",
      contentBytes: a.bytesBase64,
    })),
  };
  const r = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ message, saveToSentItems: true }),
  });
  if (r.status === 202) return { ok: true };
  let err = "HTTP " + r.status;
  try { const j = await r.json(); err = (j.error && j.error.message) || err; } catch (e) { /* no body */ }
  return { ok: false, error: err };
}
