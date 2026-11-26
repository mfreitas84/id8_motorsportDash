# id8_motorsportDash

Custom apps for the BMW MGU head unit (iDrive 8), built on the
[MGU App Kit](https://github.com/cauliflowermossgrape/idrive7-apps) and installed with
[MGU Store](https://github.com/robertnisipeanu/mgu-store). Target car: G87 M2 (S58), MGU iDrive 8 BDC3.

| App | What | State |
|---|---|---|
| [`mdev_quickstart`](apps/mdev_quickstart) | Plumbing check: live rpm, coolant, oil temperature and speed (polled SOME/IP getters), plus one gated OBD read (intake air temperature from the DME) | v0.1.0, to verify on the car |

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

## Safety

Every UDS / OBD request goes through two independent checks before it reaches the car:
[`uds_guard.js`](apps/mdev_quickstart/uds_guard.js) (this repository's rule: read / parked-only /
never) and the kit's `ReadOnlyDiag`, which refuses anything but 22 / 01 / 09. v0 sends one kind of
request, `01 0F` to the DME, and only when the setting is on and the screen is visible. The kit's
**Stop all** (in any kit app's settings) stops it at once.

## Licence

MIT ([LICENSE](LICENSE)). `kit/` is MIT, Copyright (c) 2026 cauliflowermossgrape ([kit/UPSTREAM.md](kit/UPSTREAM.md)).
