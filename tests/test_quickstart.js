'use strict';
/**
 * Tests for the parts of mdev_quickstart that must never be wrong: the UDS safety gate and the
 * OBD decoding. No head unit, no SDK, no dependencies:   node tests/test_quickstart.js
 */
const assert = require('assert');
const path = require('path');

const APP = path.join(__dirname, '..', 'apps', 'mdev_quickstart');
const { UdsGuard, classify, READ_SERVICES, BLOCKED_SERVICES } = require(path.join(APP, 'uds_guard'));

// obd_iat.js requires './kit/readonly-diag' as it sits in the built package; point that at kit/runtime here
const Module = require('module');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
    if (req === './kit/readonly-diag') req = path.join(__dirname, '..', 'kit', 'runtime', 'readonly-diag');
    return resolve.call(this, req, parent, ...rest);
};
const { decodeIat } = require(path.join(APP, 'obd_iat'));

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('ok   ' + name); };

// ---- classification -------------------------------------------------------------------------
test('every flash / memory service is blocked', () => {
    for (const sid of [0x34, 0x35, 0x36, 0x37, 0x38, 0x3D]) assert.strictEqual(classify(sid, []), 'blocked');
    assert.deepStrictEqual(BLOCKED_SERVICES, [0x34, 0x35, 0x36, 0x37, 0x38, 0x3D]);
});

test('the read services are read', () => {
    for (const sid of [0x01, 0x02, 0x03, 0x06, 0x07, 0x09, 0x0A, 0x19, 0x22, 0x3E]) assert.strictEqual(classify(sid, [0x00]), 'read');
    assert.deepStrictEqual(READ_SERVICES, [0x01, 0x02, 0x03, 0x06, 0x07, 0x09, 0x0A, 0x19, 0x22, 0x3E]);
});

test('10 01 (default session) is read, any other session is parked', () => {
    assert.strictEqual(classify(0x10, [0x01]), 'read');
    for (const s of [0x02, 0x03, 0x40, 0x41]) assert.strictEqual(classify(0x10, [s]), 'parked');
    assert.strictEqual(classify(0x10, []), 'parked');
});

test('writes, routines, resets, security access, DTC clear and unknown services are parked', () => {
    for (const sid of [0x2E, 0x31, 0x11, 0x27, 0x14, 0x04, 0x28, 0x2F, 0x85, 0x2C, 0x99, 0xFF, 0x00]) {
        assert.strictEqual(classify(sid, [0x00]), 'parked', '0x' + sid.toString(16));
    }
});

// ---- the gate --------------------------------------------------------------------------------
const clock = () => { let t = 1e6; const now = () => t; now.add = (ms) => { t += ms; }; return now; };

test('reads pass while driving', () => {
    const now = clock(), g = new UdsGuard({ now });
    g.speed(180); g.rpm(7000);
    assert.strictEqual(g.check(0x01, [0x0F]).ok, true);
    assert.strictEqual(g.check(0x22, [0xF1, 0x90]).ok, true);
});

test('blocked services never pass, not even parked', () => {
    const now = clock(), g = new UdsGuard({ now });
    g.speed(0); g.rpm(0);
    assert.strictEqual(g.parked(), true);
    for (const sid of BLOCKED_SERVICES) assert.strictEqual(g.check(sid, []).ok, false);
});

test('parked-only services need speed < 1 AND rpm < 50', () => {
    const now = clock(), g = new UdsGuard({ now });
    g.speed(0); g.rpm(800);                                    // standing, engine running
    assert.strictEqual(g.check(0x2E, [0x00, 0x00]).ok, false);
    g.speed(2); g.rpm(0);                                      // rolling, engine off
    assert.strictEqual(g.check(0x2E, [0x00, 0x00]).ok, false);
    g.speed(0.5); g.rpm(0);
    assert.strictEqual(g.check(0x2E, [0x00, 0x00]).ok, true);
});

test('missing or stale values count as not parked', () => {
    const now = clock(), g = new UdsGuard({ now, freshMs: 2000 });
    assert.strictEqual(g.check(0x14, [0xFF, 0xFF, 0xFF]).ok, false);           // nothing yet
    g.speed(0);
    assert.strictEqual(g.check(0x14, [0xFF, 0xFF, 0xFF]).ok, false);           // rpm missing
    g.rpm(0);
    assert.strictEqual(g.check(0x14, [0xFF, 0xFF, 0xFF]).ok, true);
    now.add(2001);                                                             // both too old
    assert.strictEqual(g.check(0x14, [0xFF, 0xFF, 0xFF]).ok, false);
    g.speed(0); now.add(1500); g.rpm(0); now.add(600);                         // speed 2.1 s old
    assert.strictEqual(g.parked(), false);
});

