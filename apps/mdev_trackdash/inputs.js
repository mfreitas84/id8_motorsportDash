'use strict';
/**
 * inputs.js - every live vehicle value the dashboard and the log use, in real units, in one object.
 *
 *   const inp = new Inputs(ctx);  await inp.init();
 *   inp.run(true / false)        // poll while the screen is shown OR a log is recording
 *   inp.v                        // { rpm, speed, coolant, oil, gLong, gLat, yaw, throttle, steer, braking, fix, fixT }
 *   inp.at                       // same keys -> ms the value last arrived (0 = never)
 *   inp.status()                 // per source: 'ok' / 'waiting' / 'none', for the screen and the log
 *
 * Two ways in (see apps/mdev_quickstart/poller.js for why polling):
 *   POLLED getters ("r" in app.json), 10 Hz:   CDS rpm + temperatures, Vehicle2 speed,
 *                                              CDS2 longitudinal / lateral g and yaw rate
 *   SUBSCRIBED ("s", the kit's Live Data reads them that way; no getter known yet):
 *                                              AcceleratorPedal (throttle), SteeringAngle,
 *                                              DSC StabilizationManagement.statusBrakingDriver (brake on/off)
 *   If a subscribed one stays silent on the car, the catalog tells whether it has a getter to poll.
 *
 * GPS: de.bmw.infotainment.GPSData . GPSPositionExtendedCAN, polled at 1 Hz by its own poller (the
 * head unit's GPS updates about once a second). gps.js finds latitude / longitude in the record and its
 * unit; position.js then moves the dot at 10 Hz between fixes. speedGPSCAN and
 * statusQualityPositionGPSCAN are kept raw (their scales are unknown) for the log.
 *
 * Brake: the car gives "driver is braking" (on / off), not pedal travel or pressure. The bar shows
 * how hard from the deceleration while that flag is on; without the flag it estimates from
 * deceleration alone and says so. A real pressure source is another catalog question.
 */
const { Poller } = require('./poller');
const { GpsDecoder, find } = require('./gps');

const CDS = 'de.bmw.infotainment.vehicle.CDS';
const CDS2 = 'de.bmw.infotainment.vehicle.CDS2';
const V2 = 'de.bmw.infotainment.vehicle.Vehicle2';
const PEDAL = 'de.bmw.powertrain.AcceleratorPedal';
const STEER = 'de.bmw.chassis.SteeringAngle';
const DSC = 'de.bmw.chassis.VehicleStabilizationManagement';

const GPS = 'de.bmw.infotainment.GPSData';
const GPS_FIELD = 'GPSPositionExtendedCAN';
const GPS_MS = 1000;

// Raw -> real units: BMW's scalings, as the kit's car.js and Live Data use them (README section 7).
const num = (x) => (typeof x === 'number' && isFinite(x) ? x : null);
const lin = (raw, k, o, bad) => { const r = num(raw); return r === null || r === bad ? null : r * k + (o || 0); };
const G0 = 9.80665;
// Scalings checked on a car (G87 M2, 2026-11-27): throttle and steering are NOT yet (0.025 gave 6 % at rest and
// no 100 % at full pedal; steering jumped side to side). Until they are, the dash shows their raw numbers.
const CALIBRATED = { throttle: false, steer: false };

const SC = {
    rpm: (v) => lin(v && v.actualValueRPMEngineCrankshaft, 0.25, 0, 65535),
    speed: (v) => lin(v && v.speedVehicleCentreOfGravity, 0.015625, 0, 65535),
    coolant: (v) => lin(v && v.temperatureEngineDrive, 1, -48, 255),
    oil: (v) => lin(v && v.temperatureEngineOilDrive, 1, -48, 255),
    gLong: (v) => { const a = lin(v && v.longitudinalAccelerationCentreOfGravity, 0.002, -65, 65535); return a === null ? null : a / G0; },
    gLat: (v) => { const a = lin(v && v.lateralAccelerationCentreOfGravity, 0.002, -65, 65535); return a === null ? null : a / G0; },
    yaw: (v) => lin(v && v.yawVelocityVehicle, 0.005, -163.84, 65535),
    throttle: (v) => { const p = lin(v && v.actualValueAngleAcceleratorPedal, 0.025, 0); return p === null || p < -2 || p > 102 ? null : Math.max(0, Math.min(100, p)); },
    steer: (v) => {
        let r = num(v && v.actualValueSteeringAngleDriver);
        if (r === null) return null;
        if (r >= 32768) r -= 65536;                    // signed 16 bit
        const d = r * 0.04395;
        return Math.abs(d) > 900 ? null : d;
    },
    // statusBrakingDriver: an enum; the kit's demo sends 1 for braking. Names are logged once (raw below).
    braking: (v) => {
        const r = v && v.statusBrakingDriver;
        if (r === undefined || r === null) return null;
        if (typeof r === 'number') return r === 1;
        return /BETAETIGT|ACTIVE|BRAK/i.test(String(r)) && !/NICHT|NOT|INAKTIV/i.test(String(r));
    },
};

