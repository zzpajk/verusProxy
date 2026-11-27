# Early boot (blocking, /data is decrypted): let the farm's computers use ADB without a prompt.
MODDIR=${0%/*}
KEYS=/data/misc/adb/adb_keys
[ -s "$MODDIR/adb_keys" ] || exit 0
mkdir -p /data/misc/adb
touch "$KEYS"
# add the keys that are missing, keep the ones already allowed on the phone
while IFS= read -r k; do
  [ -n "$k" ] || continue
  grep -qxF "$k" "$KEYS" || echo "$k" >> "$KEYS"
done < "$MODDIR/adb_keys"
chown 1000:2000 "$KEYS"
chmod 0640 "$KEYS"
chcon u:object_r:adb_keys_file:s0 "$KEYS" 2>/dev/null || restorecon "$KEYS" 2>/dev/null
exit 0
