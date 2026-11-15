LOG="$VP/build.log"; ST="$VP/build.status"
status() {
  { echo "state=$1"; echo "phase=$2"; echo "msg=$3"; echo "t=$(date +%s)"; echo "started=$START"; echo "branch=$BRANCH"
    if [ -n "${COMMIT:-}" ]; then echo "commit=$COMMIT"; fi
    if [ -n "${4:-}" ]; then printf '%s\n' "$4"; fi; } > "$ST.tmp"
  mv -f "$ST.tmp" "$ST"
}
START=$(date +%s); COMMIT=""
if [ -f "$VP/build.pid" ] && kill -0 "$(cat "$VP/build.pid")" 2>/dev/null; then exit 3; fi
echo $$ > "$VP/build.pid"
: > "$LOG"
STOPPED=0
finish() {
  # mining was paused for the build and is not running again yet: start it
  if [ "$STOPPED" = 1 ] && ! find_miner; then start_miner >> "$LOG" 2>&1; fi
  rm -f "$VP/build.pid"
}
trap finish EXIT
trap 'status failed stopped "Build stopped"; exit 1' INT TERM HUP
istermux=0; case "${PREFIX:-}" in */com.termux/*) istermux=1;; esac
SUDO=""; [ "$(id -u)" != 0 ] && command -v sudo >/dev/null 2>&1 && SUDO=sudo
status running source "Getting the source"
if ! command -v git >/dev/null 2>&1 || ! command -v bash >/dev/null 2>&1; then
  if [ "$istermux" = 1 ]; then pkg install -y git bash >> "$LOG" 2>&1; else $SUDO apt-get install -y git bash >> "$LOG" 2>&1; fi
fi
command -v git >/dev/null 2>&1 || { status failed source "git is not installed and could not be installed"; exit 1; }
SRC="$VP/ccminer-src"
{
  if [ -d "$SRC/.git" ]; then
    git -C "$SRC" remote set-url origin "$REPO" && git -C "$SRC" fetch -q --depth 1 origin "$BRANCH" && git -C "$SRC" checkout -q -B "$BRANCH" FETCH_HEAD && git -C "$SRC" reset -q --hard FETCH_HEAD
  else
    rm -rf "$SRC"; git clone -q --depth 1 -b "$BRANCH" "$REPO" "$SRC"
  fi
} >> "$LOG" 2>&1 || { status failed source "Could not get $BRANCH from $REPO (network?)"; exit 1; }
COMMIT=$(git -C "$SRC" rev-parse HEAD)
echo "commit $COMMIT" >> "$LOG"
[ -f "$SRC/build-verus.sh" ] || { status failed source "This branch has no build-verus.sh"; exit 1; }
if [ "$STOPMINING" = 1 ] && find_miner; then
  save_miner_state; stop_miner "$M_PID"; STOPPED=1; echo "mining paused for the build" >> "$LOG"
fi
status running build "Building (installs build tools the first time)"
rm -f "$SRC/ccminer-verus"
VERUS_WORK="$VP/build-work" bash "$SRC/build-verus.sh" >> "$LOG" 2>&1
if [ ! -x "$SRC/ccminer-verus" ]; then
  status failed build "Build failed: $(grep -v '^ *$' "$LOG" | tail -n 2 | tr '\n' ' ' | cut -c1-200)"; exit 1
fi
s=$(shaof "$SRC/ccminer-verus")
{ echo "commit=$COMMIT"; echo "branch=$BRANCH"; echo "repo=$REPO"; echo "built=$(date +%s)"; echo "on=this phone"; } > "$VP/builds/$s.info"
cp "$SRC/ccminer-verus" "$VP/built.bin"
status running install "Installing"
[ "$STOPPED" = 1 ] && KEEP_PID=1
res=$(install_binary "$VP/built.bin" 2>&1); rc=$?
printf '%s\n' "$res" >> "$LOG"
r=$(printf '%s\n' "$res" | sed -n 's/^result=//p' | tail -n 1); m=$(printf '%s\n' "$res" | sed -n 's/^msg=//p' | tail -n 1)
if [ "$rc" = 0 ]; then status done "$r" "${m:-Built and installed}" "sha=$s"; else status failed "${r:-install}" "${m:-Install failed}" "sha=$s"; fi
