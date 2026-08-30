# Installing Homebridge Dobiss LAN on Synology

This guide installs `homebridge-dobiss-lan` version `0.5.14` on a Synology NAS
running the official Homebridge package for DSM 7.

## Before you begin

- Create a Homebridge backup using **Backup / Restore**.
- Save a copy of the current plugin configuration.
- Verify that the Synology NAS can reach the Dobiss DO5435 on TCP port `10001`.
- Prefer these stable settings:

```json
"pollIntervalSeconds": 30,
"toggleOnStatusReadFailure": true,
"aggressiveStatusRetries": false
```

Download the installation package:

<https://github.com/EricVanasch/homebridge-dobiss/releases/download/v0.5.14/homebridge-dobiss-lan-0.5.14.tgz>

## Method 1: Homebridge UI

1. Open `http://<SYNOLOGY-IP-ADDRESS>:8581` on your local network.
2. Open the Homebridge terminal from the three-dot menu in the upper-right
   corner.
3. Download the package in the terminal:

```bash
curl -L https://github.com/EricVanasch/homebridge-dobiss/releases/download/v0.5.14/homebridge-dobiss-lan-0.5.14.tgz -o /tmp/homebridge-dobiss-lan-0.5.14.tgz
```

4. Install the local package:

```bash
hb-service add /tmp/homebridge-dobiss-lan-0.5.14.tgz
```

5. Open **Plugins** and verify that `homebridge-dobiss-lan` version `0.5.14`
   is shown.
6. Open **Settings** and add the Dobiss configuration or verify the existing
   configuration.
7. Restart Homebridge or only the plugin's child bridge.
8. Check the Homebridge log for `DobissLAN`, connection errors, and invalid
   configuration warnings.

If `curl` is unavailable in the UI terminal, download the file on a computer,
copy it to a shared folder using DSM File Station, and use its full path in
step 4.

## Method 2: SSH

If necessary, temporarily enable SSH under **DSM > Control Panel > Terminal &
SNMP > Enable SSH service**. Disable SSH afterwards if you do not normally use
it.

1. Connect to the NAS from a computer:

```bash
ssh <DSM-USER>@<SYNOLOGY-IP-ADDRESS>
```

2. Download the release to a temporary file:

```bash
curl -L https://github.com/EricVanasch/homebridge-dobiss/releases/download/v0.5.14/homebridge-dobiss-lan-0.5.14.tgz -o /tmp/homebridge-dobiss-lan-0.5.14.tgz
```

3. Install or update the plugin using the Homebridge service manager:

```bash
sudo hb-service add /tmp/homebridge-dobiss-lan-0.5.14.tgz
```

4. Restart Homebridge:

```bash
sudo hb-service restart
```

5. Follow the log during startup:

```bash
sudo hb-service logs
```

Press `Ctrl+C` to leave the live log.

## Configuration example

Add this platform to `config.json`, or use the plugin settings form. Adjust the
host, modules, and manually configured outputs for your installation.

```json
{
  "platform": "DobissLAN",
  "name": "Dobiss LAN",
  "host": "192.168.68.164",
  "port": 10001,
  "pollIntervalSeconds": 30,
  "toggleOnStatusReadFailure": true,
  "aggressiveStatusRetries": false,
  "autoDiscover": true,
  "discoveryModules": [1, 2, 3, 4, 5],
  "lights": []
}
```

Auto-discovery presents discovered Dobiss lighting outputs as lights in
HomeKit by default. For a manually configured regular output, `type` remains
the Dobiss protocol type while `homeKitType` controls its HomeKit presentation:

```json
{
  "name": "Kitchen",
  "type": "switch",
  "homeKitType": "light",
  "module": 3,
  "output": 0
}
```

## Verification

After restarting, verify that:

- **Plugins** shows `homebridge-dobiss-lan` version `0.5.14`;
- the log does not contain repeated TCP timeouts to the DO5435;
- dimmers can be switched on and off and set to a brightness level;
- regular lighting outputs appear as lights in HomeKit;
- physical push-button changes are reflected within approximately 30 seconds.

## Troubleshooting

### The installation command cannot find `hb-service`

With the official Synology package, use a regular DSM SSH session and run the
command with `sudo`. The official installation uses these locations and
commands:

- configuration: `/volume1/homebridge/config.json`;
- plugins: `/volume1/homebridge/node_modules`;
- Homebridge log: `sudo hb-service logs`.

The volume can differ if the `homebridge` shared folder is not stored on
`volume1`.

### The UI does not return

Check the log first:

```bash
sudo hb-service logs
```

If a plugin-related error prevents Homebridge from starting, remove only this
plugin:

```bash
sudo hb-service remove homebridge-dobiss-lan
sudo hb-service restart
```

Restore the Homebridge backup created earlier if necessary.

### HomeKit still shows a generic switch

- Verify that version `0.5.14` is active.
- For manually configured regular outputs, verify `"type": "switch"` and
  `"homeKitType": "light"`.
- Restart the main bridge or child bridge after every configuration change.

## Official Homebridge references

- <https://github.com/homebridge/homebridge/wiki/Install-Homebridge-on-Synology-DSM>
- <https://github.com/homebridge/homebridge-syno-spk>
