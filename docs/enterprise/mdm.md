---
title: MDM Deployment
description: How to deploy Ion Engine enterprise configuration via MDM profiles, Group Policy, and system config files.
sidebar_position: 2
---

# MDM Deployment

Enterprise configuration can be deployed through platform-native device management tools. Each platform has a primary delivery mechanism and a universal fallback via environment variable.

## Source resolution order

The engine checks for enterprise config in this order and uses the first source it finds:

1. `ION_ENTERPRISE_CONFIG` environment variable (all platforms, checked first)
2. Platform-native source (see below)

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

`auth.requireOperatorIdentity` is a sealed startup gate. The engine refuses `start_session` and `send_prompt` until the selected interactive provider has a usable grant. Ion Desktop keeps its standalone splash visible and shows the organization sign-in control before it creates the owner renderer, so extensions cannot start first. Do not combine this field with an OAuth entry that uses `machineIdentity`; machine sources have no operator login flow.

### Verification

After the profile is installed, verify the engine reads it:

```bash
defaults read com.ion.engine
```

## Windows: Group Policy (Registry)

The engine reads from the Windows Registry under the policies key.

### Registry path

```
HKLM\SOFTWARE\Policies\IonEngine
```

### Registry structure

Enterprise config maps to registry values under the `IonEngine` key. Complex structures (objects, arrays) are stored as JSON string values.

| Value name | Type | Example |
|------------|------|---------|
| `AllowedModels` | `REG_SZ` (JSON array) | `["claude-sonnet-4-6"]` |
| `BlockedModels` | `REG_SZ` (JSON array) | `[]` |
| `AllowedProviders` | `REG_SZ` (JSON array) | `["anthropic"]` |
| `Auth` | `REG_SZ` (JSON object) | `{"identityProvider":"corp","requireOperatorIdentity":true,"oauth":{"corp":{"issuerUrl":"...","clientId":"..."}}}` |
| `Permissions` | `REG_SZ` (JSON object) | `{"mode":"ask"}` |
| `Telemetry` | `REG_SZ` (JSON object) | `{"enabled":true}` |
| `Network` | `REG_SZ` (JSON object) | `{"proxy":{"httpProxy":"..."}}` |
| `ConfigJson` | `REG_SZ` (JSON object) | `{"limits":{"planModeAllowedBashCommands":["git log"]}}` |

`ConfigJson` is the general-purpose escape hatch: its keys are merged into the enterprise config root, so it is how you set nested blocks that have no dedicated registry value of their own. The plan-mode Bash ceiling is one of these — set it via `ConfigJson` rather than expecting a `Limits` value name.

### Group Policy template

Deploy via a custom ADMX template or a configuration management tool (Intune, SCCM) that writes registry values.

```powershell
# Example: set via PowerShell
New-Item -Path "HKLM:\SOFTWARE\Policies\IonEngine" -Force
Set-ItemProperty -Path "HKLM:\SOFTWARE\Policies\IonEngine" `
  -Name "AllowedModels" `
  -Value '["claude-sonnet-4-6","claude-haiku-4-5-20251001"]'
Set-ItemProperty -Path "HKLM:\SOFTWARE\Policies\IonEngine" `
  -Name "Permissions" `
  -Value '{"mode":"ask"}'
```

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

This is checked first on all platforms. It is useful for:

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

## Desktop app distribution (signed .pkg)

The sections above deliver engine *configuration*. This section covers pushing the Ion **desktop application** binary itself to managed Macs. Self-service users install the signed, notarized package and update through the app's built-in auto-updater; managed fleets pin the version and push the same installer package.

### The artifact

Each desktop release publishes a component installer, `Ion-<version>.pkg`, on the GitHub release. CI builds it (`build-pkg.sh`), signs it with a Developer ID Installer certificate (`productsign`), and notarizes it. The package installs `Ion.app` to `/Applications` and force-replaces any existing copy. On first launch the app self-installs its launchd LaunchAgent (`com.ion.engine`) and installs/updates the engine daemon binary at `~/.ion/bin/ion`, swapping it by content hash. No additional endpoint steps are required.

Verify a package before distributing:

```bash
pkgutil --check-signature Ion-<version>.pkg   # Developer ID Installer
spctl -a -vvv -t install Ion-<version>.pkg    # Gatekeeper accepts
```

### Push via Jamf / Intune

Upload `Ion-<version>.pkg` as a managed package and scope it to the target devices. The package refuses before it replaces `/Applications/Ion.app` when Ion is still running. MDM run-time policies can defer the package until the user quits Ion.

### Disable the in-app auto-updater on managed machines

A managed fleet owns the version lifecycle, so the app must not self-update and fight the pinned version. Set the kill switch in the desktop-owned `customFields['ion-desktop']` namespace of the same `com.ion.engine` Managed Preferences payload:

```xml
<key>customFields</key>
<dict>
  <key>ion-desktop</key>
  <dict>
    <key>disableAutoUpdate</key>
    <true/>
  </dict>
</dict>
```

With this set, the desktop skips its update check and install-on-quit entirely (`initAutoUpdater`), and version changes arrive only through your pushed `.pkg`.

### CI signing prerequisites

The release pipeline signs and notarizes the package when these repository secrets are present:

| Secret | Purpose |
|--------|---------|
| `APPLE_CERT_BASE64` / `APPLE_CERT_PASSWORD` | Developer ID **Application** cert — signs `Ion.app` |
| `APPLE_INSTALLER_CERT_BASE64` / `APPLE_INSTALLER_CERT_PASSWORD` | Developer ID **Installer** cert — `productsign` for the `.pkg` (a distinct cert type from the Application cert) |
| `APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` | App Store Connect API key (base64-encoded `.p8`) — notarization for both the app and the pkg |

Without the Installer cert, CI still builds the `.pkg` but leaves it unsigned, which is not usable for MDM push.
