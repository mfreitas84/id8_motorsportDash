'use strict';
/**
 * Tests for debug.js (Settings > Logging = Normal / Debug / Off):   node tests/test_debug.js
 * Both apps carry the same file; the test checks they really are the same.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const A = path.join(__dirname, '..', 'apps', 'mdev_trackdash', 'debug.js');
const B = path.join(__dirname, '..', 'apps', 'mdev_quickstart', 'debug.js');
const { Debug, fmt, AUTO_OFF_MS } = require(A);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-'));

/** A ctx as the kit gives it: settings with get / set / onChange, a log, a data folder. */
function fakeCtx(dir, logging) {
    const values = { logging }, listeners = [], lines = [];
    return {
        lines,
        spec: { id: 'mdev_test', version: '9.9.9' },
        dataDir: dir,
        log: { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) },
        settings: {
            values,
            get: (k) => values[k],
            set: (k, v) => { values[k] = v; listeners.forEach((fn) => fn(k, v)); },
            onChange: (fn) => listeners.push(fn),
        },
    };
}
const debugFiles = (dir) => { try { return fs.readdirSync(path.join(dir, 'debug')).filter((n) => n.endsWith('.log')); } catch (e) { return []; } };
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('both apps carry the same debug.js', () => {
    assert.strictEqual(fs.readFileSync(A, 'utf8'), fs.readFileSync(B, 'utf8'));
});

test('Normal: no debug file, kit file log on', () => {
    const dir = tmp(), dbg = new Debug(fakeCtx(dir, 'normal'));
    assert.strictEqual(dbg.on, false);
    assert.strictEqual(process.env.MGU_FILE_LOG, 'on');
    assert.deepStrictEqual(debugFiles(dir), []);
});

test('Debug: start line, ctx.log lines, raw values once a second, stats, events', async () => {
    const dir = tmp(), ctx = fakeCtx(dir, 'debug'), dbg = new Debug(ctx);
    assert.strictEqual(dbg.on, true);
    dbg.startup({ poller: 'car' });
    ctx.log.info('hello from the app');
    dbg.raw('CDS.statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 3200 });
    dbg.raw('DSC.StabilizationManagement', { statusBrakingDriver: 'BREMSE_BETAETIGT', buf: Buffer.from([1, 0xab]) });
    dbg.stats(() => ({ reads: 42 }));
    dbg.event('action toggleRec');
    await sleep(1200);
    const f = path.join(dir, 'debug', debugFiles(dir)[0]);
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(/ START .*"app":"mdev_test".*"poller":"car"/.test(text), 'start line');
    assert.ok(/ INFO hello from the app/.test(text), 'ctx.log mirrored');
    assert.ok(/ RAW .*"actualValueRPMEngineCrankshaft":3200/.test(text), 'raw value');
    assert.ok(/BREMSE_BETAETIGT/.test(text) && /hex:01ab/.test(text), 'enum names and buffers kept');
    assert.ok(/ EVENT action toggleRec/.test(text), 'event');
    assert.strictEqual(ctx.lines.indexOf('hello from the app') >= 0, true, 'the original log still gets it');
    dbg.apply('normal');
});

test('Off: kit file log off, app and debug logs deleted', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'mdev_test.log'), 'x'); fs.writeFileSync(path.join(dir, 'mdev_test.log.1'), 'x');
    fs.mkdirSync(path.join(dir, 'debug')); fs.writeFileSync(path.join(dir, 'debug', 'old.log'), 'x');
    fs.mkdirSync(path.join(dir, 'logs')); fs.writeFileSync(path.join(dir, 'logs', 'session.csv'), 'x');
    const dbg = new Debug(fakeCtx(dir, 'off'));
    assert.strictEqual(process.env.MGU_FILE_LOG, 'off');
    assert.strictEqual(dbg.on, false);
    assert.ok(!fs.existsSync(path.join(dir, 'mdev_test.log')) && !fs.existsSync(path.join(dir, 'mdev_test.log.1')));
    assert.ok(!fs.existsSync(path.join(dir, 'debug')));
    assert.ok(fs.existsSync(path.join(dir, 'logs', 'session.csv')), 'session CSVs are kept');
});

