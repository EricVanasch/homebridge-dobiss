# homebridge-dobiss-lan

Minimal Homebridge platform plugin for a Dobiss Ambiance Pro installation through the DO5435 LAN interface.

For Synology deployment through the Homebridge UI or SSH, see [INSTALLATIE.md](INSTALLATIE.md).

This version supports manually configured dimmer outputs and switch outputs.

Dimmer outputs send the command pattern confirmed from local captures:

```text
module output 01 ff ff brightness ff ff
```

For example, module `4`, output `2`, brightness `100`:

```text
04 02 01 ff ff 64 ff ff
```

Switch outputs read the module status first and only send a toggle when the current state differs from the HomeKit target. The confirmed toggle command pattern is:

```text
module output 02 ff ff 64 ff ff
```

For example, module `3`, output `0`:

```text
03 00 02 ff ff 64 ff ff
```

## Install Locally

From this folder:

```bash
npm link
```

Then on the Homebridge machine:

```bash
npm link homebridge-dobiss-lan
```

If this folder is already on the Homebridge machine, both commands can be run from this folder.

## Homebridge Config

Add a platform entry like this:

```json
{
  "platform": "DobissLAN",
  "name": "Dobiss LAN",
  "host": "192.168.68.164",
  "port": 10001,
  "sendInitFrame": true,
  "timeoutMs": 1500,
  "pollIntervalSeconds": 0,
  "startupPollDelaySeconds": 15,
  "logStatusPolls": false,
  "toggleOnStatusReadFailure": true,
  "aggressiveStatusRetries": false,
  "autoDiscover": true,
  "discoveryModules": [1, 2, 3, 4, 5],
  "lights": [
    {
      "name": "Test dimmer",
      "type": "dimmer",
      "module": 4,
      "output": 2,
      "initialBrightness": 100
    },
    {
      "name": "Test switch",
      "type": "switch",
      "homeKitType": "light",
      "module": 3,
      "output": 0
    }
  ]
}
```

## Notes

- Reserve the DO5435 IP address in DHCP before relying on this.
- Dimmers keep state optimistically inside Homebridge after a command succeeds.
- Switches read status before deciding whether a toggle is needed.
- Switch modules are polled every `pollIntervalSeconds` seconds so physical wall-button changes are pushed into HomeKit. The default is `0`, because the DO5435 can become unavailable to the Dobiss app when it is polled too aggressively.
- `startupPollDelaySeconds` delays the first status poll after Homebridge starts, so the DO5435 is not queried while discovery/startup traffic is still settling. The default is `15`.
- Switch status replies may arrive as one TCP packet, split packets, or direct status bytes without padding; these forms are parsed.
- Switch status reads use one gentle attempt by default. Set `aggressiveStatusRetries` to `true` only while debugging captures; it retries with slower module init fallbacks if Dobiss only returns echo/padding.
- Polling reads one status frame per switch module and updates all outputs from that module together.
- Status replies that contain only padding are ignored so the retry can wait for real output bytes.
- If a module status read still fails, the warning includes a short raw hex summary of the Dobiss replies for diagnosis.
- Switch status parsing requires the echoed status request prefix, which prevents module init echoes from being interpreted as real output states.
- Set `logStatusPolls` to `true` temporarily to log compact per-module output states like `0=off 1=on ...`; this helps verify module/output mappings.
- If the current Dobiss state cannot be read before a HomeKit write, the plugin falls back to the cached state so Home app control remains available.
- `toggleOnStatusReadFailure` defaults to `true`: when status is unavailable, every HomeKit switch write sends one Dobiss toggle. This makes manual Home app control usable when the cache is stale, but automations that repeatedly write the same target can still flip a switch the wrong way.
- HomeKit read requests return the cached switch state immediately; Dobiss status reads happen in the background to avoid slow Homebridge read-handler warnings at startup.
- When `autoDiscover` is enabled, configured `lights` are never overwritten. Discovery only adds missing `module/output` combinations.
- Dobiss `type` remains the protocol type (`switch` or `dimmer`). Use `homeKitType` (`light` or `switch`) to choose how a regular switch output appears in HomeKit. Dimmers always appear as lights.
- Auto-discovered outputs use `homeKitType: "light"`, so ordinary Dobiss light outputs appear as lamps in HomeKit. Existing manual switch entries without `homeKitType` keep their previous switch presentation.
- Discovery reads Dobiss module info first. Module type `0x08` is treated as a switch module and `0x10` as a dimmer module.
- `discoveryModules` controls which Dobiss module numbers are scanned. The default is `[1, 2, 3, 4, 5]`.
- Dobiss TCP commands are serialized because the DO5435 can refuse parallel connections.
- Discovery skips empty names, `reserve`, and generic `Uitgang ...` names.
