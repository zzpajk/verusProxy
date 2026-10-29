#!/usr/bin/env bash
# Install the proxy's SSH key on your Termux devices, so the dashboard can run commands on them.
# Run on the proxy machine, as the same user the proxy runs as (e.g. "pi"):
#
#   ./deploy/ssh-copy-key.sh                  # every device the dashboard knows
#   ./deploy/ssh-copy-key.sh 192.168.1.21 ... # just these addresses
#
# Each device asks for its Termux password once (set it in Termux with `passwd`).
set -u
cd "$(dirname "$0")/.." || exit 1

cfg() { node -e "const c=require('./config.json'); const v=($1); process.stdout.write(v===undefined||v===null?'':String(v))"; }
USER_NAME=$(cfg "(c.ssh||{}).user||'eek'")
PORT=$(cfg "(c.ssh||{}).port||8022")
KEY=$(cfg "(c.ssh||{}).identityFile||''")
KEY=${KEY/#\~/$HOME}
DASH_PORT=$(cfg "(c.dashboard||{}).port||8080")
AUTH=$(cfg "(c.dashboard||{}).auth||''")

for tool in ssh ssh-keygen ssh-copy-id curl; do
    command -v "$tool" >/dev/null || { echo "Missing '$tool'. Install it first (Debian/Raspberry Pi OS: sudo apt install openssh-client curl)."; exit 1; }
done

# 1. a key for the proxy
if [ -z "$KEY" ]; then
    for k in "$HOME/.ssh/id_ed25519" "$HOME/.ssh/id_ecdsa" "$HOME/.ssh/id_rsa"; do
        [ -f "$k" ] && [ -f "$k.pub" ] && { KEY=$k; break; }
    done
fi
if [ -z "$KEY" ]; then
    KEY="$HOME/.ssh/id_ed25519"
    echo "Creating an SSH key for $(whoami): $KEY"
    mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
    ssh-keygen -q -t ed25519 -N "" -C "verusproxy@$(hostname)" -f "$KEY" || exit 1
fi
[ -f "$KEY.pub" ] || { echo "Public key $KEY.pub not found."; exit 1; }
echo "Using key $KEY.pub"

# 2. which devices
if [ $# -gt 0 ]; then
    TARGETS=$(printf '%s\n' "$@" | sed 's/^/?\t/')
else
    JSON=$(curl -fsS -m 10 ${AUTH:+-u "$AUTH"} "http://127.0.0.1:$DASH_PORT/api/stats") || { echo "Could not read the device list from the dashboard on port $DASH_PORT. Is the proxy running? You can also pass IP addresses."; exit 1; }
    TARGETS=$(printf '%s' "$JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const w of JSON.parse(s).workers) if(w.ip) console.log(w.name+'\t'+w.ip)})")
fi
[ -n "$TARGETS" ] || { echo "No devices with a known address yet."; exit 1; }

# 3. copy the key, then check it works without a password
OK=0; FAIL=0
# the list is read from fd 3 so ssh / ssh-copy-id can't swallow it from stdin
while IFS=$'\t' read -r NAME IP <&3; do
    [ -n "$IP" ] || continue
    echo
    echo "== $NAME ($USER_NAME@$IP:$PORT)"
    OPTS=(-o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)
    if ssh -n -p "$PORT" -i "$KEY" -o BatchMode=yes "${OPTS[@]}" "$USER_NAME@$IP" true 2>/dev/null; then
        echo "   already set up"; OK=$((OK+1)); continue
    fi
    if ssh-copy-id -f -i "$KEY.pub" -p "$PORT" "${OPTS[@]}" "$USER_NAME@$IP" >/dev/null \
       && ssh -n -p "$PORT" -i "$KEY" -o BatchMode=yes "${OPTS[@]}" "$USER_NAME@$IP" true; then
        echo "   key installed"; OK=$((OK+1))
    else
        echo "   FAILED (is sshd running in Termux and the password right?)"; FAIL=$((FAIL+1))
    fi
done 3< <(printf '%s\n' "$TARGETS")

echo
echo "Done: $OK ready, $FAIL failed."
