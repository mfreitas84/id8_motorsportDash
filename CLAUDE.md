# Track Dashboard + USB Logger — MGU (iDrive 8) custom app

Portable project brief. Drop at repo root. Any Claude Code session (or a human) should be
able to start cold from this.

## Hardware & platform
- Car: BMW **G87 M2**. Head unit: **MGU iDrive 8, BDC3** variant.
- Already rooted with `cauliflowermossgrape/idrive7-8-ssh-root` (`--arch id8-bdc3`,
  flash + enroll + `--persist`). Coding backed up via `preflight` before flashing;
  re-code / Digital-Key re-pair handled with E-Sys/ISTA.
- `robertnisipeanu/mgu-store` installed (updater, deploy tool, `mgu-render` GPU renderer,
  `mgu-uplink`). Apps install at next unit restart.
- Dev hosts: Windows PC (this checkout) and macOS. ENET cable + USB-C→Ethernet adapter; also reachable
  over the car Wi-Fi hotspot.
- Goal: test each app on this car first, then make the repository public as an MGU Store source.

## Code we build on (and what we may NOT copy)
- **MGU App Kit** — `cauliflowermossgrape/idrive7-apps`, **MIT**. Vendored in `kit/` at a pinned commit
  (`kit/UPSTREAM.md`, re-sync with `tools/sync_kit.py`). Gives us: `build.py` (app.json → BMW package),
  `preview.js`, `emu.js` (browser emulator), `extract_sdk.js`, the runtime (`mgu.js`, `signals.js`,
  `diag.js`, `readonly-diag.js`, `parked.js`, `gauges.js`, ...). Its GPL-3.0 renderer and emulator
  engine are left out of git on purpose.
- **IterioDev/car-apps** (incl. `iteriodev_cardash`) — **PolyForm Strict 1.0.0**: install and use
  unchanged only; **no copying, modifying, derivative works or redistribution.** Only the files listed in
  cardash's `renderer/kit/NOTICE` are MIT (ported from the kit above). `obd.js` and `tasu-guard.js` are
  NOT among them — never copy them. Our gate (`uds_guard.js`) is written from the SAFETY RULE below; OBD
  decoders are written from SAE J1979.
- **mgu-store** — GPL-3.0; we only use it (install route, renderer on the car), we don't copy from it.
- Reference clones for reading live outside this repo (`../_refs/`).

## App SDK — how vehicle data is read (NO raw CAN)
SDK = BMW `oap-sdk` (cardash pins 24.10.2), extracted from your own unit; apps link the on-unit SDK.
Two data paths — use BOTH, as `iteriodev_cardash` does:

1. **SOME/IP service proxies (joynr)** — declare interfaces in `manifest.json` `proxies`
   (+ matching `permissions.json`). SDK returns proxy objects. IMPORTANT: BMW notifiers often
   don't fire on MGU — **poll the getters** (cardash polls rpm @ 50 ms while a screen is visible).
   Useful services:
   - `de.bmw.infotainment.vehicle.CDS` / `CDS2`  → rpm, oil/coolant/intake temps
   - `de.bmw.infotainment.vehicle.Vehicle2`      → road speed
   - `de.bmw.infotainment.drivingexcitement.FES` → crank torque, sport-display boost/power/torque %, g
   - `de.bmw.infotainment.displaydata.DisplayDataServer2` → gear, rpm needle, power meter
   - `de.bmw.powertrain.Powertrain` / `AcceleratorPedal`  → gear display, raw pedal
   - Harman `...environment.levelmonitor.LevelMonitor` ("Inst1") → system/battery voltage

2. **OBD/UDS via TASU** — proxy `com.harman...tasu.tasu.InternalTasu`. Internal diagnostic tester.
   Send UDS/OBD-II to ECUs by diag address: **DME 0x12**, EGS/gearbox 0x18.
   Source of boost, IAT, throttle, fuel pressures, DPF, DTCs (not on the SOME/IP bus).
   Transport: the kit's `diag.js` (sendTasuRequest, tester 0xF2) behind `readonly-diag.js` (22/01/09
   only, paced). Our own `uds_guard.js` in front of it. Write our own J1979 decoders (PID table,
   multi-PID requests, supported-PID bitmaps) as the track page needs them — NOT cardash's obd.js.
   Key PIDs: 0x0C rpm (/4), 0x05 coolant (-40), 0x5C oil (-40), 0x0F iat (-40), 0x0B map (<=255kPa),
   0x70/0x87 boost sensors, 0x33 baro, 0x0D speed, 0x5E fuelRate, 0xA4 gear (to EGS 0x18).

## SAFETY RULE (non-negotiable — implemented in apps/*/uds_guard.js, tested in tests/)
Classify every UDS request before sending:
- `read` (always): 01 02 03 06 07 09 0A, 19, 22, 3E, and `10 01`.
- `parked` (only speed <1 km/h AND rpm <50, values fresh): writes, routines, resets, security access, DTC clear.
- `blocked` (NEVER): flash/memory 0x34 0x35 0x36 0x37 0x38 0x3D.
Logging is read-only (01/22). No writes while moving. Ever.

