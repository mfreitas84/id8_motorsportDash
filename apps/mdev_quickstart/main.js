'use strict';
/**
 * mdev_quickstart - the smallest app that proves the whole plumbing on an MGU (iDrive 8):
 *
 *   SOME/IP getters, polled   rpm, coolant + oil temperature (vehicle.CDS), road speed (vehicle.Vehicle2),
 *                             10 Hz while the screen is visible, nothing while it isn't  -> poller.js
 *   One OBD-II read, gated    intake air temperature, mode 01 PID 0F to the DME (0x12) over TASU,
 *                             OFF unless the setting is on, and checked by our own gate -> obd_iat.js,
 *                                                                                         uds_guard.js
 *   One GPU screen            drawn with the kit's recorder; the Store's mgu-render shows it at 60 fps,
 *                             or the kit falls back to PNG frames through the HMI.
 *
 * How an MGU app is put together (the MGU App Kit, kit/, see kit/UPSTREAM.md):
 *   apps/<id>/app.json   what the app is: id, signals it reads, screens, settings. kit/tools/build.py
 *                        turns it into BMW's package (package.json, manifest.json with the SOME/IP
 *                        proxies, permissions.json, rhmiData/ with the HMI screens).
 *   apps/<id>/main.js    what it does: mgu.run({ start(ctx) }) - this file.
 *   kit/runtime/         copied into the package as javascript/kit/, so `require('./kit/...')` works.
 *
 * ctx (kit/runtime/mgu.js) used here:
 *   ctx.signals          SOME/IP: proxy(iface, inst), onAvailable(p, fn), watch(...)
 *   ctx.ui.onVisible     fn(screenName, visible) when the HMI shows / hides one of our screens
 *   ctx.loop(screen, fps, draw)   draws only while that screen is visible
 *   ctx.canvas(w, h)     the frame to draw on; ctx.theme() its colours
 *   ctx.settings         get(key), onChange(fn(key, value))
 *   ctx.onPanic(fn)      the kit's "Stop all" in any app's settings: stop talking to the car
 *   ctx.log              info / warn / error -> system log and data/mdev_quickstart.log
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const Sim = require('./kit/sim');
const { Poller } = require('./poller');
const { UdsGuard } = require('./uds_guard');
const { IatReader } = require('./obd_iat');

const SCREEN = 'MAIN';
const POLL_MS = 100;                 // 10 Hz
const DEMO_AFTER_MS = 5000;          // demo "auto": switch to simulated data if the car is silent this long

// Raw -> real units. BMW's own scalings, the same as kit/runtime/car.js (README section 7).
// Each field also has an "invalid" raw value the car sends when it has no reading.
const RPM = { factor: 0.25, invalid: 65535 };              // CDS.statusEngineSpeed2.actualValueRPMEngineCrankshaft
const SPEED = { factor: 0.015625, invalid: 65535 };        // Vehicle2.statusCarSpeed2.speedVehicleCentreOfGravity
const TEMP = { factor: 1, offset: -48, invalid: 255 };     // CDS.statusEngineTemperature.temperatureEngine(Oil)Drive
const scale = (raw, s) => (typeof raw === 'number' && raw !== s.invalid ? raw * s.factor + (s.offset || 0) : null);

// Warning zones for the two temperature tiles. Placeholders for v0: the track page makes them settings.
const COOLANT_ZONES = [{ from: 110, to: 999, color: 'warn' }, { from: 118, to: 999, color: 'crit' }];
const OIL_ZONES = [{ from: 130, to: 999, color: 'warn' }, { from: 140, to: 999, color: 'crit' }];

mgu.run({
    async start(ctx) {
        const log = ctx.log;
        log.info('quickstart: start');

        // ---- latest values, in real units, with the time each one arrived --------------------------
        const live = { rpm: null, speed: null, coolant: null, oil: null };
        const seen = { rpm: 0, speed: 0, coolant: 0, oil: 0 };
        const put = (k, v) => { if (v !== null) { live[k] = v; seen[k] = Date.now(); } };

        // ---- the safety gate, fed with the same speed and rpm the screen shows ---------------------
        const guard = new UdsGuard({ freshMs: 2000 });

        // ---- SOME/IP: one poller, three fields on two interfaces -------------------------------------
        const poller = new Poller(ctx.signals, log, POLL_MS);
        poller.add('de.bmw.infotainment.vehicle.CDS', 'statusEngineSpeed2', (v) => {
            const rpm = scale(v && v.actualValueRPMEngineCrankshaft, RPM);
            put('rpm', rpm); guard.rpm(rpm);
        });
        poller.add('de.bmw.infotainment.vehicle.CDS', 'statusEngineTemperature', (v) => {
            put('coolant', scale(v && v.temperatureEngineDrive, TEMP));
            put('oil', scale(v && v.temperatureEngineOilDrive, TEMP));
        });
        poller.add('de.bmw.infotainment.vehicle.Vehicle2', 'statusCarSpeed2', (v) => {
            const kmh = scale(v && v.speedVehicleCentreOfGravity, SPEED);
            put('speed', kmh); guard.speed(kmh);
        });
        await poller.init();

        // ---- OBD over TASU: built only when the setting turns it on ----------------------------------
        const iat = new IatReader(ctx, guard);
        // (the PC preview's stubbed head unit has no Stop all; the kit's own apps check the same way)
        if (ctx.onPanic) ctx.onPanic((on) => iat.panic(on));

        // ---- visibility: poll and read only while the screen is up -----------------------------------
        const visible = () => ctx.ui.isVisible(SCREEN);
        const apply = () => {
            if (visible()) poller.start(); else poller.stop();
            if (visible() && ctx.settings.get('obdIat')) iat.start(); else iat.stop();
        };
        ctx.ui.onVisible((name) => { if (name === SCREEN) apply(); });
        ctx.settings.onChange((key) => { if (key === 'obdIat') apply(); });
        apply();

        // ---- demo data (the PC, or a car whose signals don't answer) ---------------------------------
        const sim = new Sim();
        const t0 = Date.now();
        const anyLive = () => Object.keys(seen).some((k) => seen[k] > 0);
        const demoOn = () => {
            const m = ctx.settings.get('demo');
            return m === 'on' || (m !== 'off' && !anyLive() && Date.now() - t0 > DEMO_AFTER_MS);
        };

        // ---- poll rate actually achieved: values per second over the last second ---------------------
        let rate = 0, lastValues = 0;
        setInterval(() => { rate = poller.stats.values - lastValues; lastValues = poller.stats.values; }, 1000);

        // ---- the screen ------------------------------------------------------------------------------
        ctx.loop(SCREEN, 10, () => {
            const t = ctx.theme();
            const demo = demoOn();
            const d = demo ? sim.sample() : live;
            const cv = ctx.canvas(1600, 520).clear(t.bg);
            G.frame(cv, t, ['Quickstart'], 0, [demo && { text: 'DEMO' }]);

            // four tiles in a row: the values this app exists to prove
            const y = G.TOP + 8, h = 270, w = 376, gap = 16, x0 = 16;
            G.stat(cv, t, x0, y, w, h, { label: 'Coolant', value: d.coolant, unit: '°C', size: 110, zones: COOLANT_ZONES });
            G.stat(cv, t, x0 + (w + gap), y, w, h, { label: 'Oil', value: d.oil, unit: '°C', size: 110, zones: OIL_ZONES });
            G.stat(cv, t, x0 + 2 * (w + gap), y, w, h, { label: 'Engine', value: d.rpm, unit: 'rpm', size: 110 });
            G.stat(cv, t, x0 + 3 * (w + gap), y, w, h, { label: 'Speed', value: d.speed, unit: 'km/h', size: 110 });

            // bottom left: is the plumbing working?
            const by = y + h + 14, bh = G.BOTTOM - by - 4;
            const p = G.panel(cv, t, x0, by, 2 * w + gap, bh, 'SOME/IP polling');
            const line = (i, s, c) => cv.text(s, p.x + 22, p.y + 76 + i * 34, 26, c || t.text);
            const ages = Object.keys(seen).map((k) => k + ' ' + (seen[k] ? ((Date.now() - seen[k]) / 1000).toFixed(1) + ' s' : '--'));
            line(0, (poller.mode === 'car' ? 'Car' : 'Bench (no SOME/IP)') + '   ' + (poller.timer ? 'polling ' + Math.round(1000 / POLL_MS) + ' Hz' : 'idle') + '   ' + rate + ' values/s');
            line(1, 'reads ' + poller.stats.reads + '   values ' + poller.stats.values + '   errors ' + poller.stats.errors + '   skipped ' + poller.stats.skipped, t.dim);
            line(2, 'last value: ' + ages.join('   '), t.dim);

            // bottom right: the one OBD read
            const q = G.panel(cv, t, x0 + 2 * (w + gap), by, 2 * w + gap, bh, 'OBD  01 0F  ->  DME 0x12');
            const on = !!ctx.settings.get('obdIat');
            const fresh = iat.state.value !== null && Date.now() - iat.state.at < 3000;
            G.readout(cv, t, q.x + 22, q.y + 48, { label: 'Intake air', value: fresh ? iat.state.value : null, unit: '°C', size: 64 });
            cv.text(on ? 'status: ' + iat.state.status : 'off (Settings: OBD demo)', q.x + 330, q.y + 92, 26, on ? t.text : t.dim);
            if (iat.state.note) cv.text(iat.state.note.slice(0, 40), q.x + 330, q.y + 126, 22, t.dim);
            cv.text('parked: ' + (guard.parked() ? 'yes' : 'no') + '   (gate allows reads either way)', q.x + 330, q.y + 160, 22, t.dim);

            return ctx.ui.image('MAIN_GFX', cv);
        });

        log.info('quickstart: ready (poller ' + poller.mode + ')');
    },
});
