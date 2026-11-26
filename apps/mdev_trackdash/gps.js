'use strict';
/**
 * gps.js - a position from the head unit's GPS record, when we don't yet know its exact layout.
 *
 * Source: de.bmw.infotainment.GPSData . GPSPositionExtendedCAN, polled once a second (inputs.js).
 * Known (IterioDev Draggy declares it; no app reads a position from it): the record has
 * speedGPSCAN (ground speed, scale unknown) and statusQualityPositionGPSCAN. Whether it also carries
 * latitude / longitude, under which names and in which unit, is to be confirmed on the car:
 * Settings > Logging = Debug writes the whole record raw once a second.
 *
 * Until then this module works it out from the record itself:
 *   1. FIELDS  numbers whose name says latitude / longitude (lat, latitude, lon, lng, longitude; never
 *              "lateral" or "longitudinal", which are accelerations).
 *   2. SCALE   GPS position fields are often integers in a fixed unit. Candidates:
 *                deg          already degrees (a fraction: an integer field can't be degrees for long)
 *                1e-6 deg, 1e-7 deg, milliarcseconds, 180 / 2^31 deg (BMW / CAN style)
 *              Only those giving lat within +-90 and lon within +-180 (and not 0, 0) stay.
 *   3. CHECK   if more than one stays (1e-7 and 180/2^31 are only 16 % apart), drive: the one whose
 *              distance between fixes matches the distance the wheels covered (an odometer integrated
 *              from road speed at 10 Hz) best, within 10 %, and clearly better than the next (by 8 %),
 *              over at least 300 m, wins. Nothing goes to the map before that.
 *
 *   const g = new GpsDecoder(log);
 *   const fix = g.feed(record, tMs, odometerM);  // [lat, lon] or null; odometerM = metres driven so far
 *   g.state()   // { phase: 'nodata' | 'nofields' | 'calibrating' | 'ok', lat, lon (field paths), scale, ... }
 */
const geo = require('./geo');

const SCALES = [
    { name: 'deg', k: 1 },
    { name: '1e-6 deg', k: 1e-6 },
    { name: '1e-7 deg', k: 1e-7 },
    { name: 'mas', k: 1 / 3600000 },
    { name: '180/2^31 deg', k: 180 / 2147483648 },
];
// A name is latitude / longitude if it says so in full (any case), or has the short form as a whole word
// part: lat, latGPS, positionLat, LAT_DEG; lon / lng / long likewise. Not "latency", "longevity", ...
const wordPart = (short) => new RegExp('^(' + short + ')(?=[A-Z0-9_]|$)|[a-z._](' + short.split('|').map((s) => s[0].toUpperCase() + s.slice(1)).join('|') +
    ')(?=[A-Z0-9_]|$)|(^|[._])(' + short.toUpperCase() + ')(?=[_0-9]|$)');
const LAT = { full: /latitude/i, part: wordPart('lat') };
const LON = { full: /longitude/i, part: wordPart('lon|lng|long') };
const NOT_RE = /lateral|longitudinal|accel/i;
const MIN_CHECK_M = 300, MAX_RATIO_ERR = 0.1, MIN_MARGIN = 0.08, MIN_KMH = 15;

/** All numeric leaves of a record: [{ path: 'a.b', value }]. */
function leaves(o, prefix, out) {
    out = out || [];
    if (o === null || o === undefined) return out;
    if (typeof o === 'number') { out.push({ path: prefix, value: o }); return out; }
    if (typeof o !== 'object' || Buffer.isBuffer(o) || Array.isArray(o)) return out;
    Object.keys(o).forEach((k) => leaves(o[k], prefix ? prefix + '.' + k : k, out));
    return out;
}

/** The first leaf whose own name (the last part of its path) is that coordinate: a full name wins over a short one. */
function pick(list, which) {
    const name = (l) => l.path.split('.').pop();
    const ok = (l) => !NOT_RE.test(name(l));
    return list.find((l) => ok(l) && which.full.test(name(l))) || list.find((l) => ok(l) && which.part.test(name(l))) || null;
}

/** A field by name anywhere in the record (speedGPSCAN, statusQualityPositionGPSCAN). */
function find(o, name) {
    if (!o || typeof o !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(o, name)) return o[name];
    for (const k of Object.keys(o)) { const v = find(o[k], name); if (v !== undefined) return v; }
    return undefined;
}

