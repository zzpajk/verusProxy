# body of ~/.termux/boot/verusproxy-setup; lib/farm_boot.js puts the settings above it
# fixed path: the status LED part runs as root, where $HOME is not Termux's
TH=/data/data/com.termux/files/home
VP="$TH/.verusproxy"; LOG="$VP/boot.log"; LOCK="$VP/boot.lock"
mkdir -p "$VP"
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

# ---- status LED and "find me" (runs as root, started by the watchdog: sh <this script> led-run) ----
# Settings come from ~/.verusproxy/led.conf, written by the proxy: LED, TARGET_KHS, OK_PCT, SLOW_PCT,
# COLOR_OK/COLOR_BAD/COLOR_FIND (RRGGBB), FINDME_UNTIL (epoch), FIND_TORCH/FIND_VIBRATE/FIND_SOUND.
# (LED writing as in the fork's tools/phone-led.sh: Samsung sec interface, else per-colour LEDs)
led() { # RRGGBB on_ms off_ms  (off_ms 0 = steady)
  if [ -e /sys/class/sec/led/led_blink ]; then
    echo 0 > /sys/class/sec/led/led_pattern 2>/dev/null      # clears the charging/battery pattern
    echo "0x$1 $2 $3" > /sys/class/sec/led/led_blink 2>/dev/null; return
  fi
  rgb=$1; on=$2; off=$3
  r=$((0x${rgb%????})); g=$((0x$(echo "$rgb" | cut -c3-4))); b=$((0x${rgb#????}))
  for names in "red green blue" "led_r led_g led_b" "R G B"; do
    set -- $names
    [ -e "/sys/class/leds/$1/brightness" ] || continue
    for x in "$1:$r" "$2:$g" "$3:$b"; do
      d=/sys/class/leds/${x%%:*}; v=${x#*:}
      echo 0 > "$d/blink" 2>/dev/null
      echo "$v" > "$d/brightness" 2>/dev/null
      [ "$off" -gt 0 ] && [ "$v" -gt 0 ] && { echo "$on" > "$d/delay_on"; echo "$off" > "$d/delay_off"; echo 1 > "$d/blink"; } 2>/dev/null
    done
    return
  done
}
torch() { # 1 = on, 0 = off
  for t in /sys/class/leds/torch-sec1 /sys/class/leds/torch-light0 /sys/class/leds/flashlight; do
    [ -e "$t/brightness" ] && { [ "$1" = 1 ] && cat "$t/max_brightness" > "$t/brightness" || echo 0 > "$t/brightness"; return; }
  done
  [ -e /sys/class/camera/flash/rear_torch_flash ] && echo "$1" > /sys/class/camera/flash/rear_torch_flash
}
buzz() {
  if [ -e /sys/class/timed_output/vibrator/enable ]; then echo 600 > /sys/class/timed_output/vibrator/enable
  else cmd vibrator vibrate 600 >/dev/null 2>&1; fi
}
beep() { # loud, through Termux:API as Termux's user: a ringtone and "here I am"
  for st in 3 4 5; do media volume --stream $st --set 15 >/dev/null 2>&1 || cmd media_session volume --stream $st --set 15 >/dev/null 2>&1; done
  f=$(ls /system/media/audio/ringtones/*.ogg /product/media/audio/ringtones/*.ogg /system/product/media/audio/alarms/*.ogg /product/media/audio/alarms/*.ogg 2>/dev/null | head -n 1)
  TU=$(stat -c %u /data/data/com.termux); TP=/data/data/com.termux/files/usr/bin
  [ -n "$f" ] && [ -x $TP/termux-media-player ] && su "$TU" -c "PATH=$TP:\$PATH timeout 8 termux-media-player play $f" >/dev/null 2>&1
  [ -x $TP/termux-tts-speak ] && su "$TU" -c "PATH=$TP:\$PATH timeout 8 termux-tts-speak -s ALARM 'Here I am. Here I am.'" >/dev/null 2>&1 &
}
led_main() {
  L="$VP/led.lock"
  if ! mkdir "$L" 2>/dev/null; then old=$(cat "$L/pid" 2>/dev/null); [ -n "$old" ] && kill -0 "$old" 2>/dev/null && exit 0; rm -rf "$L"; mkdir "$L" || exit 1; fi
  echo $$ > "$L/pid"; chmod 755 "$L"; chmod 644 "$L/pid"
  trap '[ "$(cat "$L/pid" 2>/dev/null)" = "$$" ] && rm -rf "$L"' EXIT
  trap 'exit 0' INT TERM
  last=""; n=0
  while :; do
    LED=0; TARGET_KHS=0; OK_PCT=90; SLOW_PCT=70; COLOR_OK=0000FF; COLOR_BAD=FF3000; COLOR_FIND=FF00FF; FINDME_UNTIL=0; FIND_TORCH=0; FIND_VIBRATE=0; FIND_SOUND=0
    [ -f "$VP/led.conf" ] && . "$VP/led.conf"
    now=$(date +%s); khs=""
    if [ "$FINDME_UNTIL" -gt "$now" ]; then state=find
    elif [ "$LED" != 1 ]; then state=off
    elif [ -f "$VP/miner.paused" ]; then state=bench
    else
      sm=$(echo summary | nc -w 3 127.0.0.1 4068 2>/dev/null | tr ';' '\n')
      khs=$(echo "$sm" | sed -n 's/^KHS=\([0-9]*\).*/\1/p'); up=$(echo "$sm" | sed -n 's/^UPTIME=\([0-9]*\).*/\1/p')
      # this ccminer reports 0 in its summary until the first share: add up the threads that report instead
      if [ -n "$sm" ] && [ "${khs:-0}" = 0 ]; then
        t=$(echo threads | nc -w 3 127.0.0.1 4068 2>/dev/null | tr '|;' '\n\n' | sed -n 's/^KHS=\([0-9]*\).*/\1/p' | awk '{s += $1} END {print s + 0}')
        [ "${t:-0}" -gt 0 ] && khs=$t
      fi
      if [ -n "$sm" ] && [ "${khs:-0}" = 0 ] && [ "${up:-9999}" -lt 900 ]; then state=slow      # still starting
      elif [ -z "$khs" ] || [ "$khs" = 0 ]; then state=bad
      elif [ "$TARGET_KHS" -le 0 ]; then state=ok
      else pct=$((khs * 100 / TARGET_KHS)); if [ $pct -ge "$OK_PCT" ]; then state=ok; elif [ $pct -ge "$SLOW_PCT" ]; then state=slow; else state=bad; fi; fi
    fi
    # re-written every round: Android's battery and notification light can take the LED over
    case $state in
      ok) led "$COLOR_OK" 1000 0 ;;
      slow) led "$COLOR_OK" 1000 1500 ;;
      bad) led "$COLOR_BAD" 1000 0 ;;
      bench) led 00FFFF 1000 1000 ;;      # cyan blink: a benchmark job has the CPU
      find) if [ "$COLOR_FIND" = CYCLE ]; then set -- FF0000 00FF00 0000FF FFFFFF FF00FF 00FFFF; shift $((n % 6)); led "$1" 300 300; else led "$COLOR_FIND" 300 300; fi ;;
      off) [ "$last" != off ] && led 000000 0 0 ;;
    esac
    [ "$state" != "$last" ] && log "led: $state${khs:+ ($khs of $TARGET_KHS kH/s)}"
    echo "$state ${khs:-0} $now" > "$VP/led.state"
    last=$state
    if [ $state = find ]; then
      [ "$FIND_TORCH" = 1 ] && { torch 1; sleep 1; torch 0; }
      [ "$FIND_VIBRATE" = 1 ] && buzz
      [ "$FIND_SOUND" = 1 ] && [ $((n % 3)) = 0 ] && beep
      n=$((n + 1)); sleep 4
    else
      n=0; sleep 30
    fi
  done
}

