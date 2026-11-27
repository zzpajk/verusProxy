#!/usr/bin/env bash
# Runs farm-bootstrap.sh on a computer with Android's commands replaced by stubs that log their
# arguments: checks the order of steps and that a second run skips what already worked.
#   bash bootstrap/test/stub-run.sh            (SH=mksh or SH=busybox\ sh to pick the shell)
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
mkdir -p "$W/bin" "$W/state" "$W/mod/apks" "$W/mod/termux-boot" "$W/termux/files"
cp "$HERE/../module/farm-bootstrap.sh" "$HERE/../module/module.prop" "$W/mod/"
cp "$HERE/../module/termux-boot/farm-bootstrap" "$W/mod/termux-boot/"
echo fake > "$W/mod/apks/1-com.termux.apk"; echo fake > "$W/mod/apks/2-com.termux.boot.apk"
echo "ssh-ed25519 AAAAFAKE box" > "$W/mod/ssh_keys"
cat > "$W/mod/farm.conf" <<'C'
WIFI_SSID='Farm Net'
WIFI_PASS='it'\''s secret'
C
CALLS=$W/calls; export CALLS W
stub() { printf '#!/usr/bin/env bash\necho "%s $*" >> "$CALLS"\n%s\n' "$1" "${2:-}" > "$W/bin/$1"; chmod +x "$W/bin/$1"; }
stub getprop 'case "$1" in sys.boot_completed) echo 1;; ro.build.version.sdk) echo 30;; ro.serialno) echo ce0117123456;; ro.product.model) echo SM-G950F;; *) echo;; esac'
stub pm 'if [ "$1" = path ]; then [ "$2" = android ] && exit 0; [ -f "$W/installed.$2" ] && exit 0; exit 1; fi
if [ "$1" = install ]; then cat > /dev/null; n=$(ls "$W"/installed.* 2>/dev/null | wc -l); [ $n = 0 ] && touch "$W/installed.com.termux" || touch "$W/installed.com.termux.boot"; echo Success; fi'
stub am 'case "$*" in *com.termux/.HomeActivity*) mkdir -p "$W/termux/files/usr/bin" "$W/termux/files/home"; printf "#!/bin/sh\n" > "$W/termux/files/usr/bin/sh"; chmod +x "$W/termux/files/usr/bin/sh";; esac'
stub cmd 'mkdir -p "$W/wifi"'
stub ip '[ -d "$W/wifi" ] && echo "    inet 192.168.1.77/24 brd 192.168.1.255 scope global wlan0"; true'
stub stat 'echo 10154'
for c in settings setprop stop start svc input wm locksettings dumpsys magisk chcon chown; do stub $c; done
# toybox `ls -Zd`
stub ls 'if [ "$1" = -Zd ]; then echo "u:object_r:app_data_file:s0:c154 $2"; else /bin/ls "$@"; fi'
stub sleep
run() { PATH="$W/bin:$PATH" FARM_STATE="$W/state" FARM_TERMUX="$W/termux/files" ${SH:-sh} "$W/mod/farm-bootstrap.sh" run; }

echo "== first run"; run
fail=0
check() { if grep -q -- "$1" "$CALLS"; then echo "ok   $2"; else echo "FAIL $2"; fail=1; fi; }
check "cmd wifi connect-network Farm Net wpa2 it's secret" "WiFi joined with a quoted password"
check "setprop service.adb.tcp.port 5555" "ADB port set"
check "settings put global device_provisioned 1" "setup wizard off"
check "VALUES(2000,2,0,1,0)" "root for ADB shell"
check "am start -n com.termux.boot/.BootActivity" "Termux:Boot opened"
[ -f "$W/termux/files/home/.termux/boot/farm-bootstrap" ] && echo "ok   boot script written" || { echo "FAIL boot script"; fail=1; }
grep -q "AAAAFAKE" "$W/termux/files/home/.ssh/authorized_keys" 2>/dev/null && echo "ok   SSH key added" || { echo "FAIL SSH key"; fail=1; }
[ -f "$W/state/done" ] && echo "ok   done" || { echo "FAIL not done"; cat "$W/state/log.txt"; fail=1; }

echo "== second run"; : > "$CALLS"; run >/dev/null
if grep -q 'pm install\|BootActivity\|device_provisioned' "$CALLS"; then echo "FAIL second run repeated first-boot steps"; fail=1; else echo "ok   second run only does the every-boot steps"; fi
grep -q "connect-network" "$CALLS" && { echo "FAIL rejoined WiFi while connected"; fail=1; } || echo "ok   WiFi left alone when up"
echo; echo "log:"; cat "$W/state/log.txt"
exit $fail
