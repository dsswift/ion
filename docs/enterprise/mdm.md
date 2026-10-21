---
title: MDM Deployment
description: How to deploy Ion Engine enterprise configuration via MDM profiles, Group Policy, and system config files.
sidebar_position: 2
---

# MDM Deployment

Enterprise configuration can be deployed through platform-native device management tools. Each platform has a primary delivery mechanism and a universal fallback via environment variable.

## Source resolution order

On an unmanaged installation the engine checks `ION_ENTERPRISE_CONFIG` first on every platform. When that variable names a readable JSON file, that file is the whole enterprise config and no platform source is consulted. On a [managed installation](#managed-mode) the variable is ignored.

Otherwise the engine reads its platform-native source:

| Platform | Source |
|----------|--------|
| macOS | `/Library/Managed Preferences/com.ion.engine.plist` |
| Windows | `%ProgramData%\Ion\enterprise-config.json` + `enterprise-config.d\*.json`, then `HKLM\SOFTWARE\Policies\IonEngine` overlaid on top |
| Linux | `/etc/ion/config.json` + `/etc/ion/config.d/*.json` |

Within a platform the listed sources are merged, not raced: a later source overlays the earlier ones field by field.

A host that serves more than one person can scope further policy to specific accounts. That policy is still part of the machine source listed above: see [Account policies](sealed-config.md#account-policies).

This page describes the **machine layer** -- the sole policy enforcer. A second,
additive-only **per-user layer** lets IT provision a per-person environment catalog for a client that offers one, without giving a person-writable file any power to loosen policy. See
[Enterprise Configuration](../configuration/enterprise.md) for the two-layer model.

## Managed mode

Policy and the application usually arrive as separate packages. If the policy package is removed, unassigned, or never installed, an engine with no other signal runs with no restrictions, which is correct for a personal machine and wrong for a fleet device. The **managed-mode marker** is that signal. It says "this installation is supposed to be managed", and it is separate from the policy so it still says so when the policy is missing.

The marker is a JSON file an administrator places where a standard user cannot write:

| Platform | Marker path |
|----------|-------------|
| macOS | `/Library/Application Support/Ion/managed.json` |
| Windows | `%ProgramData%\Ion\managed.json` |
| Linux | `/etc/ion/managed.json` |

```json
{"managed": true}
```

On Windows the engine resolves `%ProgramData%` from the system's known-folder table, not from the environment variable of that name, for the marker and for the policy files alike.

No marker means unmanaged, and nothing on this page changes. A marker that exists but cannot be read or parsed counts as managed. Only an explicit `{"managed": false}` opts back out.

With the marker present:

| Condition | What the engine does | Log line (`~/.ion/engine.jsonl`) | Telemetry event |
|-----------|----------------------|----------------------------------|-----------------|
| No machine policy resolves | Starts **locked**. Every prompt is refused with error code `managed_policy_absent`, and no extension is loaded. | `ERROR` `enterprise policy expected and absent` | `enforcement.managed_policy_absent` |
| `ION_ENTERPRISE_CONFIG` is set | Ignores the variable and reads the machine source. | `WARN` `enterprise policy override refused` | `enforcement.managed_override_refused` |

Both conditions also reach clients. The policy blob from `get_enterprise_policy` carries a `managedMode` object, present only on a managed installation:

```json
{"managedMode": {"managed": true, "policyAbsent": true, "overrideRefused": true}}
```

A client shows a notice for each condition. The engine stamps `managedMode` itself, so a policy file cannot set it.

The marker and the policy are read when the engine starts. After restoring policy on a locked device, restart the engine.

The marker says the installation is managed. It does not make the user's configuration files managed. To own those, see [Managed configuration files](managed-config.md).

### Placing the marker

```bash
# macOS
sudo mkdir -p "/Library/Application Support/Ion"
echo '{"managed": true}' | sudo tee "/Library/Application Support/Ion/managed.json"

# Linux
sudo mkdir -p /etc/ion
echo '{"managed": true}' | sudo tee /etc/ion/managed.json
```

Leave both owned by root and not writable by anyone else. On Windows the marker is `%ProgramData%\Ion\managed.json`, written by the deployment that installs the engine.

## macOS: Managed Preferences

The engine reads from the `com.ion.engine` preference domain. Deploy this via an MDM profile (Jamf, Mosyle, Kandji, Fleet, etc.) as a custom settings payload.

### Config profile location

```
/Library/Managed Preferences/com.ion.engine.plist
```

### MDM profile example (Jamf)

Create a Configuration Profile with a Custom Settings payload targeting the `com.ion.engine` preference domain. The payload is a property list containing the enterprise config keys.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>allowedModels</key>
  <array>
    <string>claude-sonnet-4-6</string>
    <string>claude-haiku-4-5-20251001</string>
  </array>
  <key>allowedProviders</key>
  <array>
    <string>anthropic</string>
  </array>
  <key>auth</key>
  <dict>
    <key>identityProvider</key>
    <string>corp</string>
    <key>requireOperatorIdentity</key>
    <true/>
    <key>oauth</key>
    <dict>
      <key>corp</key>
      <dict>
        <key>issuerUrl</key>
        <string>https://login.corp.example.com/tenant/v2.0</string>
        <key>clientId</key>
        <string>managed-public-client-id</string>
        <key>scopes</key>
        <array><string>openid</string><string>profile</string><string>offline_access</string></array>
      </dict>
    </dict>
  </dict>
  <key>permissions</key>
  <dict>
    <key>mode</key>
    <string>ask</string>
  </dict>
  <key>limits</key>
  <dict>
    <key>planModeAllowedBashCommands</key>
    <array>
      <string>git log</string>
      <string>git diff</string>
      <string>gh pr view</string>
      <string>ls</string>
    </array>
  </dict>
  <key>telemetry</key>
  <dict>
    <key>enabled</key>
    <true/>
    <key>targets</key>
    <array>
      <string>http</string>
    </array>
    <key>httpEndpoint</key>
    <string>https://siem.corp.example.com/ingest/ion</string>
  </dict>
</dict>
</plist>
```

`auth.requireOperatorIdentity` is a sealed startup gate. The engine refuses `start_session` and `send_prompt` until the selected interactive provider has a usable grant. A client should show its sign-in control before it starts any session, so extensions cannot start first. Do not combine this field with an OAuth entry that uses `machineIdentity`; machine sources have no operator login flow.

### Verification

After the profile is installed, verify the engine reads it:

```bash
defaults read com.ion.engine
```

## Windows: registry policy and ProgramData

The engine reads two Windows sources and merges them, in this order:

1. `%ProgramData%\Ion\enterprise-config.json` -- main file
2. `%ProgramData%\Ion\enterprise-config.d\*.json` -- drop-in overrides, merged alphabetically
3. `HKEY_LOCAL_MACHINE\SOFTWARE\Policies\IonEngine` -- registry policy, overlaid on top

Registry policy wins over the ProgramData files. The machine hive is the only hive read: the engine never reads `HKEY_CURRENT_USER`, so a user cannot author their own policy.

### Value names are field names

The reader addresses registry values by reflecting over the engine's `EnterpriseConfig` struct. Any field's JSON name is a valid value name, matched case-insensitively -- there is no hand-maintained list to fall behind the schema.

| Value name | Registry type | Example data |
|------------|---------------|--------------|
| `AllowedModels` | `REG_MULTI_SZ` | `claude-sonnet-4-6` / `claude-haiku-4-5-20251001` (one per line) |
| `BlockedModels` | `REG_MULTI_SZ` | one model ID per line |
| `AllowedProviders` | `REG_MULTI_SZ` | `anthropic` |
| `McpAllowlist` | `REG_MULTI_SZ` | `filesystem` / `github` |
| `McpDenylist` | `REG_MULTI_SZ` | one server name per line |
| `Auth` | `REG_SZ` (JSON object) | `{"identityProvider":"corp","requireOperatorIdentity":true}` |
| `Permissions` | `REG_SZ` (JSON object) | `{"mode":"ask"}` |
| `Telemetry` | `REG_SZ` (JSON object) | `{"enabled":true}` |
| `Network` | `REG_SZ` (JSON object) | `{"proxy":{"httpProxy":"http://proxy.corp.example.com:8080"}}` |
| `Limits` | `REG_SZ` (JSON object) | `{"planModeAllowedBashCommands":["git log","git diff"]}` |
| `ConfigJson` | `REG_MULTI_SZ` or `REG_SZ` (JSON object) | the whole enterprise config as one object |

### Value typing rules

The reader accepts more than one registry type per field and converts:

| Registry type | List field | Object field | Text field | Boolean field |
|---------------|------------|--------------|------------|---------------|
| `REG_SZ` / `REG_EXPAND_SZ` | JSON array text | JSON object text | verbatim | JSON `true` / `false` |
| `REG_MULTI_SZ` | one entry per line | lines joined with newlines, then parsed as JSON | lines joined with newlines | lines joined, then parsed |
| `REG_DWORD` / `REG_QWORD` | rejected | rejected | decimal text | non-zero is true |

An unrecognized value name is logged at `WARN` (`unknown enterprise policy value name`) and ignored. A recognized value that fails to decode is logged at `WARN` (`enterprise policy value skipped`) and skipped -- every other value still applies. `MDMDeviceID` and `MDMSerialNumber` are reserved: the desktop reads them for machine identity, and the engine skips them rather than reporting them as unknown.

### `ConfigJson` is the escape hatch

`ConfigJson` (alias: `Config`) holds a whole enterprise config object whose keys are merged at the root. Every other value overlays it, so a dedicated value name wins over the same key inside `ConfigJson`.

Use it for nested fields that have no top-level value name of their own:

| Setting | `ConfigJson` shape |
|---------|--------------------|
| Require operator sign-in | `{"auth":{"requireOperatorIdentity":true}}` |
| A client-namespace field (the archived Ion Studio desktop read `disableAutoUpdate` here) | `{"customFields":{"ion-desktop":{"disableAutoUpdate":true}}}` |

### Setting policy with PowerShell

```powershell
New-Item -Path "HKLM:\SOFTWARE\Policies\IonEngine" -Force | Out-Null
New-ItemProperty -Path "HKLM:\SOFTWARE\Policies\IonEngine" `
  -Name "AllowedModels" -PropertyType MultiString `
  -Value @("claude-sonnet-4-6", "claude-haiku-4-5-20251001") -Force | Out-Null
New-ItemProperty -Path "HKLM:\SOFTWARE\Policies\IonEngine" `
  -Name "Permissions" -PropertyType String `
  -Value '{"mode":"ask"}' -Force | Out-Null
New-ItemProperty -Path "HKLM:\SOFTWARE\Policies\IonEngine" `
  -Name "ConfigJson" -PropertyType MultiString `
  -Value @('{"customFields":{"ion-desktop":{"disableAutoUpdate":true}}}') -Force | Out-Null
```

### Group Policy / Intune template

The archived Ion Studio shipped `IonEngine.admx` and `en-US/IonEngine.adml` policy templates with every desktop release (`Ion-PolicyTemplates-<version>.zip`). They give administrators a real settings UI for the values above and still describe the engine's value names.

- **Domain Central Store:** copy `IonEngine.admx` to `\\<domain>\SYSVOL\<domain>\Policies\PolicyDefinitions\` and `en-US\IonEngine.adml` to the `en-US` subfolder. The settings appear under Computer Configuration > Administrative Templates > Ion Engine.
- **Intune ADMX ingestion:** Devices > Configuration > Import ADMX, upload the `.admx` and its `.adml`, then create a Settings Catalog profile from the imported template.

The template is Machine class only, matching the hive the engine reads.

### Verification

```powershell
reg query HKLM\SOFTWARE\Policies\IonEngine
```

The engine logs `loaded enterprise config from windows registry` and a `windows registry policy read` summary line to `%USERPROFILE%\.ion\engine.jsonl` on startup. Restart the Ion Engine scheduled task for a policy change to take effect.

## Linux: System config files

The engine reads from two locations, merged in order:

1. `/etc/ion/config.json` -- main enterprise config file
2. `/etc/ion/config.d/*.json` -- drop-in override files, merged alphabetically

Drop-in files allow configuration management tools (Puppet, Chef, Ansible, Salt) to deliver partial overrides without managing the entire config file.

### Main config file

```bash
sudo mkdir -p /etc/ion
sudo cat > /etc/ion/config.json << 'EOF'
{
  "allowedProviders": ["anthropic"],
  "auth": {
    "identityProvider": "corp",
    "requireOperatorIdentity": true,
    "oauth": {
      "corp": {
        "issuerUrl": "https://login.corp.example.com/tenant/v2.0",
        "clientId": "managed-public-client-id",
        "scopes": ["openid", "profile", "offline_access"]
      }
    }
  },
  "permissions": {
    "mode": "ask"
  },
  "limits": {
    "planModeAllowedBashCommands": ["git log", "git diff", "gh pr view", "ls"]
  },
  "telemetry": {
    "enabled": true,
    "targets": ["http"],
    "httpEndpoint": "https://siem.corp.example.com/ingest/ion"
  }
}
EOF
```

The `limits.planModeAllowedBashCommands` key is the ceiling for shell commands a planning session may run. It uses the same key path as `engine.json`, so administrators and developers write the concept in one place rather than two.

Setting it caps every lower source — the developer's `~/.ion/engine.json`, any committed `.ion/engine.json` in a cloned repository, and the two client-supplied run-time paths. Omitting it entirely means no policy on this axis and lower layers compose freely; setting it to `[]` blocks Bash in plan mode outright. Because a narrower entry is retained against a broader ceiling, write the ceiling at the broadest level you are willing to permit. See [Sealed Configuration → Plan-mode Bash allowlist](sealed-config.md#plan-mode-bash-allowlist).

### Drop-in files

```bash
# /etc/ion/config.d/10-network.json
{
  "network": {
    "proxy": {
      "httpProxy": "http://proxy.corp.example.com:8080",
      "httpsProxy": "http://proxy.corp.example.com:8080",
      "noProxy": "localhost,127.0.0.1"
    },
    "customCaCerts": ["/etc/pki/tls/certs/corp-ca.pem"]
  }
}
```

```bash
# /etc/ion/config.d/20-sandbox.json
{
  "sandbox": {
    "required": true,
    "allowDisable": false
  }
}
```

Drop-in files are merged alphabetically. Use numeric prefixes (`10-`, `20-`) to control ordering.

## Environment variable fallback

On any platform, set `ION_ENTERPRISE_CONFIG` to the path of a JSON file containing the enterprise config:

```bash
export ION_ENTERPRISE_CONFIG=/opt/ion/enterprise-config.json
```

On an unmanaged installation this is checked first on all platforms. A [managed installation](#managed-mode) ignores it. It is useful for:

- Containerized deployments where MDM is not available
- CI/CD environments
- Testing enterprise config locally before deploying via MDM

## File permissions

Enterprise config files should be readable by all users but writable only by root/admin:

```bash
# Linux
sudo chmod 644 /etc/ion/config.json
sudo chown root:root /etc/ion/config.json
```

On macOS, Managed Preferences are protected by the system and do not need manual permission changes.
