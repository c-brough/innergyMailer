#!/usr/bin/env python3
"""Innergy PO -> Mail native messaging host.

Reads one message from Chrome over stdin using the native-messaging framing
(4-byte little-endian length prefix + UTF-8 JSON), then drafts an email in the
user's chosen mail client (Apple Mail or Microsoft Outlook) with the exported PO
PDF attached. The draft is left OPEN and unsent so the user can review and send
it manually.

Message in:  {"pdfPath": "...", "subject": "...", "body": "...", "to": "...",
              "app": "mail" | "outlook"}
Message out: {"ok": true} or {"ok": false, "error": "..."}

NOTE: stdout is reserved for the native-messaging protocol. All diagnostics go
to the log file beside this script, never to stdout.
"""

import json
import os
import struct
import subprocess
import sys
import traceback

LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "host.log")

# Each script takes argv: 1=subject, 2=body, 3=to, 4..N=attachment POSIX paths
APPLESCRIPT_MAIL = r'''
on run argv
    set theSubject to item 1 of argv
    set theBody to item 2 of argv
    set theTo to item 3 of argv
    tell application "Mail"
        set newMsg to make new outgoing message with properties {subject:theSubject, content:theBody, visible:true}
        tell newMsg
            if theTo is not "" then
                make new to recipient at end of to recipients with properties {address:theTo}
            end if
            repeat with i from 4 to (count of argv)
                make new attachment with properties {file name:(POSIX file (item i of argv))} at after the last paragraph of content
            end repeat
        end tell
        activate
    end tell
end run
'''

APPLESCRIPT_OUTLOOK = r'''
on run argv
    set theSubject to item 1 of argv
    set theBody to item 2 of argv
    set theTo to item 3 of argv
    tell application "Microsoft Outlook"
        set newMsg to make new outgoing message with properties {subject:theSubject, content:theBody}
        tell newMsg
            if theTo is not "" then
                make new to recipient with properties {email address:{address:theTo}}
            end if
            repeat with i from 4 to (count of argv)
                make new attachment with properties {file:(POSIX file (item i of argv))}
            end repeat
        end tell
        open newMsg
        activate
    end tell
end run
'''

SCRIPTS = {"mail": APPLESCRIPT_MAIL, "outlook": APPLESCRIPT_OUTLOOK}


def to_html(text):
    """Outlook's message body is HTML, so plain newlines collapse. Escape the
    text and turn line breaks into <br> so the body keeps its formatting."""
    escaped = (
        (text or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )
    return escaped.replace("\r\n", "\n").replace("\n", "<br>\n")


def log(message):
    try:
        with open(LOG_PATH, "a") as fh:
            fh.write(message.rstrip() + "\n")
    except Exception:
        pass


def read_message():
    """Read a single native-messaging message from stdin, or None on EOF."""
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) < 4:
        return None
    (length,) = struct.unpack("<I", raw_length)
    data = sys.stdin.buffer.read(length)
    return json.loads(data.decode("utf-8"))


def send_message(obj):
    """Write a single native-messaging message to stdout."""
    encoded = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def draft_email(attachments, subject, body, to, app):
    # Keep only attachments that actually exist on disk.
    existing = [p for p in (attachments or []) if p and os.path.exists(p)]
    missing = [p for p in (attachments or []) if p and not os.path.exists(p)]
    for p in missing:
        log(f"WARNING: attachment not found, skipping: {p!r}")
    if not existing:
        raise FileNotFoundError(f"No attachment files found on disk: {attachments!r}")

    app = (app or "mail").lower()
    script = SCRIPTS.get(app)
    if script is None:
        raise ValueError(f"Unknown mail app: {app!r}")

    # Outlook renders the body as HTML; Apple Mail uses plain text.
    body_arg = to_html(body) if app == "outlook" else (body or "")

    result = subprocess.run(
        ["osascript", "-", subject or "", body_arg, to or ""] + existing,
        input=script,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        label = "Microsoft Outlook" if app == "outlook" else "Apple Mail"
        raise RuntimeError(
            f"{label} draft failed (osascript exit {result.returncode}): "
            f"{result.stderr.strip()}"
        )


def main():
    try:
        msg = read_message()
        if msg is None:
            return
        # Prefer the multi-file `attachments` list; fall back to single pdfPath.
        attachments = msg.get("attachments")
        if not attachments:
            attachments = [msg.get("pdfPath")] if msg.get("pdfPath") else []
        log(
            f"received: app={msg.get('app')!r} to={msg.get('to')!r} "
            f"subject={msg.get('subject')!r} attachments={attachments!r}"
        )
        draft_email(
            attachments,
            msg.get("subject"),
            msg.get("body"),
            msg.get("to"),
            msg.get("app"),
        )
        send_message({"ok": True})
        log("draft created")
    except Exception as exc:  # report back to the extension and log details
        log("ERROR: " + traceback.format_exc())
        try:
            send_message({"ok": False, "error": str(exc)})
        except Exception:
            pass


if __name__ == "__main__":
    main()
