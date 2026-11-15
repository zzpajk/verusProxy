if [ -f "$VP/build.status" ]; then cat "$VP/build.status"; else echo "state=none"; fi
if [ -f "$VP/build.pid" ] && kill -0 "$(cat "$VP/build.pid")" 2>/dev/null; then echo "alive=1"; else echo "alive=0"; fi
echo "logtail=$(grep -v '^ *$' "$VP/build.log" 2>/dev/null | grep -v '^  *C' | tail -n 1 | cut -c1-200)"