test('switching at runtime: Normal -> Debug -> Off -> Normal', () => {
    const dir = tmp(), ctx = fakeCtx(dir, 'normal'), dbg = new Debug(ctx);
    ctx.settings.set('logging', 'debug');
    assert.strictEqual(dbg.on, true);
    assert.strictEqual(debugFiles(dir).length, 0);          // (the file appears with its first line)
    ctx.settings.set('logging', 'off');
    assert.strictEqual(dbg.on, false);
    assert.strictEqual(process.env.MGU_FILE_LOG, 'off');
    ctx.settings.set('logging', 'normal');
    assert.strictEqual(process.env.MGU_FILE_LOG, 'on');
});

test('auto-off after 2 h, counted across restarts', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'debug'));
    fs.writeFileSync(path.join(dir, 'debug', '.since'), String(Date.now() - AUTO_OFF_MS - 1000));   // switched on 2 h ago
    const ctx = fakeCtx(dir, 'debug'), dbg = new Debug(ctx);
    assert.strictEqual(ctx.settings.get('logging'), 'normal', 'set back to Normal at start');
    assert.strictEqual(dbg.on, false);
    // an app restart 1 h in keeps the original start
    const dir2 = tmp();
    fs.mkdirSync(path.join(dir2, 'debug'));
    const since = Date.now() - 3600 * 1000;
    fs.writeFileSync(path.join(dir2, 'debug', '.since'), String(since));
    const d2 = new Debug(fakeCtx(dir2, 'debug'));
    assert.strictEqual(d2.on, true);
    assert.strictEqual(Number(fs.readFileSync(path.join(dir2, 'debug', '.since'), 'utf8')), since);
    d2.apply('normal');
});

test('a full file rolls over and only the newest 5 are kept', async () => {
    const dir = tmp(), dbg = new Debug(fakeCtx(dir, 'debug'));
    for (let f = 0; f < 7; f++) {
        dbg.bytes = 2 * 1024 * 1024;                     // pretend the current file is full
        await sleep(1100);                               // a new second: a new file name
        dbg.event('file ' + f);
    }
    await sleep(100);
    assert.ok(debugFiles(dir).length <= 5, debugFiles(dir).length + ' files');
    dbg.apply('normal');
});

test('the QR log export reads the debug file (Settings > Debug log (QR))', async () => {
    const { logText } = require('../kit/runtime/qrlog');
    const dir = tmp(), ctx = fakeCtx(dir, 'debug'), dbg = new Debug(ctx);
    dbg.startup({ poller: 'car' });
    dbg.raw('CDS.statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 3200 });
    await sleep(1200);
    const text = logText(path.join(dir, 'debug', debugFiles(dir)[0]));
    assert.ok(/ START .*"app":"mdev_test"/.test(text), 'start line in the QR text: ' + JSON.stringify(text));
    assert.ok(/ RAW .*3200/.test(text), 'raw line in the QR text');
    dbg.apply('normal');
});

test('Delete debug logs: files gone, Debug keeps logging into a fresh file', async () => {
    const dir = tmp(), ctx = fakeCtx(dir, 'debug'), dbg = new Debug(ctx);
    dbg.event('one');
    await sleep(100);
    assert.strictEqual(dbg.usage().files, 1);
    assert.strictEqual(dbg.clear(), 1);
    await sleep(100);
    const left = debugFiles(dir);
    assert.strictEqual(left.length, 1, 'a fresh file');
    assert.ok(/logs deleted/.test(fs.readFileSync(path.join(dir, 'debug', left[0]), 'utf8')));
    assert.ok(!/ EVENT one/.test(fs.readFileSync(path.join(dir, 'debug', left[0]), 'utf8')), 'old lines gone');
    dbg.apply('normal');
    dbg.clear();
    assert.strictEqual(debugFiles(dir).length, 0, 'Normal: nothing left');
});

test('fmt: errors with stack, long arrays cut, plain values', () => {
    assert.ok(fmt(new Error('boom')).indexOf('boom') >= 0);
    assert.ok(fmt({ a: new Array(100).fill(1) }).indexOf('...(100)') >= 0);
    assert.strictEqual(fmt(5), '5');
});

(async () => {
    let n = 0;
    for (const [name, fn] of tests) { await fn(); n++; console.log('ok   ' + name); }
    console.log('\n' + n + ' tests passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