class Inputs {
    constructor(ctx) {
        this.ctx = ctx;
        this.log = ctx.log;
        this.v = { rpm: null, speed: null, coolant: null, oil: null, gLong: null, gLat: null, yaw: null,
            throttle: null, steer: null, braking: null, fix: null, fixT: 0, gpsSpeedRaw: null, gpsQualityRaw: null,
            throttleRaw: null, steerRaw: null, steerRawNc: null };   // unscaled, while CALIBRATED says no
        this.at = {};
        Object.keys(this.v).forEach((k) => { this.at[k] = 0; });
        this.raw = { braking: [] };                    // first few raw brake values seen, for the log
        this.poller = new Poller(ctx.signals, ctx.log, 100);
        this.gpsPoller = new Poller(ctx.signals, ctx.log, GPS_MS);
        this.gps = new GpsDecoder(ctx.log);
        this.odoM = 0;                  // metres driven since start, from road speed
        this.subs = {};
        this.onRaw = null;              // fn(name, rawValue) for every value that arrives (debug.js)
    }

    /** Wrap a handler so the raw value is also handed to onRaw (the debug log) under `name`. */
    _tap(name, fn) { return (v) => { if (this.onRaw) this.onRaw(name, v); fn(v); }; }

    _put(k, x) { if (x !== null && x !== undefined) { this.v[k] = x; this.at[k] = Date.now(); } }

    async init() {
        const P = this.poller, put = (k, f) => (v) => this._put(k, f(v));
        const add = (iface, field, fn) => P.add(iface, field, this._tap(iface.split('.').pop() + '.' + field, fn));
        add(CDS, 'statusEngineSpeed2', put('rpm', SC.rpm));
        add(CDS, 'statusEngineTemperature', (v) => { this._put('coolant', SC.coolant(v)); this._put('oil', SC.oil(v)); });
        add(V2, 'statusCarSpeed2', (v) => {
            const kmh = SC.speed(v), t = Date.now();
            // odometer from road speed (trapezoid, gaps over 1 s skipped): gps.js checks GPS units against it
            if (kmh !== null && this.at.speed && t - this.at.speed < 1000 && this.v.speed !== null) this.odoM += ((kmh + this.v.speed) / 2 / 3.6) * ((t - this.at.speed) / 1000);
            this._put('speed', kmh);
        });
        add(CDS2, 'statusLongitudinalAccelerationMassCenter', put('gLong', SC.gLong));
        add(CDS2, 'statusLateralAccelerationMassCenter', put('gLat', SC.gLat));
        add(CDS2, 'statusYawVelocityVehicle', put('yaw', SC.yaw));
        await P.init();

        // subscriptions: kept for the app's whole life (no traffic unless the value changes)
        const watch = async (iface, handlers) => {
            Object.keys(handlers).forEach((f) => { handlers[f] = this._tap(iface.split('.').pop() + '.' + f, handlers[f]); });
            try {
                const s = await this.ctx.signals.watch(iface, '1', handlers, this.log);
                this.subs[iface] = s;
                this.log.info('inputs: ' + iface.split('.').pop() + (s.error ? ' error: ' + s.error : ' subscribed'));
            } catch (e) { this.log.warn('inputs: ' + iface + ': ' + e); }
        };
        // the named member, else (a record shaped otherwise, e.g. the NoCRC one) its first angle / pedal number
        const rawOf = (v, k) => {
            if (!v || typeof v !== 'object') return num(v);
            if (k in v) return num(v[k]);
            const alt = Object.keys(v).find((n) => /angle|pedal/i.test(n) && !/crc|alive|qualifier/i.test(n) && num(v[n]) !== null);
            return alt ? num(v[alt]) : null;
        };
        await watch(PEDAL, { AngleAcceleratorPedal: (v) => { this._put('throttleRaw', rawOf(v, 'actualValueAngleAcceleratorPedal')); this._put('throttle', SC.throttle(v)); } });
        // the two steering messages are kept apart (raw), to see whether they agree
        await watch(STEER, {
            ActualSteeringAngleDriver: (v) => { this._put('steerRaw', rawOf(v, 'actualValueSteeringAngleDriver')); this._put('steer', SC.steer(v)); },
            actualSteeringAngleDriverNoCRC: (v) => {
                this._put('steerRawNc', rawOf(v, 'actualValueSteeringAngleDriver'));
                if (!this.at.steer || Date.now() - this.at.steer > 500) this._put('steer', SC.steer(v));
            },
        });
        await watch(DSC, {
            StabilizationManagement: (v) => {
                const r = v && v.statusBrakingDriver;
                if (this.raw.braking.length < 6 && this.raw.braking.indexOf(String(r)) < 0) {
                    this.raw.braking.push(String(r));
                    this.log.info('inputs: statusBrakingDriver raw value ' + JSON.stringify(r));
                }
                this._put('braking', SC.braking(v));
            },
        });
        // GPS: one record a second; the whole record goes to the debug log (field discovery)
        this.gpsPoller.add(GPS, GPS_FIELD, this._tap('GPSData.' + GPS_FIELD, (rec) => {
            const t = Date.now();
            this.v.gpsSpeedRaw = num(find(rec, 'speedGPSCAN'));
            const q = find(rec, 'statusQualityPositionGPSCAN');
            this.v.gpsQualityRaw = q === undefined ? null : q;
            this.at.gpsRecord = t;
            const fix = this.gps.feed(rec, t, this.odoM);
            if (fix) { this.v.fix = fix; this.v.fixT = t; this.at.fix = t; }
        }));
        await this.gpsPoller.init();
    }

