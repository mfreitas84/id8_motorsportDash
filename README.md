# id8_motorsportDash

Custom apps for the BMW MGU head unit (iDrive 8), built on the
[MGU App Kit](https://github.com/cauliflowermossgrape/idrive7-apps) and installed with
[MGU Store](https://github.com/robertnisipeanu/mgu-store). Target car: G87 M2 (S58), MGU iDrive 8 BDC3.

| App | What | State |
|---|---|---|
| [`mdev_quickstart`](apps/mdev_quickstart) | Plumbing check: live rpm, coolant, oil temperature and speed (polled SOME/IP getters), plus one gated OBD read (intake air temperature from the DME) | v0.1.0, to verify on the car |
| [`mdev_trackdash`](apps/mdev_trackdash) | Track day: track map with the car's position (record a track once, reuse it), coolant / oil / speed, throttle / brake / steering bars, CSV session log with GPS; Save USB (parked only) | v0.1.0. **GPS source and USB helper still to wire** (see below) |

The project brief (hardware, data paths, safety rule, roadmap) is [CLAUDE.md](CLAUDE.md).

## Layout

```
apps/<id>/          app.json (what the app is) + main.js (what it does) + its helpers
kit/                the MGU App Kit, vendored at one upstream commit (kit/UPSTREAM.md). Don't edit it here.
tests/              node tests/test_quickstart.js
tools/sync_kit.py   re-copies kit/ from an idrive7-apps clone
mgu-repo.json       makes this repository an MGU Store source (the head unit builds apps/* itself)
```

Never in git (see `.gitignore`): `oap-sdk/` (BMW's SDK), `dist/` (every built package contains it),
`reference/` (your unit's SOME/IP catalog), SSH keys, and `kit/emu/` (the emulator, GPL-3.0, local only).

## Requirements

**Python 3.6+** and **Node.js 14+**. Nothing else: no npm packages.

## On the PC: test, preview, emulate

These work without the car and without BMW's SDK. (On macOS use `python3` instead of `python`.)

```sh
node tests/test_quickstart.js                                    # safety gate, OBD decoding, poller
node tests/test_trackdash.js                                     # track recording, position, log, scalings
python kit/tools/build.py mdev_quickstart --preview-only         # -> dist/mdev_quickstart (not installable)
node kit/tools/preview.js dist/mdev_quickstart preview wait=20 render     # -> preview/main_gfx-0.png (demo data)
```

Live emulator in the browser (the car's own draw engine as WebAssembly, demo drive or manual sliders):

```sh
python tools/sync_kit.py <idrive7-apps clone> --with-emu         # once: copies kit/emu locally (git-ignored)
node kit/tools/emu.js mdev_quickstart                            # -> http://localhost:8077
```

In the emulator the poller runs in **bench** mode. The PC has no SOME/IP, so values come from the
emulator's feed instead of `getValue()`, and the OBD panel says `no link`.

## On the car

The head unit already runs MGU Store, which provides the GPU renderer (`mgu-render`) and the custom-app
hook. Install through the Store, not through the kit's `push-to-car` (that installs its own renderer
and hooks next to the Store's).

### Option A: this repository as a Store source (recommended)

The head unit downloads the repository and builds the app itself, against the SDK already on the unit.
No SDK on the PC, and it's the same route other people will use once the repository is public.

1. The repository is private while testing, so give the Store read access. Create a fine-grained GitHub
   token: **Only select repositories** → `id8_motorsportDash`, **Contents: Read-only**. Add it on the
   car (Store → Settings → Accounts → **Add token**). Typing it on the Store's phone page is easier
   (Settings → Phone access).
2. Store → Settings → **Add source** → `mfreitas84/id8_motorsportDash` → follow the `main` branch.
3. Store page → **Quickstart** → Install. The tile appears under **Apps** about 1-2 minutes later.

To update after a push: Store → **Check now** → Update.

### Option B: build here, install from a USB stick

1. Get BMW's SDK from your unit, once (the key and IP come from idrive7-8-ssh-root's
   `data\enrollments\<VIN>\`):
   ```sh
   scp -i <key> root@<unit-ip>:'/usr/lib/oap-mainapp/preinstalled_apps/x_call@*.tgz' .
   mkdir x_call && tar xzf x_call@<version>.tgz -C x_call
   node kit/tools/extract_sdk.js x_call/javascript/app.js        # -> oap-sdk/ (git-ignored)
   ```
2. Build: `python kit/tools/build.py mdev_quickstart` → `dist/mdev_quickstart@0.1.0.tgz`
3. Put it on a stick with the Store's installer (from an mgu-store checkout):
   `node mgu-install.js usb-repo <stick> dist/mdev_quickstart@0.1.0.tgz`
4. Car: Store → **USB** → Quickstart → Install.

### Optional: check the signals against your unit's catalog

The installer refuses a field flagged `r` (read) that has no getter on this firmware. To check before
installing, copy the catalog off the unit and run the kit's checker:

```sh
scp -i <key> root@<unit-ip>:/etc/oap/someip/someip-interfaces.json reference/
python kit/tools/check_signals.py
python kit/tools/sigdoc.py de.bmw.infotainment.vehicle.CDS
```

## What to verify on the car (v0)

Ignition on (engine running for the rpm and temperature values). Open **Apps → Quickstart**.

| # | Check | Expected | If not |
|---|---|---|---|
| 1 | Tile | "Quickstart" under Apps, about 1-2 min after install | Store → Installed shows the state and error |
| 2 | Screen | Four tiles, no **DEMO** badge top right | DEMO after 5 s = no value arrived: see 3 |
| 3 | Polling panel | `Car   polling 10 Hz   ~30 values/s` (3 fields x 10 Hz); `errors` stays near 0 | `Bench` = no SOME/IP module; `errors` climbing = getter not answering |
| 4 | Live values | rpm follows the throttle; speed matches the cluster; coolant and oil plausible and rising when warming up | A tile stuck at `--`: that getter doesn't deliver on the S58. Note which one |
| 5 | Hide / show | Press HOME: the log says `poller: stop`. Reopen: `poller: start` | |
| 6 | OBD demo | Settings → **OBD demo: intake air temp (DME)** → On. Panel: `status: live` and a plausible IAT (about ambient when cold) | `no answer`, `refused by DME (NRC ..)` or `no link`: note the text |
| 7 | OBD off | Switch it Off: `off`, and the log says `OBD IAT: stop` | |

The app's log is `/var/opt/public/oap/oap_<uid>/data/mdev_quickstart.log` (the Store's phone page
shows logs too). Send back what 3, 4 and 6 show: that decides what the track page can rely on.

## Track Dash (`mdev_trackdash`)

**Header menu:** DASH · TRACKS · REC LOG / STOP LOG · SAVE USB (and Settings). Without the Store's
renderer the same actions are the HMI's bar buttons.

**Track line: record once, reuse.** At a saved track (found by GPS) the map shows its recorded line and
the car as a dot. Anywhere else it draws the live trail. After one full lap, *Save lap as track*
(Tracks page) stores a smoothed, closed line with a start / finish. Tracks live in the app's
`data/tracks.json`, in **CanBusTrackAnalyser's format** plus `line`, so the two can share tracks. The dot
moves at 10 Hz between GPS fixes, from speed and yaw rate (`position.js`).

**Log:** REC LOG writes `data/logs/<YYYYMMDD-HHMMSS>.csv` at 10 rows a second, and keeps recording with
the screen hidden. Columns: `t_iso, t_ms, lat, lon` (smoothed), `gps_lat, gps_lon, gps_age_ms` (the raw
fix), `heading_deg, speed_kmh, rpm, coolant_c, oil_c, throttle_pct, brake_on, brake_pct, steer_deg,
g_long, g_lat, yaw_dps, track_id, demo`. The newest 30 sessions are kept.

**Brake:** the car reports "driver braking" (on / off), not pedal travel or pressure. The red bar shows
how hard from the deceleration (1.3 g = 100 %).

**Not wired yet:**
- **GPS.** No public app reads a position over SOME/IP. I need your unit's catalog to find the
  service: copy `/etc/oap/someip/someip-interfaces.json` into `reference/` (command above). Until then
  the map says *No GPS source yet* on the car; the demo has GPS.
- **Save USB.** Sticks are mounted read-only, so it needs a small root helper (a Store tool). That
  needs one SSH look at how sticks mount first. Until then the button says why it can't run.

**What to check on the car (v0.1.0):**

| # | Check | Expected |
|---|---|---|
| 1 | Tiles | Coolant, oil, speed live; no DEMO badge |
| 2 | Throttle bar | Follows the pedal (green). If it stays `--` / `waiting`: the pedal signal doesn't notify on this car |
| 3 | Brake bar | Goes red when braking. The log line `inputs: statusBrakingDriver raw value ...` shows what the car sends: send it to me |
| 4 | Steering bar | Turning left fills to the left. If it's mirrored, tell me |
| 5 | g long / lat | Plausible under braking and in corners |
| 6 | REC LOG | The REC badge counts up. STOP LOG says how many rows; the file is in `data/logs/` |

## Logging (both apps): Settings → Logging

| Mode | What is written |
|---|---|
| **Normal** (default) | The kit's small app log `data/<id>.log` (two files of 256 KB at most) |
| **Debug** | Normal, plus `data/debug/<YYYYMMDD-HHMMSS>.log`: the start state (settings, every SOME/IP source and whether it works), the **raw value of every field once a second** exactly as the car sent it, counters every 5 s, every button, screen and setting change, OBD requests and replies, and errors with their stack. 2 MB a file, newest 5 kept. **Back to Normal by itself after 2 hours** (counted across restarts) |
| **Off** | No log files at all. The existing app and debug logs are deleted, and the kit's own file log is switched off (a one-line patch, listed in `kit/UPSTREAM.md`). Your REC session CSVs are kept |

To get a debug log off the car without SSH: **Settings → Debug log (QR)** shows it as QR codes. Photograph
them, and `python kit/tools/qrlog_decode.py <photos>` turns them back into text. Over SSH it's in
`/var/opt/public/oap/oap_<uid>/data/debug/`.

**For the first drive, set Logging = Debug** in both apps. The raw values answer the open questions:
which fields arrive, what the brake flag sends, and the steering and yaw signs.

```sh
node tests/test_debug.js                                         # the logging switch
```

## Safety

Every UDS / OBD request goes through two independent checks before it reaches the car:
[`uds_guard.js`](apps/mdev_quickstart/uds_guard.js) (this repository's rule: read / parked-only /
never) and the kit's `ReadOnlyDiag`, which refuses anything but 22 / 01 / 09. v0 sends one kind of
request, `01 0F` to the DME, and only when the setting is on and the screen is visible. The kit's
**Stop all** (in any kit app's settings) stops it at once.

## Licence

MIT ([LICENSE](LICENSE)). `kit/` is MIT, Copyright (c) 2026 cauliflowermossgrape ([kit/UPSTREAM.md](kit/UPSTREAM.md)).
