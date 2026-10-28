#!/usr/bin/env bash
# verusProxy device agent - reports device details + ccminer stats to the proxy dashboard.
# Works in Termux (Android) and on ARM Linux boards (Raspberry Pi, Orange Pi, ...).
#
# usage:  ./verus-agent.sh http://<proxy-ip>:8080
# env:    WORKER=phone01            worker name (default: taken from ccminer's pool login)
#         TOKEN=secret              must match dashboard.reportToken if set
#         CCMINER_API=127.0.0.1:4068
#         INTERVAL=30               seconds between reports
#         ONCE=1                    print one report and exit (for testing)

AGENT_VERSION="0.2.0"
URL="${1:-${PROXY_URL:-}}"
INTERVAL="${INTERVAL:-30}"
CCMINER_API="${CCMINER_API:-127.0.0.1:4068}"
CC_HOST="${CCMINER_API%%:*}"
CC_PORT="${CCMINER_API##*:}"

if [ -z "$URL" ] && [ -z "$ONCE" ]; then
    echo "usage: $0 http://<proxy-ip>:8080   (or ONCE=1 $0 to print a report)" >&2
    exit 1
fi

have() { command -v "$1" >/dev/null 2>&1; }
rd() { [ -r "$1" ] && tr -d '\000' < "$1" 2>/dev/null | head -c 200; }
esc() { printf '%s' "$1" | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g'; }
str() { if [ -n "$1" ]; then printf '"%s"' "$(esc "$1")"; else printf 'null'; fi; }
nmb() { case "$1" in ''|*[!0-9.-]*) printf 'null';; *) printf '%s' "$1";; esac; }
prop() { have getprop && getprop "$1" 2>/dev/null; }

# ---- ccminer API (plain TCP: send command, read reply until close) ----
ccq() {
    local out=""
    if { exec 3<>"/dev/tcp/$CC_HOST/$CC_PORT"; } 2>/dev/null; then
        printf '%s' "$1" >&3
        if have timeout; then out=$(timeout 3 cat <&3 2>/dev/null); else out=$(cat <&3 2>/dev/null); fi
        exec 3<&- 3>&-
    fi
    printf '%s' "$out"
}

# ---- static device info (collected once) ----
collect_static() {
    if have getprop && [ -n "$(prop ro.build.version.release)" ]; then
        MAKE=$(prop ro.product.manufacturer)
        MODEL=$(prop ro.product.marketname)
        [ -z "$MODEL" ] && MODEL=$(prop ro.product.model)
        SOC=$(prop ro.soc.model)
        [ -n "$SOC" ] && [ -n "$(prop ro.soc.manufacturer)" ] && SOC="$(prop ro.soc.manufacturer) $SOC"
        [ -z "$SOC" ] && SOC=$(prop ro.board.platform)
        [ -z "$SOC" ] && SOC=$(prop ro.hardware)
        OS="Android $(prop ro.build.version.release)"
        sdk=$(prop ro.build.version.sdk); [ -n "$sdk" ] && OS="$OS (API $sdk)"
    else
        MODEL=$(rd /proc/device-tree/model)
        [ -z "$MODEL" ] && MODEL=$(rd /sys/class/dmi/id/product_name)
        MAKE=$(rd /sys/class/dmi/id/sys_vendor)
        [ -z "$MAKE" ] && MAKE="${MODEL%% *}"
        SOC=$({ tr '\000' '\n' < /proc/device-tree/compatible; } 2>/dev/null | tail -n 1)
        [ -z "$SOC" ] && SOC=$(grep -m1 -i '^Hardware' /proc/cpuinfo 2>/dev/null | cut -d: -f2-)
        [ -z "$SOC" ] && SOC=$(grep -m1 -i 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2-)
        OS=$(. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME")
        [ -z "$OS" ] && OS="Linux"
    fi
    KERNEL=$(uname -r 2>/dev/null)
    ARCH=$(uname -m 2>/dev/null)
    CORES=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)
    RAM_MB=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null)
    SOC=$(echo "$SOC" | sed 's/^ *//')
}

