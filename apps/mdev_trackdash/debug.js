'use strict';
/**
 * debug.js - the app's logging switch: Settings > Logging = Normal / Debug / Off.
 * (The same file in every app of this repository: build.py packs one app folder, so each has its copy.)
 *
 *   Normal  the kit's small app log, data/<id>.log (two files of 256 KB at most), as every kit app has.
 *   Debug   that, plus data/debug/<YYYYMMDD-HHMMSS>.log with what is needed to make sense of a car:
 *             - at start: app, version, settings, every SOME/IP source and its state
 *             - every second: the RAW value of every field, exactly as the car sent it (no scaling)
 *             - every 5 s: the app's counters (polls, errors, rates, ages ...)
 *             - events: screen shown / hidden, buttons, settings, recording, errors with stack
 *           2 MB a file at most, the newest 5 files kept. Switches itself back to Normal after 2 hours
 *           (counted across restarts), so it can't stay on by accident.
 *   Off     no log file at all: the kit's file log is switched off too (MGU_FILE_LOG=off, kit/UPSTREAM.md
 *           lists the patch), and the existing app and debug logs are deleted. (BMW's own system log
 *           still gets the SDK's lines: that is the head unit's, not a file of this app.)
 *   Session CSVs (Track Dash's REC LOG) are recordings you start yourself: this switch leaves them alone.
 *
 * Getting a debug log off the car: Settings > "Debug log (QR)" shows it as QR codes to photograph
 * (the kit's QR log; kit/tools/qrlog_decode.py turns the photos back into text), or over SSH from
 * /var/opt/public/oap/oap_<uid>/data/debug/.
 *
 *   const dbg = new Debug(ctx);            // wraps ctx.log: every line also goes to the debug file
 *   dbg.raw(name, value)                   // remember a field's latest raw value (written once a second)
 *   dbg.stats(() => ({ ... }))             // counters, written every 5 s
 *   dbg.event('rec start', { file })       // one line now
 *   dbg.on                                 // true while Debug is on (skip work otherwise)
 */
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 2 * 1024 * 1024;
const KEEP_FILES = 5;
const AUTO_OFF_MS = 2 * 60 * 60 * 1000;
const RAW_MS = 1000, STATS_MS = 5000;

class Debug {
    constructor(ctx) {
        this.ctx = ctx;
        this.S = ctx.settings;
        this.id = (ctx.spec && ctx.spec.id) || 'app';
        this.version = (ctx.spec && ctx.spec.version) || '';
        this.dir = ctx.dataDir ? path.join(ctx.dataDir, 'debug') : null;
        this.on = false;
        this.file = null; this.bytes = 0;
        this.rawLast = {}; this.rawChanged = {};
        this.statFns = [];
        this.timers = [];
        this.mode = null;

        // every ctx.log line also lands in the debug file while Debug is on
        const log = ctx.log, self = this;
        ['info', 'warn', 'error'].forEach((lvl) => {
            const orig = log[lvl].bind(log);
            log[lvl] = function () {
                orig.apply(null, arguments);
                if (self.on) self._write(lvl.toUpperCase(), Array.prototype.map.call(arguments, fmt).join(' '));
            };
        });
        process.on('uncaughtException', (e) => { if (this.on) this._writeSync('FATAL', e && e.stack || String(e)); });

        this.apply(this.S.get('logging') || 'normal');
        if (this.S.onChange) this.S.onChange((key, value) => { if (key === 'logging') this.apply(value); else this.event('setting', { [key]: value }); });
    }

    /** Switch to mode 'normal' | 'debug' | 'off'. */
    apply(mode) {
        if (mode === this.mode) return;
        const was = this.mode;
        this.mode = mode;
        process.env.MGU_FILE_LOG = mode === 'off' ? 'off' : 'on';
        if (mode === 'debug') this._start(was);
        else this._stop();
        if (mode === 'off') this._deleteLogs();
        if (was !== null) this.ctx.log.info('logging: ' + mode);       // (Off: goes only to the system log)
    }

    raw(name, value) {
        if (!this.on) return;
        this.rawLast[name] = value;
        this.rawChanged[name] = true;
    }

    stats(fn) { this.statFns.push(fn); }

    event(what, details) {
        if (this.on) this._write('EVENT', what + (details === undefined ? '' : ' ' + fmt(details)));
    }

    /** One line about how things stand at start (call once the app has set itself up). */
    startup(info) {
        if (!this.on) return;
        this._write('START', fmt(Object.assign({ app: this.id, version: this.version, node: process.version,
            settings: this.S.values || null }, info || {})));
    }

    /** A settings row (where the kit draws Settings) that shows the debug log as QR codes. */
    settingsRow() {
        if (!this.ctx.settingsRow) return;
        let qrLogSheet;
        try { qrLogSheet = require('./kit/qrlog').qrLogSheet; } catch (e) { return; }
        this.ctx.settingsRow({
            label: 'Debug log (QR)',
            value: () => (this.file ? path.basename(this.file) + '  ' + Math.round(this.bytes / 1024) + ' KB' : 'none (Logging = Debug)'),
            open: () => qrLogSheet({ file: this.file || this._newest(), app: this.id + '-debug', version: this.version }),
        });
    }

