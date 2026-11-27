#!/usr/bin/env bash
# Builds the farm-bootstrap Magisk module zip with this farm's WiFi, ADB keys and Termux APKs.
#
#   bootstrap/build.sh [--conf FILE] [--key FILE]... [--apks DIR] [--no-apks] [--out FILE]
#
# Defaults (all gitignored, the zip holds the WiFi password: keep it off GitHub):
#   --conf  bootstrap/local/farm.conf          copy of bootstrap/module/farm.conf.example, filled in
#   keys    farm.defaults.adbKeys / sshKeys from config.local.json and data/keys/*.txt
#           (the list phones sync from)
#   --key   bootstrap/local/adb_keys            extra keys, one adbkey.pub line each (e.g. the laptop's)
#           plus ~/.android/adbkey.pub of the user running this (on the box: run as verusproxy,
#           the user the dashboard's adb runs as, or pass ~verusproxy/.android/adbkey.pub)
#   --apks  bootstrap/local/apks, else data/apks
#           Termux, Termux:Boot, Termux:API (all from the same source: GitHub build or F-Droid)
#   --out   data/bootstrap/farm-bootstrap-<version>.zip
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
MOD=$ROOT/bootstrap/module
CONF=$ROOT/bootstrap/local/farm.conf
KEYS=()
[ -f "$ROOT/bootstrap/local/adb_keys" ] && KEYS+=("$ROOT/bootstrap/local/adb_keys")
[ -f "$HOME/.android/adbkey.pub" ] && KEYS+=("$HOME/.android/adbkey.pub")
APKS=
NOAPKS=0
OUT=

while [ $# -gt 0 ]; do
  case "$1" in
    --conf) CONF=$2; shift 2 ;;
    --key) KEYS+=("$2"); shift 2 ;;
    --apks) APKS=$2; shift 2 ;;
    --no-apks) NOAPKS=1; shift ;;
    --out) OUT=$2; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
done

VERSION=$(grep '^version=' "$MOD/module.prop" | cut -d= -f2)
[ -n "$OUT" ] || OUT=$ROOT/data/bootstrap/farm-bootstrap-$VERSION.zip
if [ -z "$APKS" ]; then
  if [ -d "$ROOT/bootstrap/local/apks" ]; then APKS=$ROOT/bootstrap/local/apks; else APKS=$ROOT/data/apks; fi
fi

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
cp -a "$MOD/." "$STAGE/"
rm -f "$STAGE/farm.conf.example"

# settings
if [ -f "$CONF" ]; then
  bash -n "$CONF" || { echo "$CONF: not valid shell syntax" >&2; exit 1; }
  cp "$CONF" "$STAGE/farm.conf"
  ssid=$(bash -c '. "$1"; printf %s "${WIFI_SSID:-}"' _ "$CONF")
  echo "settings: $CONF (WiFi: ${ssid:-not set})"
else
  echo "warning: no $CONF, the phone will not join WiFi (copy bootstrap/module/farm.conf.example)" >&2
fi

# the farm's key list: farm.defaults.adbKeys / sshKeys in config.local.json, the same list the
# phones sync from the box later (a string or an array of adbkey.pub / authorized_keys lines)
farmkeys() {
  [ -f "$ROOT/config.local.json" ] || return 0
  python3 - "$ROOT/config.local.json" "$1" <<'PY'
import json, sys
try: d = ((json.load(open(sys.argv[1])).get('farm') or {}).get('defaults') or {}).get(sys.argv[2])
except Exception as e: sys.exit('config.local.json: %s' % e)
for k in ([d] if isinstance(d, str) else d or []):
    for line in str(k).splitlines():
        if line.strip(): print(line.strip())
PY
}

# ADB keys, without duplicates
farmkeys adbKeys > "$STAGE/adb_keys"
# the files the box serves for the key sync (data/keys), when present
[ -f "$ROOT/data/keys/adb_keys.txt" ] && grep -v '^[[:space:]]*\(#\|$\)' "$ROOT/data/keys/adb_keys.txt" >> "$STAGE/adb_keys" || true
[ -s "$STAGE/adb_keys" ] && echo "adb keys from the farm key list: $(wc -l < "$STAGE/adb_keys")"
farmkeys sshKeys > "$STAGE/ssh_keys"
[ -f "$ROOT/data/keys/authorized_keys.txt" ] && grep -v '^[[:space:]]*\(#\|$\)' "$ROOT/data/keys/authorized_keys.txt" >> "$STAGE/ssh_keys" || true
sort -u -o "$STAGE/ssh_keys" "$STAGE/ssh_keys"
if [ -s "$STAGE/ssh_keys" ]; then echo "ssh keys from the farm key list: $(wc -l < "$STAGE/ssh_keys")"; else rm -f "$STAGE/ssh_keys"; fi
for k in "${KEYS[@]}"; do
  [ -f "$k" ] || { echo "no key file $k" >&2; exit 1; }
  grep -v '^[[:space:]]*\(#\|$\)' "$k" >> "$STAGE/adb_keys" || true
done
sort -u -o "$STAGE/adb_keys" "$STAGE/adb_keys"
if [ -s "$STAGE/adb_keys" ]; then
  echo "adb keys: $(wc -l < "$STAGE/adb_keys")"; awk '{print "  " $2}' "$STAGE/adb_keys"
else
  rm -f "$STAGE/adb_keys"; echo "warning: no ADB keys, the phone will ask on screen" >&2
fi

# APKs: newest file per app, named <order>-<package>.apk for the phone
mkdir -p "$STAGE/apks"
if [ $NOAPKS = 0 ]; then
  [ -d "$APKS" ] || { echo "no APK folder $APKS (use --apks DIR or --no-apks)" >&2; exit 1; }
  pick() {   # pattern exclude
    ls "$APKS" | grep -i -- "$1" | { if [ -n "$2" ]; then grep -vi -- "$2"; else cat; fi; } \
      | grep -vi 'x86\|armeabi-v7a' | sort -V | tail -1
  }
  termux=$(pick '^\(termux-app\|com\.termux_\)' '')
  boot=$(pick '^\(termux-boot\|com\.termux\.boot_\)' '')
  api=$(pick '^\(termux-api\|com\.termux\.api_\)' '')
  [ -n "$termux" ] || { echo "no Termux APK in $APKS" >&2; exit 1; }
  [ -n "$boot" ] || { echo "no Termux:Boot APK in $APKS" >&2; exit 1; }
  src() { case "$1" in *github*) echo github ;; com.termux*_[0-9]*.apk) echo f-droid ;; *) echo unknown ;; esac; }
  for f in "$boot" $api; do
    [ "$(src "$f")" = "$(src "$termux")" ] || echo "warning: $f does not look like the same source as $termux (Termux and its add-ons must match)" >&2
  done
  cp "$APKS/$termux" "$STAGE/apks/1-com.termux.apk"
  cp "$APKS/$boot" "$STAGE/apks/2-com.termux.boot.apk"
  [ -n "$api" ] && cp "$APKS/$api" "$STAGE/apks/3-com.termux.api.apk"
  echo "apks ($(src "$termux")): $termux, $boot${api:+, $api}"
fi

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
OUT=$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")
if command -v zip >/dev/null; then
  (cd "$STAGE" && zip -qr -X "$OUT" .)
else
  python3 - "$STAGE" "$OUT" <<'EOF'
import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for d, _, files in os.walk(src):
        for f in files:
            p = os.path.join(d, f)
            z.write(p, os.path.relpath(p, src))
EOF
fi
chmod 600 "$OUT"
echo "built $OUT ($(du -h "$OUT" | cut -f1))"