test('bad input is refused', () => {
    const g = new UdsGuard();
    for (const sid of [-1, 256, 1.5, NaN, undefined, '0x01']) assert.strictEqual(g.check(sid, []).ok, false);
    g.speed(NaN); g.rpm(Infinity);
    assert.strictEqual(g.lastSpeed, null);
    assert.strictEqual(g.lastRpm, null);
});

// ---- OBD decoding ----------------------------------------------------------------------------
test('IAT: 41 0F A -> A - 40', () => {
    assert.strictEqual(decodeIat([0x41, 0x0F, 0x00]), -40);
    assert.strictEqual(decodeIat([0x41, 0x0F, 0x50]), 40);
    assert.strictEqual(decodeIat([0x41, 0x0F, 0xFF]), 215);
});

test('IAT: anything else is no value', () => {
    assert.strictEqual(decodeIat(null), null);
    assert.strictEqual(decodeIat([]), null);
    assert.strictEqual(decodeIat([0x41, 0x0F]), null);              // too short
    assert.strictEqual(decodeIat([0x41, 0x05, 0x50]), null);        // another PID (coolant)
    assert.strictEqual(decodeIat([0x7F, 0x01, 0x12]), null);        // refusal
    assert.strictEqual(decodeIat([0x62, 0x0F, 0x50]), null);        // a 22 reply
});

// ---- the kit's read-only link agrees ---------------------------------------------------------
test("kit ReadOnlyDiag.check accepts 01 0F to 0x12 and refuses writes and flashing", () => {
    const { check } = require(path.join(__dirname, '..', 'kit', 'runtime', 'readonly-diag'));
    check(0x12, 0x01, [0x0F], false);
    for (const [sid, data] of [[0x2E, [0x00, 0x00, 0x01]], [0x34, [0x00]], [0x31, [0x01, 0x00, 0x00]], [0x14, [0xFF, 0xFF, 0xFF]]]) {
        assert.throws(() => check(0x12, sid, data, false));
    }
});

// ---- the poller, car mode, against a fake SOME/IP --------------------------------------------
const { Poller } = require(path.join(APP, 'poller'));
const quiet = { info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeSignals(opts) {
    const calls = [];
    const s = {
        calls,
        hasNative: () => true,
        proxy: async (iface) => ({
            getValue: (field) => {
                calls.push(field);
                return new Promise((res) => setTimeout(() => res({ actualValueRPMEngineCrankshaft: 3000 }), opts.slowMs || 0));
            },
            iface,
        }),
        onAvailable: async (p, fn) => { s.setAvail = fn; fn(opts.available !== false); },
        watch: async () => { throw new Error('car mode must not subscribe'); },
    };
    return s;
}

const asyncTests = [
    ['poller polls only between start() and stop(), and only when available', async () => {
        const sig = fakeSignals({ available: false });
        const p = new Poller(sig, quiet, 20);
        let got = 0;
        p.add('de.bmw.infotainment.vehicle.CDS', 'statusEngineSpeed2', () => { got++; });
        await p.init();
        assert.strictEqual(p.mode, 'car');
        await sleep(60);
        assert.strictEqual(sig.calls.length, 0, 'no reads before start()');
        p.start();
        await sleep(60);
        assert.strictEqual(sig.calls.length, 0, 'no reads while the provider is unavailable');
        sig.setAvail(true);
        await sleep(110);
        p.stop();
        const n = sig.calls.length;
        assert.ok(n >= 3, 'reads after it became available (' + n + ')');
        assert.ok(got >= 3, 'values delivered (' + got + ')');
        await sleep(80);
        assert.strictEqual(sig.calls.length, n, 'no reads after stop()');
    }],
    ['a slow getter is never asked twice at once', async () => {
        const sig = fakeSignals({ slowMs: 100 });
        const p = new Poller(sig, quiet, 10);
        p.add('de.bmw.infotainment.vehicle.CDS', 'statusEngineSpeed2', () => {});
        await p.init();
        p.start();
        await sleep(250);
        p.stop();
        assert.ok(sig.calls.length <= 3, 'at most one read in flight (' + sig.calls.length + ' reads in 250 ms)');
        assert.ok(p.stats.skipped > 5, 'rounds skipped while busy (' + p.stats.skipped + ')');
    }],
];

(async () => {
    for (const [name, fn] of asyncTests) { await fn(); passed++; console.log('ok   ' + name); }
    console.log('\n' + passed + ' tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
