#!/usr/bin/env python3
"""Innergy Mailer native messaging host (Windows).

Reads one message from Chrome over stdin (4-byte little-endian length prefix +
UTF-8 JSON), drafts an email in Microsoft Outlook via COM automation, and
leaves the draft open and unsent for review.

Requires: pip install pywin32

Message in:  {"attachments": [...], "subject": "...", "body": "...", "to": "...",
              "app": "outlook"}
Message out: {"ok": true} or {"ok": false, "error": "..."}

NOTE: stdout is reserved for the native-messaging protocol. All diagnostics go
to host.log beside this script, never to stdout.
"""

import json
import os
import struct
import sys
import traceback

if getattr(sys, "frozen", False):
    _BASE = os.path.dirname(sys.executable)
else:
    _BASE = os.path.dirname(os.path.abspath(__file__))
LOG_PATH = os.path.join(_BASE, "host.log")


def log(message):
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(message.rstrip() + "\n")
    except Exception:
        pass


def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) < 4:
        return None
    (length,) = struct.unpack("<I", raw_length)
    data = sys.stdin.buffer.read(length)
    return json.loads(data.decode("utf-8"))


def send_message(obj):
    encoded = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def _mapi_send(subject, body, to, attachments):
    """Open a compose window via Simple MAPI (MAPISendMail).

    Simple MAPI is the API behind Windows Explorer's "Send to → Mail recipient".
    New Outlook registers as the MAPI handler when it is the default mail
    client, so the compose window appears in New Outlook with all attachments
    already loaded.
    """
    import ctypes

    MAPI_LOGON_UI = 0x00000001
    MAPI_DIALOG   = 0x00000008
    MAPI_TO       = 1

    class MapiRecipDesc(ctypes.Structure):
        _fields_ = [
            ("ulReserved",  ctypes.c_ulong),
            ("ulRecipClass",ctypes.c_ulong),
            ("lpszName",    ctypes.c_char_p),
            ("lpszAddress", ctypes.c_char_p),
            ("ulEIDSize",   ctypes.c_ulong),
            ("lpEntryID",   ctypes.c_void_p),
        ]

    class MapiFileDesc(ctypes.Structure):
        _fields_ = [
            ("ulReserved",   ctypes.c_ulong),
            ("flFlags",      ctypes.c_ulong),
            ("nPosition",    ctypes.c_ulong),
            ("lpszPathName", ctypes.c_char_p),
            ("lpszFileName", ctypes.c_char_p),
            ("lpFileType",   ctypes.c_void_p),
        ]

    class MapiMessage(ctypes.Structure):
        _fields_ = [
            ("ulReserved",        ctypes.c_ulong),
            ("lpszSubject",       ctypes.c_char_p),
            ("lpszNoteText",      ctypes.c_char_p),
            ("lpszMessageType",   ctypes.c_char_p),
            ("lpszDateReceived",  ctypes.c_char_p),
            ("lpszConversationID",ctypes.c_char_p),
            ("flFlags",           ctypes.c_ulong),
            ("lpOriginator",      ctypes.c_void_p),
            ("nRecipCount",       ctypes.c_ulong),
            ("lpRecips",          ctypes.c_void_p),
            ("nFileCount",        ctypes.c_ulong),
            ("lpFiles",           ctypes.c_void_p),
        ]

    def enc(s):
        return (s or "").encode("cp1252", errors="replace")

    # Recipients
    recip_arr = None
    recip_count = 0
    if to:
        RecipArray = MapiRecipDesc * 1
        recip_arr = RecipArray()
        recip_arr[0].ulRecipClass = MAPI_TO
        recip_arr[0].lpszName    = enc(to)
        recip_arr[0].lpszAddress = enc(f"SMTP:{to}")
        recip_count = 1

    # Attachments
    file_arr = None
    file_count = len(attachments)
    if file_count:
        FileArray = MapiFileDesc * file_count
        file_arr = FileArray()
        for i, path in enumerate(attachments):
            abs_path = os.path.abspath(path)
            file_arr[i].nPosition    = 0xFFFFFFFF  # not inline in body
            file_arr[i].lpszPathName = enc(abs_path)
            file_arr[i].lpszFileName = enc(os.path.basename(abs_path))

    msg = MapiMessage()
    msg.lpszSubject  = enc(subject)
    msg.lpszNoteText = enc(body)
    msg.nRecipCount  = recip_count
    msg.lpRecips     = ctypes.cast(recip_arr, ctypes.c_void_p) if recip_arr else None
    msg.nFileCount   = file_count
    msg.lpFiles      = ctypes.cast(file_arr,  ctypes.c_void_p) if file_arr  else None

    mapi = ctypes.WinDLL("MAPI32.DLL")
    rc = mapi.MAPISendMail(0, 0, ctypes.byref(msg), MAPI_DIALOG | MAPI_LOGON_UI, 0)
    if rc not in (0, 1):  # 0=SUCCESS, 1=USER_ABORT (user closed dialog — not an error)
        raise RuntimeError(f"MAPISendMail returned error code {rc}")


