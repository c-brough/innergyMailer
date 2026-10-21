# Changelog

All notable changes to InnerCider, newest first. The Options page reads this
file to show you what's new when an update is available.

## [1.19.2] - 2026-10-21
### Added
- Windows file-path links: an **"Open in real app"** option. When on, clicking a
  `W:\…`/`M:\…` path hands it to the InnerCider helper, which opens the folder in
  **Finder/Explorer** (and files in their **default app**) on any OS — the true
  native open, rather than a browser view. Off by default; opt in under **Windows
  file-path links** in Options.
- Options (Windows file-path links): a **helper setup** box with the install one-liner
  for your OS (Copy button) and a **"Check helper"** button that verifies the native
  helper is installed and reachable.
- Native helper: new `open_path` action (opens a folder/file/`smb://` URL in the OS
  default handler) and a `ping` action for the reachability check. Re-run the installer
  to pick up the updated helper.

## [1.19.1] - 2026-10-20
### Changed
- Windows file-path links now open the folder as a **Chrome file-browser tab**
  (`file:///…`) instead of only copying the path — browse subfolders and preview
  files right in the tab. Because an https page can't open `file://` itself, the
  extension's background worker opens the tab. Chrome requires its one-time per-
  extension **"Allow access to file URLs"** toggle (no code can flip it); when it's
  off, the first click shows a short prompt with a button to the extension's
  settings page and copies the path meanwhile. Once enabled, clicks just open the
  folder. Mac/Linux are unchanged (SMB → Finder/Files).

## [1.19.0] - 2026-10-20
### Added
- **Windows file-path links**: any `W:\…` or `M:\…` path written in Innergy (e.g. a
  work-order folder pasted into a note) is now a clickable link that opens that folder.
  The whole path is captured to the end of the line, so folder/file names with spaces
  stay intact.
  - On **Mac/Linux** the mapped drive opens over the network share: `W:\` →
    `smb://10.1.0.6/Projects-CPW`, `M:\` →
    `smb://10.1.0.6/Projects-CPW/CNC/Microvellum Data` (the rest of the path converted
    to a forward-slash, space-encoded SMB URL).
  - On **Windows** it opens the native path in File Explorer, and copies the path as a
    fallback (browsers block `file://` links from a web page).
  - On by default; opt out under **Windows file-path links** in Options. Makes no
    network requests.

## [1.18.8] - 2026-10-20
### Fixed
- Quick Change Order wizard: a commit whose takeoff tab was closed before it
  finished (e.g. no sheet was open) left the job stuck "in progress" and blocked all
  future commits ("there's already a commit, let it finish"). A stale job is now
  ignored after 90 seconds, so you can always retry. Also: if no sheet is open, the
  takeoff status card now tells you to open one instead of hanging, and never leaves
  the job stuck.

## [1.18.7] - 2026-10-20
### Fixed
- Quick Change Order wizard: products are now created with a **Product Type** ("PP")
  set — a required field real products carry. Without it the product rendered but
  showed blank in the takeoff's Budget → Products grid.

## [1.18.6] - 2026-10-20
### Fixed
- Quick Change Order wizard: product names, like location names, must be unique in a
  takeoff — a leftover product from a failed attempt made retries fail with "User
  Input Name has to be unique." The wizard now tracks the products it creates and, on
  a retry, removes and recreates its own leftover product (never a real one — it asks
  you to rename instead).

## [1.18.5] - 2026-10-20
### Fixed
- Quick Change Order wizard: re-committing after a failed attempt could stack
  duplicate copies of the same location, making the product fail with "Product
  intersects multiple Locations." The wizard now tracks the locations it creates and,
  on a retry, deletes and recreates its own leftover location cleanly — while never
  touching a real location that happens to share the name (it asks you to rename
  instead). Verified the full create chain end to end.

## [1.18.4] - 2026-10-20
### Fixed
- Quick Change Order wizard commit failed with "r is not defined" — a variable
  scoping regression from the previous fix. Product creation now works again.

