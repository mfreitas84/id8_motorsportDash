'use strict';
/**
 * obd_iat.js - ONE OBD-II read over TASU, as a worked example of the diagnostic path:
 * intake air temperature (mode 01, PID 0x0F) from the DME (engine control unit, diag address 0x12).
 *
 * OFF by default. Turned on by the app setting "OBD demo: intake air temp (DME)" (app.json
 * "obdIat"), and then it only runs while the screen is visible, about once a second.
 *
 * The path one request takes:
 *   1. uds_guard.js   classifies 01 0F as 'read' (allowed while driving). Anything not allowed
 *                     is dropped here and logged; nothing is sent.
 *   2. ReadOnlyDiag   (kit/runtime/readonly-diag.js) checks it AGAIN (only 22 / 01 / 09 pass),
 *                     paces requests (one at a time, >= 25 ms apart, backs off on "busy"),
 *                     and skips a unit that stops answering.
 *   3. Diag           (kit/runtime/diag.js) sends sendTasuRequest{ source 0xF2 (tester),
 *                     target 0x12, serviceID 0x01, udsData [0x0F] } on the InternalTasu proxy
 *                     and waits for the sendTasuResponse event from that unit.
 *   4. Reply          41 0F A  ->  IAT = A - 40 degC   (SAE J1979: one byte, offset -40)
 *                     7F 01 xx ->  refused (NRC xx); null -> no answer in time.
 *
 * The TASU proxy is only built the first time the demo is switched on, so with it off the app
 * never touches the diagnostic transport at all.
 */
const { ReadOnlyDiag } = require('./kit/readonly-diag');

const DME = 0x12;
const MODE_CURRENT_DATA = 0x01;
const PID_IAT = 0x0F;
const PERIOD_MS = 1000;

/** SAE J1979 mode 01 PID 0F: A - 40 degC. Returns null for anything that isn't 41 0F A. */
function decodeIat(uds) {
    if (!uds || uds.length < 3 || uds[0] !== MODE_CURRENT_DATA + 0x40 || uds[1] !== PID_IAT) return null;
    return uds[2] - 40;
}

class IatReader {
    constructor(ctx, guard) {
        this.ctx = ctx;
        this.log = ctx.log;
        this.guard = guard;
        this.link = null;            // ReadOnlyDiag, built on first use
        this.timer = null;
        this.paused = false;         // the kit's "Stop all" (ctx.onPanic) is on
        this.state = { value: null, at: 0, status: 'off', note: '' };
        this.onTrace = null;         // fn(what, details): every request and reply (the debug log)
    }

    _trace(what, d) { if (this.onTrace) this.onTrace(what, d); }

    async _ensureLink() {
        if (this.link) return this.link;
        const link = new ReadOnlyDiag(this.ctx.signals, this.log);
        await link.init();           // builds the InternalTasu proxy; fails cleanly on the PC
        if (link.error) throw new Error(link.error);
        this.link = link;
        return link;
    }

    start() {
        if (this.timer || this.paused) return;
        this.state.status = 'starting';
        this._ensureLink()
            .then(() => {
                if (this.timer || this.paused) return;
                this.log.info('OBD IAT: start (01 0F to DME 0x12, every ' + PERIOD_MS + ' ms)');
                this.timer = setInterval(() => this._readOnce(), PERIOD_MS);
                this._readOnce();
            })
            .catch((e) => { this.state.status = 'no link'; this.state.note = String(e.message || e); this.log.warn('OBD IAT: ' + e); });
    }

    stop() {
        if (this.timer) { clearInterval(this.timer); this.timer = null; this.log.info('OBD IAT: stop'); }
        if (this.link) this.link.cancel();     // drop anything still queued
        if (this.state.status !== 'no link') this.state.status = 'off';
    }

    /** ctx.onPanic: "Stop all" from any app's settings. Stop at once and send nothing until it ends. */
    panic(on) {
        this.paused = on;
        if (on) { this.stop(); this.state.status = 'stopped (Stop all)'; }
    }

    async _readOnce() {
        if (this.busy || !this.link) return;
        const data = [PID_IAT];
        // (1) our gate, right before sending
        const verdict = this.guard.check(MODE_CURRENT_DATA, data);
        if (!verdict.ok) { this.state.status = 'refused'; this.state.note = verdict.why; this.log.warn('OBD IAT: ' + verdict.why); this._trace('refused by gate', verdict.why); return; }
        this.busy = true;
        const t0 = Date.now();
        this._trace('request', { to: '0x12', uds: '01 0F', gate: verdict.cls });
        try {
            // (2)+(3) the kit's read-only link; accept() keeps only OUR answer: other apps poll the DME too
            const uds = await this.link.physical(DME, MODE_CURRENT_DATA, data, 1500,
                (u) => (u[0] === 0x41 && u[1] === PID_IAT) || (u[0] === 0x7F && u[1] === MODE_CURRENT_DATA));
            this._trace('reply', { ms: Date.now() - t0, uds: uds === undefined ? 'cancelled' : uds === null ? 'none' : uds.map((b) => (b < 16 ? '0' : '') + b.toString(16)).join(' ') });
            if (uds === undefined) return;                              // cancelled before it was sent
            if (uds === null) { this.state.status = 'no answer'; return; }
            if (uds[0] === 0x7F) { this.state.status = 'refused by DME'; this.state.note = 'NRC 0x' + uds[2].toString(16); return; }
            // (4) decode
            const iat = decodeIat(uds);
            if (iat !== null) { this.state.value = iat; this.state.at = Date.now(); this.state.status = 'live'; this.state.note = ''; }
        } catch (e) {
            this.state.status = 'error';
            this.state.note = String(e.message || e);
            this._trace('error', this.state.note);
        } finally {
            this.busy = false;
        }
    }
}

module.exports = { IatReader, decodeIat };
