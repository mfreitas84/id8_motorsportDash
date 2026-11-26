'use strict';
/**
 * uds_guard.js - the safety gate every UDS / OBD request of this repo goes through BEFORE it is sent.
 *
 * The rule (CLAUDE.md, "SAFETY RULE", non-negotiable):
 *   read     always allowed      OBD modes 01 02 03 06 07 09 0A, 19 (read DTCs), 22 (read data by id),
 *                                3E (tester present), and 10 01 (back to the default session)
 *   parked   only while parked   everything else that exists: writes (2E), routines (31), resets (11),
 *                                security access (27), DTC clear (14 / OBD 04), sessions (10 xx), ...
 *   blocked  never               flash / memory: 34 35 36 37 38 3D
 *
 * "Parked" = road speed < 1 km/h AND engine speed < 50 rpm, BOTH read within the last freshMs.
 * A value that is missing or too old counts as NOT parked: when in doubt, refuse.
 *
 * Why BMW's own filter doesn't cover us: BMW's speed / rpm conditions live inside BMW's diagnostic
 * app, not in the TASU transport. Anything we hand TASU is sent as is.
 *
 * This is a second, independent layer: v0 sends its OBD read through the kit's ReadOnlyDiag
 * (kit/runtime/readonly-diag.js), which on its own refuses anything but 22 / 01 / 09. Keep both:
 * when a later version needs a parked-only request, it gets its own link, and this gate still
 * decides.
 *
 *   const guard = new UdsGuard({ freshMs: 2000 });
 *   guard.speed(kmh); guard.rpm(rpm);                  // feed it from the poller
 *   const v = guard.check(0x01, [0x0F]);               // { ok: true, cls: 'read' }
 *   if (!v.ok) log.warn(v.why);                        // and don't send
 */

const READ_SERVICES = [0x01, 0x02, 0x03, 0x06, 0x07, 0x09, 0x0A, 0x19, 0x22, 0x3E];
const BLOCKED_SERVICES = [0x34, 0x35, 0x36, 0x37, 0x38, 0x3D];
const SESSION_CONTROL = 0x10;
const DEFAULT_SESSION = 0x01;

/** 'read' | 'parked' | 'blocked' for service `sid` with the bytes that follow it (`data`). */
function classify(sid, data) {
    if (BLOCKED_SERVICES.includes(sid)) return 'blocked';
    if (READ_SERVICES.includes(sid)) return 'read';
    if (sid === SESSION_CONTROL && Array.isArray(data) && data[0] === DEFAULT_SESSION) return 'read';
    return 'parked';                       // unknown services land here too, never in 'read'
}

class UdsGuard {
    constructor(opts) {
        this.freshMs = (opts && opts.freshMs) || 2000;
        this.now = (opts && opts.now) || Date.now;   // injectable clock, for the tests
        this.lastSpeed = null;                        // { v: km/h, at: ms }
        this.lastRpm = null;                          // { v: rpm, at: ms }
    }

    speed(kmh) { if (typeof kmh === 'number' && isFinite(kmh)) this.lastSpeed = { v: kmh, at: this.now() }; }
    rpm(rpm) { if (typeof rpm === 'number' && isFinite(rpm)) this.lastRpm = { v: rpm, at: this.now() }; }

    /** true only with BOTH values fresh and both under the limits. */
    parked() {
        const t = this.now();
        const fresh = (x) => x !== null && t - x.at <= this.freshMs;
        return fresh(this.lastSpeed) && fresh(this.lastRpm) && this.lastSpeed.v < 1 && this.lastRpm.v < 50;
    }

    /** { ok, cls, why } for one request. Call it right before sending, every time. */
    check(sid, data) {
        if (!Number.isInteger(sid) || sid < 0 || sid > 0xFF) return { ok: false, cls: 'blocked', why: 'bad service id' };
        const cls = classify(sid, data);
        const name = '0x' + sid.toString(16).toUpperCase().padStart(2, '0');
        if (cls === 'blocked') return { ok: false, cls, why: 'service ' + name + ' is never allowed (flash / memory)' };
        if (cls === 'parked' && !this.parked()) return { ok: false, cls, why: 'service ' + name + ' needs the car parked (speed < 1 km/h, rpm < 50, fresh)' };
        return { ok: true, cls, why: '' };
    }
}

module.exports = { UdsGuard, classify, READ_SERVICES, BLOCKED_SERVICES };
