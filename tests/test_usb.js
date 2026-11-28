'use strict';
/**
 * Tests for Save USB:   node tests/test_usb.js
 *   - tools/mdev-usb/usb-helper.sh (the root helper), run with sh against a fake /proc/mounts and a
 *     fake mount command (skipped where there is no sh);
 *   - apps/mdev_trackdash/usb.js (the app side) against a fake /dev/shm folder and a fake stick.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HELPER = path.join(ROOT, 'tools', 'mdev-usb', 'usb-helper.sh');
const { UsbBridge, FOLDER } = require(path.join(ROOT, 'apps', 'mdev_trackdash', 'usb.js'));

const fwd = (p) => p.replace(/\\/g, '/');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'usb-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowS = () => Math.floor(Date.now() / 1000);
const log = { info: () => {}, warn: () => {}, error: () => {} };
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

let haveSh = true;
try { execFileSync('sh', ['-c', 'true']); } catch (e) { haveSh = false; }

/** One pass of the helper. mounts: the fake /proc/mounts text. Returns { status, calls, dir }. */
function helperOnce(dir, mounts, request) {
    const mf = path.join(dir, 'mounts'), calls = path.join(dir, 'calls');
    if (mounts !== undefined) fs.writeFileSync(mf, mounts);
    // the fake mount: logs its arguments and flips ro / rw in the fake mounts file, like the real remount
    fs.writeFileSync(path.join(dir, 'mount.sh'),
        'echo "$*" >> "' + fwd(calls) + '"\n' +
        'case "$2" in remount,rw) sed -i "s/ ro,/ rw,/" "' + fwd(mf) + '" ;; remount,ro) sed -i "s/ rw,/ ro,/" "' + fwd(mf) + '" ;; esac\n');
    const shm = path.join(dir, 'shm');
    if (request === null) { try { fs.unlinkSync(path.join(shm, 'request')); } catch (e) { /* */ } }
    else if (request !== undefined) { fs.mkdirSync(shm, { recursive: true }); fs.writeFileSync(path.join(shm, 'request'), String(request)); }
    execFileSync('sh', [fwd(HELPER)], { env: Object.assign({}, process.env, {
        MDEV_USB_DIR: fwd(shm), MDEV_USB_MOUNTS: fwd(mf), MDEV_USB_MOUNT: 'sh ' + fwd(path.join(dir, 'mount.sh')), MDEV_USB_ONCE: '1' }) });
    let c = '';
    try { c = fs.readFileSync(calls, 'utf8'); fs.unlinkSync(calls); } catch (e) { /* none */ }
    return { status: JSON.parse(fs.readFileSync(path.join(shm, 'status'), 'utf8')), calls: c.trim(), opened: fs.existsSync(path.join(shm, '.opened')) };
}
const STICK = '/dev/sda1 /media/3A49-FA6D vfat ro,nosuid,nodev,noexec,relatime,uid=2010 0 0\n';
const OTHER = 'tmpfs /media tmpfs rw,nosuid,nodev 0 0\ntmpfs /var/cache/mediaramdisk tmpfs rw 0 0\n';

