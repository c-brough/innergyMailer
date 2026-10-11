# Changelog

All notable changes to InnerCider, newest first. The Options page reads this
file to show you what's new when an update is available.

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