def _graph_draft(subject, body, to, attachments, client_id):
    """Create a draft via Microsoft Graph API and open it in New Outlook."""
    import msal
    import requests
    import base64

    AUTHORITY = "https://login.microsoftonline.com/common"
    SCOPES    = ["Mail.ReadWrite"]

    # Token cache lives beside the exe so it survives recompiles.
    if getattr(sys, "frozen", False):
        base_dir = os.path.dirname(sys.executable)
    else:
        base_dir = os.path.dirname(os.path.abspath(__file__))
    cache_path = os.path.join(base_dir, "graph_token_cache.json")

    cache = msal.SerializableTokenCache()
    if os.path.exists(cache_path):
        cache.deserialize(open(cache_path).read())

    app = msal.PublicClientApplication(client_id, authority=AUTHORITY, token_cache=cache)

    token = None
    accounts = app.get_accounts()
    if accounts:
        result = app.acquire_token_silent(SCOPES, account=accounts[0])
        if result and "access_token" in result:
            token = result["access_token"]

    if not token:
        flow = app.initiate_device_flow(scopes=SCOPES)
        if "user_code" not in flow:
            raise RuntimeError(f"Device flow failed: {flow}")
        log(f"Auth required: {flow['message']}")
        open_url = flow.get("verification_uri_complete") or flow.get("verification_uri")
        _open_in_chrome(open_url)
        result = app.acquire_token_by_device_flow(flow)  # blocks until user signs in
        if "access_token" not in result:
            raise RuntimeError(f"Auth failed: {result.get('error_description', result)}")
        token = result["access_token"]

    if cache.has_state_changed:
        with open(cache_path, "w") as f:
            f.write(cache.serialize())

    hdrs = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    # Create the draft.
    draft_body = {
        "subject": subject or "",
        "body": {"contentType": "Text", "content": body or ""},
        "isDraft": True,
    }
    if to:
        draft_body["toRecipients"] = [{"emailAddress": {"address": to}}]

    r = requests.post("https://graph.microsoft.com/v1.0/me/messages", headers=hdrs, json=draft_body)
    r.raise_for_status()
    draft = r.json()
    draft_id  = draft["id"]
    web_link  = draft.get("webLink", "")

    # Attach files.
    INLINE_LIMIT = 3 * 1024 * 1024  # 3 MB — use upload session above this
    for path in attachments:
        path = os.path.abspath(path)
        size = os.path.getsize(path)
        name = os.path.basename(path)

        if size <= INLINE_LIMIT:
            with open(path, "rb") as fh:
                content_b64 = base64.b64encode(fh.read()).decode()
            attach = {
                "@odata.type": "#microsoft.graph.fileAttachment",
                "name": name,
                "contentBytes": content_b64,
            }
            r = requests.post(
                f"https://graph.microsoft.com/v1.0/me/messages/{draft_id}/attachments",
                headers=hdrs, json=attach,
            )
            r.raise_for_status()
        else:
            # Large file — use an upload session.
            session_payload = {
                "AttachmentItem": {
                    "attachmentType": "file",
                    "name": name,
                    "size": size,
                }
            }
            r = requests.post(
                f"https://graph.microsoft.com/v1.0/me/messages/{draft_id}/attachments/createUploadSession",
                headers=hdrs, json=session_payload,
            )
            r.raise_for_status()
            upload_url = r.json()["uploadUrl"]

            chunk = 4 * 1024 * 1024
            with open(path, "rb") as fh:
                start = 0
                while True:
                    data = fh.read(chunk)
                    if not data:
                        break
                    end = start + len(data) - 1
                    requests.put(
                        upload_url,
                        headers={"Content-Length": str(len(data)),
                                 "Content-Range": f"bytes {start}-{end}/{size}"},
                        data=data,
                    ).raise_for_status()
                    start += len(data)

    # Open the draft. New Outlook intercepts outlook.office365.com links when
    # it is the default mail app; OWA is the fallback if it doesn't.
    if not web_link:
        r = requests.get(
            f"https://graph.microsoft.com/v1.0/me/messages/{draft_id}?$select=webLink",
            headers=hdrs,
        )
        if r.ok:
            web_link = r.json().get("webLink", "")

    if web_link:
        _open_in_chrome(web_link)
    else:
        log("WARNING: no webLink returned for draft")


