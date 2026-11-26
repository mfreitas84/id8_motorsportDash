'use strict';
/**
 * Tests for mdev_trackdash's logic (no head unit, no SDK):   node tests/test_trackdash.js
 * Track recording from a simulated lap, the saved format, position smoothing, the CSV log, scalings.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const APP = path.join(__dirname, '..', 'apps', 'mdev_trackdash');
// app files require './kit/...' as they sit in the built package; point that at kit/runtime here
const resolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
    if (req.indexOf('./kit/') === 0) req = path.join(__dirname, '..', 'kit', 'runtime', req.slice(6));
    return resolve.call(this, req, parent, ...rest);
};
const geo = require(path.join(APP, 'geo'));
const { Position } = require(path.join(APP, 'position'));
const { TrackStore, TrailRecorder } = require(path.join(APP, 'tracks'));
const { SessionLogger, cell } = require(path.join(APP, 'logger'));
const { Demo } = require(path.join(APP, 'demo'));
const { SC } = require(path.join(APP, 'inputs'));

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('ok   ' + name); };
const quiet = { info() {}, warn() {}, error() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trackdash-'));

/** Drive the demo circuit for `seconds` at 10 Hz; feed position + trail like main.js does. */
function drive(seconds) {
    const demo = new Demo(), pos = new Position(), trail = new TrailRecorder();
    let t = 1e9, lastFix = 0;
    const out = { demo, pos, trail, lapAt: null };
    for (let i = 0; i < seconds * 10; i++) {
        t += 100;
        const d = demo.sample(t);
        if (d.fixT !== lastFix) { lastFix = d.fixT; pos.fix(d.fix[0], d.fix[1], d.fixT); }
        pos.step(d.speed, d.yaw, t);
        trail.feed(pos.latLon(), pos.heading(), t);
        if (out.lapAt === null && trail.lapReady()) out.lapAt = i / 10;
    }
    return out;
}

// ---- geometry --------------------------------------------------------------------------------
test('distance and plane agree (100 m north, 100 m east)', () => {
    const o = [37.89, -7.34], pl = geo.plane(o);
    const n = pl.ll([0, 100]), e = pl.ll([100, 0]);
    assert.ok(Math.abs(geo.distance(o, n) - 100) < 0.1);
    assert.ok(Math.abs(geo.distance(o, e) - 100) < 0.1);
    assert.ok(Math.abs(geo.heading([0, 0], [100, 0]) - 90) < 1e-9);
    assert.strictEqual(geo.headingDiff(350, 10), 20);
});

test('resample makes even spacing; smooth keeps a closed loop closed', () => {
    const sq = [[0, 0], [100, 0], [100, 100], [0, 100]];
    const r = geo.resample(sq, 10, true);
    assert.ok(r.length >= 39 && r.length <= 40, 'about 40 points round a 400 m square: ' + r.length);
    for (let i = 1; i < r.length; i++) assert.ok(Math.abs(Math.hypot(r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1]) - 10) < 1e-6 || i % 10 === 0);
    const s = geo.smooth(r, 2, true);
    assert.strictEqual(s.length, r.length);
});

// ---- position --------------------------------------------------------------------------------
test('dead reckoning keeps the dot moving between 1 Hz fixes, close to the true path', () => {
    const { demo, pos } = drive(40);
    const truth = demo.c.pts[Math.floor(demo.s / 2) % demo.c.n];          // circuit points are local metres already
    const est = demo.pl.xy(pos.latLon());
    const err = Math.hypot(est[0] - truth[0], est[1] - truth[1]);
    assert.ok(err < 25, 'within 25 m of the true position at speed (' + err.toFixed(1) + ' m)');
});

test('without fixes for 3 s the dot stops (no drifting off forever)', () => {
    const p = new Position();
    p.fix(37.89, -7.34, 0); p.fix(37.8901, -7.34, 1000);
    for (let t = 1100; t <= 6000; t += 100) p.step(100, 0, t);
    const a = p.latLon();
    for (let t = 6100; t <= 9000; t += 100) p.step(100, 0, t);
    assert.deepStrictEqual(p.latLon(), a);
});

// ---- trail -> track ----------------------------------------------------------------------------
const lapRun = drive(90);

test('one lap of the demo circuit closes the trail', () => {
    assert.ok(lapRun.lapAt !== null, 'lap closed');
    assert.ok(lapRun.lapAt > 30 && lapRun.lapAt < 90, 'after a plausible lap time: ' + lapRun.lapAt + ' s');
});

test('buildTrack: closed, smoothed line in the analyser format, close to the real circuit', () => {
    const tr = lapRun.trail.buildTrack('Demo');
    assert.ok(tr.id && tr.name === 'Demo');
    for (const k of ['detect', 'start_finish', 'min_lap_s', 'line']) assert.ok(tr[k] !== undefined, k);
    assert.ok(typeof tr.detect.lat === 'number' && typeof tr.detect.lon === 'number' && tr.detect.radius_m > 200);
    assert.strictEqual(tr.start_finish.a.length, 2);
    const real = lapRun.demo.c.length;
    assert.ok(Math.abs(tr.length_m - real) / real < 0.08, 'length ' + tr.length_m + ' m vs circuit ' + Math.round(real) + ' m');
    // every saved point lies near the true circuit
    const pl = lapRun.demo.pl, ref = lapRun.demo.c.pts;
    let worst = 0;
    for (const p of tr.line.filter((_, i) => i % 10 === 0)) {
        const q = pl.xy(p);
        worst = Math.max(worst, Math.min.apply(null, ref.map((r) => Math.hypot(r[0] - q[0], r[1] - q[1]))));
    }
    assert.ok(worst < 12, 'line within 12 m of the circuit (worst ' + worst.toFixed(1) + ' m)');
});

