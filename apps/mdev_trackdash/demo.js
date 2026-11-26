'use strict';
/**
 * demo.js - a simulated car on a simulated circuit, for the PC (preview, emulator) and for a car
 * whose signals don't answer (setting "Demo data").
 *
 * The circuit is a closed curve of ~2.3 km. A speed profile is computed once the way a lap-time
 * simulator would: corner speed from a lateral grip limit, then braking and acceleration limits
 * backwards and forwards along the lap. Everything else follows from it: throttle, brake, steering
 * angle, yaw rate, g-forces, rpm, and GPS fixes once a second with a few metres of noise (so the
 * dead reckoning in position.js has real work to do).
 *
 * Engine temperatures warm up like the kit's demo drive (kit/runtime/sim.js).
 */
const geo = require('./geo');
const Sim = require('./kit/sim');

const ORIGIN = [37.8925, -7.3420];       // somewhere in the Alentejo; the demo never saves to disk
const STEP = 2;                          // m between profile points
const A_LAT = 11, A_BRAKE = 11, A_ACC = 4.5, V_MAX = 62;   // m/s^2, m/s^2, m/s^2, m/s (223 km/h)
const WHEELBASE = 2.75, STEER_RATIO = 14;
const GPS_MS = 1000, GPS_NOISE_M = 2.5;
const RATIOS = [4.11, 2.52, 1.77, 1.36, 1.1, 0.92], FINAL = 3.15, TYRE_M = 2.08;   // rough, for an rpm

function circuit() {
    const raw = [];
    for (let i = 0; i < 720; i++) {
        const u = (i / 720) * 2 * Math.PI;
        raw.push([420 * Math.cos(u) + 90 * Math.cos(3 * u) + 40 * Math.sin(5 * u), 230 * Math.sin(u) - 70 * Math.sin(2 * u)]);
    }
    const pts = geo.resample(raw, STEP, true), n = pts.length;
    const at = (i) => pts[(i + n) % n];
    // signed curvature (1/m, + = left) from three points 3 steps apart
    const k = pts.map((_, i) => {
        const a = at(i - 3), b = at(i), c = at(i + 3);
        const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
        const d = Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.hypot(c[0] - b[0], c[1] - b[1]) * Math.hypot(c[0] - a[0], c[1] - a[1]);
        return d > 0 ? (2 * cross) / d : 0;
    });
    // speed profile: grip limit, then braking (backwards) and acceleration (forwards), twice round for the seam
    const v = k.map((c) => Math.min(V_MAX, Math.sqrt(A_LAT / Math.max(1e-4, Math.abs(c)))));
    for (let pass = 0; pass < 2; pass++) {
        for (let i = 2 * n - 1; i >= 0; i--) { const j = i % n, nx = (i + 1) % n; v[j] = Math.min(v[j], Math.sqrt(v[nx] * v[nx] + 2 * A_BRAKE * STEP)); }
        for (let i = 0; i < 2 * n; i++) { const j = i % n, pv = (i - 1 + n) % n; v[j] = Math.min(v[j], Math.sqrt(v[pv] * v[pv] + 2 * A_ACC * STEP)); }
    }
    return { pts, k, v, n, length: n * STEP };
}

class Demo {
    constructor() {
        this.c = circuit();
        this.pl = geo.plane(ORIGIN);
        this.s = 0;                 // distance along the lap, m
        this.last = 0;
        this.lastFix = 0;
        this.temps = new Sim();     // the kit's demo drive, used here only for its warming-up temperatures
        this.d = {};
    }

    /** Advance to tMs; returns the current values (same names main.js uses for live data). */
    sample(t) {
        const dt = this.last ? Math.min(0.2, (t - this.last) / 1000) : 0.1;
        this.last = t;
        const C = this.c, i = Math.floor(this.s / STEP) % C.n, j = (i + 1) % C.n;
        const f = (this.s % STEP) / STEP, v = C.v[i] + (C.v[j] - C.v[i]) * f;
        const vNext = C.v[(i + 5) % C.n], acc = (vNext * vNext - v * v) / (2 * 5 * STEP);
        this.s = (this.s + v * dt) % C.length;
        const p = C.pts[i], q = C.pts[j], k = C.k[i];
        const gear = Math.min(6, Math.max(1, RATIOS.findIndex((r) => (v / TYRE_M) * 60 * r * FINAL < 7000) + 1 || 6));
        const temps = this.temps.sample(t);
        const d = this.d;
        d.speed = v * 3.6;
        d.rpm = Math.max(1100, (v / TYRE_M) * 60 * RATIOS[gear - 1] * FINAL);
        d.coolant = temps.coolant; d.oil = temps.oil;
        d.gLong = acc / 9.80665;
        d.gLat = (v * v * k) / 9.80665;
        d.yaw = (v * k * 180) / Math.PI;                           // deg/s, + = left
        d.steer = (Math.atan(k * WHEELBASE) * STEER_RATIO * 180) / Math.PI;   // deg at the wheel, + = left
        d.throttle = acc > 0.3 ? Math.min(100, 30 + (acc / A_ACC) * 70) : acc > -0.5 ? 18 : 0;
        d.braking = acc < -2;
        d.heading = geo.heading(p, q);
        if (!this.lastFix || t - this.lastFix >= GPS_MS) {
            this.lastFix = t;
            const nx = p[0] + (Math.random() - 0.5) * 2 * GPS_NOISE_M, ny = p[1] + (Math.random() - 0.5) * 2 * GPS_NOISE_M;
            d.fix = this.pl.ll([nx, ny]);
            d.fixT = t;
        }
        return d;
    }
}

module.exports = { Demo };