    run(on) {
        if (on) { this.poller.start(); this.gpsPoller.start(); } else { this.poller.stop(); this.gpsPoller.stop(); }
    }

    /**
     * GPS for the screen: 'ok' (a fix within 3 s), 'none' (no GPSData service on this unit),
     * 'nodata' (no record yet, or no fix), 'nofields' (no lat / lon in the record), 'calibrating'.
     */
    gpsState(t) {
        if (this.v.fixT && t - this.v.fixT < 3000) return 'ok';
        const e = this.gpsPoller.proxies[GPS];
        if (this.gpsPoller.mode === 'car' && (!e || !e.proxy)) return 'none';
        if (!this.at.gpsRecord || t - this.at.gpsRecord > 3000) return this.gpsPoller.mode === 'car' ? 'nodata' : 'none';
        const ph = this.gps.state().phase;
        return ph === 'ok' ? 'nodata' : ph;
    }

    /** 'ok' (value within 2 s), 'waiting' (source there, nothing recent), 'none' (no source). */
    status(t) {
        const age = (k) => (this.at[k] ? t - this.at[k] : Infinity);
        const st = (k, has) => (age(k) < 2000 ? 'ok' : has ? 'waiting' : 'none');
        return {
            polled: st('speed', true),
            throttle: st('throttle', !!this.subs[PEDAL] && !this.subs[PEDAL].error),
            steer: st('steer', !!this.subs[STEER] && !this.subs[STEER].error),
            braking: st('braking', !!this.subs[DSC] && !this.subs[DSC].error),
            gps: this.gpsState(t),
        };
    }

    anyLive() { return Object.keys(this.at).some((k) => this.at[k] > 0); }

    /** How each source started, for the debug log's start line. */
    sources() {
        const g = this.gpsPoller.proxies[GPS];
        const out = { poller: this.poller.mode, GPSData: this.gpsPoller.mode !== 'car' ? 'bench' : g && g.proxy ? 'proxy built' : 'no proxy (service missing?)' };
        Object.keys(this.subs).forEach((i) => { out[i.split('.').pop()] = this.subs[i].error ? 'error: ' + this.subs[i].error : 'subscribed'; });
        Object.keys(this.poller.proxies).forEach((i) => { out[i.split('.').pop()] = this.poller.proxies[i].proxy ? (this.poller.proxies[i].available ? 'available' : 'proxy, not available yet') : 'no proxy'; });
        return out;
    }
}

module.exports = { Inputs, SC, CALIBRATED };
