# Ion Mobile MDM Deployment Guide

This guide is for MDM administrators deploying Ion Remote (iOS) and Ion Engine (macOS desktop) in a managed environment. When configured correctly, every Ion log line carries stable, MDM-assigned device identity fields (`mdm_device_id`, `mdm_serial`) that enable cross-reference to Intune and other MDM consoles directly from Grafana.

---

## iOS — Managed App Config

Ion Remote reads two keys from the Apple [Managed App Config](https://developer.apple.com/documentation/devicemanagement/implementing_device_management/managed_app_configuration_and_feedback) dictionary. These appear as `mdm_device_id` and `mdm_serial` in the `fields` object of every iOS log line.

### Keys

| Key | Purpose |
|---|---|
| `MDMDeviceID` | MDM-assigned device identifier (e.g. Intune `deviceid`) |
| `MDMSerialNumber` | Hardware serial number as known to the MDM console |

### Intune substitution variables

Intune supports substitution variables in App Configuration Policies. Use these so each device receives its own values automatically:

| Key | Intune substitution |
|---|---|
| `MDMDeviceID` | `{{deviceid}}` |
| `MDMSerialNumber` | `{{serialnumber}}` |

### How to configure in Intune

1. Navigate to **Intune admin center** → **Apps** → **App configuration policies** → **Add** → **Managed devices**.
2. Select platform: **iOS/iPadOS**.
3. Associate the policy with the Ion Remote app.
4. Under **Configuration settings**, set format to **Use configuration designer**.
5. Add the following key-value pairs:

| Configuration key | Value type | Configuration value |
|---|---|---|
| `MDMDeviceID` | String | `{{deviceid}}` |
| `MDMSerialNumber` | String | `{{serialnumber}}` |

6. Assign the policy to the target device groups and save.

### Sample JSON key-value snippet (XML format alternative)

```json
{
  "kind": "Managed App Configuration",
  "version": "1",
  "content": {
    "MDMDeviceID": "{{deviceid}}",
    "MDMSerialNumber": "{{serialnumber}}"
  }
}
```

For MDM platforms that accept a raw plist payload, the equivalent is:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>MDMDeviceID</key>
  <string>{{deviceid}}</string>
  <key>MDMSerialNumber</key>
  <string>{{serialnumber}}</string>
</dict>
</plist>
```

> **Note:** `UIDevice.identifierForVendor` (the `device_id` field) is always stamped by Ion Remote regardless of MDM enrollment. The MDM fields add cross-reference capability; they do not replace the stable hardware identity.

---

## macOS — Custom Configuration Profile

On macOS, Ion Engine reads the same two keys from `/Library/Managed Preferences/com.ion.engine.plist`. The engine's log egress forwarder stamps them on every egress record as `mdm_device_id` and `mdm_serial` in `fields`. The desktop process does the same for its own log lines.

### Custom profile payload

Push a custom configuration profile with the following payload key path: `com.ion.engine`.

Sample plist payload (embed inside a `.mobileconfig`):

```xml
<key>PayloadContent</key>
<array>
  <dict>
    <key>PayloadType</key>
    <string>com.apple.ManagedClient.preferences</string>
    <key>PayloadIdentifier</key>
    <string>com.ion.engine.managed</string>
    <key>PayloadUUID</key>
    <string><!-- generate a unique UUID --></string>
    <key>PayloadVersion</key>
    <integer>1</integer>
    <key>PayloadEnabled</key>
    <true/>
    <key>PayloadScope</key>
    <string>System</string>
    <key>PayloadContent</key>
    <dict>
      <key>com.ion.engine</key>
      <dict>
        <key>Forced</key>
        <array>
          <dict>
            <key>mcx_preference_settings</key>
            <dict>
              <key>MDMDeviceID</key>
              <string><!-- Intune: {{deviceid}} or your MDM substitution --></string>
              <key>MDMSerialNumber</key>
              <string><!-- Intune: {{serialnumber}} or your MDM substitution --></string>
            </dict>
          </dict>
        </array>
      </dict>
    </dict>
  </dict>
</array>
```

Intune custom attribute substitution variables for macOS profiles vary by MDM version; consult your Intune documentation for the correct macOS device attribute variable syntax.

---

## Windows — Registry policy

On Windows the same two keys are registry values under the engine's policy key,
`HKLM\SOFTWARE\Policies\IonEngine`:

| Value name | Type | Data |
|------------|------|------|
| `MDMDeviceID` | `REG_SZ` | Your MDM's device identifier |
| `MDMSerialNumber` | `REG_SZ` | Hardware serial number as the MDM console knows it |

Deliver them the same way you deliver any other Ion policy: through the
`IonEngine.admx` template's key, an Intune platform script, or Group Policy
preferences. Intune's Win32 and script surfaces do not expand `{{deviceid}}`
substitutions the way managed app config does, so write the values from a
script that reads them from the device, or push them per device group.

```powershell
New-Item -Path "HKLM:\SOFTWARE\Policies\IonEngine" -Force | Out-Null
Set-ItemProperty -Path "HKLM:\SOFTWARE\Policies\IonEngine" -Name "MDMDeviceID" -Value "<device id>"
Set-ItemProperty -Path "HKLM:\SOFTWARE\Policies\IonEngine" -Name "MDMSerialNumber" -Value "<serial>"
```

The desktop reads both at startup (`machine-identity.ts`) alongside
`MachineGuid` from `HKLM\SOFTWARE\Microsoft\Cryptography`, which supplies
`machine_id` on this platform. Both names are reserved in the engine's
enterprise reader: it skips them rather than reporting them as unknown policy
values.

Neither value is required. A device that is not enrolled simply reports empty
`mdm_device_id` and `mdm_serial`, logged at DEBUG rather than WARN.

---

## What appears in Grafana after enrollment

Once enrolled devices are sending logs through Ion's egress pipeline:

- The **Ion Mobile** dashboard (`docs/observability/dashboards/src/dashboards/mobile.ts`) shows `mdm_device_id` and `mdm_serial` as columns in the **App version by device** and **Device→desktop pairing** tables.
- LogQL queries can filter or group by `fields_mdm_device_id` (Alloy-promoted as a structured metadata field) to scope any panel to a specific MDM device ID.
- Cross-reference example: take an `mdm_device_id` from an Ion log line, look it up in Intune's device inventory to find the user, device compliance state, and assigned policies.

### Field availability

| Field | iOS | macOS desktop | macOS engine |
|---|---|---|---|
| `mdm_device_id` in log `fields` | Yes (Managed App Config) | Yes (managed plist, desktop log) | Yes (managed plist, egress record) |
| `mdm_serial` in log `fields` | Yes (Managed App Config) | Yes (managed plist, desktop log) | Yes (managed plist, egress record) |

Fields are absent (never empty strings) when the device is not enrolled or the managed config does not carry the key.
