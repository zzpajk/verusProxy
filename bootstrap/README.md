# Farm bootstrap (Magisk module)

Flash it in TWRP right after Magisk (same session, no boot needed) and a new phone comes up ready for the dashboard: ADB over WiFi on
port 5555 that the proxy box and the laptop can use without a prompt, joined to the farm WiFi,
no setup wizard, Termux + Termux:Boot (+ Termux:API) installed, opened once and allowed root
forever. The dashboard's scan (Find phones) then finds it, and **Set up phone** does the rest
(packages, SSH, miner, farm profile).

| File | What it does |
|---|---|
| `module/system.prop` | `persist.sys.usb.config=mtp,adb`, `service.adb.tcp.port=5555`, `ro.setupwizard.mode=DISABLED` (LineageOS), at every boot, in memory |
| `module/post-fs-data.sh` | adds the zip's `adb_keys` to `/data/misc/adb/adb_keys` (keeps keys already there) |
| `module/farm-bootstrap.sh` | every boot: ADB on 5555, WiFi (`cmd wifi connect-network`, Android 11+), screen on. Until done: setup wizard, lock screen, developer options, install APKs, Magisk root for ADB shell + Termux, battery optimisation off, open Termux and Termux:Boot once, small Termux:Boot script. A step that fails is tried again at the next boot. |
| keys | ADB and SSH keys come from `farm.defaults.adbKeys` / `sshKeys` in `config.local.json`, the same list the phones keep syncing from the box, plus `bootstrap/local/adb_keys` and the build user's `~/.android/adbkey.pub` |
| `module/boot/` | first-boot hook added to the boot image for the one-session flash (below) |
| `module/termux-boot/farm-bootstrap` | wake lock + sshd until Apply profile writes `verusproxy-setup`, then deletes itself |
| `build.sh` | builds the zip with this farm's settings, keys and APKs |
| `test/stub-run.sh` | runs the script on a computer with Android's commands stubbed |

On the phone: log `/data/adb/farm-bootstrap/log.txt`, state `/data/adb/farm-bootstrap/status`.
Remove the module in the Magisk app (or `rm -rf /data/adb/modules/farm-bootstrap`) to stop it;
ADB keys, settings and apps stay.

## Build (on the proxy box)

```sh
cd ~/verusProxy
mkdir -p bootstrap/local/apks
cp bootstrap/module/farm.conf.example bootstrap/local/farm.conf   # fill in WIFI_SSID / WIFI_PASS
# the laptop's key: copy the line from %USERPROFILE%\.android\adbkey.pub on Windows
echo 'QAAAA...= eek@laptop' >> bootstrap/local/adb_keys
# Termux, Termux:Boot, Termux:API APKs (GitHub build = current standard), arm64-v8a or universal
cp termux-app_*arm64-v8a.apk termux-boot-app_*.apk termux-api-app_*.apk bootstrap/local/apks/
# as the user the dashboard runs adb as, so its key goes in too
sudo -u verusproxy bootstrap/build.sh
```

The zip lands in `data/bootstrap/` and holds the WiFi password: keep it off GitHub
(`bootstrap/local/` and `data/` are gitignored).

## Test it

1. **On the computer:** `bash bootstrap/test/stub-run.sh` checks the order of steps and that a
   second boot skips what already worked.
2. **On a rooted spare phone, no recovery** (any phone that already has Magisk; one that does
   not mine is best). Apps that are already installed are skipped, so on a set-up phone this
   mostly checks ADB keys, WiFi and root grants:
   ```sh
   adb -s <ip>:5555 push data/bootstrap/farm-bootstrap-v0.1.0.zip /data/local/tmp/
   adb -s <ip>:5555 shell su -c 'magisk --install-module /data/local/tmp/farm-bootstrap-v0.1.0.zip'
   adb -s <ip>:5555 reboot
   # 1-2 minutes later
   adb -s <ip>:5555 shell su -c 'cat /data/adb/farm-bootstrap/log.txt /data/adb/farm-bootstrap/status'
   ```
   To also test the app install and first open on that phone: uninstall Termux, Termux:Boot and
   Termux:API first (this wipes Termux's home, so only on a phone whose Termux you don't need),
   then reboot. To run the steps again without a reboot: `su -c 'sh /data/adb/modules/farm-bootstrap/farm-bootstrap.sh run'`.
3. **Full flash on a wiped phone, one recovery session** (with the phone in hand): TWRP →
   format data → flash the ROM → flash Magisk → flash `farm-bootstrap-*.zip` → reboot. No boot in
   between and no setup wizard: within a few minutes the phone should answer on `<ip>:5555` and
   show up in the dashboard's scan. If the zip says something is not supported, boot once,
   go back to TWRP and flash it again (it then installs as a normal module).

### How the one-session flash works

Before Magisk's first boot there is no `/data/adb`, so a recovery cannot install a module the
normal way. Instead the zip leaves the module in `/data/farm-bootstrap` and adds two files to the
boot image Magisk just patched (`boot/farm-bootstrap.rc` and `boot/farm-stage.sh`, through
Magisk's documented `overlay.d`), using Magisk's own `magiskboot` from `/data/magisk`:

- early in the first boot (post-fs-data, before the setup wizard and adbd): `ro.setupwizard.mode=DISABLED`,
  ADB on 5555 with the farm's keys
- when boot completes: moves the module into `/data/adb/modules` and runs it; from then on
  Magisk runs it at every boot and the two boot files do nothing

The boot partition is only written after the boot image unpacked, was confirmed as Magisk-patched,
the module was copied and the new image fits. Flashing a new ROM or Magisk later replaces the boot
image, so flash this zip after Magisk again. Use TWRP: LineageOS Recovery cannot read encrypted
`/data`. Phones with a `vendor_boot` ramdisk (some Android 12+) are not handled yet: boot once
and flash, or install it from the Magisk app.

The setup wizard: the module marks the phone as set up (`device_provisioned`, `user_setup_complete`)
and turns off the wizard packages (LineageOS, Google, AOSP provision, Samsung) if one started anyway.
