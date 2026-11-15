env=other; case "${PREFIX:-}" in */com.termux/*) env=termux;; esac
[ "$env" = other ] && [ -f /etc/os-release ] && env="linux:$(. /etc/os-release; echo "$ID")"
echo "env=$env"; echo "arch=$(uname -m)"
if find_miner; then
  echo "running=1"; echo "pid=$M_PID"; echo "exe=$M_EXE"; echo "cwd=$M_CWD"
  echo "screen=$(screen_of "$M_PID")"
  echo "started=$(stat -c %Y /proc/$M_PID 2>/dev/null)"
  echo "cmd=$(tr '\0' ' ' < /proc/$M_PID/cmdline | cut -c1-400)"
  bin=$M_EXE
else
  echo "running=0"
  bin=$(cat "$VP/miner.exe" 2>/dev/null); [ -n "$bin" ] && [ -f "$bin" ] || bin=$(expand "$HINT")
fi
if [ -f "$bin" ]; then
  s=$(shaof "$bin"); echo "path=$bin"; echo "sha=$s"; echo "size=$(wc -c < "$bin" | tr -d ' ')"; echo "mtime=$(stat -c %Y "$bin")"
  echo "variant=$(grep -aoE 'baseline(\+[a-z0-9]+)+' "$bin" 2>/dev/null | head -n 1)"
  [ -f "$VP/builds/$s.info" ] && sed 's/^/build_/' "$VP/builds/$s.info"
  [ -f "$bin.old" ] && echo "old=$(shaof "$bin.old")"
else
  echo "path=$bin"; echo "sha="
fi
if [ -f "$VP/build.status" ]; then sed 's/^/b_/' "$VP/build.status"; fi
[ -d "$VP/ccminer-src/.git" ] && echo "srccommit=$(git -C "$VP/ccminer-src" rev-parse HEAD 2>/dev/null)"
echo "info_done=1"
