#!/system/bin/sh
# First boot after a one-session recovery flash (see farm-bootstrap.rc). The zip left the module
# in /data/farm-bootstrap because /data/adb does not exist before Magisk's first boot.
#   early  post-fs-data, before the setup wizard and adbd: props and ADB keys
#   late   boot completed: install the module into /data/adb/modules and run it
# Nothing to do once the module is installed (later boots run it as a normal Magisk module).
P=/data/farm-bootstrap
M=$P/module
TMP=$2
[ -d "$M" ] || exit 0
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') stage $*" >> "$P/log.txt"; }

case "$1" in
  early)
    log "early boot"
    RP="$TMP/magisk resetprop"
    # same as the module's system.prop, which Magisk only loads once the module is installed
    $RP -n ro.setupwizard.mode DISABLED
    $RP persist.sys.usb.config mtp,adb
    $RP service.adb.tcp.port "$(. "$M/farm.conf" 2>/dev/null; echo "${ADB_PORT:-5555}")"
    [ -f "$M/post-fs-data.sh" ] && sh "$M/post-fs-data.sh"   # ADB keys (its MODDIR is $M)
    log "props and ADB keys set"
    ;;
  late)
    log "boot completed"
    i=0; while [ ! -d /data/adb/modules ] && [ $i -lt 60 ]; do sleep 2; i=$((i+1)); done
    [ -d /data/adb/modules ] || { log "no /data/adb/modules: Magisk not running?"; exit 1; }
    D=/data/adb/modules/farm-bootstrap
    rm -rf "$D"
    cp -a "$M" "$D" || { log "copy to $D failed"; exit 1; }
    chown -R 0:0 "$D"
    chmod 0755 "$D" "$D"/*.sh
    chcon -R u:object_r:system_file:s0 "$D"
    for f in farm.conf adb_keys ssh_keys; do [ -f "$D/$f" ] && chmod 0600 "$D/$f"; done
    [ -d "$D/apks" ] && chmod 0700 "$D/apks" && chmod 0600 "$D"/apks/*
    mkdir -p /data/adb/farm-bootstrap
    cat "$P/log.txt" >> /data/adb/farm-bootstrap/log.txt 2>/dev/null
    rm -rf "$P"
    # from now on Magisk runs it at every boot; this first time, run it now
    exec sh "$D/farm-bootstrap.sh" run >/dev/null 2>&1
    ;;
esac
