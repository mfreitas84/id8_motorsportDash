'use strict';
/**
 * usb.js - "Save USB": copy the session logs to a USB stick.
 *
 * The car mounts USB sticks read-only (for its media player), and an app runs as its own sandbox
 * user, so the app cannot make a stick writable itself. The Store tool "mdev USB helper"
 * (tools/mdev-usb, root) does that part:
 *   - it writes /dev/shm/mdev-usb/status every 2 s: { t, mount, label, freeMb, rw };
 *   - while /dev/shm/mdev-usb/request holds a recent time (epoch seconds) it makes the stick
 *     read-write; once the request is ~10 s old: sync, read-only again.
 * The stick's FAT permissions are open (fmask 0000), so once it is read-write the app writes to it
 * as its own user. save() keeps the request fresh, waits for rw, copies, flushes, lets go.
 *
 * The rule for the button stays in main.js: a stick present AND the car parked.
 */
const fs = require('fs');
const path = require('path');

const SHM = '/dev/shm/mdev-usb';
const STALE_S = 10;            // a status older than this: the helper is not running
const WAIT_RW_MS = 15000;      // how long save() waits for the stick to become writable
const FOLDER = 'M2_logs';

/**
 * Copies by reading and writing, then fsync. NOT fs.copyFile: Node's copyfile also sets the file
 * mode (fchmod), and on the stick (FAT mounted for uid 2010) only that uid may: the app (uid 12201)
 * gets EPERM even though it may write. Seen on the G87, trackdash 0.1.8.
 */
// The car's Node is old: no fs.promises (0.1.9 failed with "Cannot read property 'open' of undefined").
// Plain callback fs only, wrapped here.
const call = (fn, ...a) => new Promise((ok, no) => fn(...a, (e, r) => (e ? no(e) : ok(r))));
async function copyPlain(from, to) {
    const src = await call(fs.open, from, 'r');
    let dst = null;
    try {
        dst = await call(fs.open, to, 'w');
        const buf = Buffer.alloc(256 * 1024);
        for (;;) {
            const got = await call(fs.read, src, buf, 0, buf.length, null);
            if (!got) break;
            let off = 0;
            while (off < got) off += await call(fs.write, dst, buf, off, got - off, null);
        }
        await call(fs.fsync, dst);
    } finally {
        await call(fs.close, src).catch(() => {});
        if (dst !== null) await call(fs.close, dst).catch(() => {});
    }
}

class UsbBridge {
    constructor(log, opts) {
        const o = opts || {};
        this.log = log;
        this.shm = o.shm || SHM;
        this.now = o.now || (() => Date.now());
        this.tick = o.tick || 1000;
        this.busy = false;
    }

    _status() {
        try { return JSON.parse(fs.readFileSync(path.join(this.shm, 'status'), 'utf8')); } catch (e) { return null; }
    }

    /** { present, label, freeMb, rw, mount, why } - why = the reason Save USB can't run now ('' when it can). */
    status() {
        const s = this._status();
        const no = (why) => ({ present: false, label: null, freeMb: null, rw: false, mount: null, why });
        if (!s) return no('install "mdev USB helper" from the Store');
        if (!(s.t > 0) || this.now() / 1000 - s.t > STALE_S) return no('the USB helper is not running');
        if (!s.mount) return no('no USB stick');
        if (this.busy) return Object.assign(no('copying already'), { present: true, label: s.label, mount: s.mount });
        return { present: true, label: s.label || null, freeMb: typeof s.freeMb === 'number' ? s.freeMb : null,
            rw: s.rw === true, mount: s.mount, why: '' };
    }

    _ask() { try { fs.writeFileSync(path.join(this.shm, 'request'), String(Math.floor(this.now() / 1000))); } catch (e) { /* */ } }
    _letGo() { try { fs.unlinkSync(path.join(this.shm, 'request')); } catch (e) { /* */ } }

    _waitRw() {
        const t0 = Date.now();
        return new Promise((resolve, reject) => {
            const check = () => {
                const s = this._status();
                if (s && s.mount && s.rw === true) return resolve(s);
                if (Date.now() - t0 > WAIT_RW_MS) return reject(new Error('the stick did not become writable'));
                setTimeout(check, Math.min(this.tick, 250));
            };
            check();
        });
    }

    /**
     * Copies the .csv files of dir to <stick>/M2_logs/ (a file already there with the same size is
     * skipped; skip = a file name left out, the one being recorded). Resolves { copied, dst }.
     */
    save(dir, skip) {
        const u = this.status();
        if (!u.present || u.why) return Promise.reject(new Error(u.why || 'no USB stick'));
        let names;
        try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.csv') && n !== skip).sort(); } catch (e) { names = []; }
        if (!names.length) return Promise.reject(new Error('no log yet'));
        const bytes = names.reduce((a, n) => a + fs.statSync(path.join(dir, n)).size, 0);
        if (u.freeMb !== null && bytes / 1048576 > u.freeMb - 1) return Promise.reject(new Error('the stick is full'));

        this.busy = true;
        this._ask();
        const keep = setInterval(() => this._ask(), this.tick);
        const done = () => { clearInterval(keep); this._letGo(); this.busy = false; };
        return this._waitRw().then(async (s) => {
            const dst = path.join(s.mount, FOLDER);
            if (!fs.existsSync(dst)) fs.mkdirSync(dst);
            let copied = 0;
            for (const n of names) {
                const from = path.join(dir, n), to = path.join(dst, n);
                let same = false;
                try { same = fs.statSync(to).size === fs.statSync(from).size; } catch (e) { /* not there */ }
                if (same) continue;
                await copyPlain(from, to);
                copied++;
            }
            done();
            this.log.info('usb: ' + copied + ' of ' + names.length + ' logs copied to ' + dst);
            return { copied, total: names.length, dst: (s.label || 'USB') + '/' + FOLDER };
        }, (e) => { done(); throw e; }).catch((e) => { if (this.busy) done(); throw e; });
    }
}

module.exports = { UsbBridge, SHM, FOLDER };