def draft_email(attachments, subject, body, to, app, client_id=None):
    existing = [p for p in (attachments or []) if p and os.path.exists(p)]
    missing  = [p for p in (attachments or []) if p and not os.path.exists(p)]
    for p in missing:
        log(f"WARNING: attachment not found, skipping: {p!r}")
    if not existing:
        raise FileNotFoundError(f"No attachment files found on disk: {attachments!r}")

    if app == "outlook_new":
        if not client_id:
            raise ValueError(
                "Azure App Client ID is required for New Outlook. "
                "Open the extension Options and paste your Client ID."
            )
        _graph_draft(subject, body, to, existing, client_id)
        return None

    # Outlook Classic — COM automation.
    try:
        import win32com.client
    except ImportError:
        raise RuntimeError("pywin32 is not installed. Run: pip install pywin32")

    try:
        outlook = win32com.client.Dispatch("Outlook.Application")
    except Exception as exc:
        raise RuntimeError(
            f"Could not connect to Outlook COM server: {exc}\n"
            "Make sure classic Outlook (Microsoft 365 desktop app or Outlook 2019/2021) is installed."
        )

    mail = outlook.CreateItem(0)  # 0 = olMailItem
    mail.Subject = subject or ""
    mail.Body    = body or ""
    if to:
        mail.To = to
    for path in existing:
        mail.Attachments.Add(os.path.abspath(path))
    mail.Display(False)
    return None


def _open_in_chrome(url):
    """Open a URL in Chrome, falling back to the default browser if not found."""
    import subprocess
    chrome_paths = [
        os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%LocalAppData%\Google\Chrome\Application\chrome.exe"),
    ]
    for path in chrome_paths:
        if os.path.exists(path):
            subprocess.Popen([path, url])
            return
    import webbrowser
    webbrowser.open(url)


