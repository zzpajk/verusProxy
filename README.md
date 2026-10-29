# verusProxy
**Experimental** stratum proxy for VerusCoin based mining pools. This is currently work in progress.  
  
Proxy requires miner to support extra nonce subscription (xnsub) or will result in mostly low difficulty rejects.  
If the pool connection is lost, a new extra nonce will be assigned by the pool and sent to miners (xnsub)  
  
## Setup
    sudo apt install nodejs npm
    git clone https://github.com/hellcatz/verusProxy
    cd verusProxy
    npm install

## Modify config.js

### Proxy Setup

    "stratumPort": 8000,
    
**NOTE**: stratum port can not be the same as pool port  
    
#### Proxy TLS/SSL Encryption
If needed, generate self sign certificate to use with proxy stratum port

    openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -sha256 -days 3650 -nodes -subj '/CN=localhost'  

#### Enable TLS/SSL config

    "stratumSSL": {
        "enabled": true,
        "key" : "key.pem",
        "cert" : "cert.pem"
    },

### Pool Connection

    "pools": [
        { "name": "luckpool NA", "host": "na.luckpool.net", "port": 3958, "ssl": true },
        { "name": "verus.io",    "host": "pool.verus.io",   "port": 9998, "ssl": false }
    ]

Pools are tried in priority order; see *Pool failover* below. A single `"pool": {...}` entry still works.

#### Miner Authorization
By default, authorization from miner will be used to create pool connections for each unique miner address.  
  
Optionally, you may force all miners to use the specified proxy wallet.

    "wallet": "WALLET_ADDRESS",
    "password": "x"

## Run
    node proxy.js

---

# Fleet dashboard

The proxy now has a built-in web dashboard for all devices mining through it.

Open `http://<proxy-ip>:8080/` (port set in `config.json` → `dashboard.port`).

