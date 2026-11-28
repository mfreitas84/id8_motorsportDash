#!/bin/sh
# mdev-usb helper (root): makes the car's USB stick writable only while an mdev app asks for it.
#
# The car mounts USB sticks read-only for its media player. Every 2 s this script:
#   - writes /dev/shm/mdev-usb/status (JSON: time, mount path, label, free MB, read-write or not);
#   - remounts the stick read-write while /dev/shm/mdev-usb/request holds a time (epoch seconds)
#     at most FRESH seconds old: the app rewrites it every second while it copies;
#   - once the request is older than that, or gone: sync, then read-only again.
# It only remounts a stick it opened itself, and only vfat / exfat mounts directly under /media.
# BusyBox sh only: mount, df, date, sync, cat, mv, tr, basename.

D=${MDEV_USB_DIR:-/dev/shm/mdev-usb}
REQ=$D/request
ST=$D/status
FRESH=${MDEV_USB_FRESH:-10}
EVERY=${MDEV_USB_EVERY:-2}
MOUNTS=${MDEV_USB_MOUNTS:-/proc/mounts}
MOUNT=${MDEV_USB_MOUNT:-mount}          # (tests swap these three)

mkdir -p "$D" && chmod 1777 "$D"
# the stick this helper made writable, kept across a restart of the helper
OPENED=$(cat "$D/.opened" 2>/dev/null)
set_opened() { OPENED=$1; if [ -n "$1" ]; then printf '%s' "$1" > "$D/.opened"; else rm -f "$D/.opened"; fi; }

close_stick() {
    if [ -n "$OPENED" ]; then
        sync
        $MOUNT -o remount,ro "$OPENED" 2>/dev/null
        set_opened ""
    fi
}
trap 'close_stick; exit 0' TERM INT HUP

# the first vfat / exfat mount under /media: sets MNT (empty if none) and RO (1 / 0)
find_stick() {
    MNT=""; RO=1
    while read -r dev m fs opts rest; do
        case "$m" in /media/*/*) continue ;; /media/?*) ;; *) continue ;; esac
        case "$fs" in vfat|exfat) ;; *) continue ;; esac
        case "$m" in *'\'*) m=$(printf '%b' "$m") ;; esac    # /proc/mounts writes a space as \040
        MNT=$m
        case ",$opts," in *,ro,*) RO=1 ;; *) RO=0 ;; esac
        return
    done < "$MOUNTS"
}

# 1 if the request file holds a recent time
wanted() {
    r=$(cat "$REQ" 2>/dev/null)
    case "$r" in ''|*[!0-9]*) echo 0; return ;; esac
    if [ $((NOW - r)) -le "$FRESH" ] && [ $((r - NOW)) -le 5 ]; then echo 1; else echo 0; fi
}

free_mb() {
    set -- $(df -k "$1" 2>/dev/null | tail -n 1)
    if [ $# -ge 6 ]; then echo $(($4 / 1024)); elif [ $# -eq 5 ]; then echo $(($3 / 1024)); else echo null; fi
}

while :; do
    NOW=$(date +%s)
    find_stick
    want=$(wanted)
    if [ -z "$MNT" ]; then
        [ -n "$OPENED" ] && set_opened ""             # the stick was pulled out
    elif [ "$want" = 1 ] && [ "$RO" = 1 ]; then
        $MOUNT -o remount,rw "$MNT" 2>/dev/null && RO=0 && set_opened "$MNT"
    elif [ "$want" = 0 ] && [ -n "$OPENED" ] && [ "$OPENED" = "$MNT" ]; then
        close_stick
        RO=1
    fi
    if [ -n "$MNT" ]; then
        label=$(basename "$MNT" | tr -d '\042\134')        # no " or \ in the JSON
        mj=$(printf '%s' "$MNT" | tr -d '\042\134')
        rw=false; [ "$RO" = 0 ] && rw=true
        printf '{"t":%s,"mount":"%s","label":"%s","freeMb":%s,"rw":%s}\n' "$NOW" "$mj" "$label" "$(free_mb "$MNT")" "$rw" > "$ST.tmp"
    else
        printf '{"t":%s,"mount":null}\n' "$NOW" > "$ST.tmp"
    fi
    chmod 644 "$ST.tmp"; mv -f "$ST.tmp" "$ST"
    [ -n "$MDEV_USB_ONCE" ] && exit 0
    sleep "$EVERY"
done
