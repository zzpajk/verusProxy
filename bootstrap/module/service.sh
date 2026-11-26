# Late boot (Magisk runs this in the background): see farm-bootstrap.sh
MODDIR=${0%/*}
rm -rf /data/adb/farm-bootstrap/lock   # nothing else runs yet; a lock now is from before a power cut
sh "$MODDIR/farm-bootstrap.sh" boot >/dev/null 2>&1 &
