'use strict';
/**
 * usb.js - "Save USB": copy the newest session log to a USB stick. NOT WIRED YET.
 *
 * The car mounts USB sticks read-only (for its media player), and an app runs as its own sandbox
 * user, so the app cannot write a stick by itself. The plan (CLAUDE.md, "USB-logger design decision"):
 *   - a small root helper, installed as an MGU Store tool, modelled on the Drive Recorder's usb-rw.sh:
 *     it reports the stick (label, free space), and remounts it read-write only while the app keeps a
 *     request flag fresh in /dev/shm, and only while the car stands still; read-only again ~20 s later.
 *   - the app asks, waits for read-write, copies, and lets the flag go stale.
 * Building it needs one SSH session on the car first: where sticks mount, and how they are mounted.
 *
 * Until then status() says why the button is greyed, and save() refuses.
 * The rule for the button stays: a stick present AND the car parked.
 */

class UsbBridge {
    constructor(log) { this.log = log; }

    /** { present, label, freeMb, why } - why = the reason Save USB can't run now ('' when it can). */
    status() {
        return { present: false, label: null, freeMb: null, why: 'USB helper not installed yet' };
    }

    /** Copies file to the stick; resolves with the path written there. */
    save(file) {
        return Promise.reject(new Error('USB helper not installed yet (next step: needs the car)'));
    }
}

module.exports = { UsbBridge };