test('an imported track without a line keeps its id, name, detect and start/finish', () => {
    const imported = { id: 'circuito_do_sol', name: 'Circuito do Sol', detect: { lat: 1, lon: 2, radius_m: 513 },
        start_finish: { a: [1, 2], b: [1, 2.0001] }, min_lap_s: 40 };
    const tr = lapRun.trail.buildTrack(null, imported);
    assert.strictEqual(tr.id, 'circuito_do_sol');
    assert.deepStrictEqual(tr.detect, imported.detect);
    assert.deepStrictEqual(tr.start_finish, imported.start_finish);
    assert.ok(tr.line.length > 100);
});

// ---- store ----------------------------------------------------------------------------------------
test('TrackStore saves, reloads, detects and deletes', () => {
    const dir = tmp(), st = new TrackStore(dir, quiet);
    const tr = lapRun.trail.buildTrack('Demo');
    st.add(tr);
    const again = new TrackStore(dir, quiet);
    assert.strictEqual(again.tracks.length, 1);
    assert.strictEqual(again.detect([tr.detect.lat, tr.detect.lon]).id, tr.id);
    assert.strictEqual(again.detect([tr.detect.lat + 0.1, tr.detect.lon]), null);
    again.remove(tr.id);
    assert.strictEqual(new TrackStore(dir, quiet).tracks.length, 0);
});

test("TrackStore reads CanBusTrackAnalyser's tracks.json as it is", () => {
    const real = path.join(__dirname, '..', '..', 'CanBusTrackAnalyser', 'tracks.json');
    if (!fs.existsSync(real)) { console.log('     (skipped: no CanBusTrackAnalyser checkout next to this repo)'); return; }
    const dir = tmp();
    fs.copyFileSync(real, path.join(dir, 'tracks.json'));
    const st = new TrackStore(dir, quiet);
    assert.ok(st.tracks.length >= 1);
    const t0 = st.tracks[0];
    assert.strictEqual(st.detect([t0.detect.lat, t0.detect.lon]).id, t0.id);
});

test('a demo store never writes', () => {
    const st = new TrackStore(null, quiet, { memoryOnly: true });
    st.add({ id: 'x', detect: { lat: 0, lon: 0 } });
    assert.strictEqual(st.tracks.length, 1);
});

// ---- logger -----------------------------------------------------------------------------------------
test('CSV cells: numbers, empties, booleans, quoting', () => {
    assert.strictEqual(cell(1.23456789), '1.234568');
    assert.strictEqual(cell(null), ''); assert.strictEqual(cell(NaN), ''); assert.strictEqual(cell(undefined), '');
    assert.strictEqual(cell(true), '1');
    assert.strictEqual(cell('a,b'), '"a,b"');
});

test('SessionLogger writes a header and every row by stop()', () => {
    const dir = tmp(), lg = new SessionLogger(dir, quiet, ['t_ms', 'lat', 'lon', 'speed_kmh']);
    assert.ok(lg.start());
    for (let i = 0; i < 25; i++) lg.row({ t_ms: i, lat: 37.1 + i * 1e-5, lon: -7.3, speed_kmh: i % 3 ? 100 : null });
    lg.stop();
    const lines = fs.readFileSync(lg.file, 'utf8').trim().split('\n');
    assert.strictEqual(lines[0], 't_ms,lat,lon,speed_kmh');
    assert.strictEqual(lines.length, 26);
    assert.strictEqual(lines[1], '0,37.1,-7.3,');
    assert.ok(/^\d{8}-\d{6}\.csv$/.test(path.basename(lg.file)));
});

// ---- scalings (BMW's, as in the kit) -----------------------------------------------------------------
test('raw -> real: rpm, speed, temps, g, yaw, throttle, steering, invalid values', () => {
    assert.strictEqual(SC.rpm({ actualValueRPMEngineCrankshaft: 28000 }), 7000);
    assert.strictEqual(SC.rpm({ actualValueRPMEngineCrankshaft: 65535 }), null);
    assert.strictEqual(SC.speed({ speedVehicleCentreOfGravity: 6400 }), 100);
    assert.strictEqual(SC.coolant({ temperatureEngineDrive: 138 }), 90);
    assert.strictEqual(SC.oil({ temperatureEngineOilDrive: 255 }), null);
    assert.ok(Math.abs(SC.gLong({ longitudinalAccelerationCentreOfGravity: 32500 })) < 1e-9);     // 0 m/s^2
    assert.ok(Math.abs(SC.yaw({ yawVelocityVehicle: 32768 })) < 1e-9);                            // 0 deg/s
    assert.strictEqual(SC.throttle({ actualValueAngleAcceleratorPedal: 4000 }), 100);
    assert.strictEqual(SC.throttle({ actualValueAngleAcceleratorPedal: 5000 }), null);           // 125 %: no data
    assert.ok(Math.abs(SC.steer({ actualValueSteeringAngleDriver: 65536 - 2048 }) + 90.0096) < 1e-3);   // signed: -90 deg
    assert.strictEqual(SC.steer({ actualValueSteeringAngleDriver: 30000 }), null);              // 1318 deg: no data
});

test('statusBrakingDriver: numbers and German / English enum names', () => {
    assert.strictEqual(SC.braking({ statusBrakingDriver: 1 }), true);
    assert.strictEqual(SC.braking({ statusBrakingDriver: 0 }), false);
    assert.strictEqual(SC.braking({ statusBrakingDriver: 'BREMSE_BETAETIGT' }), true);
    assert.strictEqual(SC.braking({ statusBrakingDriver: 'BREMSE_NICHT_BETAETIGT' }), false);
    assert.strictEqual(SC.braking({}), null);
});

console.log('\n' + passed + ' tests passed');