- **Hashrate chart** – fleet total, the total of whatever the filters select, and up to 6 individual devices (tick them in the table, or press *Plot filtered devices*). Ranges 1h / 6h / 24h / 7d / 30d. Toggle between **device-reported** (ccminer's own number) and **pool-side** (calculated from accepted shares × share difficulty — what the pool actually credits).
- **Device table** – sort by any column, search, filter by status / make / system / temperature, choose columns. Shows make, model, SoC, Android/OS version, kernel, cores, CPU MHz, CPU temp, battery temp/level, reported & pool-side hashrate, hashrate per core, shares, reject %, miner version, IP, uptime, last share.
- Offline devices stay in the table so you notice dead phones (auto-removed after 14 days, or press *Forget*).
- History is kept for 24h at 1-minute resolution and 30 days at 15-minute resolution, saved to `data/stats.json` so it survives restarts.

## Device groups

Put devices in groups (a shelf, a room, a batch of phones…) to filter and chart them together. Each device is in at most one group, so group totals never double count. Groups are stored on the proxy in `data/groups.json`, so they survive restarts and are the same in every browser.

- **One device:** pick a group in its *Group* column, or *New group…*.
- **Many at once:** filter the table (e.g. make = Samsung), open **Groups** at the bottom of the table and *Move the N devices shown to* a group.
- **Groups menu:** each group's devices online and total hashrate; tick a group to plot its total; *Show* filters the table to it; *Rename* (renaming onto an existing name merges the two); *Delete* (the devices stay, just without a group).
- **Chart:** *Plot groups* draws one line per group (up to 6). A group line adds up its *current* members' history, so moving a device into a group also moves its past into that line.
- The group filter also has *No group*, to find devices you haven't sorted yet.

Devices are matched by worker name, so keep names unique and stable. Anyone who can open the dashboard can edit groups; set `dashboard.auth` if that should be restricted.

## Where the data comes from

| Source | Gives | Setup |
|---|---|---|
| Stratum traffic through the proxy | worker name, IP, miner software, accepted/rejected shares, **pool-side hashrate** | nothing — automatic |
| ccminer API, polled by the proxy (`:4068`) | **reported hashrate**, CPU temp, CPU MHz, cores, per-thread hashrate, ccminer share counts, ping | start ccminer with the API open to the LAN (below) |
| `agent/verus-agent.sh` on the device (optional) | **make, model, SoC, Android/OS version**, battery temp/level/charging, load, RAM — plus ccminer data if its API is localhost-only | run the script in Termux / on the board |

Devices are matched by **worker name** — the part after the dot in the miner login (`RYourAddress.phone01` → `phone01`). Use a unique worker name per device. Devices with no worker name are listed by IP.

### ccminer API (recommended, no install)

Add to each device's ccminer command line:

```
--api-bind 0.0.0.0:4068 --api-allow 0/0
```

or in its `config.json`: `"api-bind": "0.0.0.0:4068", "api-allow": "0/0"`.
(Use your LAN range instead of `0/0`, e.g. `192.168.1.0/24`, to keep it private.) The proxy polls every device it sees on stratum every 30 s. Devices behind NAT or mining elsewhere can be listed manually in `dashboard.ccminerHosts`, e.g. `["192.168.1.50", {"host": "192.168.1.51:4068", "name": "phone09"}]`.

### Device agent (optional, for make/model/system/battery)

Termux (Android):

```
pkg install curl
curl -O http://<proxy-ip>:8080/agent.sh      # or copy agent/verus-agent.sh over
chmod +x agent.sh
nohup ./agent.sh http://<proxy-ip>:8080 >/dev/null 2>&1 &
```

To start it with the phone, put that last line in `~/.termux/boot/start-agent` (Termux:Boot app), next to your ccminer start script.
Battery data works without root on most phones; if not, install the Termux:API app + `pkg install termux-api`.

Linux boards (Raspberry Pi, Orange Pi, …): same script, run it from `crontab -e` with `@reboot /path/verus-agent.sh http://<proxy-ip>:8080`.

Options (environment variables): `WORKER=phone01` (otherwise taken from ccminer's login), `TOKEN=...`, `CCMINER_API=127.0.0.1:4068`, `INTERVAL=30`. Test with `ONCE=1 ./agent.sh` — it prints the report instead of sending it.

### Dashboard settings (`config.json` → `dashboard`)

| key | default | |
|---|---|---|
| `enabled` | `true` | |
| `host`, `port` | `0.0.0.0`, `8080` | |
| `auth` | `""` | `"user:password"` to require a login for the dashboard |
| `reportToken` | `""` | if set, agents must send the same `TOKEN` |
| `hashrateWindowSec` | `600` | averaging window for pool-side hashrate |
| `staleAfterSec` | `300` | connected but no accepted share for this long → "No shares" |
| `forgetOfflineAfterDays` | `14` | |
| `ccminerApi`, `ccminerApiPort`, `ccminerPollSec` | `true`, `4068`, `30` | |
| `ccminerHosts` | `[]` | extra ccminer APIs to poll |

# Pool failover

List several pools in priority order; the proxy mines on one and moves every device to the next if it stops answering. Devices stay connected to the proxy the whole time — they just get a new extranonce and job (this is why miners must support extranonce subscription, which ccminer does).

```
"pools": [
    { "name": "luckpool NA", "host": "na.luckpool.net", "port": 3958, "ssl": true },
    { "name": "verus.io",    "host": "pool.verus.io",   "port": 9998, "ssl": false }
],
"failover": {
    "enabled": true,
    "connectFailures": 2,
    "connectTimeoutSec": 15,
    "submitTimeoutSec": 60,
    "probeEverySec": 60,
    "failback": true,
    "failbackAfterSec": 300
}
```

(The old single `"pool": {...}` entry still works and means a list of one.)

**When does it switch?** Only when the pool stops talking to the proxy:

- `connectFailures` connection attempts in a row fail (refused, TLS error, or no answer to subscribe within `connectTimeoutSec`), or
- shares were submitted and *nothing* came back for `submitTimeoutSec`.

TCP keepalive is enabled on pool connections so dead links are noticed even when nothing is being submitted.
Time since the last block or job is **never** a reason to switch — Verus blocks have no upper time limit. Rejected shares don't trigger a switch either (the pool is up; that's a config or miner problem) — they show in the dashboard.

**Failback.** The proxy probes the standby pools every `probeEverySec` (connect, subscribe and log in with a `.proxyprobe` worker, then hang up). When the preferred pool has passed probes continuously for `failbackAfterSec`, it moves back.

**Dashboard control.** The Pools panel shows each pool's status, ping, pool-side hashrate, accepted/rejected shares, time since last job, last problem, and a log of switches. With a login configured you can:

- **Switch here** — moves all devices to that pool and makes it the *preferred* pool (failover still protects you; failback returns to it instead of #1).
- **Auto failover** on/off.
- **Use priority order** — clears the preferred pool so #1 is preferred again.

Pool control only works when `dashboard.auth` is set (it moves all your hashrate, so it must not be open to the whole LAN), and it can only switch between pools listed in `config.json` — never to an address typed into the page. Requests also need a custom header and must come from the dashboard's own origin, so another website open in your browser can't trigger a switch using your saved login. The preferred pool and the on/off setting are kept in `data/pools.json` across restarts (the saved preferred pool is ignored if you edit the pool list).

**The proxy itself is still a single point of failure.** Give ccminer on each device a second pool that goes straight to a real pool, so devices keep mining if the proxy machine is down.

# Devices showing "Offline" / reconnecting

ccminer disconnects when it receives nothing from its pool for `--timeout` seconds — 300 by default, but **60 as soon as more than one pool is configured**. During a long Verus block (no new job) a phone that rarely finds a share can go that long without hearing anything, so ccminer drops the connection and reconnects, or fails over to its backup pool.

The proxy prevents this: if it hasn't sent a device anything for `minerKeepaliveSec` (default 30), it resends the current share target, which ccminer treats as "nothing changed" and keeps mining. Keep it below ccminer's timeout; `0` disables it.

Statuses in the device table:

| Status | Meaning |
|---|---|
| Online | connected to the proxy |
| Reconnecting | disconnected less than a minute ago |
| No shares | connected, but no accepted share for `staleAfterSec` |
| Mining elsewhere | not connected, but its ccminer API answers and says it's on another pool (usually its backup pool) — hover for the pool |
| Offline | not connected and ccminer not reachable |

For a backup pool in ccminer's own config, add `"time-limit": 900` to the backup entry so ccminer returns to the proxy after 15 minutes instead of staying on the backup until it fails. (`"timeout"` is a global ccminer option, not a per-pool one.)

# Remote commands (SSH)

Run shell commands on one device, a group, or every device shown in the table, from the dashboard, and see each device's output. It uses Termux's SSH server (port 8022) and the proxy machine's own `ssh` client.

**It is off by default**, because it gives anyone who can use the dashboard a shell on every phone. To turn it on:

1. Set a dashboard login, `"dashboard": { "auth": "user:a-long-password" }`. Remote commands refuse to work without one.
2. Set `"ssh": { "enabled": true }` in `config.json` and restart the proxy.
3. On each phone in Termux: `pkg install openssh`, `passwd` (set a password), `sshd`. To start sshd with the phone, add `sshd` to `~/.termux/boot/` (Termux:Boot app).
4. On the proxy machine, **as the user the proxy runs as** (e.g. `pi`): `./deploy/ssh-copy-key.sh`. It creates an SSH key if there is none and installs it on every device the dashboard knows, asking each device's Termux password once. Pass IP addresses to do only some devices. The dashboard's *Setup* button also shows the public key and a one-liner to paste in Termux.

Then use the **Remote commands** panel below the device table: pick the devices (*devices shown in the table*, a group, or one device; each row's *SSH* button picks that device), type a command or click a saved command, and press *Run*. You confirm the exact devices first. Results appear per device as they finish, failures first, with a plain-English hint (sshd not running, key not installed, device unreachable, timed out); *Retry failed* re-runs on just those.

| `ssh` setting | default | |
|---|---|---|
| `enabled` | `false` | |
| `user`, `port` | `eek`, `8022` | Termux sshd |
| `identityFile` | `""` | private key to use; empty = the proxy user's `~/.ssh/id_ed25519` (or ecdsa/rsa) |
| `timeoutSec` | `60` | a device's command is stopped after this |
| `parallel` | `10` | devices worked on at the same time |
| `allowCustomCommands` | `true` | `false` = only the saved `presets` can be run |
| `presets` | uptime, ccminer running?, battery, disk & memory, stop ccminer | `{ "name": "...", "command": "..." }` buttons |

A useful preset to add, with your own start command: `{ "name": "Restart ccminer", "command": "pkill -f ccminer; sleep 2; cd ~/ccminer && nohup ./ccminer -c config.json > miner.log 2>&1 & echo restarted" }`. Anything that should keep running after the command returns needs `nohup … &` like this, otherwise it stops when the SSH session closes.

How it's kept safe:
- Keys only. `BatchMode` means ssh never asks for or uses a password, and none is stored.
- Devices are picked by worker name; the proxy uses the address it already knows for that device. The page can't make the proxy connect anywhere else.
- Host keys are remembered per device (trust on first use) in `data/ssh_known_hosts`, so a phone getting a new IP from DHCP is fine, but a different phone answering on a known one is refused. If you reinstall Termux on a device, delete its line from that file.
- Commands can only be sent from the dashboard page itself, with the login.
- Every command is logged per device in `data/ssh-log.jsonl` (time, dashboard user, device, command, exit code, start of the output). The last 30 runs with full output survive restarts in `data/ssh-runs.json`.

# Run at boot and restart when stalled (Linux / systemd)

Service files are in `deploy/`. Edit `User=` and the paths in `verusproxy.service` (the example assumes user `pi` and `/home/pi/verusProxy`; `which node` shows the node path), then:

```
sudo cp deploy/verusproxy*.service deploy/verusproxy-watchdog.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now verusproxy
sudo systemctl enable --now verusproxy-watchdog.timer
```

- **Starts at boot, restarts on crash** (`Restart=always`). Inside, the proxy already re-forks a crashed stratum worker by itself.
- **Restarts when stalled:** every minute the watchdog calls `GET /api/health`, which returns 503 when a stratum worker process has stopped checking in (they report every 5 s). Two failures 20 s apart → `systemctl restart verusproxy`. It needs the dashboard enabled; if you changed `dashboard.port`, change 8080 in the watchdog too.
- Logs: `journalctl -u verusproxy -f` (watchdog restarts: `journalctl -u verusproxy-watchdog`).

### API

`GET /api/health`, `GET /api/stats`, `GET /api/history?range=1h|6h|24h|7d|30d&metric=rep|eff`, `GET /api/pools`, `POST /api/report`, `POST /api/forget {"worker": "..."}`.
Remote commands (needs `ssh.enabled`, `dashboard.auth` and header `X-VP-Control: 1`): `GET /api/ssh`, `POST /api/ssh/run {"workers": ["phone01"], "command": "uptime"}` (or `"preset": "Uptime"`), `GET /api/ssh/run?id=...`.
Pool control (needs `dashboard.auth` and header `X-VP-Control: 1`): `POST /api/pools/switch {"index": 1}`, `POST /api/pools/auto {"enabled": true}`, `POST /api/pools/reset-preferred`.

The dashboard is meant for your LAN. If you expose it to the internet, set `auth` and put it behind HTTPS.