def _get_base_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def _graph_auth_start(client_id):
    """Step 1: start device flow, return user code immediately, save flow to disk."""
    import msal
    import json as _json

    AUTHORITY = "https://login.microsoftonline.com/common"
    SCOPES    = ["Mail.ReadWrite"]
    base_dir  = _get_base_dir()
    cache_path   = os.path.join(base_dir, "graph_token_cache.json")
    pending_path = os.path.join(base_dir, "auth_pending.json")

    cache = msal.SerializableTokenCache()
    if os.path.exists(cache_path):
        cache.deserialize(open(cache_path).read())

    app = msal.PublicClientApplication(client_id, authority=AUTHORITY, token_cache=cache)

    # Try silent first — if already signed in, skip the whole device flow.
    accounts = app.get_accounts()
    if accounts:
        result = app.acquire_token_silent(SCOPES, account=accounts[0])
        if result and "access_token" in result:
            if cache.has_state_changed:
                with open(cache_path, "w") as f:
                    f.write(cache.serialize())
            return {"ok": True, "alreadySignedIn": True, "message": "Already signed in."}

    flow = app.initiate_device_flow(scopes=SCOPES)
    if "user_code" not in flow:
        return {"ok": False, "error": f"Device flow init failed: {flow}"}

    # Save the flow dict so auth_complete can pick it up in a new process.
    with open(pending_path, "w") as f:
        _json.dump({"clientId": client_id, "flow": flow}, f)

    open_url = flow.get("verification_uri_complete") or flow.get("verification_uri")
    log(f"auth_start: user_code={flow['user_code']} url={open_url}")
    _open_in_chrome(open_url)

    return {
        "ok": True,
        "pending": True,
        "userCode": flow["user_code"],
        "verificationUri": flow.get("verification_uri", "https://microsoft.com/devicelogin"),
    }


def _graph_auth_complete():
    """Step 2: wait for the user to finish signing in, then save the token."""
    import msal
    import json as _json

    AUTHORITY = "https://login.microsoftonline.com/common"
    SCOPES    = ["Mail.ReadWrite"]
    base_dir  = _get_base_dir()
    cache_path   = os.path.join(base_dir, "graph_token_cache.json")
    pending_path = os.path.join(base_dir, "auth_pending.json")

    if not os.path.exists(pending_path):
        return {"ok": False, "error": "No pending auth session found. Click Sign in again."}

    with open(pending_path) as f:
        pending = _json.load(f)

    client_id = pending["clientId"]
    flow      = pending["flow"]

    cache = msal.SerializableTokenCache()
    if os.path.exists(cache_path):
        cache.deserialize(open(cache_path).read())

    app    = msal.PublicClientApplication(client_id, authority=AUTHORITY, token_cache=cache)
    result = app.acquire_token_by_device_flow(flow)  # blocks until signed in or expired

    os.remove(pending_path)

    if "access_token" not in result:
        return {"ok": False, "error": result.get("error_description", str(result))}

    if cache.has_state_changed:
        with open(cache_path, "w") as f:
            f.write(cache.serialize())

    log("auth_complete: signed in successfully")
    return {"ok": True, "message": "Signed in successfully."}


def main():
    try:
        msg = read_message()
        if msg is None:
            return

        if msg.get("action") == "auth_start":
            client_id = msg.get("clientId", "").strip()
            if not client_id:
                send_message({"ok": False, "error": "No client ID provided."})
                return
            send_message(_graph_auth_start(client_id))
            return

        if msg.get("action") == "auth_complete":
            send_message(_graph_auth_complete())
            return

        attachments = msg.get("attachments")
        if not attachments:
            attachments = [msg.get("pdfPath")] if msg.get("pdfPath") else []
        log(
            f"received: app={msg.get('app')!r} to={msg.get('to')!r} "
            f"subject={msg.get('subject')!r} attachments={attachments!r}"
        )
        note = draft_email(
            attachments,
            msg.get("subject"),
            msg.get("body"),
            msg.get("to"),
            msg.get("app", "outlook_classic"),
            client_id=msg.get("clientId", "").strip() or None,
        )
        resp = {"ok": True}
        if note:
            resp["message"] = note
        send_message(resp)
        log("draft created")
    except Exception as exc:
        log("ERROR: " + traceback.format_exc())
        try:
            send_message({"ok": False, "error": str(exc)})
        except Exception:
            pass


if __name__ == "__main__":
    main()