# Termux:Boot waits for its scripts: carry on detached
# ("loop": only the watchdog, used when "Apply profile" replaces a running copy)
MODE=${1:-}
[ "$MODE" = led-run ] && { led_main; exit 0; }
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
# WAKEUP (224) never turns the screen off, unlike POWER; dismiss-keyguard opens a swipe lock screen
case "$S" in OFF_*) input keyevent 224; sleep 1; S=$(dumpsys nfc 2>/dev/null | sed -n "s/.*mScreenState=//p" | head -n 1); echo woke;; esac
[ "$S" = ON_LOCKED ] && { wm dismiss-keyguard 2>/dev/null || input keyevent 82; sleep 1; echo unlocked; }
F=$(dumpsys window 2>/dev/null | grep -m 1 mCurrentFocus)
case "$F" in *com.termux/*) ;; *) am start -n com.termux/com.termux.HomeActivity >/dev/null 2>&1; echo "brought Termux to the front";; esac'
keep_front() {
  [ "$KEEP_FRONT" = 1 ] || return 0
  out=$(su -c "$FRONT" 2>/dev/null)
  [ -n "$out" ] && log "keep in front: $(echo $out)"
}

# the status LED loop runs as root; its own lock keeps it to one copy
led_up() { [ "$STATUS_LED" = 1 ] || return 0; su -c "nohup sh $0 led-run >/dev/null 2>&1 < /dev/null &" >/dev/null 2>&1; }

# benchmark job runner (verus-phone-jobs): started with the watchdog; while one of its jobs runs a
# miner of its own (scripts and work directories under ~/verus-runs) the normal miner is stopped
runner_up() {
  # (not before its jobs repo is cloned: without it the runner only fails and leaves an empty folder)
  [ "$RUNNER" = 1 ] && [ -f "$TH/.verus-runner.conf" ] && [ -f "$TH/phone-runner.sh" ] && [ -d "$TH/verus-phone-jobs/.git" ] || return 0
  bash "$TH/phone-runner.sh" status 2>/dev/null | grep -q '^running' && return 0
  bash "$TH/phone-runner.sh" start >/dev/null 2>&1 && log "benchmark runner started"
}
job_running() { pgrep -f "$TH/verus-runs/(scripts|work-)" >/dev/null 2>&1; }
paused=0

fails=0; started=0; missing=0; n=0
while :; do
  [ $((n % 3)) = 0 ] && keep_front
  [ $((n % 5)) = 0 ] && led_up
  [ $((n % 5)) = 0 ] && runner_up
  if [ "$MINER_ENV" = termux ] && job_running; then
    if [ $paused = 0 ]; then paused=1; : > "$VP/miner.paused"; log "benchmark job running: miner paused"; fi
    miner_running && pkill -f "^$MINER_BIN( |\$)" && log "stopped the miner for the benchmark job"
    n=$((n + 1)); sleep 60 & wait $!; continue
  elif [ $paused = 1 ]; then paused=0; rm -f "$VP/miner.paused"; started=0; fails=0; log "benchmark job finished: miner resumes"
  fi
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
