# body of ~/.termux/boot/verusproxy-setup; lib/farm_boot.js puts the settings above it
VP="$HOME/.verusproxy"; LOG="$VP/boot.log"; LOCK="$VP/boot.lock"
mkdir -p "$VP"
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

# Termux:Boot waits for its scripts: carry on detached
# ("loop": only the watchdog, used when "Apply profile" replaces a running copy)
MODE=${1:-}
if [ "$MODE" != run ] && [ "$MODE" != loop-run ]; then
  [ "$MODE" = loop ] && next=loop-run || next=run
  if command -v setsid >/dev/null 2>&1; then setsid nohup sh "$0" $next >/dev/null 2>&1 < /dev/null &
  else nohup sh "$0" $next >/dev/null 2>&1 < /dev/null & fi
  exit 0
fi

[ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 262144 ] && mv -f "$LOG" "$LOG.1"

# one instance only (a stale lock from a crash or reboot is taken over)
if ! mkdir "$LOCK" 2>/dev/null; then
  old=$(cat "$LOCK/pid" 2>/dev/null)
  # (the crontab backup asks every 5 minutes: stay quiet then)
  if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then [ "$MODE" = run ] && log "already running (pid $old), not starting twice"; exit 0; fi
  rm -rf "$LOCK"; mkdir "$LOCK" || { log "cannot take $LOCK"; exit 1; }
fi
echo $$ > "$LOCK/pid"
# remove the lock only while it is still ours (a replacement may hold it already)
trap '[ "$(cat "$LOCK/pid" 2>/dev/null)" = "$$" ] && rm -rf "$LOCK"' EXIT
trap 'exit 0' INT TERM
log "start ($MODE): profile $STAMP, miner $MINER_ENV"
asroot() { if su -c "$1" >/dev/null 2>&1; then log "root: $1"; else log "root FAILED: $1"; fi; }
if [ "$MODE" = run ]; then

command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock && log "wake lock taken"
# Termux's profile starts termux-services (sshd, crond) where they are set up
[ -f "$PREFIX/etc/profile" ] && . "$PREFIX/etc/profile" >/dev/null 2>&1
sleep 2
if pgrep -x sshd >/dev/null 2>&1; then log "sshd already running"
elif command -v sshd >/dev/null 2>&1; then sshd && log "sshd started" || log "sshd FAILED"
else log "sshd not installed (pkg install openssh)"; fi

asroot "settings put global adb_enabled 1"
[ -n "$ADB_PORT" ] && asroot "setprop service.adb.tcp.port $ADB_PORT; stop adbd; start adbd"
case "$BATTERY_SPOOF" in
  1) asroot "dumpsys battery unplug; dumpsys battery set status 4; dumpsys battery set level 100" ;;
  0) asroot "dumpsys battery reset" ;;
esac
[ -n "$CPUSET" ] && asroot "echo $CPUSET > /dev/cpuset/foreground/cpus"
[ "$KEEP_FRONT" = 1 ] && asroot "settings put system screen_off_timeout $SCREEN_TIMEOUT_MS"

# UserLAnd miners: what start-kluster.sh did at boot (the kluster cron job keeps it up afterwards)
if [ "$MINER_ENV" = userland ] && [ -f "$HOME/kluster/update-UserLAnd.sh" ]; then
  log "starting UserLAnd and its miner (kluster/update-UserLAnd.sh)"
  bash "$HOME/kluster/update-UserLAnd.sh" >/dev/null 2>&1 || log "update-UserLAnd.sh exited $?"
fi

if [ "$AGENT" = 1 ] && [ -f "$HOME/verus-agent.sh" ] && [ -n "$PROXY_URL" ]; then
  if pgrep -f verus-agent.sh >/dev/null 2>&1; then log "agent already running"
  else nohup bash "$HOME/verus-agent.sh" "$PROXY_URL" >/dev/null 2>&1 < /dev/null & log "agent started ($PROXY_URL)"; fi
fi

fi   # end of boot-only steps

# Termux's pgrep names processes by their full path: match the command line instead
miner_running() { pgrep -f "^$MINER_BIN( |\$)" >/dev/null 2>&1; }
ME=$(id -un)
start_miner() {
  # Termux can't see other apps' processes: ask root whether a miner already runs elsewhere (UserLAnd)
  other=$(su -c "ps -A -o USER,NAME" 2>/dev/null | awk -v me="$ME" '$1 != me && $2 ~ /^ccminer/' | grep -c .)
  if [ "${other:-0}" -gt 0 ]; then log "a miner already runs outside Termux ($other), not starting a second one"; return 0; fi
  screen -wipe >/dev/null 2>&1
  screen -dmS ccminer sh -c "exec $MINER_BIN $MINER_ARGS" && log "ccminer started in screen ccminer" || log "ccminer start FAILED"
}

# from keep-alive.sh: screen on and unlocked, Termux in front, so Android runs it on all cores at full speed
FRONT='S=$(dumpsys nfc 2>/dev/null | sed -n "s/.*mScreenState=//p" | head -n 1)
case "$S" in OFF_*) input keyevent 26; sleep 1; S=$(dumpsys nfc 2>/dev/null | sed -n "s/.*mScreenState=//p" | head -n 1); echo woke;; esac
[ "$S" = ON_LOCKED ] && { input keyevent 82; sleep 1; echo unlocked; }
F=$(dumpsys window 2>/dev/null | grep -m 1 mCurrentFocus)
case "$F" in *com.termux/*) ;; *) am start -n com.termux/com.termux.HomeActivity >/dev/null 2>&1; echo "brought Termux to the front";; esac'
keep_front() {
  [ "$KEEP_FRONT" = 1 ] || return 0
  out=$(su -c "$FRONT" 2>/dev/null)
  [ -n "$out" ] && log "keep in front: $(echo $out)"
}

fails=0; started=0; missing=0; n=0
while :; do
  [ $((n % 3)) = 0 ] && keep_front
  n=$((n + 1))
  if [ "$MINER_ENV" = termux ]; then
    if miner_running; then
      missing=0
      [ $fails -gt 0 ] && [ $(( $(date +%s) - started )) -gt 300 ] && { fails=0; log "ccminer stable for 5 min, backoff reset"; }
    elif [ ! -x "$MINER_BIN" ]; then
      [ $missing = 0 ] && log "no miner at $MINER_BIN, not starting"; missing=1
    else
      # died within 5 minutes of its last start: back off 10 s, 30 s, then 120 s
      if [ $started -gt 0 ] && [ $(( $(date +%s) - started )) -lt 300 ]; then fails=$((fails + 1)); else fails=0; fi
      if [ $fails -gt 0 ]; then
        d=10; [ $fails -ge 2 ] && d=30; [ $fails -ge 3 ] && d=120
        log "ccminer not running (quick exit #$fails), waiting $d s"; sleep $d & wait $!
      else log "ccminer not running"; fi
      miner_running || { start_miner; started=$(date +%s); }
    fi
  fi
  # Android may reset the cpuset; it can be read without root
  if [ -n "$CPUSET" ]; then
    cur=$(cat /dev/cpuset/foreground/cpus 2>/dev/null)
    [ -n "$cur" ] && [ "$cur" != "$CPUSET" ] && { log "cpuset was $cur"; asroot "echo $CPUSET > /dev/cpuset/foreground/cpus"; }
  fi
  sleep 60 & wait $!
done