if (haveSh) {
    test('helper: a stick, nobody asking -> status read-only, no remount', () => {
        const r = helperOnce(tmp(), OTHER + STICK);
        assert.strictEqual(r.status.mount, '/media/3A49-FA6D');
        assert.strictEqual(r.status.label, '3A49-FA6D');
        assert.strictEqual(r.status.rw, false);
        assert.ok(Math.abs(r.status.t - nowS()) <= 2);
        assert.strictEqual(r.calls, '');
    });

    test('helper: a fresh request -> read-write; a stale one -> sync, read-only again', () => {
        const dir = tmp();
        let r = helperOnce(dir, OTHER + STICK, nowS());
        assert.strictEqual(r.calls, '-o remount,rw /media/3A49-FA6D');
        assert.strictEqual(r.status.rw, true);
        assert.ok(r.opened, 'remembers it opened the stick');
        r = helperOnce(dir, undefined, nowS());                // still wanted: nothing to do
        assert.strictEqual(r.calls, '');
        assert.strictEqual(r.status.rw, true);
        r = helperOnce(dir, undefined, nowS() - 60);           // the app stopped asking
        assert.strictEqual(r.calls, '-o remount,ro /media/3A49-FA6D');
        assert.strictEqual(r.status.rw, false);
        assert.ok(!r.opened);
    });

    test('helper: a request file removed -> read-only again', () => {
        const dir = tmp();
        helperOnce(dir, STICK, nowS());
        const r = helperOnce(dir, undefined, null);
        assert.strictEqual(r.calls, '-o remount,ro /media/3A49-FA6D');
    });

    test('helper: never touches a stick it did not open, junk requests, or non-FAT mounts', () => {
        let r = helperOnce(tmp(), STICK.replace(' ro,', ' rw,'), null);   // someone else made it rw
        assert.strictEqual(r.calls, '');
        assert.strictEqual(r.status.rw, true);
        r = helperOnce(tmp(), STICK, 'rm -rf /');
        assert.strictEqual(r.calls, '');
        r = helperOnce(tmp(), STICK, nowS() + 3600);                       // from the future
        assert.strictEqual(r.calls, '');
        r = helperOnce(tmp(), '/dev/sda1 /media/x ext4 ro 0 0\n/dev/sdb1 /media/a/b vfat ro 0 0\n', nowS());
        assert.strictEqual(r.status.mount, null);
        assert.strictEqual(r.calls, '');
    });

    test('helper: no stick -> mount null; a label with a space', () => {
        assert.strictEqual(helperOnce(tmp(), OTHER).status.mount, null);
        const r = helperOnce(tmp(), '/dev/sda1 /media/MY\\040STICK vfat ro,nosuid 0 0\n');
        assert.strictEqual(r.status.mount, '/media/MY STICK');
        assert.strictEqual(r.status.label, 'MY STICK');
    });
} else {
    console.log('(no sh here: helper tests skipped)');
}

// ---- the app side -------------------------------------------------------------------------------
function writeStatus(shm, s) { fs.mkdirSync(shm, { recursive: true }); fs.writeFileSync(path.join(shm, 'status'), JSON.stringify(s)); }

/** A stand-in helper in-process: rw while the request is fresh. */
function fakeHelper(shm, stick) {
    const tick = () => {
        let r = null;
        try { r = Number(fs.readFileSync(path.join(shm, 'request'), 'utf8')); } catch (e) { /* */ }
        writeStatus(shm, { t: nowS(), mount: stick, label: 'STICK', freeMb: 1000, rw: r !== null && nowS() - r <= 10 });
    };
    tick();
    const h = setInterval(tick, 50);
    return () => clearInterval(h);
}

test('usb.js status: tool missing / not running / no stick / ready', () => {
    const shm = path.join(tmp(), 'shm');
    const u = new UsbBridge(log, { shm });
    assert.ok(/install/.test(u.status().why));
    writeStatus(shm, { t: nowS() - 60, mount: '/media/X' });
    assert.ok(/not running/.test(u.status().why));
    writeStatus(shm, { t: nowS(), mount: null });
    assert.strictEqual(u.status().why, 'no USB stick');
    writeStatus(shm, { t: nowS(), mount: '/media/X', label: 'X', freeMb: 500, rw: false });
    const s = u.status();
    assert.deepStrictEqual([s.present, s.label, s.freeMb, s.why], [true, 'X', 500, '']);
});

