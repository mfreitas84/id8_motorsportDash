'use strict';
/**
 * mdev_trackdash - track-day dashboard.
 *
 *   Header menu   DASH | TRACKS | REC LOG / STOP LOG | SAVE USB   (+ the kit's Settings)
 *   Dash          the track map with the car as a dot; coolant, oil, speed; throttle (green), brake (red)
 *                 and steering bars; g long / lat
 *   Tracks        saved tracks; "Save lap as track" once the live trail closes a lap; start / finish;
 *                 delete
 *
 * The track line (CLAUDE.md, decided 2026-11-26): record once, reuse.
 *   - At a saved track (found by GPS: its detect circle), the map shows its clean recorded line.
 *   - Anywhere else it draws the live trail. When the trail closes into a lap, "Save lap as track"
 *     turns it into a smoothed, closed line with a start / finish (tracks.js). An imported track with
 *     no line (CanBusTrackAnalyser's tracks.json) gets the lap added to it.
 *
 * Logging: REC LOG starts a new CSV in the app's data folder (logger.js), 10 rows a second, GPS
 * included; it keeps recording while the screen is hidden. SAVE USB copies the newest log to a stick:
 * only with a stick present AND the car parked (usb.js; the helper that makes it possible comes next).
 *
 * Polling (inputs.js) runs while the screen is shown or a log is recording, and stops otherwise.
 * Values: inputs.js (car) or demo.js (PC / no answer) -> position.js (smooth dot between GPS fixes).
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const geo = require('./geo');
const draw = require('./draw');
const { Inputs } = require('./inputs');
const { Position } = require('./position');
const { TrackStore, TrailRecorder } = require('./tracks');
const { SessionLogger } = require('./logger');
const { UsbBridge } = require('./usb');
const { Demo } = require('./demo');
const { Debug } = require('./debug');

const SCREEN = 'MAIN';
const SAMPLE_MS = 100;            // 10 Hz: dashboard model, dead reckoning, log rows
const DEMO_AFTER_MS = 5000;
const PAGES = ['Dash', 'Tracks'];
const TAB_REC = 2, TAB_USB = 3;

const COLUMNS = ['t_iso', 't_ms', 'lat', 'lon', 'gps_lat', 'gps_lon', 'gps_age_ms', 'heading_deg', 'speed_kmh', 'rpm',
    'coolant_c', 'oil_c', 'throttle_pct', 'brake_on', 'brake_pct', 'steer_deg', 'g_long', 'g_lat', 'yaw_dps', 'track_id', 'demo',
    'gps_speed_raw', 'gps_quality_raw'];      // GPSData's ground speed and fix quality, unscaled (scales unknown)

mgu.run({
    async start(ctx) {
        const log = ctx.log, S = ctx.settings;
        // Settings > Logging (Normal / Debug / Off): first, so the debug file sees everything that follows
        const dbg = new Debug(ctx);
        log.info('trackdash: start');

        const inputs = new Inputs(ctx);
        inputs.onRaw = (name, v) => dbg.raw(name, v);         // raw car values, once a second, in Debug
        await inputs.init();
        const demo = new Demo();
        const pos = new Position();
        const trail = new TrailRecorder();
        const realStore = new TrackStore(ctx.dataDir, log);
        const demoStore = new TrackStore(null, log, { memoryOnly: true });     // demo laps are never written
        const logger = new SessionLogger(ctx.dataDir, log, COLUMNS);
        const usb = new UsbBridge(log);

        let page = 0, selId = null, track = null, toastMsg = '', toastT = 0, demoWas = null;
        const t0 = Date.now();
        const toast = (s) => { toastMsg = s; toastT = Date.now(); log.info('toast: ' + s); };
        const demoOn = () => {
            const mode = S.get('demo');
            return mode === 'on' || (mode !== 'off' && !inputs.anyLive() && Date.now() - t0 > DEMO_AFTER_MS);
        };
        const store = () => (demoWas ? demoStore : realStore);

        // ---- "parked" for Save USB: the same rule as the UDS gate in CLAUDE.md --------------------
        const fresh = (k) => inputs.at[k] && Date.now() - inputs.at[k] < 2000;
        const parked = () => !demoWas && fresh('speed') && fresh('rpm') && inputs.v.speed < 1 && inputs.v.rpm < 50;

        // ---- actions (header tabs, HMI bar buttons and page buttons all land here) -------------------
        const act = {
            page: (i) => { page = i; },
            toggleRec: () => {
                if (logger.on) { logger.stop(); toast('Log saved: ' + logger.status().rows + ' rows'); return; }
                if (logger.start()) toast('Recording to ' + require('path').basename(logger.file));
                else toast('Cannot record: ' + logger.error);
            },
            saveUsb: () => {
                const u = usb.status();
                if (!u.present) return toast('Save USB: ' + (u.why || 'no USB stick'));
                if (!parked()) return toast('Save USB: only while parked (engine off, standing still)');
                const f = logger.latest();
                if (!f) return toast('Save USB: no log yet');
                return usb.save(f).then((dst) => toast('Saved to USB: ' + dst)).catch((e) => toast('Save USB: ' + e.message));
            },
            select: (id) => { selId = id; },
            saveLap: () => {
                const start = trail.pl ? trail.pl.ll(trail.points()[0]) : null;
                const nearby = start ? store().detect(start) : null;      // an imported track here gets the line
                const tr = trail.buildTrack(null, nearby && !nearby.line ? nearby : null);
                if (!tr) return toast('Drive one full lap first');
                store().add(tr);
                selId = tr.id; trail.reset();
                toast('Saved ' + tr.name + ' (' + (tr.length_m / 1000).toFixed(2) + ' km)');
            },
            restartTrail: () => { trail.reset(); toast('Trail restarted'); },
            startFinish: () => {
                const id = selId || (track && track.id);
                if (store().setStartFinish(id, pos.latLon(), pos.heading())) toast('Start/finish set here');
                else toast('Start/finish needs a GPS fix and a heading (drive a little)');
            },
            remove: () => {
                const id = selId || (track && track.id);
                if (!id) return;
                store().remove(id);
                if (track && track.id === id) track = null;
                selId = null; toast('Track deleted');
            },
        };
        // every action is one line in the debug log
        Object.keys(act).forEach((k) => { const fn = act[k]; act[k] = (...a) => { dbg.event('action ' + k, a.length ? a : undefined); return fn(...a); }; });
        ctx.ui.onVisible((name, on) => dbg.event('screen ' + name + (on ? ' shown' : ' hidden')));
        if (ctx.onTab) ctx.onTab((i) => {
            if (i === TAB_REC) return act.toggleRec();
            if (i === TAB_USB) return act.saveUsb();
            return act.page(i);
        });
        ctx.ui.onClick('BTN_PAGE', () => act.page((page + 1) % PAGES.length));
        ctx.ui.onClick('BTN_REC', () => act.toggleRec());
        ctx.ui.onClick('BTN_USB', () => act.saveUsb());
        // where the kit runs the screen the header tabs do these jobs, so the bar buttons go
        if (ctx.hideButton) ['BTN_PAGE', 'BTN_REC', 'BTN_USB'].forEach((b) => ctx.hideButton(b));

        // ---- the 10 Hz sample: values -> position -> track / trail -> log -------------------------
        let lastFixT = 0, lastDetect = 0, d = inputs.v;
        setInterval(() => {
            const now = Date.now(), dm = demoOn();
            if (dm !== demoWas) {                                         // live <-> demo: start the map afresh
                demoWas = dm; pos.reset(); trail.reset(); track = null; lastFixT = 0;
                log.info(dm ? 'demo data on' : 'live car data');       // (also in the debug log: ctx.log is wrapped)
            }
            d = dm ? demo.sample(now) : inputs.v;
            if (d.fixT && d.fixT !== lastFixT) { lastFixT = d.fixT; pos.fix(d.fix[0], d.fix[1], d.fixT); }
            pos.step(d.speed, d.yaw, now);
            const ll = pos.latLon();
            if (now - lastDetect > 2000) { lastDetect = now; track = store().detect(ll); }
            if (!(track && track.line)) trail.feed(ll, pos.heading(), now);
            inputs.run(ctx.ui.isVisible(SCREEN) || logger.on);
            if (logger.on) {
                const fixLL = pos.fixLatLon(), b = brake(d, dm);
                logger.row({
                    t_iso: new Date(now).toISOString(), t_ms: now,
                    lat: ll && ll[0], lon: ll && ll[1], gps_lat: fixLL && fixLL[0], gps_lon: fixLL && fixLL[1],
                    gps_age_ms: pos.fixAge(now), heading_deg: pos.heading(),
                    speed_kmh: d.speed, rpm: d.rpm, coolant_c: d.coolant, oil_c: d.oil,
                    throttle_pct: d.throttle, brake_on: d.braking, brake_pct: b.pct, steer_deg: d.steer,
                    g_long: d.gLong, g_lat: d.gLat, yaw_dps: d.yaw, track_id: track ? track.id : '', demo: dm,
                    gps_speed_raw: dm ? null : inputs.v.gpsSpeedRaw, gps_quality_raw: dm ? null : inputs.v.gpsQualityRaw,
                });
            }
        }, SAMPLE_MS);

        // ---- the screen ------------------------------------------------------------------------------
        ctx.loop(SCREEN, 10, () => {
            const t = ctx.theme(), now = Date.now(), dm = !!demoWas;
            const cv = ctx.canvas(1600, 520).clear(t.bg);
            const st = logger.status();
            const recText = st.on ? 'Stop log' : 'Rec log';
            const mmss = (ms) => { const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
            G.frame(cv, t, PAGES.concat([recText, 'Save USB']), page,
                [dm && { text: 'DEMO' }, st.on && { text: 'REC ' + mmss(now - st.since), color: t.crit }]);

            const src = inputs.status(now), b = brake(d, dm);
            const m = {
                d, demo: dm, src, settings: { coolWarn: S.get('coolWarn'), oilWarn: S.get('oilWarn'), steerRange: S.get('steerRange') },
                pos: pos.latLon(), heading: pos.heading(), fixAge: pos.fixAge(now),
                gpsState: dm ? 'ok' : src.gps, track, trail, lapReady: trail.lapReady(), store: store(), selId,
                mapTitle: track ? track.name : 'Track',
                brakePct: b.pct, brakeNote: b.note,
            };
            if (page === 0) draw.dash(cv, t, m); else draw.tracks(cv, t, m, act);
            if (now - toastT < 2500) draw.toast(cv, t, toastMsg);
            return ctx.ui.image('MAIN_GFX', cv);
        });

        // ---- debug log: how things stand at start, then counters every 5 s ----------------------------
        dbg.startup({ sources: inputs.sources(), tracks: realStore.tracks.map((x) => x.id), dataDir: ctx.dataDir });
        dbg.stats(() => {
            const now = Date.now(), ages = {};
            Object.keys(inputs.at).forEach((k) => { ages[k] = inputs.at[k] ? now - inputs.at[k] : null; });
            const st = logger.status();
            return {
                demo: !!demoWas, page: PAGES[page], visible: ctx.ui.isVisible(SCREEN),
                poll: Object.assign({ running: !!inputs.poller.timer }, inputs.poller.stats), src: inputs.status(now), ageMs: ages,
                gps: Object.assign({ state: inputs.gpsState(now), fixAgeMs: pos.fixAge(now), heading: pos.heading() }, inputs.gps.state()),
                track: track ? track.id : null,
                trailM: Math.round(trail.lengthM()), lapReady: trail.lapReady(), rec: st.on ? { rows: st.rows, kb: Math.round(st.bytes / 1024) } : false,
            };
        });
        dbg.settingsRow();
        log.info('trackdash: ready');
    },
});

/**
 * Brake bar: { pct, note }. The car tells "driver braking" (on / off), not how hard; the deceleration
 * says how hard. 1.3 g of deceleration = 100 %.
 */
function brake(d, demo) {
    const decel = G.isNum(d.gLong) ? Math.max(0, -d.gLong) : null;
    const fromG = decel === null ? null : Math.min(100, (decel / 1.3) * 100);
    if (d.braking === true) return { pct: Math.max(8, fromG || 0), note: demo ? '' : 'on/off + decel' };
    if (d.braking === false) return { pct: 0, note: demo ? '' : 'on/off + decel' };
    if (fromG === null) return { pct: null, note: 'no data' };          // neither the flag nor g: "--", not 0 %
    return { pct: decel > 0.15 ? fromG : 0, note: 'est. from decel' };
}