# hottest CPU-ish thermal zone, in degrees C
cpu_temp() {
    local best="" any="" z t ty
    for z in /sys/class/thermal/thermal_zone*; do
        t=$(cat "$z/temp" 2>/dev/null) || continue
        case "$t" in ''|*[!0-9-]*) continue;; esac
        [ "$t" -gt 1000 ] 2>/dev/null && t=$((t / 1000))
        [ "$t" -le 0 ] || [ "$t" -ge 130 ] && continue
        ty=$(cat "$z/type" 2>/dev/null | tr 'A-Z' 'a-z')
        [ -z "$any" ] || [ "$t" -gt "$any" ] && any=$t
        case "$ty" in *cpu*|*soc*|*tsens*|*cluster*|*little*|*big*|*core*)
            [ -z "$best" ] || [ "$t" -gt "$best" ] && best=$t;;
        esac
    done
    echo "${best:-$any}"
}

battery() {
    BAT_TEMP=""; BAT_LEVEL=""; BAT_STATUS=""
    local b=/sys/class/power_supply/battery
    if [ -r "$b/capacity" ]; then
        BAT_LEVEL=$(cat $b/capacity 2>/dev/null)
        local t; t=$(cat $b/temp 2>/dev/null)
        [ -n "$t" ] && BAT_TEMP=$(awk -v t="$t" 'BEGIN{printf "%.1f", t/10}')
        BAT_STATUS=$(cat $b/status 2>/dev/null)
    elif have termux-battery-status && have timeout; then
        # needs the Termux:API app; times out cleanly if it's missing
        local j; j=$(timeout 6 termux-battery-status 2>/dev/null | tr -d '\n ')
        BAT_LEVEL=$(echo "$j" | sed -n 's/.*"percentage":\([0-9.]*\).*/\1/p')
        BAT_TEMP=$(echo "$j" | sed -n 's/.*"temperature":\([0-9.]*\).*/\1/p')
        BAT_STATUS=$(echo "$j" | sed -n 's/.*"status":"\([A-Z_]*\)".*/\1/p')
    fi
}

build_report() {
    local temp load up summary hwinfo pool threads
    temp=$(cpu_temp)
    battery
    load=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)
    up=$(cut -d' ' -f1 /proc/uptime 2>/dev/null | cut -d. -f1)
    summary=$(ccq summary)
    if [ -n "$summary" ]; then
        hwinfo=$(ccq hwinfo); pool=$(ccq pool); threads=$(ccq threads)
    fi
    cat <<EOF
{"agent":"$AGENT_VERSION","worker":$(str "$WORKER"),"make":$(str "$MAKE"),"model":$(str "$MODEL"),"soc":$(str "$SOC"),"os":$(str "$OS"),"kernel":$(str "$KERNEL"),"arch":$(str "$ARCH"),"cores":$(nmb "$CORES"),"ramMB":$(nmb "$RAM_MB"),"cpuTemp":$(nmb "$temp"),"batteryTemp":$(nmb "$BAT_TEMP"),"batteryLevel":$(nmb "$BAT_LEVEL"),"charging":$(str "$BAT_STATUS"),"load":$(nmb "$load"),"uptime":$(nmb "$up"),"ccminer":{"summary":$(str "$summary"),"hwinfo":$(str "$hwinfo"),"pool":$(str "$pool"),"threads":$(str "$threads")}}
EOF
}

post() {
    local endpoint="${URL%/}/api/report"
    if have curl; then
        curl -s -m 10 -H 'Content-Type: application/json' ${TOKEN:+-H "X-Token: $TOKEN"} --data-binary @- "$endpoint"
    elif have wget; then
        wget -q -T 10 -O - --header='Content-Type: application/json' ${TOKEN:+--header="X-Token: $TOKEN"} --post-file=/dev/stdin "$endpoint"
    else
        echo "need curl or wget (Termux: pkg install curl)" >&2; return 1
    fi
}

collect_static
if [ -n "$ONCE" ]; then build_report; exit 0; fi
echo "verus-agent $AGENT_VERSION -> $URL every ${INTERVAL}s ($MAKE $MODEL, $OS)"
while true; do
    build_report | post >/dev/null 2>&1 || echo "$(date '+%H:%M:%S') report failed" >&2
    sleep "$INTERVAL"
done
