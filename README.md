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

    "pool" : {
      "host" : "na.luckpool.net",
      "port" : 3958,
      "ssl"  :  true
    }

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

### API

`GET /api/stats`, `GET /api/history?range=1h|6h|24h|7d|30d&metric=rep|eff`, `POST /api/report`, `POST /api/forget {"worker": "..."}`.

The dashboard is meant for your LAN. If you expose it to the internet, set `auth` and put it behind HTTPS.