    /* ---------------- internals ---------------- */

    _start(was) {
        if (!this.dir) return;
        try { fs.mkdirSync(this.dir); } catch (e) { if (e.code !== 'EEXIST') { this.ctx.log.warn('debug: ' + e.message); return; } }
        // the 2 h start: kept in a file, so restarting the app doesn't restart the count
        const mark = path.join(this.dir, '.since');
        let since = Date.now();
        if (was === null) { try { since = Number(fs.readFileSync(mark, 'utf8')) || since; } catch (e) { /* first time */ } }
        try { fs.writeFileSync(mark, String(since)); } catch (e) { /* read-only */ }
        const left = since + AUTO_OFF_MS - Date.now();
        if (left <= 0) { this._autoOff(); return; }
        this.on = true;
        this._open();
        this.timers.push(setTimeout(() => this._autoOff(), left));
        this.timers.push(setInterval(() => this._flushRaw(), RAW_MS));
        this.timers.push(setInterval(() => this._flushStats(), STATS_MS));
        this._write('DEBUG', 'on for ' + Math.round(left / 60000) + ' more min (auto-off after 2 h)');
    }

    _stop() {
        this.timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
        this.timers = [];
        if (this.on) this._write('DEBUG', 'off');
        this.on = false;
        if (this.mode !== 'debug' && this.dir) { try { fs.unlinkSync(path.join(this.dir, '.since')); } catch (e) { /* none */ } }
    }

    _autoOff() {
        this.ctx.log.info('debug: 2 h up, back to Normal logging');
        if (this.S.set) this.S.set('logging', 'normal', 'app'); else this.apply('normal');
    }

    _open() {
        const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
        this.file = path.join(this.dir, stamp + '.log');
        this.bytes = 0;
        try {
            const all = fs.readdirSync(this.dir).filter((n) => n.endsWith('.log')).sort();
            all.slice(0, Math.max(0, all.length - (KEEP_FILES - 1))).forEach((n) => fs.unlinkSync(path.join(this.dir, n)));
        } catch (e) { /* nothing to prune */ }
    }

    _write(tag, msg) {
        if (!this.file) return;
        const line = new Date().toISOString().slice(11, 23) + ' ' + tag + ' ' + msg + '\n';
        if (this.bytes + line.length > MAX_BYTES) this._open();
        this.bytes += line.length;
        fs.appendFile(this.file, line, () => {});
    }

    _writeSync(tag, msg) {
        try { fs.appendFileSync(this.file, new Date().toISOString().slice(11, 23) + ' ' + tag + ' ' + msg + '\n'); } catch (e) { /* nothing */ }
    }

    _flushRaw() {
        const names = Object.keys(this.rawChanged);
        if (!names.length) return;
        const out = {};
        names.forEach((n) => { out[n] = this.rawLast[n]; });
        this.rawChanged = {};
        this._write('RAW', fmt(out));
    }

    _flushStats() {
        const out = {};
        this.statFns.forEach((fn) => { try { Object.assign(out, fn()); } catch (e) { out.statsError = String(e); } });
        out.rssMb = Math.round(process.memoryUsage().rss / 1048576);
        this._write('STATS', fmt(out));
    }

    _newest() {
        try { const f = fs.readdirSync(this.dir).filter((n) => n.endsWith('.log')).sort().pop(); return f ? path.join(this.dir, f) : null; } catch (e) { return null; }
    }

    _deleteLogs() {
        const gone = [];
        const rm = (f) => { try { fs.unlinkSync(f); gone.push(path.basename(f)); } catch (e) { /* not there */ } };
        if (this.dir) {
            try { fs.readdirSync(this.dir).forEach((n) => rm(path.join(this.dir, n))); } catch (e) { /* none */ }
            try { fs.rmdirSync(this.dir); } catch (e) { /* not empty / none */ }
        }
        if (this.ctx.dataDir) { rm(path.join(this.ctx.dataDir, this.id + '.log')); rm(path.join(this.ctx.dataDir, this.id + '.log.1')); }
        this.file = null;
        this.ctx.log.info('logging off: deleted ' + (gone.length ? gone.join(', ') : 'nothing'));
    }
}

/** Compact, safe text for a value: Buffers as hex, long arrays cut. */
function fmt(x) {
    if (x && x.stack) return x.stack;
    if (typeof x !== 'object' || x === null) return String(x);
    try {
        return JSON.stringify(x, (k, v) => {
            if (v && v.type === 'Buffer' && Array.isArray(v.data)) return 'hex:' + v.data.map((b) => (b < 16 ? '0' : '') + b.toString(16)).join('');
            if (Array.isArray(v) && v.length > 64) return v.slice(0, 64).concat(['...(' + v.length + ')']);
            return v;
        });
    } catch (e) { return String(x); }
}

module.exports = { Debug, fmt, AUTO_OFF_MS };
