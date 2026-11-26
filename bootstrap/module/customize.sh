# Runs once while the module is installed (Magisk app, `magisk --install-module` or recovery).
# Magisk has already extracted the zip into $MODPATH.

if [ -f "$MODPATH/farm.conf" ]; then
  . "$MODPATH/farm.conf"
  ui_print "- Farm settings: farm.conf"
else
  ui_print "! No farm.conf in this zip: WiFi will not be set up (build it with bootstrap/build.sh)"
fi
if [ -n "$WIFI_SSID" ]; then ui_print "- WiFi: $WIFI_SSID"; else ui_print "- WiFi: not set"; fi
if [ -s "$MODPATH/adb_keys" ]; then
  ui_print "- ADB keys: $(grep -c . "$MODPATH/adb_keys") computer(s) allowed without a prompt"
else
  ui_print "! No adb_keys in this zip: ADB will ask on the screen"
fi
[ -s "$MODPATH/ssh_keys" ] && ui_print "- SSH keys for Termux: $(grep -c . "$MODPATH/ssh_keys")"
ui_print "- Apps to install: $(ls "$MODPATH/apks" 2>/dev/null | tr '\n' ' ')"
[ "$API" -lt 30 ] 2>/dev/null && ui_print "! Android API $API: joining WiFi needs Android 11+, connect it by hand"

# WiFi password and keys: root only
set_perm "$MODPATH/farm.conf" 0 0 0600 2>/dev/null
set_perm "$MODPATH/adb_keys" 0 0 0600 2>/dev/null
set_perm "$MODPATH/ssh_keys" 0 0 0600 2>/dev/null
set_perm_recursive "$MODPATH/apks" 0 0 0700 0600 2>/dev/null
set_perm "$MODPATH/post-fs-data.sh" 0 0 0755
set_perm "$MODPATH/service.sh" 0 0 0755
set_perm "$MODPATH/farm-bootstrap.sh" 0 0 0755

# a reinstall starts the first-boot steps over (apps already there are skipped)
rm -f /data/adb/farm-bootstrap/done
ui_print "- Reboot: the phone sets itself up on the next boot (log: /data/adb/farm-bootstrap/log.txt)"