test('usb.js save: asks, waits for read-write, copies the logs, skips the one recording, lets go', async () => {
    const dir = tmp(), shm = path.join(dir, 'shm'), stick = path.join(dir, 'stick'), logs = path.join(dir, 'logs');
    fs.mkdirSync(stick); fs.mkdirSync(logs);
    fs.writeFileSync(path.join(logs, '20261128-150000.csv'), 'a,b\n1,2\n');
    fs.writeFileSync(path.join(logs, '20261128-160000.csv'), 'a,b\n3,4\n5,6\n');
    fs.writeFileSync(path.join(logs, '20261128-170000.csv'), 'recording');
    const stop = fakeHelper(shm, stick);
    const u = new UsbBridge(log, { shm, tick: 50 });
    const r = await u.save(logs, '20261128-170000.csv');
    assert.strictEqual(r.copied, 2);
    assert.strictEqual(r.dst, 'STICK/' + FOLDER);
    assert.deepStrictEqual(fs.readdirSync(path.join(stick, FOLDER)).sort(), ['20261128-150000.csv', '20261128-160000.csv']);
    assert.strictEqual(fs.readFileSync(path.join(stick, FOLDER, '20261128-160000.csv'), 'utf8'), 'a,b\n3,4\n5,6\n');
    assert.ok(!fs.existsSync(path.join(shm, 'request')), 'request gone: the helper makes it read-only again');
    assert.strictEqual(u.busy, false);
    // again: nothing new
    const r2 = await u.save(logs, '20261128-170000.csv');
    assert.strictEqual(r2.copied, 0);
    assert.strictEqual(r2.total, 2);
    stop();
});

test('usb.js save: never uses copyFile (it sets the mode: EPERM on the car\'s FAT stick)', async () => {
    const dir = tmp(), shm = path.join(dir, 'shm'), stick = path.join(dir, 'stick'), logs = path.join(dir, 'logs');
    fs.mkdirSync(stick); fs.mkdirSync(logs);
    const big = Buffer.alloc(700 * 1024, 7);                       // more than one 256 KB chunk
    fs.writeFileSync(path.join(logs, 'big.csv'), big);
    const eperm = () => { const e = new Error('EPERM: operation not permitted, copyfile'); e.code = 'EPERM'; throw e; };
    const saved = [fs.copyFileSync, fs.copyFile, fs.promises.copyFile];
    fs.copyFileSync = eperm; fs.copyFile = eperm; fs.promises.copyFile = eperm;
    const stop = fakeHelper(shm, stick);
    try {
        const r = await new UsbBridge(log, { shm, tick: 50 }).save(logs);
        assert.strictEqual(r.copied, 1);
        assert.ok(fs.readFileSync(path.join(stick, FOLDER, 'big.csv')).equals(big));
    } finally {
        [fs.copyFileSync, fs.copyFile, fs.promises.copyFile] = saved;
        stop();
    }
});

test('usb.js save: refuses with no logs, or a full stick', async () => {
    const dir = tmp(), shm = path.join(dir, 'shm'), logs = path.join(dir, 'logs');
    fs.mkdirSync(logs);
    writeStatus(shm, { t: nowS(), mount: dir, label: 'S', freeMb: 0, rw: false });
    const u = new UsbBridge(log, { shm });
    await assert.rejects(u.save(logs), /no log/);
    fs.writeFileSync(path.join(logs, 'a.csv'), 'x');
    await assert.rejects(u.save(logs), /full/);
    assert.ok(!fs.existsSync(path.join(shm, 'request')));
});

test('component.json: files and unit are in the folder, script mode 0755', () => {
    const dir = path.join(ROOT, 'tools', 'mdev-usb');
    const c = JSON.parse(fs.readFileSync(path.join(dir, 'component.json'), 'utf8'));
    assert.strictEqual(c.id, 'mdev-usb'); assert.strictEqual(c.kind, 'tool'); assert.ok(/^\d+\.\d+\.\d+$/.test(c.version));
    c.files.forEach((f) => { assert.ok(fs.existsSync(path.join(dir, f.from))); assert.strictEqual(f.mode, '0755'); });
    c.units.forEach((u) => assert.ok(fs.existsSync(path.join(dir, u.from))));
    const repo = JSON.parse(fs.readFileSync(path.join(ROOT, 'mgu-repo.json'), 'utf8'));
    assert.ok(repo.components.some((e) => e.id === 'mdev-usb' && e.kind === 'tool' && e.path === 'tools/mdev-usb'));
});

(async () => {
    let n = 0;
    for (const [name, fn] of tests) { await fn(); n++; console.log('ok   ' + name); }
    console.log('\n' + n + ' tests passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
