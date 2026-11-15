running=0
if find_miner; then running=1; save_miner_state; target=$M_EXE; else target=$(cat "$VP/miner.exe" 2>/dev/null); [ -n "$target" ] || target=$(expand "$HINT"); fi
[ -f "$target.old" ] || { echo "result=failed"; echo "msg=No previous version kept next to $target"; exit 1; }
cp -p "$target" "$target.vptmp" && cp "$target.old" "$target.vpnew" && chmod 755 "$target.vpnew" && mv -f "$target.vpnew" "$target" && mv -f "$target.vptmp" "$target.old" \
  || { echo "result=failed"; echo "msg=Could not swap the files"; exit 1; }
echo "target=$target"
if [ "$running" = 1 ] && [ "$RESTART" = 1 ]; then
  stop_miner "$M_PID"; start_miner
  if check_up 10; then echo "result=restarted"; echo "msg=Back on the previous version"; else echo "result=failed"; echo "msg=Swapped back, but the miner did not stay up"; exit 1; fi
else
  echo "result=installed"; echo "msg=Previous version put back"
fi
