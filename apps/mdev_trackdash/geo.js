'use strict';
/**
 * geo.js - the little geometry the track map needs. No dependencies.
 *
 * Positions are [lat, lon] in degrees (WGS-84, as GPS gives them). For drawing and for distances on
 * a circuit-sized area we project onto a flat local plane in metres around a reference point
 * (equirectangular: x = east, y = north). Over a few km the error is far below GPS noise.
 */
const R = 6371008.8;                          // mean Earth radius, m
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** Great-circle distance in metres between two [lat, lon]. */
function distance(a, b) {
    const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A local flat projection around origin [lat, lon]: xy([lat, lon]) -> [x, y] m, ll([x, y]) -> [lat, lon]. */
function plane(origin) {
    const k = Math.cos(rad(origin[0]));
    return {
        origin,
        xy: (p) => [rad(p[1] - origin[1]) * R * k, rad(p[0] - origin[0]) * R],
        ll: (q) => [origin[0] + deg(q[1] / R), origin[1] + deg(q[0] / (R * k))],
    };
}

/** Heading in degrees (0 = north, 90 = east) from local point a to b. */
function heading(a, b) { return (deg(Math.atan2(b[0] - a[0], b[1] - a[1])) + 360) % 360; }

/** Smallest difference between two headings, 0..180. */
function headingDiff(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

/** Total length in metres of a polyline of local [x, y] points. */
function length(pts) {
    let s = 0;
    for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return s;
}

/** Points every `step` m along a polyline (local [x, y]); `closed` also walks back to the start. */
function resample(pts, step, closed) {
    const src = closed ? pts.concat([pts[0]]) : pts;
    if (src.length < 2) return pts.slice();
    const out = [src[0].slice()];
    let carry = 0;
    for (let i = 1; i < src.length; i++) {
        const a = src[i - 1], b = src[i];
        const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
        let d = step - carry;
        while (d <= seg) {
            const f = d / seg;
            out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
            d += step;
        }
        carry = seg - (d - step);
    }
    if (closed && out.length > 1 && Math.hypot(out[out.length - 1][0] - out[0][0], out[out.length - 1][1] - out[0][1]) < step / 2) out.pop();
    return out;
}

/** Moving average over 2*half+1 points; on a closed loop it wraps around, so the seam stays smooth. */
function smooth(pts, half, closed) {
    const n = pts.length;
    if (n < 3 || half < 1) return pts.slice();
    return pts.map((_, i) => {
        let sx = 0, sy = 0, c = 0;
        for (let j = -half; j <= half; j++) {
            let k = i + j;
            if (closed) k = (k + n) % n; else if (k < 0 || k >= n) continue;
            sx += pts[k][0]; sy += pts[k][1]; c++;
        }
        return [sx / c, sy / c];
    });
}

/** Bounding box of local points: { x0, y0, x1, y1 }. */
function bbox(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    return { x0, y0, x1, y1 };
}

/**
 * A start / finish line through point p (local), across the direction of travel `hdg`: two ends
 * `half` m either side, as [lat, lon] (the format CanBusTrackAnalyser's tracks.json uses).
 */
function crossLine(pl, p, hdg, half) {
    const a = rad(hdg + 90);
    const dx = Math.sin(a) * half, dy = Math.cos(a) * half;
    return { a: round6(pl.ll([p[0] - dx, p[1] - dy])), b: round6(pl.ll([p[0] + dx, p[1] + dy])) };
}

const round6 = (p) => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6];

module.exports = { distance, plane, heading, headingDiff, length, resample, smooth, bbox, crossLine, round6 };
