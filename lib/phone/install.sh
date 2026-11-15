NEW="$VP/incoming.bin"
cat > "$NEW" || { echo "result=failed"; echo "msg=Transfer failed"; exit 1; }
[ "$(shaof "$NEW")" = "$EXPECT" ] || { rm -f "$NEW"; echo "result=failed"; echo "msg=Transfer damaged (checksum differs), try again"; exit 1; }
install_binary "$NEW"; rc=$?
rm -f "$NEW"
exit $rc
