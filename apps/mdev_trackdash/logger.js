'use strict';
/**
 * logger.js - one CSV file per recording session, in the app's data folder.
 *
 * Where: <dataDir>/logs/<YYYYMMDD-HHMMSS>.csv. The data folder is the app's own and always writable;
 * a USB stick is NOT (the car mounts sticks read-only), so copying to a stick is a separate, parked-only
 * step (usb.js).
 *
 * How: rows are buffered in memory and appended to the file once a second, so a power cut loses at
 * most about a second. stop() writes what is left. Only the newest KEEP sessions are kept.
 *
 *   const lg = new SessionLogger(dataDir, log, ['t_iso', 'speed_kmh', ...]);
 *   lg.start();  lg.row({ t_iso: ..., speed_kmh: 123.4 });  lg.stop();
 *   lg.status()  // { on, file, rows, bytes, since }
 */
const fs = require('fs');
const path = require('path');

const FLUSH_MS = 1000;
const KEEP = 30;

class SessionLogger {
    constructor(dataDir, log, columns) {
        this.dir = dataDir ? path.join(dataDir, 'logs') : null;
        this.log = log;
        this.columns = columns;
        this.on = false;
        this.file = null;
        this.buf = [];
        this.rows = 0;
        this.bytes = 0;
        this.since = 0;
        this.timer = null;
        this.error = null;
        // the platform stops apps by asking them to exit: write what is buffered before going
        process.on('exit', () => this._flushSync());
    }

    start() {
        if (this.on) return true;
        if (!this.dir) { this.error = 'no data folder'; return false; }
        try {
            // (the head unit runs Node 8: no { recursive: true }; dataDir itself always exists)
            try { fs.mkdirSync(this.dir); } catch (e) { if (e.code !== 'EEXIST') throw e; }
            const d = new Date();
            const stamp = d.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
            this.file = path.join(this.dir, stamp + '.csv');
            const head = this.columns.join(',') + '\n';
            fs.writeFileSync(this.file, head);
            this.bytes = head.length; this.rows = 0; this.since = d.getTime(); this.buf = []; this.error = null;
            this.on = true;
            this.timer = setInterval(() => this._flush(), FLUSH_MS);
            this.log.info('log: recording to ' + this.file);
            this._prune();
            return true;
        } catch (e) {
            this.error = e.message;
            this.log.error('log: cannot start: ' + e.message);
            return false;
        }
    }

    stop() {
        if (!this.on) return;
        clearInterval(this.timer); this.timer = null;
        this._flushSync();
        this.on = false;
        this.log.info('log: stopped, ' + this.rows + ' rows, ' + Math.round(this.bytes / 1024) + ' KB in ' + this.file);
    }

    /** One sample: an object with (some of) the columns. Missing or non-finite values are left empty. */
    row(values) {
        if (!this.on) return;
        this.buf.push(this.columns.map((c) => cell(values[c])).join(','));
        this.rows++;
    }

    status() { return { on: this.on, file: this.file, rows: this.rows, bytes: this.bytes + this.buf.length * 80, since: this.since, error: this.error }; }

    /** The newest session file, or null. */
    latest() {
        if (this.file) return this.file;
        try {
            const f = fs.readdirSync(this.dir).filter((n) => n.endsWith('.csv')).sort().pop();
            return f ? path.join(this.dir, f) : null;
        } catch (e) { return null; }
    }

    _take() { const s = this.buf.length ? this.buf.join('\n') + '\n' : ''; this.buf = []; return s; }

    _flush() {
        const s = this._take();
        if (!s || !this.file) return;
        this.bytes += s.length;
        fs.appendFile(this.file, s, (e) => { if (e) { this.error = e.message; this.log.error('log: write failed: ' + e.message); } });
    }

    _flushSync() {
        const s = this._take();
        if (!s || !this.file) return;
        try { fs.appendFileSync(this.file, s); this.bytes += s.length; } catch (e) { this.error = e.message; }
    }

    _prune() {
        try {
            const all = fs.readdirSync(this.dir).filter((n) => n.endsWith('.csv')).sort();
            all.slice(0, Math.max(0, all.length - KEEP)).forEach((n) => fs.unlinkSync(path.join(this.dir, n)));
        } catch (e) { /* nothing to prune */ }
    }
}

function cell(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : '';
    if (typeof v === 'boolean') return v ? '1' : '0';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

module.exports = { SessionLogger, cell };
