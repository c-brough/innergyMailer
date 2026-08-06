#!/usr/bin/env python3
"""InnerCider native messaging host (Linux, incl. Raspberry Pi OS / ARM).

Reads one message from Chromium over stdin (4-byte little-endian length prefix +
UTF-8 JSON) and drafts a PO email with the exported PDF attached. Two routes:

  app = "outlook_web"  -> Microsoft Graph API. Creates the draft in the user's
                          Microsoft 365 mailbox and hands the webLink back to
                          the extension, which opens it in a new tab (Outlook on
                          the web). Needs `msal` + `requests` and a one-time
                          device-code sign-in. This is the primary Linux route:
                          Linux has no Outlook desktop app and Raspberry Pi OS
                          ships no mail client at all.
  app = "linux_mail"   -> hands off to `xdg-email`, i.e. whatever desktop mail
                          client is registered for mailto: links (Thunderbird,
                          Evolution, Geary). Requires a client to actually be
                          installed; the host refuses rather than opening an
                          attachment-less compose window.

Unlike the macOS and Windows hosts, this one never opens a browser itself — it
returns `openUrl` and lets the extension's background service worker call
chrome.tabs.create(). A native-messaging host spawned by the browser has no
reliable claim on DISPLAY, and the extension can always open a tab.

Message in:  {"attachments": [...], "subject": "...", "body": "...", "to": "...",
              "app": "outlook_web" | "linux_mail", "clientId": "..."}
             or {"action": "auth_start", "clientId": "..."}
             or {"action": "auth_complete"}
Message out: {"ok": true, ...} or {"ok": false, "error": "..."}

NOTE: stdout is reserved for the native-messaging protocol. All diagnostics go
to host.log beside this script, never to stdout.
"""

import json
import os
import shutil
import struct
import subprocess
import sys
import traceback

AUTHORITY = "https://login.microsoftonline.com/common"
SCOPES = ["Mail.ReadWrite"]

# "outlook_new" is the value Windows installs already have saved in
# chrome.storage.local for the Graph route. Accept it here too so a shared
# profile (or a copied settings export) doesn't fall through to an error.
GRAPH_APPS = ("outlook_web", "outlook_new")
XDG_APPS = ("linux_mail",)


def _base_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


BASE_DIR = _base_dir()
LOG_PATH = os.path.join(BASE_DIR, "host.log")
CACHE_PATH = os.path.join(BASE_DIR, "graph_token_cache.json")
PENDING_PATH = os.path.join(BASE_DIR, "auth_pending.json")


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


def _write_private(path, text):
    """Write a file containing credentials with 0600 permissions.

    chmod happens before the content lands so the token is never briefly
    world-readable on a multi-user box.
    """
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(text)


def _import_msal():
    try:
        import msal  # noqa: F401
        return msal
    except ImportError:
        raise RuntimeError(
            "The Python package 'msal' is not installed for the interpreter "
            "running this host. Re-run install_linux.sh, which creates a venv "
            "with msal + requests."
        )


def _import_requests():
    try:
        import requests  # noqa: F401
        return requests
    except ImportError:
        raise RuntimeError(
            "The Python package 'requests' is not installed for the interpreter "
            "running this host. Re-run install_linux.sh, which creates a venv "
            "with msal + requests."
        )


def _load_cache(msal):
    cache = msal.SerializableTokenCache()
    if os.path.exists(CACHE_PATH):
        with open(CACHE_PATH) as fh:
            cache.deserialize(fh.read())
    return cache


def _save_cache(cache):
    if cache.has_state_changed:
        _write_private(CACHE_PATH, cache.serialize())


# ---------------------------------------------------------------- Graph route

def _graph_token(client_id):
    """Return a cached access token, or raise telling the user to sign in.

    Deliberately does NOT start a device flow: the draft click happens on the
    Innergy page where there is nowhere good to show a device code. Sign-in is
    the Options page's job (auth_start / auth_complete below).
    """
    msal = _import_msal()
    cache = _load_cache(msal)
    app = msal.PublicClientApplication(client_id, authority=AUTHORITY, token_cache=cache)

    accounts = app.get_accounts()
    if accounts:
        result = app.acquire_token_silent(SCOPES, account=accounts[0])
        if result and "access_token" in result:
            _save_cache(cache)
            return result["access_token"]

    raise RuntimeError(
        "Not signed in to Microsoft. Open the InnerCider Options page and click "
        "Sign in (one time), then try the draft again."
    )


