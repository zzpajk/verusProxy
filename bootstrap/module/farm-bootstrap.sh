# Farm bootstrap: brings a freshly rooted phone up ready for the verusProxy dashboard.
#   sh farm-bootstrap.sh boot     what service.sh runs: wait for Android, then run
#   sh farm-bootstrap.sh run      run now (as root), e.g. to test over ADB
#   sh farm-bootstrap.sh status   print the status file
#
# Every boot: ADB over WiFi on, WiFi joined, screen kept on.
# Until done (each step is retried on the next boot until it worked): setup wizard off, lock screen
# off, developer options, Termux apps installed and opened once, Magisk root for ADB shell and
# Termux, battery optimisation off, a small Termux:Boot script, the farm's SSH keys. The rest (packages, SSH, miner,
# farm profile) is the dashboard's "Set up phone" once its scan finds the phone on ADB_PORT.

MODDIR=${0%/*}
STATE=${FARM_STATE:-/data/adb/farm-bootstrap}   # overridable for bootstrap/test/stub-run.sh
LOG=$STATE/log.txt
T=${FARM_TERMUX:-/data/data/com.termux/files}
mkdir -p "$STATE"
chmod 0700 "$STATE"

# settings (farm.conf from the zip), defaults as in farm.conf.example
WIFI_SSID=''; WIFI_PASS=''; WIFI_SECURITY='wpa2'; ADB_PORT='5555'
SKIP_SETUP_WIZARD='1'; DISABLE_LOCKSCREEN='1'; STAY_AWAKE='1'; DEV_OPTIONS='1'; INSTALL_APPS='1'
ROOT_SHELL='1'; ROOT_TERMUX='1'; BATTERY_WHITELIST='1'; PROXY_HOST=''
[ -f "$MODDIR/farm.conf" ] && . "$MODDIR/farm.conf"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
on() { [ "$1" = 1 ]; }
# a step that worked is not run again (rm $STATE/ok.* or reinstall the module to redo)
done_step() { [ -f "$STATE/ok.$1" ]; }
mark() { touch "$STATE/ok.$1"; log "ok: $1"; }

# keep the log small
[ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 200000 ] && tail -c 100000 "$LOG" > "$LOG.tmp" && mv -f "$LOG.tmp" "$LOG"

wait_boot() {
  until [ "$(getprop sys.boot_completed)" = 1 ]; do sleep 3; done
  # the package and settings services answer a little after boot_completed
  i=0; until pm path android >/dev/null 2>&1 || [ $i -ge 60 ]; do sleep 2; i=$((i+1)); done
  sleep 5
}

# ---- every boot ----

adb_listening() {
  hex=$(printf '%04X' "$ADB_PORT")
  cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk -v p=":$hex" '$2 ~ p"$" && $4 == "0A" { f=1 } END { exit !f }'
}
adb_up() {
  settings put global adb_enabled 1
  [ "$(getprop service.adb.tcp.port)" = "$ADB_PORT" ] || setprop service.adb.tcp.port "$ADB_PORT"
  if ! adb_listening; then
    log "adb: restarting adbd on port $ADB_PORT"
    stop adbd; sleep 1; start adbd; sleep 3
  fi
  adb_listening && log "adb: listening on $ADB_PORT" || log "adb: NOT listening on $ADB_PORT"
}

wifi_ip() { ip -4 addr show wlan0 2>/dev/null | awk '/inet /{ sub("/.*", "", $2); print $2; exit }'; }
wifi_up() {
  [ -n "$WIFI_SSID" ] || { log "wifi: no WIFI_SSID in farm.conf, skipped"; return 0; }
  svc wifi enable 2>/dev/null
  i=0; while [ -z "$(wifi_ip)" ] && [ $i -lt 15 ]; do sleep 2; i=$((i+1)); done
  if [ -n "$(wifi_ip)" ]; then log "wifi: up, $(wifi_ip)"; return 0; fi
  if [ "$(getprop ro.build.version.sdk)" -lt 30 ]; then log "wifi: Android before 11 has no 'cmd wifi connect-network', join $WIFI_SSID by hand"; return 1; fi
  log "wifi: joining $WIFI_SSID ($WIFI_SECURITY)"
  if [ "$WIFI_SECURITY" = open ] || [ "$WIFI_SECURITY" = owe ]; then
    out=$(cmd wifi connect-network "$WIFI_SSID" "$WIFI_SECURITY" 2>&1)
  else
    out=$(cmd wifi connect-network "$WIFI_SSID" "$WIFI_SECURITY" "$WIFI_PASS" 2>&1)
  fi
  [ -n "$out" ] && log "wifi: $out"
  i=0; while [ -z "$(wifi_ip)" ] && [ $i -lt 30 ]; do sleep 2; i=$((i+1)); done
  if [ -n "$(wifi_ip)" ]; then log "wifi: up, $(wifi_ip)"; else log "wifi: not connected yet, trying again next boot"; return 1; fi
}

awake() {
  on "$STAY_AWAKE" || return 0
  settings put global stay_on_while_plugged_in 7
  settings put system screen_off_timeout 2147483647
}

# ---- until done ----

wizard_off() {
  on "$SKIP_SETUP_WIZARD" || return 0
  done_step wizard && return 0
  settings put global device_provisioned 1
  settings put secure user_setup_complete 1
  # a wizard that already started: turn it off (the phone counts as set up now, so the
  # launcher takes over); only ever these setup wizard packages
  for p in org.lineageos.setupwizard com.google.android.setupwizard com.android.provision com.sec.android.app.SecSetupWizard; do
    installed "$p" && pm disable "$p" >/dev/null 2>&1 && log "wizard: disabled $p"
  done
  # leave a wizard that is already on screen
  am start -a android.intent.action.MAIN -c android.intent.category.HOME >/dev/null 2>&1
  mark wizard
}

lock_off() {
  on "$DISABLE_LOCKSCREEN" || return 0
  done_step lockscreen && return 0
  locksettings set-disabled true >/dev/null 2>&1 && mark lockscreen || log "lockscreen: not disabled (the phone has a PIN?)"
}

dev_options() {
  on "$DEV_OPTIONS" || return 0
  done_step devoptions && return 0
  settings put global development_settings_enabled 1 && mark devoptions
}

installed() { pm path "$1" >/dev/null 2>&1; }
install_apps() {
  on "$INSTALL_APPS" || return 0
  # build.sh names them <order>-<package>.apk: 1-com.termux.apk, 2-com.termux.boot.apk, ...
  for f in "$MODDIR"/apks/*.apk; do
    [ -f "$f" ] || continue
    pkg=$(basename "$f" .apk); pkg=${pkg#*-}
    if installed "$pkg"; then continue; fi
    log "apps: installing $pkg"
    out=$(cat "$f" | pm install -r -S "$(wc -c < "$f")" 2>&1)
    case "$out" in
      *Success*) log "apps: $pkg installed" ;;
      *) # some ROMs refuse stdin installs: try from /data/local/tmp
         cp -f "$f" /data/local/tmp/farm-bootstrap.apk && chmod 644 /data/local/tmp/farm-bootstrap.apk
         out=$(pm install -r /data/local/tmp/farm-bootstrap.apk 2>&1); rm -f /data/local/tmp/farm-bootstrap.apk
         case "$out" in *Success*) log "apps: $pkg installed" ;; *) log "apps: $pkg FAILED: $out" ;; esac ;;
    esac
  done
}

screen_on() {
  input keyevent KEYCODE_WAKEUP 2>/dev/null
  wm dismiss-keyguard 2>/dev/null
}

termux_first_open() {
  installed com.termux || return 1
  [ -x "$T/usr/bin/sh" ] && return 0
  log "termux: opening once to install its base system"
  screen_on
  am start -n com.termux/.HomeActivity >/dev/null 2>&1
  i=0; while [ ! -x "$T/usr/bin/sh" ] && [ $i -lt 150 ]; do sleep 2; i=$((i+1)); done
  [ -x "$T/usr/bin/sh" ] && log "termux: base system installed" || { log "termux: base system not there after 5 min, next boot again"; return 1; }
}

boot_first_open() {
  installed com.termux.boot || return 1
  done_step bootapp && return 0
  screen_on
  am start -n com.termux.boot/.BootActivity >/dev/null 2>&1 && sleep 3 && mark bootapp
  # Termux back in front: the foreground app gets all cores
  am start -n com.termux/.HomeActivity >/dev/null 2>&1
}

grant() {   # uid what
  magisk --sqlite "REPLACE INTO policies (uid,policy,until,logging,notification) VALUES($1,2,0,1,0)" >/dev/null 2>&1 \
    && log "root: allowed forever for $2 (uid $1)" || { log "root: could not write the Magisk policy for $2"; return 1; }
}
root_grants() {
  if on "$ROOT_SHELL" && ! done_step rootshell; then grant 2000 'ADB shell' && mark rootshell; fi
  if on "$ROOT_TERMUX" && ! done_step roottermux && installed com.termux; then
    uid=$(stat -c %u "${T%/files}" 2>/dev/null)
    [ "${uid:-0}" -ge 10000 ] && grant "$uid" Termux && mark roottermux
  fi
}

battery() {
  on "$BATTERY_WHITELIST" || return 0
  for p in com.termux com.termux.boot com.termux.api; do
    installed "$p" && dumpsys deviceidle whitelist +"$p" >/dev/null 2>&1
  done
  return 0
}

boot_script() {
  done_step bootscript && return 0
  [ -d "$T/home" ] || return 1
  # already on the farm profile: its own boot script does all of this
  [ -f "$T/home/.termux/boot/verusproxy-setup" ] && { mark bootscript; return 0; }
  # the dashboard's "Apply profile" writes its own boot script; this one only keeps the phone
  # awake and SSH up until then, and removes itself once verusproxy-setup is there
  uid=$(stat -c %u "$T") || return 1
  [ "$uid" -ge 10000 ] || { log "termux: unexpected owner uid $uid of $T"; return 1; }
  ctx=$(ls -Zd "$T/home" | awk '{print $1}')
  mkdir -p "$T/home/.termux/boot"
  cp -f "$MODDIR/termux-boot/farm-bootstrap" "$T/home/.termux/boot/farm-bootstrap"
  chown "$uid:$uid" "$T/home/.termux" "$T/home/.termux/boot" "$T/home/.termux/boot/farm-bootstrap"
  chmod 700 "$T/home/.termux/boot" "$T/home/.termux/boot/farm-bootstrap"
  [ -n "$ctx" ] && chcon -R "$ctx" "$T/home/.termux" 2>/dev/null
  mark bootscript
}

ssh_keys() {   # the zip's ssh_keys into Termux's authorized_keys (added, never removed)
  [ -s "$MODDIR/ssh_keys" ] && [ -d "$T/home" ] || return 0
  done_step sshkeys && return 0
  uid=$(stat -c %u "$T") || return 1
  [ "$uid" -ge 10000 ] || return 1
  ctx=$(ls -Zd "$T/home" | awk '{print $1}')
  A=$T/home/.ssh/authorized_keys
  mkdir -p "$T/home/.ssh"; touch "$A"
  while IFS= read -r k; do [ -n "$k" ] && ! grep -qxF "$k" "$A" && echo "$k" >> "$A"; done < "$MODDIR/ssh_keys"
  chown -R "$uid:$uid" "$T/home/.ssh"; chmod 700 "$T/home/.ssh"; chmod 600 "$A"
  [ -n "$ctx" ] && chcon -R "$ctx" "$T/home/.ssh" 2>/dev/null
  mark sshkeys
}

status() {
  {
    echo "version=$(grep '^version=' "$MODDIR/module.prop" | cut -d= -f2)"
    echo "time=$(date +%s)"
    echo "serial=$(getprop ro.serialno)"
    echo "model=$(getprop ro.product.model)"
    echo "ip=$(wifi_ip)"
    echo "adb_port=$ADB_PORT"
    echo "proxy=$PROXY_HOST"
    echo "done=$([ -f "$STATE/done" ] && echo 1 || echo 0)"
    echo "steps=$(cd "$STATE" && ls ok.* 2>/dev/null | sed 's/^ok\.//' | tr '\n' ' ')"
    for p in com.termux com.termux.boot com.termux.api; do installed "$p" && echo "app=$p"; done
  } > "$STATE/status"
}

run() {
  log "---- farm bootstrap $(grep '^version=' "$MODDIR/module.prop" | cut -d= -f2), $(getprop ro.product.model) $(getprop ro.serialno)"
  adb_up
  awake
  wifi_up
  if [ ! -f "$STATE/done" ]; then
    wizard_off
    lock_off
    dev_options
    install_apps
    root_grants
    termux_first_open && boot_first_open
    root_grants      # Termux may have been installed just now
    battery
    boot_script
    ssh_keys
    all=1
    on "$INSTALL_APPS" && for f in "$MODDIR"/apks/*.apk; do
      [ -f "$f" ] || continue; p=$(basename "$f" .apk); installed "${p#*-}" || all=0
    done
    installed com.termux && { [ -x "$T/usr/bin/sh" ] || all=0; }
    installed com.termux.boot && { done_step bootapp || all=0; }
    on "$ROOT_SHELL" && { done_step rootshell || all=0; }
    on "$ROOT_TERMUX" && installed com.termux && { done_step roottermux || all=0; }
    installed com.termux && { done_step bootscript || all=0; }
    [ -s "$MODDIR/ssh_keys" ] && installed com.termux && { done_step sshkeys || all=0; }
    if [ $all = 1 ]; then touch "$STATE/done"; log "done: ready for the dashboard's Set up phone"; else log "not done yet, the rest runs next boot"; fi
  fi
  status
}

[ "$1" = status ] && { cat "$STATE/status" 2>/dev/null; exit 0; }

# one at a time (service.sh clears a lock left by a power cut before it starts this)
if ! mkdir "$STATE/lock" 2>/dev/null; then
  [ -n "$(find "$STATE/lock" -maxdepth 0 -mmin +20 2>/dev/null)" ] && rm -rf "$STATE/lock" && mkdir "$STATE/lock" || { echo "already running"; exit 0; }
fi
trap 'rm -rf "$STATE/lock"' EXIT

case "$1" in
  boot) wait_boot; run ;;
  run) run; cat "$STATE/status" ;;
  *) echo "usage: $0 boot|run|status"; exit 1 ;;
esac
