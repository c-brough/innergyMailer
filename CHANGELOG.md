# Changelog

All notable changes to InnerCider, newest first. The Options page reads this
file to show you what's new when an update is available.

## [1.12.1] - 2026-10-11
### Changed
- PO email: the attached PDF now defaults to **Export Custom PDF** (your default
  report) instead of Innergy's standard Generate PDF. Switch back any time under
  Options → PO email. (Only affects the default; an explicit choice is kept.)

## [1.12.0] - 2026-10-11
### Added
- Options → PO email: editable **email header** and **footer** (with sensible
  defaults). The PO number, vendor, items, and notes are inserted between them.
- A **signature** you can paste formatted (keeps bold, links, etc.). It renders
  with formatting on the compose-and-send path (sent as HTML); plain mail apps
  get an auto plain-text version. Header/footer/signature apply to all paths.

## [1.11.0] - 2026-10-11
### Changed
- Time Tracking: a single selected segment now offers only **Add Segments**
  (per side), and that form opens with **one** segment ("+ Add segment" adds
  more).
### Added
- Add-segments (before/after a single segment): an **End/Start** toggle —
  **Keep original** (re-slice within the segment's own time) or **Extend** to an
  editable **clock-out** (after) / **clock-in** (before), defaulting to the next
  segment or end/start of day. Works on both sides.

## [1.10.1] - 2026-10-11
### Changed
- Time Tracking: gaps longer than **2 hours** are no longer treated as unpaid
  breaks — they aren't labeled, noted, or counted (a longer gap is off-shift
  time, not a break). Breaks of 1 min–2 h behave as before.

## [1.10.0] - 2026-10-11
### Added
- Options: each feature's category shows a **green dot + tint when it's enabled
  or configured**, so you can see what's in use while collapsed.
- Options: **Expand all / Collapse all** controls, and the page now opens with
  everything collapsed.
### Changed
- **PO email is now opt-in.** The "Draft Email w/ PDF" button only appears when
  you enable it under Options → PO email. (Turn it on after updating.)
- Options: the **Mail app** section moved to the end of the list and is grayed
  out until PO email (a compose feature) is enabled.

## [1.9.2] - 2026-10-11
### Changed
- Compose-and-send modal: recipients now behave like a desktop mail client —
  typing an address and pressing space, comma, Enter, or Tab turns it into a
  removable chip; click a chip to edit it, Backspace to pull the last one back.
- The compose window is now ~75% of the browser viewport, with the body growing
  to fill it.
- The PO email body uses a cleaner, more professional purchase-order layout.

## [1.9.1] - 2026-10-11
### Fixed
- Compose-and-send: corrected the Azure setup — the redirect URI must be
  registered under the **Single-page application** platform (not "Mobile and
  desktop"), otherwise sign-in fails with AADSTS9002326.
- Hid the device-code "Sign in" button for the compose-and-send option (it
  signs in automatically on first Send) to avoid a confusing error.

## [1.9.0] - 2026-10-11
### Added
- **Outlook on the web — compose & send here.** A new global mail-app option
  (any OS): clicking "Draft Email w/ PDF" opens a compose window inside Innergy
  (To / Subject / Body, editable, PO PDF attached). Click Send and it sends
  through your Microsoft 365 account via Graph, then the window clears; Discard
  or close to go back. Needs a one-time Azure setup (a redirect URI + the
  Mail.Send permission) shown in Options.

## [1.8.0] - 2026-10-11
### Added
- **In-app updates.** The Options page now checks GitHub for a newer version,
  shows an "update available" banner, lets you view this changelog, and can
  update in one click (downloads the latest and reloads the extension). Pick
  which branch to track from Options.

## [1.7.1] - 2026-10-11
### Added
- Time Tracking: the leading gap before your first new segment is now recorded
  as an unpaid break too (noted on the earlier existing segment).
### Changed
- Any save that resizes or annotates an existing time entry now asks for
  confirmation first, spelling out exactly what will change (shrink/grow + note).

## [1.7.0] - 2026-10-11
### Added
- Time Tracking: with a **single** segment selected, add segment(s) **before**
  (above) or **after** (below) it — shown only where there's room, bounded by the
  neighboring segment or midnight.
- You can shrink the selected segment to make room; that edits the entry while
  preserving its allocation.

## [1.6.0] - 2026-10-11
### Added
- Time Tracking: **Split by start/end time** (in addition to by hours) with
  flexible time entry (e.g. `4:30pm`, `430p`, `16:00`) and contextual AM/PM.
- Leaving a gap between segments records an **unpaid break** (not an entry),
  counted in the math and noted on the segment before it.

## [1.5.1] - 2026-10-11
### Changed
- Time Tracking: each split segment chooses its own Generic/Job allocation.
- Picker dropdowns widen to fit long work-order names.

## [1.5.0] - 2026-10-11
### Added
- Time Tracking: allocate a segment to a **Job → Work Order → Activity** (not just
  a generic labor item), with type-to-filter dropdowns and required-field hints.

## [1.4.0] - 2026-10-06
### Added
- **Time Tracking Tools** (opt-in): select two adjacent segments for the same
  employee to fill or split the gap between them (by hours).
- PO email: per-line-item notes and PO notes; optional line-item pricing; and
  "project - work order" in the subject when uniform.
### Changed
- Options reorganized into searchable, collapsible categories.
