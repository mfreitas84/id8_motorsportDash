'use strict';
/**
 * draw.js - the two pages, drawn on the kit's 1600 x 520 page canvas (content between G.TOP and
 * G.BOTTOM). main.js gathers everything into one model `m` per frame and calls these.
 *
 * Buttons: G.button() draws AND makes the button tappable where the kit runs the screen (the Store's
 * mgu-render with touch routing). Without it the HMI's own bar buttons do the same jobs (app.json).
 */
const G = require('./kit/gauges');
const geo = require('./geo');

const GREEN = '#2ecc40', RED = '#ff3b30';

// what the map says while there is no position (inputs.gpsState)
const GPS_TEXT = {
    none: ['No GPS on this unit', 'the GPSData service is missing'],
    nodata: ['Waiting for GPS', 'no fix yet'],
    nofields: ['GPS found, no position in it', 'set Logging = Debug and send the log'],
    calibrating: ['GPS: learning its units', 'drive a few hundred metres'],
};
const MAX_TRAIL_SEG = 600;

/* ---------------- the map ---------------- */

/** Fit local points into rect r (north up): returns a function local [x, y] -> screen [x, y]. */
function fitter(pts, r, pad) {
    const b = geo.bbox(pts);
    const w = Math.max(1, b.x1 - b.x0), h = Math.max(1, b.y1 - b.y0);
    const s = Math.min((r.w - 2 * pad) / w, (r.h - 2 * pad) / h);
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2, mx = (b.x0 + b.x1) / 2, my = (b.y0 + b.y1) / 2;
    return (p) => [cx + (p[0] - mx) * s, cy - (p[1] - my) * s];
}

const planes = new Map();          // track id -> { pl, xy: local line }
function trackPlane(track) {
    let c = planes.get(track.id);
    if (!c || c.n !== track.line.length) {
        const pl = geo.plane(track.line[0]);
        c = { pl, xy: track.line.map((p) => pl.xy(p)), n: track.line.length };
        planes.set(track.id, c);
    }
    return c;
}

function drawMap(cv, t, r, m) {
    const box = G.panel(cv, t, r.x, r.y, r.w, r.h, m.mapTitle);
    const area = { x: box.x + 14, y: box.y + 44, w: box.w - 28, h: box.h - 58 };
    const dot = m.pos;
    if (m.track && m.track.line && m.track.line.length > 2) {
        // a saved track: its line as a cached layer, the car as a dot
        const c = trackPlane(m.track);
        const map = fitter(c.xy, area, 18);
        const key = ['trk', m.track.id, c.n, area.w, area.h, t.name].join('|');
        const L = G.layer(key, area.w, area.h, (lc) => {
            const loc = (p) => { const s = map(p); return [s[0] - area.x, s[1] - area.y]; };
            const pts = c.xy.map(loc); pts.push(pts[0]);
            lc.polyline(pts, 9, G.withAlpha(t.text, 0.18));
            lc.polyline(pts, 3, G.withAlpha(t.text, 0.75));
            if (m.track.start_finish) {
                const a = loc(c.pl.xy(m.track.start_finish.a)), b = loc(c.pl.xy(m.track.start_finish.b));
                lc.line(a[0], a[1], b[0], b[1], 5, t.accent);
            }
        }, cv.textScale);
        cv.blit(L, area.x, area.y);
        if (dot) carDot(cv, t, map(c.pl.xy(dot)));
        return;
    }
    const trail = m.trail.points();
    if (trail.length > 1 && m.trail.pl) {
        // no saved line here: the live trail
        const map = fitter(trail, area, 18);
        const every = Math.max(1, Math.ceil(trail.length / MAX_TRAIL_SEG));
        const pts = [];
        for (let i = 0; i < trail.length; i += every) pts.push(map(trail[i]));
        pts.push(map(trail[trail.length - 1]));
        cv.polyline(pts, 3, G.withAlpha(t.accent, 0.8));
        const s = map(trail[0]);
        cv.circle(s[0], s[1], 6, t.dim);
        if (dot) carDot(cv, t, map(m.trail.pl.xy(dot)));
        cv.text(m.lapReady ? 'Lap closed: save it on the Tracks page' : 'Live trail ' + (m.trail.lengthM() / 1000).toFixed(2) + ' km',
            area.x + 6, area.y + area.h - 6, 22, m.lapReady ? t.accent : t.dim);
        return;
    }
    const msg = GPS_TEXT[m.gpsState] || GPS_TEXT.nodata;
    cv.text(msg[0], area.x + area.w / 2, area.y + area.h / 2, 32, t.dim, { align: 'center', font: 'bold' });
    if (msg[1]) cv.text(msg[1], area.x + area.w / 2, area.y + area.h / 2 + 40, 22, t.dim, { align: 'center' });
}

function carDot(cv, t, p) {
    cv.circle(p[0], p[1], 15, G.withAlpha(t.accent, 0.3));
    cv.circle(p[0], p[1], 10, '#ffffff');
    cv.circle(p[0], p[1], 7, t.accent);
}