## Package shape (kit format)
We write only `apps/<id>/app.json` (id, `mguHmi: ["ID8"]`, `signals` with flags `r` getter / `s`
subscribe / `w` setter, `screens`, `settings`) + `main.js` (+ helpers). `kit/tools/build.py` generates
BMW's package from it: `package.json`, `manifest.json` (proxies), `permissions.json`, `rhmiData/`, and
copies `kit/runtime` in as `javascript/kit/`. Output `dist/<id>@<ver>.tgz` (contains BMW's SDK: never
publish). Drawing goes through the kit's recorder to the Store's `mgu-render`
(`/run/mgu-render/render.sock`), else PNG frames via the HMI.
Install via MGU Store: this repo is a "repo tree" source (`mgu-repo.json`; the unit builds the apps
with its own SDK), or a built `.tgz` on a USB stick. Not the kit's `push-to-car` (it installs its own
renderer/hooks beside the Store's). Tiles appear ~1-2 min later. See README.md.

## v0 scope — two features
### A. Track-day driving page (GPU / mgu-render)
Glanceable while driving. Priorities for track engine survival:
- **Oil temp, coolant temp** — big, with warning zones (amber/red thresholds, configurable).
- **Oil pressure** if obtainable (confirm PID/service on-car; may need 0x22 DID).
- rpm + shift indication, gear, speed, boost (fused 0x70/0x87/0x0B minus 0x33), IAT, battery V.
- Peak-hold on temps/boost/rpm. Metric units (match car setting later).
- Layout: thermal vitals dominant; engine/speed secondary. One screen, no paging while driving.

### B. USB logging while driving
- Capture all polled SOME/IP signals + the OBD PID set to **CSV** (timestamp + columns), ~10 Hz
  (SOME/IP) with OBD at its slower round-trip rate; one row per sample, ISO-8601 or ms epoch.
- Auto-start when car moving / screen open; flush periodically; close file cleanly on hide/shutdown.
- **OPEN QUESTION — verify on-device:** where USB mounts on this unit (e.g. /media/...). The Drive
  Recorder app writes media, so a path exists — inspect a mounted stick over SSH before coding the writer.
  Fallback: log to app dataDir, copy to USB on request.

## Build / deploy loop (Windows or macOS; `python3` on macOS)
1. Edit `apps/<id>/app.json` / `main.js`. 2. `node tests/test_quickstart.js`.
3. `python kit/tools/build.py <id> --preview-only` + `node kit/tools/preview.js dist/<id> preview wait=20 render`
   (or the live emulator `node kit/tools/emu.js <id>`) — no car, no SDK needed.
4. Push to GitHub → car: Store → Check now → Update (repo-tree source). For a local `.tgz` build the SDK
   must be extracted once (`kit/tools/extract_sdk.js`, see README).
5. Verify on the car with the checklist in README.md.

## Open questions to resolve on-device
- USB mount path (feature B).
- Oil-pressure availability (PID or 0x22 DID; the M2 S58 may expose it).
- GPS/position service for lap timing (future; is there a SOME/IP position provider?).
- Confirm which SOME/IP getters actually return live values on the S58 (cardash CAL notes are guesses).

## Storage & USB (learned from oap-driverecorder-next 2.5.2)
- App runs under a sandbox uid. Own dirs:
  - data: `/var/opt/public/oap/oap_<uid>/data`   (write freely here — use for logs)
  - source: `/var/opt/public/oap/oap_<uid>/source`
- The car mounts USB sticks **read-only** (for its media player). An app CANNOT write the stick directly.
  Drive Recorder's pattern to copy to USB: app writes a flag `/dev/shm/oap-driverecorder-usb` every 3 s;
  a **root helper** (`usb-rw.sh`, shipped in its player component, runs as root) remounts the stick rw
  while the flag is fresh and back to ro ~20 s later — and ONLY while the car stands still.
- Stick discovery (label, free space) is delegated to that root helper, not scanned by the app.

### USB-logger design decision (v-next, not v0)
- Log continuously to the app data dir while driving (read-only capture → CSV). ALLOWED while moving.
- Copy/flush to USB only when PARKED, via our own small root remount helper (model on usb-rw.sh),
  installed through mgu-store deploy. Do NOT keep a stick writable at speed (corruption risk on power cut).
- **Log lifecycle = per session:** on app entry, CLEAR the existing log (start a fresh CSV each launch).
- **Two on-screen buttons:**
  - "Clear log" — wipes the current session CSV in the data dir, resets the capture. Allowed any time.
  - "Save to USB" — copies the current CSV to the stick. ENABLED only when a stick is detected AND the
    car is parked; otherwise greyed with a hint ("No USB stick" / "Only while parked"). Uses the root
    remount helper (flag in /dev/shm → helper makes stick rw → copy → helper restores ro).
- Stick-present detection: delegated to the root helper (reports label + free space), same as the recorder.

## Revised v0 scope (START HERE — keep it a "quick start" reference)
Fresh, minimal, heavily-commented app that proves the plumbing end to end — NOT the full track page yet:
- One GPU (mgu-render) screen showing a few LIVE values via polled SOME/IP getters:
  rpm (CDS/CDS2), coolant + oil temp, road speed (Vehicle2). Poll ~10 Hz while screen visible.
- Keep OBD OFF in v0 — ONE OBD read (IAT 0x0F to DME 0x12) behind a setting, through our own
  `uds_guard.js` and the kit's `ReadOnlyDiag`, so the TASU path is demonstrated, gated.
  (Built: `apps/mdev_quickstart`, v0.1.0 — awaiting the on-car checklist in README.md.)
- No logging, no USB, no settings sprawl. Clean app.json / manifest.json / permissions.json.
Once this runs on-car, layer: (1) the track-day thermal layout + peak-hold, (2) dataDir CSV logger,
(3) parked USB copy via root helper.
