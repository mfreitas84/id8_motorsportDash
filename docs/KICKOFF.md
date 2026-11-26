# Kickoff prompt — paste into Claude Code at the repo root

> **Correction (kept for history):** this prompt asks to copy `obd.js` and `tasu-guard.js` from
> iteriodev_cardash. Those files are under the PolyForm Strict licence (no copying or derivative
> works), not MIT. v0 was built on the MIT MGU App Kit instead, with our own gate and decoder.
> See CLAUDE.md, "Code we build on".

Read CLAUDE.md in this repo first — it has the full context (G87 M2, rooted MGU iDrive 8 BDC3,
mgu-store installed, the two vehicle-data paths, the safety rule, and the v0 scope).

Build the **v0 "quick start" app** described under "Revised v0 scope": a fresh, minimal, heavily
commented MGU ID8 app that proves the plumbing — do NOT build the full track page or logging yet.

Requirements:
- New app id with my prefix: `mdev_quickstart` (change the prefix if you prefer). mguHmi: ["ID8"].
- Package shape: package.json, manifest.json (declare only the SOME/IP proxies v0 needs:
  vehicle.CDS/CDS2, vehicle.Vehicle2 — add powertrain only if needed for gear), permissions.json,
  rhmiData/ host state, renderer/ (mgu-render GPU) with ONE screen.
- One GPU screen showing live: rpm, coolant temp, oil temp, road speed. Poll the getters ~10 Hz
  while the screen is visible (notifiers don't fire on MGU — poll, don't subscribe). Stop polling
  when hidden/closed.
- Copy `obd.js` and `tasu-guard.js` from iteriodev_cardash verbatim (MIT). Wire ONE gated OBD read
  as a demonstration — IAT (PID 0x0F) to the DME (diag 0x12) via TASU — classified `read` through
  tasu-guard. Keep everything else OBD off.
- Enforce the safety rule from CLAUDE.md: never send blocked services (34/35/36/37/38/3D); gate
  state-changing services to parked; v0 only ever does reads.
- Comment generously — this app doubles as my how-to reference for the plumbing.

Deliver: the full app source tree, a short README with the build/preview/push-to-car commands, and
tell me what to verify on-car (tile appears, values go live). Then stop — we'll layer the track
layout and the logger as separate steps after this runs.

LOGGER STEP (build AFTER v0 runs — see CLAUDE.md "USB-logger design decision"):
- Per-session CSV in the app data dir; CLEAR it on app entry (fresh log each launch).
- Continuous capture while driving (read-only signals only).
- Two buttons: "Clear log" (wipe current CSV, any time) and "Save to USB" (copy CSV to stick; enabled
  only when a stick is detected AND the car is parked, else greyed with a reason). USB write goes
  through a small root remount helper modeled on the Drive Recorder's usb-rw.sh (flag in /dev/shm).