/* ---------------- driver inputs ---------------- */

/** A horizontal bar, 0..100 %, filled in colour c. */
function pctBar(cv, t, x, y, w, h, label, pct, c, note, raw) {
    const ls = Math.round(h * 0.34);
    cv.text(label, x, y - 12, ls, t.dim, { font: 'bold', spacing: 1.5 });
    if (note) cv.text(note, x + w, y - 12, Math.round(ls * 0.82), t.dim, { align: 'right' });
    cv.roundRect(x, y, w, h, 6, G.withAlpha('#ffffff', 0.08));
    if (isRaw(raw)) { rawText(cv, t, x, y, w, h, raw); return; }
    if (G.isNum(pct) && pct > 0) cv.roundRect(x, y, Math.max(h, (w * Math.min(100, pct)) / 100), h, 6, c);
    cv.text(G.isNum(pct) ? Math.round(pct) + '%' : '--', x + w - 10, y + h * 0.72, h * 0.62, G.isNum(pct) && pct > 55 ? '#000000' : t.text, { align: 'right', font: 'num' });
}

/** Not calibrated yet (inputs.js CALIBRATED): the car's own number, plainly marked, in place of a wrong % / angle. */
const isRaw = (raw) => raw !== undefined && raw !== null;
function rawText(cv, t, x, y, w, h, raw) {
    cv.text('raw', x + 12, y + h * 0.66, h * 0.32, t.dim);
    cv.text(String(raw), x + w - 10, y + h * 0.72, h * 0.62, t.text, { align: 'right', font: 'num' });
}

/** Steering: a centred bar, left of centre = left; full scale = range degrees. */
function steerBar(cv, t, x, y, w, h, deg, range, raw) {
    const ls = Math.round(h * 0.34);
    cv.text('STEERING', x, y - 12, ls, t.dim, { font: 'bold', spacing: 1.5 });
    cv.roundRect(x, y, w, h, 6, G.withAlpha('#ffffff', 0.08));
    if (isRaw(raw)) { rawText(cv, t, x, y, w, h, raw); return; }
    const mid = x + w / 2;
    if (G.isNum(deg)) {
        const f = Math.max(-1, Math.min(1, deg / range)), dx = (-f * w) / 2;   // + (left) draws to the left
        cv.fillRect(Math.min(mid, mid + dx), y + 4, Math.abs(dx), h - 8, t.accent);
    }
    cv.fillRect(mid - 1.5, y - 6, 3, h + 12, t.text);
    const txt = G.isNum(deg) ? Math.abs(Math.round(deg)) + '°' + (Math.round(deg) > 0 ? ' L' : Math.round(deg) < 0 ? ' R' : '') : '--';
    cv.text(txt, x + w, y - 12, ls, t.text, { align: 'right', font: 'bold' });
}

/**
 * The page's usable width in its own units. iDrive 8's screen (2880 px) is wider than the kit's 1600 x 520 page
 * scaled to fill the height, so the page stands in the middle with empty sides. The renderer doesn't cut drawing at
 * the page's edge, and the recorder knows where the page lands (cv.place), so the dash uses those sides too.
 * Anywhere else (iDrive 7, the HMI's software path, the PC preview): the page as it is. cv.span overrides (tests).
 */
function span(cv) {
    if (cv.span) return cv.span;
    const p = cv.place;
    if (p && p.full && p.scale > 0 && p.w >= 2400) {
        const x0 = Math.max(-400, Math.ceil(-p.ox / p.scale) + 16), x1 = Math.min(2000, Math.floor((p.w - p.ox) / p.scale) - 16);
        if (x1 - x0 > 1600) return { x0, x1 };
    }
    return { x0: 16, x1: 1584 };
}

/* ---------------- pages ---------------- */