## [1.18.3] - 2026-10-19
### Fixed
- Quick Change Order wizard commit: two reliability fixes. (1) It now reads the
  open sheet id from the takeoff's own sheet queries, so creating records no longer
  fails with "An error occurred while creating Location" when the sheet id couldn't
  be scraped. (2) Re-committing after a failed attempt no longer errors on "Location
  with this number and name already exists" — it reuses the existing location. Error
  messages are also more specific now, and new locations sit in a safer spot.

## [1.18.2] - 2026-10-19
### Fixed
- Quick Change Order wizard commit failed at "placing location" when the generated
  location rectangle overlapped existing products on the sheet ("Product intersects
  multiple Locations"). New locations are now placed as small rectangles in a clear
  area off to the side of the blueprint, so they never collide with existing work.

## [1.18.1] - 2026-10-19
### Fixed
- Quick Change Order wizard: typing in a location/product field lost focus every
  1–2 seconds. The commit-progress storage listener was re-rendering the panel on
  each keystroke-triggered autosave; it now re-renders only when the committed state
  actually changes (a real commit), so typing is uninterrupted.

## [1.18.0] - 2026-10-19
### Added
- **Quick Change Order wizard — Phase 2: commit creates the records.** Committing
  now opens the project's Takeoff and creates each location (name + scope) and
  product (name + price) there via the Takeoff API — headless, no sheet drawing. It
  maps your product price to the **Fixed Price · Unit Fabrication Pre-Sell-Tax
  Price**, places everything under the change order's origin, and marks the items
  locked when done. A status card in the takeoff shows progress. After it finishes,
  click **Recalculate direct costs and labor** in the takeoff to roll the pricing
  into the CO total (auto-recalc is the next phase). Implemented with a MAIN-world
  bridge (reuses the takeoff session's own request headers) + an isolated
  orchestrator that runs the verified command sequence.

## [1.17.4] - 2026-10-19
### Changed
- Quick Change Order wizard: the open icon is now a **form being auto-filled with a
  magic sparkle** (clearer that it fills out the change order) instead of a wand.
### Fixed
- The larger icon was stretching the grid row taller (looked glitchy). Sized the
  icon box to the row's line height (18px, `line-height:0`) so it no longer grows
  the row.

## [1.17.3] - 2026-10-19
### Changed
- Quick Change Order wizard: made the wand icon **bolder and more obviously a magic
  wand** — thicker handle, a big chunky sparkle-star at the tip plus two smaller
  sparkles, full black at 22px.

## [1.17.2] - 2026-10-19
### Changed
- Quick Change Order wizard: the open button is now a **black magician's wand with
  sparkles** (borderless) instead of a boxed button, and product **price** fields
  show as **US currency** ($1,234.56 — two decimals + thousands separators) when
  not being edited.

## [1.17.1] - 2026-10-19
### Fixed
- Quick Change Order wizard button didn't appear: reading the DevExtreme grid
  needs the page's own jQuery, which an isolated content script can't see. A
  MAIN-world helper now tags the qualifying change-order cells and the wizard
  injects its button onto those tags (same pattern as the other grid readers).

## [1.17.0] - 2026-10-19
### Added
- **Quick Change Order wizard — Phase 1** (on by default; opt out in Options). On a
  project's **Change Orders** grid, a wizard button now appears to the left of any
  change order that is **Pending** with a **$0 grand total cost**. It opens a wizard
  to build **locations** (name + scope) and the **products** (name + price) within
  each, then **Commit & lock** them. This phase is UI + local save/lock only —
  committing does not yet create records in Innergy (that, and the automatic
  takeoff recalculation, come in the next updates).

## [1.16.2] - 2026-10-19
### Changed
- Note drafts now **show images** in the preview. Images you paste into a note are
  uploaded by Innergy and kept as normal image links, so they were already saved
  in your drafts — but the preview only showed plain text. It now renders the
  draft's formatting and images (sanitized) in place, and **Copy** still restores
  them when you paste a draft back. (Same in the Options drafts list.)

## [1.16.1] - 2026-10-19
### Fixed
- Note draft autosave was re-reading storage and measuring layout on **every**
  DOM change (which happens on each keystroke), which could hang or crash a busy
  notes page ("Aw, Snap!"). It now caches drafts in memory, reads storage only on
  change, and debounces all re-evaluation. (For the record, this feature makes
  **no** network requests — it never contacts Innergy's servers.)
### Changed
- Note drafts now surface as a small blue **draft icon** at the bottom of a notes
  page; **hover** expands it into the banner, and its **×** collapses it back to
  the icon (rather than a persistent banner). The whole icon/banner (outside ×)
  opens the drafts view.
- The drafts card now shows the **latest draft prominently** and keeps earlier
  drafts **collapsed** — click one to unroll it.

## [1.16.0] - 2026-10-19
### Added
- **Note draft autosave** (on by default; opt out in Options). While you compose
  a note — a new post or a reply — it quietly snapshots the rich-text field on
  every **carriage return** and at least every **5 minutes**, keeping the **last
  3 drafts per notes page**. If a draft isn't already in an open editor, a
  dismissible blue banner appears at the bottom of the notes page; click it for a
  ~75%-width card to view, **copy** (formatting preserved), or **delete** each
  draft. Options lists **every** saved draft across all pages (copy/delete there
  too). Nothing is sent anywhere — drafts live only in your browser.
### Changed
- Notifications sidebar: clicking a notification's body, its context chip, or
  **Preview** now marks that notification read (a real update to Innergy), so
  opening something to look at it clears it like you'd expect.

## [1.15.4] - 2026-10-19
### Changed
- Notifications button: stronger, more obvious orange pulse, and the white bell
  icon now pulses its color too (white ↔ orange) in sync.

## [1.15.3] - 2026-10-19
### Changed
- Notifications button: also hides Innergy's green unread-count badge on its bell
  (by hiding the whole `.notification-wrapper`), not just the bell icon.

## [1.15.2] - 2026-10-19
### Changed
- Notifications button: hides Innergy's own header bell while ours is shown
  (restored if you disable the feature), and the circle + bell are half the size.

## [1.15.1] - 2026-10-19
### Changed
- Notifications button restyle: the bell icon is twice as large and white on a
  gray circle, with a wider (12px), softer orange pulse that fades toward the
  edges.

## [1.15.0] - 2026-10-19
### Added
- Notifications sidebar: the **project name** now shows in front of the
  project/work-order context link; **task** notifications show the current **due
  date + a status pill**; and the type filters are now **Mentioned / Replies /
  Assigned / Reports / Other** (Options defaults updated to match).
### Changed
- The notifications button now sits **over Innergy's own header bell** (top
  right), at ~2/3 the size, as an orange circle with a blue bell icon.

## [1.14.1] - 2026-10-18
### Changed
- Notifications sidebar: clicking outside the panel now closes it; the unread
  count refreshes more often (and on open/close); and the 🔔 button pulses an
  orange shadow while you have unread notifications.

## [1.14.0] - 2026-10-18
### Added
- **Notifications sidebar** (opt-in). A floating 🔔 button opens a right-docked
  panel that mirrors your Innergy notifications without leaving the page:
  read/unread/all filter, quick search, type filters (Notes / Tasks / Reports /
  Other), an unread-count badge, click to open the linked note/task/report, a
  context chip to the project/work order, an inline **Preview** of note replies,
  and **mark one / mark all read** (real updates to Innergy). Default filters are
  configurable in Options and seed each fresh open.

## [1.13.1] - 2026-10-18
### Changed
- Notes Enhancements: the linked-note highlight now outlines only that note's own
  card (not its whole reply thread), and uses an orange border with a pulsing
  orange shadow that stops once you hover inside it.

## [1.13.0] - 2026-10-18
### Added
- **Notes Enhancements** (on by default; opt out in Options). On a Note link that
  points at a specific note, scrolls that note into view (centered) and gives it
  a 2px red border. Also highlights every mention of your own name in the notes
  as bold red.

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