def _graph_draft(subject, body, to, attachments, client_id):
    """Create a draft via Microsoft Graph; return the webLink for the extension."""
    requests = _import_requests()
    import base64

    token = _graph_token(client_id)
    hdrs = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    draft_body = {
        "subject": subject or "",
        "body": {"contentType": "Text", "content": body or ""},
        "isDraft": True,
    }
    if to:
        draft_body["toRecipients"] = [{"emailAddress": {"address": to}}]

    r = requests.post(
        "https://graph.microsoft.com/v1.0/me/messages", headers=hdrs, json=draft_body
    )
    r.raise_for_status()
    draft = r.json()
    draft_id = draft["id"]
    web_link = draft.get("webLink", "")

    INLINE_LIMIT = 3 * 1024 * 1024  # 3 MB — above this Graph wants an upload session
    for path in attachments:
        path = os.path.abspath(path)
        size = os.path.getsize(path)
        name = os.path.basename(path)

        if size <= INLINE_LIMIT:
            with open(path, "rb") as fh:
                content_b64 = base64.b64encode(fh.read()).decode()
            r = requests.post(
                f"https://graph.microsoft.com/v1.0/me/messages/{draft_id}/attachments",
                headers=hdrs,
                json={
                    "@odata.type": "#microsoft.graph.fileAttachment",
                    "name": name,
                    "contentBytes": content_b64,
                },
            )
            r.raise_for_status()
        else:
            r = requests.post(
                f"https://graph.microsoft.com/v1.0/me/messages/{draft_id}"
                "/attachments/createUploadSession",
                headers=hdrs,
                json={
                    "AttachmentItem": {
                        "attachmentType": "file",
                        "name": name,
                        "size": size,
                    }
                },
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
                        headers={
                            "Content-Length": str(len(data)),
                            "Content-Range": f"bytes {start}-{end}/{size}",
                        },
                        data=data,
                    ).raise_for_status()
                    start += len(data)

    if not web_link:
        r = requests.get(
            f"https://graph.microsoft.com/v1.0/me/messages/{draft_id}?$select=webLink",
            headers=hdrs,
        )
        if r.ok:
            web_link = r.json().get("webLink", "")

    if web_link:
        return {"message": "Draft created in Outlook on the web.", "openUrl": web_link}
    log("WARNING: no webLink returned for draft")
    return {"message": "Draft created in your Microsoft 365 Drafts folder."}


# ------------------------------------------------------------ xdg-email route

