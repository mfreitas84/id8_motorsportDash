'use strict';
/**
 * poller.js - read SOME/IP fields by POLLING their getters, only while we ask it to run.
 *
 * Why poll: on the MGU many BMW notifiers never fire (a field is only "notified" on change, and
 * some providers don't notify at all), so subscribing alone leaves the screen frozen. Reading the
 * getter on a timer always gets the current value. That is why app.json lists these fields with
 * flag "r" (getter only) and not "s" (subscribe): the installer then generates only the getter.
 *
 * Why only while running: polling costs CPU and SOME/IP traffic on a shared bus. main.js starts the
 * poller when the screen becomes visible and stops it when the screen is hidden.
 *
 *   const poller = new Poller(ctx.signals, ctx.log, 100);          // every 100 ms = 10 Hz
 *   poller.add('de.bmw.infotainment.vehicle.CDS', 'statusEngineSpeed2', (v) => { ... });
 *   await poller.init();     // builds one proxy per interface (no reads yet)
 *   poller.start();          // screen shown
 *   poller.stop();           // screen hidden
 *
 * Two sources, picked by init():
 *   car   - ctx.signals.proxy() + proxy.getValue(field): the real head unit.
 *   bench - the PC emulator / preview (kit/tools/hu-stub.js) has no SOME/IP proxies; it only feeds
 *           values to ctx.signals.watch() handlers. There we register the same handlers with watch(),
 *           so the emulator's sliders and demo drive reach the screen through the same code below.
 */

class Poller {
    constructor(signals, log, periodMs) {
        this.signals = signals;
        this.log = log;
        this.periodMs = periodMs || 100;
        this.fields = [];            // { iface, field, onValue, busy }
        this.proxies = {};           // iface -> { proxy, available }
        this.mode = null;            // 'car' | 'bench' | null (not initialised)
        this.timer = null;
        // counters shown on screen and in the log: proof the plumbing works
        this.stats = { reads: 0, values: 0, errors: 0, skipped: 0 };
    }

    /** Register one field; onValue(v) gets the field's struct (raw, unscaled). */
    add(iface, field, onValue) {
        this.fields.push({ iface, field, onValue, busy: false });
    }

    async init() {
        const ifaces = Array.from(new Set(this.fields.map((f) => f.iface)));
        // hasNative() is false (or missing) when the 'someip' native module isn't there: the PC
        if (!(this.signals.hasNative && this.signals.hasNative())) return this._initBench(ifaces);
        this.mode = 'car';
        for (const iface of ifaces) {
            const entry = { proxy: null, available: false };
            this.proxies[iface] = entry;
            try {
                // instance '1' is what the kit's apps use for the vehicle interfaces
                entry.proxy = await this.signals.proxy(iface, '1');
                // availability = the providing ECU / service is up. Reads before that only time out.
                await this.signals.onAvailable(entry.proxy, (a) => {
                    entry.available = a;
                    this.log.info('poller: ' + short(iface) + (a ? ' available' : ' gone'));
                });
            } catch (e) {
                this.log.warn('poller: no proxy for ' + iface + ': ' + e);
            }
        }
        this.log.info('poller: car mode, ' + this.fields.length + ' fields on ' + ifaces.length + ' interfaces');
    }

    async _initBench(ifaces) {
        this.mode = 'bench';
        for (const iface of ifaces) {
            const handlers = {};
            this.fields.filter((f) => f.iface === iface).forEach((f) => {
                handlers[f.field] = (v) => { this.stats.values++; f.onValue(v); };
            });
            try { await this.signals.watch(iface, '1', handlers, this.log); } catch (e) { /* preview: nothing feeds it */ }
        }
        this.log.info('poller: bench mode (no SOME/IP here): values come from the emulator, if any');
    }

    start() {
        if (this.timer || this.mode !== 'car') return;
        this.log.info('poller: start (' + Math.round(1000 / this.periodMs) + ' Hz)');
        this.timer = setInterval(() => this._tick(), this.periodMs);
        this._tick();
    }

    stop() {
        if (!this.timer) return;
        clearInterval(this.timer);
        this.timer = null;
        this.log.info('poller: stop (' + JSON.stringify(this.stats) + ')');
    }

    get running() { return !!this.timer || this.mode === 'bench'; }

    _tick() {
        for (const f of this.fields) {
            const entry = this.proxies[f.iface];
            if (!entry || !entry.proxy || !entry.available) continue;
            // never stack reads: if the last one for this field hasn't answered, skip this round
            if (f.busy) { this.stats.skipped++; continue; }
            f.busy = true;
            this.stats.reads++;
            // the kit's signals.js reads getters from a fresh setImmediate tick, never inline in a
            // promise chain (the native binding can deadlock otherwise); do the same
            setImmediate(() => {
                entry.proxy.getValue(f.field, Math.max(300, this.periodMs * 3))
                    .then((v) => { this.stats.values++; f.onValue(v); })
                    .catch(() => { this.stats.errors++; })
                    .then(() => { f.busy = false; });
            });
        }
    }
}

const short = (iface) => iface.split('.').pop();

module.exports = { Poller };