class GpsDecoder {
    constructor(log) {
        this.log = log;
        this.phase = 'nodata';
        this.fields = null;            // { lat: path, lon: path }
        this.scale = null;             // chosen SCALES entry
        this.cands = null;             // [{ s, prev, gpsM, wheelM }]
        this.lastT = 0;
        this.logged = {};
    }

    feed(rec, t, odoM) {
        if (!rec || typeof rec !== 'object') return null;
        const list = leaves(rec, '');
        const la = pick(list, LAT), lo = pick(list, LON);
        if (!la || !lo) {
            this.phase = 'nofields';
            this._once('fields', 'gps: no latitude / longitude field in the record; numeric fields: ' + list.map((l) => l.path).join(', '));
            return null;
        }
        if (!this.fields) {
            this.fields = { lat: la.path, lon: lo.path };
            this.log.info('gps: position fields ' + la.path + ' / ' + lo.path);
        }
        const plausible = (s) => {
            const lat = la.value * s.k, lon = lo.value * s.k;
            return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (Math.abs(lat) > 0.01 || Math.abs(lon) > 0.01);
        };
        const dt = this.lastT ? (t - this.lastT) / 1000 : 0;
        const dOdo = typeof odoM === 'number' && typeof this.lastOdo === 'number' ? odoM - this.lastOdo : null;
        this.lastT = t; this.lastOdo = odoM;

        if (!this.scale) {
            // degrees given as a fraction: decided at once
            if (!Number.isInteger(la.value) && !Number.isInteger(lo.value) && plausible(SCALES[0])) this._choose(SCALES[0], 'fractional degrees');
            else {
                const ok = SCALES.filter((s) => s.k !== 1 && plausible(s));
                if (!ok.length) { this.phase = 'nodata'; return null; }            // no fix yet (zeros), or a unit not in the list
                if (!this.cands) this.cands = ok.map((s) => ({ s, prev: null, gpsM: 0, wheelM: 0 }));
                this.cands = this.cands.filter((c) => ok.indexOf(c.s) >= 0);
                if (this.cands.length === 1) this._choose(this.cands[0].s, 'only plausible unit');
                else this._check(la.value, lo.value, dt, dOdo);
            }
        }
        if (!this.scale) { this.phase = 'calibrating'; return null; }
        if (!plausible(this.scale)) { this.phase = 'nodata'; return null; }               // no fix right now
        this.phase = 'ok';
        return [la.value * this.scale.k, lo.value * this.scale.k];
    }

    _check(latRaw, lonRaw, dt, dOdo) {
        // only intervals of real driving count: a fix a second or so, at MIN_KMH or more
        const moving = dOdo !== null && dt > 0 && dt < 2.5 && dOdo / dt >= MIN_KMH / 3.6;
        for (const c of this.cands) {
            const p = [latRaw * c.s.k, lonRaw * c.s.k];
            if (c.prev && moving) { c.gpsM += geo.distance(c.prev, p); c.wheelM += dOdo; }
            c.prev = p;
        }
        const ready = this.cands.filter((c) => c.wheelM >= MIN_CHECK_M);
        if (!ready.length) return;
        const ranked = ready.map((c) => ({ c, err: Math.abs(c.gpsM / c.wheelM - 1) })).sort((a, b) => a.err - b.err);
        const best = ranked[0], next = ranked[1];
        const ratios = ranked.map((r) => r.c.s.name + ' x' + (r.c.gpsM / r.c.wheelM).toFixed(3)).join(', ');
        if (best.err <= MAX_RATIO_ERR && (!next || next.err - best.err >= MIN_MARGIN)) this._choose(best.c.s, 'GPS distance / wheel distance: ' + ratios);
        else this._once('nomatch', 'gps: no clear unit yet (GPS / wheel distance): ' + ratios);
    }

    _choose(s, why) {
        this.scale = s;
        this.log.info('gps: unit ' + s.name + ' (' + why + ')');
    }

    _once(key, msg) { if (!this.logged[key]) { this.logged[key] = true; this.log.info(msg); } }

    state() { return { phase: this.phase, lat: this.fields && this.fields.lat, lon: this.fields && this.fields.lon, scale: this.scale && this.scale.name }; }
}

module.exports = { GpsDecoder, leaves, find, pick, LAT, LON, SCALES };
