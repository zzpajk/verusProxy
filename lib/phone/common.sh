VP="$HOME/.verusproxy"; mkdir -p "$VP/builds"
MATCH="${MATCH:-ccminer}"
expand() { case "$1" in "~/"*) echo "$HOME/${1#\~/}";; "~") echo "$HOME";; *) echo "$1";; esac; }
shaof() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }
# the running miner: a process whose program (or first argument) has $MATCH in its name
find_miner() {
  M_PID=""; M_EXE=""; M_CWD=""
  for p in /proc/[0-9]*; do
    pid=${p#/proc/}
    [ "$pid" = "$$" ] && continue
    exe=$(readlink "$p/exe" 2>/dev/null) || continue
    exe=${exe% (deleted)}
    a0=$(tr '\0' '\n' < "$p/cmdline" 2>/dev/null | head -n 1)
    case "${exe##*/}" in *"$MATCH"*) ;; *)
      case "${a0##*/}" in *"$MATCH"*) ;; *) continue;; esac
      # program is an interpreter or wrapper (e.g. proot): resolve the first argument instead
      case "$a0" in /*) exe=$a0;; */*) exe="$(readlink "$p/cwd")/${a0#./}";; *) exe=$(command -v "$a0" 2>/dev/null || echo "$a0");; esac;;
    esac
    case "$a0" in *vp-*.sh) continue;; esac
    M_PID=$pid; M_EXE=$exe; M_CWD=$(readlink "$p/cwd" 2>/dev/null); return 0
  done
  return 1
}
# screen session the process runs in (empty if none)
screen_of() {
  p=$1; i=0
  while [ "$i" -lt 10 ] && [ -n "$p" ] && [ "$p" != 1 ] && [ "$p" != 0 ]; do
    case "$(cat /proc/$p/comm 2>/dev/null)" in
      screen*|SCREEN*) command -v screen >/dev/null 2>&1 && screen -ls 2>/dev/null | tr -d '\t' | sed -n "s/^ *$p\.\([^ (]*\).*/\1/p" | head -n 1; return 0;;
    esac
    p=$(sed 's/^.*) //' /proc/$p/stat 2>/dev/null | cut -d' ' -f2)
    i=$((i+1))
  done
}
# remember how the miner runs, so it can be started again the same way
save_miner_state() {
  tr '\0' '\n' < /proc/$M_PID/cmdline > "$VP/miner.cmd" 2>/dev/null
  echo "$M_CWD" > "$VP/miner.cwd"; echo "$M_EXE" > "$VP/miner.exe"
  screen_of "$M_PID" > "$VP/miner.screen"
}
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
saved_cmd() { c=""; while IFS= read -r a || [ -n "$a" ]; do c="$c $(quote "$a")"; done < "$VP/miner.cmd"; echo "$c"; }
stop_miner() {
  kill "$1" 2>/dev/null; i=0
  while kill -0 "$1" 2>/dev/null && [ "$i" -lt 30 ]; do sleep 0.5; i=$((i+1)); done
  kill -9 "$1" 2>/dev/null; sleep 0.5
}
start_miner() {
  [ -s "$VP/miner.cmd" ] || return 1
  cwd=$(cat "$VP/miner.cwd" 2>/dev/null); [ -d "$cwd" ] || cwd=$HOME
  cmd=$(saved_cmd); scr=$(cat "$VP/miner.screen" 2>/dev/null)
  cd "$cwd" 2>/dev/null || cd "$HOME"
  if [ -n "$scr" ] && command -v screen >/dev/null 2>&1; then
    screen -S "$scr" -X quit >/dev/null 2>&1; screen -wipe >/dev/null 2>&1
    screen -dmS "$scr" sh -c "exec $cmd" >/dev/null 2>&1 < /dev/null
    echo "how=in screen session $scr"
  else
    nohup sh -c "exec $cmd" >> "$VP/miner.log" 2>&1 < /dev/null &
    echo "how=in the background (output in ~/.verusproxy/miner.log)"
  fi
  cd "$HOME"
}
# after a start: is it still running after a while?
check_up() { sleep "$1"; find_miner; }
# install file $1 as the miner (checks it runs here, keeps the old one as <name>.old, restarts if it was running)
install_binary() {
  new=$1
  chmod 755 "$new" 2>/dev/null
  out=$("$new" -V 2>&1); rc=$?
  if [ "$rc" -ne 0 ] || ! printf '%s' "$out" | grep -qi ccminer; then
    echo "result=failed"; echo "msg=The new miner does not run on this phone: $(printf '%s' "$out" | head -n 3 | tr '\n' ' ' | cut -c1-240)"; return 1
  fi
  echo "newversion=$(printf '%s' "$out" | head -n 1)"
  running=0
  if [ -n "${KEEP_PID:-}" ]; then running=2
  elif find_miner; then running=1; save_miner_state; fi
  if [ "$running" = 1 ]; then target=$M_EXE; else target=$(cat "$VP/miner.exe" 2>/dev/null); [ -n "$target" ] || target=$(expand "$HINT"); fi
  echo "target=$target"
  mkdir -p "$(dirname "$target")" || { echo "result=failed"; echo "msg=Cannot create $(dirname "$target")"; return 1; }
  sn=$(shaof "$new")
  if [ -f "$target" ] && [ "$(shaof "$target")" = "$sn" ]; then
    echo "result=same"; echo "msg=This miner is already installed"
    [ "$running" = 2 ] && { start_miner; check_up 5 >/dev/null; }
    return 0
  fi
  rm -f "$target.vpprev"; [ -f "$target.old" ] && cp -p "$target.old" "$target.vpprev"
  [ -f "$target" ] && cp -p "$target" "$target.old"
  if ! { cp "$new" "$target.vpnew" && chmod 755 "$target.vpnew" && mv -f "$target.vpnew" "$target"; }; then
    rm -f "$target.vpnew"; echo "result=failed"; echo "msg=Could not write $target"; [ "$running" = 2 ] && start_miner; return 1
  fi
  if [ "$running" = 0 ] || { [ "$running" = 1 ] && [ "$RESTART" != 1 ]; }; then
    rm -f "$target.vpprev"
    echo "result=installed"; [ "$running" = 1 ] && echo "msg=Installed; the miner keeps running the old version until it restarts" || echo "msg=Installed (the miner was not running)"
    return 0
  fi
  [ "$running" = 1 ] && stop_miner "$M_PID"
  logl=$(cat "$VP/miner.log" 2>/dev/null | wc -l)
  start_miner
  if check_up 12; then rm -f "$target.vpprev"; echo "result=restarted"; echo "pid=$M_PID"; return 0; fi
  why=$(tail -n +$((logl + 1)) "$VP/miner.log" 2>/dev/null | grep -v '^ *$' | tail -n 3 | tr '\n' ' ' | cut -c1-200)
  # the new miner did not stay up: put the old one back (and the backup from before)
  if [ -f "$target.old" ]; then
    cp "$target.old" "$target.vpnew" && mv -f "$target.vpnew" "$target"
    if [ -f "$target.vpprev" ]; then mv -f "$target.vpprev" "$target.old"; else rm -f "$target.old"; fi
    start_miner >/dev/null; check_up 6 >/dev/null
    echo "result=rolledback"; echo "msg=The new miner stopped within 12 s, so the previous one was put back. ${why}"
  else
    echo "result=failed"; echo "msg=The new miner stopped within 12 s (no previous version to go back to). ${why}"
  fi
  return 1
}
