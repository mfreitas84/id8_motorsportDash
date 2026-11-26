'use strict';
/**
 * tracks.js - saved tracks, and turning one driven lap into a track.
 *
 * File: <dataDir>/tracks.json, in the same format as CanBusTrackAnalyser's tracks.json, plus a
 * recorded "line", so tracks (and the CSV logs) move between the car and the analyser unchanged:
 *
 *   { "tracks": [ {
 *       "id": "circuito_do_sol", "name": "Circuito do Sol",
 *       "detect": { "lat": 37.891971, "lon": -7.341338, "radius_m": 513 },   // "am I at this track?"
 *       "start_finish": { "a": [lat, lon], "b": [lat, lon] },              // a line across the track
 *       "min_lap_s": 40.0,
 *       "line": [[lat, lon], ...]                                          // the driven lap, smoothed, closed
 *   } ] }
 *
 * Tracks without a "line" (imported from the analyser) still detect and still have a start / finish;
 * the map then draws the live trail until a lap is saved onto them.
 *
 * TrailRecorder: while no saved line is shown, the driven path is kept as a trail. Once it closes
 * into a lap (back within CLOSE_M of where it started, heading the same way, after MIN_LAP_M),
 * lap() returns the points and buildTrack() makes a track of them.
 */
const fs = require('fs');
const path = require('path');
const geo = require('./geo');

const STEP_M = 2;              // keep a trail point every 2 m
const MAX_POINTS = 20000;      // ~40 km of trail
const CLOSE_M = 15;            // back this close to the start ...
const CLOSE_HDG = 45;          // ... heading within 45 deg of the start heading ...
const MIN_LAP_M = 600;         // ... after at least this far: one lap
const LINE_STEP_M = 4;         // the saved line: a point every 4 m
const SMOOTH = 3;              // and smoothed over 7 points (28 m)

class TrackStore {
    constructor(dir, log, opts) {
        this.file = dir ? path.join(dir, 'tracks.json') : null;
        this.log = log;
        this.memoryOnly = !!(opts && opts.memoryOnly) || !dir;      // demo: nothing written
        this.tracks = [];
        this.load();
    }

    load() {
        if (!this.file) return;
        try {
            const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            this.tracks = Array.isArray(d.tracks) ? d.tracks.filter((t) => t && t.id && t.detect) : [];
        } catch (e) {
            if (e.code !== 'ENOENT') this.log.warn('tracks: ' + this.file + ' unreadable (' + e.message + '); starting empty');
            this.tracks = [];
        }
    }

    save() {
        if (this.memoryOnly) return;
        const tmp = this.file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ tracks: this.tracks }, null, 1));
        fs.renameSync(tmp, this.file);                // a power cut leaves the old file, never half a file
    }

    get(id) { return this.tracks.find((t) => t.id === id) || null; }

    /** The saved track whose detect circle holds [lat, lon] (the nearest centre if several), else null. */
    detect(ll) {
        if (!ll) return null;
        let best = null, bestD = Infinity;
        for (const t of this.tracks) {
            const d = geo.distance(ll, [t.detect.lat, t.detect.lon]);
            if (d <= (t.detect.radius_m || 500) && d < bestD) { best = t; bestD = d; }
        }
        return best;
    }

    add(track) {
        this.tracks = this.tracks.filter((t) => t.id !== track.id).concat([track]);
        this.save();
        this.log.info('tracks: saved ' + track.id + ' (' + (track.line ? track.line.length : 0) + ' points)');
    }

    remove(id) {
        this.tracks = this.tracks.filter((t) => t.id !== id);
        this.save();
        this.log.info('tracks: deleted ' + id);
    }

    /** Start / finish across the direction of travel at [lat, lon]. */
    setStartFinish(id, ll, hdg) {
        const t = this.get(id);
        if (!t || !ll || hdg === null || hdg === undefined) return false;
        const pl = geo.plane(ll);
        t.start_finish = geo.crossLine(pl, [0, 0], hdg, 12);
        this.save();
        return true;
    }
}

class TrailRecorder {
    constructor() { this.reset(); }

    reset() {
        this.pl = null;
        this.pts = [];                 // local [x, y]
        this.t = [];                   // ms per point
        this.len = 0;
        this.startHdg = null;
        this.closedAt = -1;            // index where the lap closed, -1 = not yet
    }

    /** Feed the car's position (fused, 10 Hz is fine). */
    feed(ll, hdg, tMs) {
        if (!ll) return;
        if (!this.pl) this.pl = geo.plane(ll);
        const q = this.pl.xy(ll);
        const last = this.pts[this.pts.length - 1];
        if (last && Math.hypot(q[0] - last[0], q[1] - last[1]) < STEP_M) return;
        if (last) this.len += Math.hypot(q[0] - last[0], q[1] - last[1]);
        this.pts.push(q); this.t.push(tMs);
        if (this.startHdg === null && hdg !== null && hdg !== undefined && this.len > 10) this.startHdg = hdg;
        if (this.pts.length > MAX_POINTS) { this.pts.shift(); this.t.shift(); this.closedAt = -1; }
        if (this.closedAt < 0 && this.len >= MIN_LAP_M && this.startHdg !== null) {
            const s = this.pts[0];
            if (Math.hypot(q[0] - s[0], q[1] - s[1]) <= CLOSE_M && hdg !== null && geo.headingDiff(hdg, this.startHdg) <= CLOSE_HDG) {
                this.closedAt = this.pts.length - 1;
            }
        }
    }

    lapReady() { return this.closedAt > 0; }
    points() { return this.pts; }
    lengthM() { return this.len; }

    /** A track from the closed lap: smoothed, evenly spaced, closed line; start / finish where the trail began. */
    buildTrack(name, nearby) {
        if (!this.lapReady()) return null;
        const lap = this.pts.slice(0, this.closedAt + 1);
        const line = geo.smooth(geo.resample(lap, LINE_STEP_M, true), SMOOTH, true);
        const lapS = (this.t[this.closedAt] - this.t[0]) / 1000;
        const b = geo.bbox(line), centre = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
        const radius = Math.max(...line.map((p) => Math.hypot(p[0] - centre[0], p[1] - centre[1]))) + 200;
        const c = geo.round6(this.pl.ll(centre));
        const when = new Date(this.t[0]);
        const stamp = when.toISOString().slice(0, 16).replace(/[-:T]/g, '');
        return {
            id: nearby ? nearby.id : 'trk_' + stamp,
            name: nearby ? nearby.name : name || 'Track ' + when.toISOString().slice(0, 10),
            detect: nearby ? nearby.detect : { lat: c[0], lon: c[1], radius_m: Math.round(radius) },
            start_finish: nearby && nearby.start_finish ? nearby.start_finish : geo.crossLine(this.pl, lap[0], this.startHdg, 12),
            min_lap_s: nearby && nearby.min_lap_s ? nearby.min_lap_s : Math.max(20, Math.round(lapS * 0.6)),
            line: line.map((p) => geo.round6(this.pl.ll(p))),
            recorded: when.toISOString(),
            length_m: Math.round(geo.length(line.concat([line[0]]))),
        };
    }
}

module.exports = { TrackStore, TrailRecorder };