def _mailto_handler():
    """Return the .desktop id handling mailto: links, or "" if none is set."""
    if shutil.which("xdg-mime") is None:
        return ""
    try:
        r = subprocess.run(
            ["xdg-mime", "query", "default", "x-scheme-handler/mailto"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except Exception:
        return ""
    return r.stdout.strip() if r.returncode == 0 else ""


def _xdg_email_draft(subject, body, to, attachments):
    """Open a compose window in the desktop mail client via xdg-email.

    Refuses when no mailto: handler is registered. Without one, xdg-email falls
    back to a generic URL open that silently drops --attach — the user would get
    an empty compose window and no warning that the PDF never made it.
    """
    if shutil.which("xdg-email") is None:
        raise RuntimeError(
            "xdg-email not found. Install it (sudo apt install xdg-utils), or "
            "switch to 'Outlook on the web' in the InnerCider Options."
        )
    handler = _mailto_handler()
    if not handler:
        raise RuntimeError(
            "No desktop mail client is registered for mailto: links, so the PDF "
            "attachment would be dropped. Install one (e.g. sudo apt install "
            "thunderbird) or switch to 'Outlook on the web' in the InnerCider "
            "Options."
        )

    cmd = ["xdg-email"]
    if subject:
        cmd += ["--subject", subject]
    if body:
        cmd += ["--body", body]
    for path in attachments:
        cmd += ["--attach", os.path.abspath(path)]
    if to:
        cmd.append(to)

    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    # Some handlers return immediately, others stay attached to the compose
    # window. Give it a moment to fail loudly; if it's still alive, it launched.
    try:
        _, stderr = proc.communicate(timeout=5)
        if proc.returncode != 0:
            raise RuntimeError(
                f"xdg-email exited {proc.returncode}: "
                f"{(stderr or b'').decode(errors='replace').strip()}"
            )
    except subprocess.TimeoutExpired:
        pass

    name = handler.replace(".desktop", "")
    return {"message": f"Compose window opened in {name} — confirm the PDF attached."}


# --------------------------------------------------------------------- dispatch

def draft_email(attachments, subject, body, to, app, client_id=None):
    existing = [p for p in (attachments or []) if p and os.path.exists(p)]
    missing = [p for p in (attachments or []) if p and not os.path.exists(p)]
    for p in missing:
        log(f"WARNING: attachment not found, skipping: {p!r}")
    if not existing:
        raise FileNotFoundError(f"No attachment files found on disk: {attachments!r}")

    app = (app or "outlook_web").lower()

    if app in GRAPH_APPS:
        if not client_id:
            raise ValueError(
                "Azure App Client ID is required for Outlook on the web. Open the "
                "InnerCider Options and paste your Client ID."
            )
        return _graph_draft(subject, body, to, existing, client_id)

    if app in XDG_APPS:
        return _xdg_email_draft(subject, body, to, existing)

    raise ValueError(
        f"Mail app {app!r} is not available on Linux. Open the InnerCider Options "
        "and pick 'Outlook on the web' or 'Default mail client'."
    )


def _graph_auth_start(client_id):
    """Step 1: start the device flow and return the user code immediately."""
    msal = _import_msal()
    cache = _load_cache(msal)
    app = msal.PublicClientApplication(client_id, authority=AUTHORITY, token_cache=cache)

    # Already signed in? Skip the device flow entirely.
    accounts = app.get_accounts()
    if accounts:
        result = app.acquire_token_silent(SCOPES, account=accounts[0])
        if result and "access_token" in result:
            _save_cache(cache)
            return {"ok": True, "alreadySignedIn": True, "message": "Already signed in."}

    flow = app.initiate_device_flow(scopes=SCOPES)
    if "user_code" not in flow:
        return {"ok": False, "error": f"Device flow init failed: {flow}"}

    # auth_complete runs in a *new* host process (Chrome spawns one per message),
    # so the flow dict has to survive on disk. It carries the device code, so
    # keep it 0600 like the token cache.
    _write_private(PENDING_PATH, json.dumps({"clientId": client_id, "flow": flow}))

    verification_uri = flow.get("verification_uri", "https://microsoft.com/devicelogin")
    log(f"auth_start: user_code={flow['user_code']} url={verification_uri}")

    return {
        "ok": True,
        "pending": True,
        "userCode": flow["user_code"],
        "verificationUri": verification_uri,
        # The extension opens this tab; the host does not touch the browser.
        "openUrl": flow.get("verification_uri_complete") or verification_uri,
    }


def _graph_auth_complete():
    """Step 2: block until the user finishes signing in, then cache the token."""
    msal = _import_msal()

    if not os.path.exists(PENDING_PATH):
        return {"ok": False, "error": "No pending auth session found. Click Sign in again."}

    with open(PENDING_PATH) as fh:
        pending = json.load(fh)

    cache = _load_cache(msal)
    app = msal.PublicClientApplication(
        pending["clientId"], authority=AUTHORITY, token_cache=cache
    )
    result = app.acquire_token_by_device_flow(pending["flow"])  # blocks

    try:
        os.remove(PENDING_PATH)
    except OSError:
        pass

    if "access_token" not in result:
        return {"ok": False, "error": result.get("error_description", str(result))}

    _save_cache(cache)
    log("auth_complete: signed in successfully")
    return {"ok": True, "message": "Signed in successfully."}


def main():
    try:
        msg = read_message()
        if msg is None:
            return

        action = msg.get("action")
        if action == "auth_start":
            client_id = (msg.get("clientId") or "").strip()
            if not client_id:
                send_message({"ok": False, "error": "No client ID provided."})
                return
            send_message(_graph_auth_start(client_id))
            return

        if action == "auth_complete":
            send_message(_graph_auth_complete())
            return

        attachments = msg.get("attachments")
        if not attachments:
            attachments = [msg.get("pdfPath")] if msg.get("pdfPath") else []
        log(
            f"received: app={msg.get('app')!r} to={msg.get('to')!r} "
            f"subject={msg.get('subject')!r} attachments={attachments!r}"
        )
        extra = draft_email(
            attachments,
            msg.get("subject"),
            msg.get("body"),
            msg.get("to"),
            msg.get("app", "outlook_web"),
            client_id=(msg.get("clientId") or "").strip() or None,
        )
        resp = {"ok": True}
        if extra:
            resp.update(extra)
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
