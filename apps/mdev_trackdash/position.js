'use strict';
/**
 * position.js - a smooth car position from slow GPS fixes plus the car's own motion sensors.
 *
 * A head unit's GPS typically gives about one fix a second. At 150 km/h that is a jump of ~40 m,
 * so a dot driven only by fixes stutters around the map. Between fixes we move the dot ourselves
 * (dead reckoning), 10 times a second, from:
 *     road speed        Vehicle2.statusCarSpeed2      (km/h)
 *     yaw rate          CDS2.statusYawVelocityVehicle (deg/s, positive = turning left)
 * and pull it back onto each new fix as it arrives (a short blend, so the dot doesn't jump).
 *
 *   const pos = new Position();
 *   pos.fix(lat, lon, tMs);                     // a GPS fix
 *   pos.step(speedKmh, yawDegS, tMs);           // every sample (10 Hz)
 *   pos.latLon()                                // [lat, lon] or null
 *   pos.fixAge(tMs)                             // ms since the last fix
 */
const geo = require('./geo');

const BLEND_MS = 600;        // how long the dot takes to settle onto a new fix
const STALE_MS = 3000;       // no fix for this long: stop dead reckoning (tunnel, pits, lost GPS)
const MIN_MOVE_M = 3;        // a heading is only taken from fixes this far apart (GPS noise when slow)
// Sign of the yaw rate: +1 if the car reports a LEFT turn as positive (ISO 8855, z up), so the
// compass heading goes DOWN. VERIFY ON THE CAR: if the dot curves the wrong way between fixes, flip it.
const YAW_LEFT_POSITIVE = 1;

class Position {
    constructor() { this.reset(); }

    reset() {
        this.pl = null;            // local plane around the first fix
        this.p = null;             // current estimate, local [x, y] m
        this.hdg = null;           // heading, degrees
        this.lastFix = null;       // { p: [x, y], t, ll: [lat, lon] }
        this.prevFix = null;
        this.err = null;           // offset still to blend out, [dx, dy] m
        this.errT = 0;
        this.lastStep = 0;
    }

    fix(lat, lon, t) {
        if (typeof lat !== 'number' || typeof lon !== 'number' || !isFinite(lat) || !isFinite(lon)) return;
        if (!this.pl || geo.distance(this.pl.origin, [lat, lon]) > 20000) {    // first fix, or 20 km away: new plane
            this.pl = geo.plane([lat, lon]);
            this.p = null; this.lastFix = null; this.prevFix = null;
        }
        const q = this.pl.xy([lat, lon]);
        if (this.lastFix && Math.hypot(q[0] - this.lastFix.p[0], q[1] - this.lastFix.p[1]) >= MIN_MOVE_M) {
            this.hdg = geo.heading(this.lastFix.p, q);
        }
        this.prevFix = this.lastFix;
        this.lastFix = { p: q, t, ll: [lat, lon] };
        if (!this.p) { this.p = q.slice(); return; }
        // the estimate drifted from the fix: remember the gap and close it over BLEND_MS
        this.err = [q[0] - this.p[0], q[1] - this.p[1]];
        this.errT = t;
    }

    step(speedKmh, yawDegS, t) {
        const dt = this.lastStep ? Math.min(0.5, (t - this.lastStep) / 1000) : 0;
        this.lastStep = t;
        if (!this.p || !this.lastFix || t - this.lastFix.t > STALE_MS) return;
        if (typeof yawDegS === 'number' && this.hdg !== null) this.hdg = (this.hdg - YAW_LEFT_POSITIVE * yawDegS * dt + 360) % 360;
        if (typeof speedKmh === 'number' && this.hdg !== null && dt > 0) {
            const v = speedKmh / 3.6, a = (this.hdg * Math.PI) / 180;
            this.p[0] += Math.sin(a) * v * dt;
            this.p[1] += Math.cos(a) * v * dt;
        }
        if (this.err) {
            const left = Math.max(0, 1 - (t - this.errT) / BLEND_MS), take = Math.min(1, dt * 1000 / BLEND_MS);
            this.p[0] += this.err[0] * take; this.p[1] += this.err[1] * take;
            this.err = left > 0 ? [this.err[0] * (1 - take), this.err[1] * (1 - take)] : null;
        }
    }

    latLon() { return this.p && this.pl ? geo.round6(this.pl.ll(this.p)) : null; }
    fixLatLon() { return this.lastFix ? this.lastFix.ll : null; }
    fixAge(t) { return this.lastFix ? t - this.lastFix.t : null; }
    heading() { return this.hdg; }
}

module.exports = { Position };