function dash(cv, t, m) {
    const top = G.TOP + 8, bottom = G.BOTTOM - 6, sp = span(cv), W = sp.x1 - sp.x0, gap = 16;
    const mapW = Math.round(W * 0.42);
    drawMap(cv, t, { x: sp.x0, y: top, w: mapW, h: bottom - top }, m);

    const x0 = sp.x0 + mapW + gap, rw = sp.x1 - x0, w = (rw - 2 * gap) / 3, h = 210;
    const size = Math.round(Math.max(96, Math.min(124, w * 0.33)));
    const d = m.d, s = m.settings, raw = m.raw || {};
    const cz = [{ from: s.coolWarn, to: 999, color: 'warn' }, { from: s.coolWarn + 8, to: 999, color: 'crit' }];
    const oz = [{ from: s.oilWarn, to: 999, color: 'warn' }, { from: s.oilWarn + 10, to: 999, color: 'crit' }];
    G.stat(cv, t, x0, top, w, h, { label: 'Coolant', value: d.coolant, unit: '°C', size, zones: cz });
    G.stat(cv, t, x0 + w + gap, top, w, h, { label: 'Oil', value: d.oil, unit: '°C', size, zones: oz });
    G.stat(cv, t, x0 + 2 * (w + gap), top, w, h, { label: 'Speed', value: d.speed, unit: 'km/h', size });

    const py = top + h + 14, ph = bottom - py;
    const p = G.panel(cv, t, x0, py, rw, ph, 'Driver');
    const bh = W > 1700 ? 76 : 64, bx = p.x + 24, bw = (p.w - 24 * 4) / 3, by = p.y + 92;
    const thrNote = m.src.throttle === 'ok' || m.demo ? '' : m.src.throttle;
    pctBar(cv, t, bx, by, bw, bh, 'THROTTLE', d.throttle, GREEN, thrNote, raw.throttle);
    pctBar(cv, t, bx + bw + 24, by, bw, bh, 'BRAKE', m.brakePct, RED, m.brakeNote);
    steerBar(cv, t, bx + 2 * (bw + 24), by, bw, bh, d.steer, s.steerRange, raw.steer);
    const g = (v) => (G.isNum(v) ? (v >= 0 ? '+' : '') + v.toFixed(2) : '--');
    cv.text('g long ' + g(d.gLong) + '    g lat ' + g(d.gLat), bx, by + bh + 44, W > 1700 ? 28 : 22, t.dim);
}

function tracks(cv, t, m, act) {
    const top = G.TOP + 8, bottom = G.BOTTOM - 6;
    const L = G.panel(cv, t, 16, top, 700, bottom - top, 'Saved tracks');
    const list = m.store.tracks;
    if (!list.length) cv.text('None yet. Drive a lap, then "Save lap as track".', L.x + 24, L.y + 90, 24, t.dim);
    list.slice(0, 7).forEach((tr, i) => {
        const here = m.track && m.track.id === tr.id;
        const label = tr.name + (tr.line ? '' : '  (no line)') + (here ? '  - here' : '');
        G.chip(cv, t, L.x + 18, L.y + 56 + i * 58, L.w - 36, 50, label, m.selId === tr.id ? true : null, () => act.select(tr.id));
    });

    const R = G.panel(cv, t, 732, top, 852, bottom - top, 'Track');
    const sel = m.store.get(m.selId) || m.track;
    const line = (i, s, c) => cv.text(s, R.x + 24, R.y + 84 + i * 34, 24, c || t.text);
    line(0, 'GPS: ' + (m.gpsState === 'ok' ? 'fix ' + (m.fixAge / 1000).toFixed(1) + ' s ago' : (GPS_TEXT[m.gpsState] || GPS_TEXT.nodata)[0]), m.gpsState === 'ok' ? t.text : t.dim);
    line(1, 'Detected: ' + (m.track ? m.track.name : 'none'), t.dim);
    if (sel) {
        line(2, sel.name + (sel.length_m ? '   ' + (sel.length_m / 1000).toFixed(2) + ' km' : ''));
        line(3, (sel.recorded ? 'recorded ' + sel.recorded.slice(0, 10) : 'imported') + (sel.start_finish ? '   start/finish set' : '   no start/finish'), t.dim);
    }
    const by = R.y + R.h - 150, bw = 260, bh = 56;
    if (!cv.own) {
        // software path (no mgu-render running the screen): page buttons can't be tapped here
        cv.text('Track buttons need the GPU renderer (MGU Store\'s mgu-render).', R.x + 24, by + 40, 22, t.dim);
        cv.text(m.lapReady ? 'A lap is ready to save.' : 'Drive one full lap to record a track.', R.x + 24, by + 74, 22, t.dim);
        return;
    }
    G.button(cv, t, R.x + 24, by, bw, bh, 'Save lap as track', act.saveLap, { primary: true, busy: !m.lapReady, key: 'save' });
    G.button(cv, t, R.x + 24 + bw + 16, by, bw, bh, 'Restart trail', act.restartTrail, { key: 'restart' });
    G.button(cv, t, R.x + 24, by + bh + 14, bw, bh, 'Start/finish here', act.startFinish, { busy: !(sel && m.gpsState === 'ok' && m.heading !== null), key: 'sf' });
    G.button(cv, t, R.x + 24 + bw + 16, by + bh + 14, bw, bh, 'Delete', act.remove, { color: t.crit, confirm: true, busy: !sel, key: 'del' });
    if (!m.lapReady) cv.text('Save is enabled after one full lap of trail.', R.x + 24, by - 18, 20, t.dim);
}

/** A short message over the bottom of the page (2.5 s). */
function toast(cv, t, msg) {
    if (!msg) return;
    const w = Math.min(1200, cv.textWidth(msg, 26) + 60), x = (1600 - w) / 2, y = G.BOTTOM - 70;
    cv.roundRect(x, y, w, 52, 10, G.withAlpha('#000000', 0.85));
    cv.strokeRoundRect(x, y, w, 52, 10, 1.5, t.accent);
    cv.text(msg, 800, y + 35, 26, t.text, { align: 'center' });
}

module.exports = { dash, tracks, toast, span, GREEN, RED };
