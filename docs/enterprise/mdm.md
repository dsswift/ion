---
title: MDM Deployment
description: How to deploy Ion Engine enterprise configuration via MDM profiles, Group Policy, and system config files.
sidebar_position: 2
---

# MDM Deployment

Enterprise configuration can be deployed through platform-native device management tools. Each platform has a primary delivery mechanism and a universal fallback via environment variable.

## Source resolution order

The engine checks `ION_ENTERPRISE_CONFIG` first on every platform. When that variable names a readable JSON file, that file is the whole enterprise config and no platform source is consulted.

Otherwise the engine reads its platform-native source:

| Platform | Source |
|----------|--------|
| macOS | `/Library/Managed Preferences/com.ion.engine.plist` |
| Windows | `%ProgramData%\Ion\enterprise-config.json` + `enterprise-config.d\*.json`, then `HKLM\SOFTWARE\Policies\IonEngine` overlaid on top |
| Linux | `/etc/ion/config.json` + `/etc/ion/config.d/*.json` |

Within a platform the listed sources are merged, not raced: a later source overlays the earlier ones field by field.

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
| Disable the desktop auto-updater | `{"customFields":{"ion-desktop":{"disableAutoUpdate":true}}}` |
| Pin the desktop presentation | `{"customFields":{"ion-desktop":{"activeUiPolicy":"studio"}}}` |

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

`packaging/windows/intune/Set-IonPolicy.ps1` is a ready-to-assign version of this for tenants that deliver policy as an Intune platform script rather than through ADMX.

### Group Policy / Intune template

`packaging/windows/policy/IonEngine.admx` and `policy/en-US/IonEngine.adml` ship with every desktop release as `Ion-PolicyTemplates-<version>.zip`. They give administrators a real settings UI for the values above.

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

## Desktop app distribution, macOS (signed .pkg)

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

All signing and notarization secrets are required for a desktop release. CI stops before upload if the Installer certificate is absent, if notarization fails, or if Gatekeeper rejects the package.

## Desktop app distribution, Windows (.intunewin)

The Windows equivalent of the `.pkg` section above. Each desktop release
publishes `Ion-Setup-<version>-x64.intunewin` -- the NSIS installer already
wrapped by the Microsoft Win32 Content Prep Tool -- plus the version-stamped
`Detect-Ion.ps1` it pairs with and `Ion-PolicyTemplates-<version>.zip`.

x64 is the supported target. An `arm64` installer is published as a
best-effort cross-build; it is neither verified nor supported.

### Win32 app settings

| Setting | Value |
|---------|-------|
| Install command | `Ion-Setup-<version>-x64.exe /S /allusers` |
| Uninstall command | `"%ProgramFiles%\Ion\Uninstall Ion.exe" /allusers /S` |
| Install behavior | System |
| Detection rule | Custom detection script -- upload the stamped `Detect-Ion.ps1`. Run as 32-bit: No. |
| Return codes | `0` = Success |

`/allusers` is what forces the per-machine install into `%ProgramFiles%\Ion`.
Without it the assisted installer installs per-user, which under a
System-context Intune deployment means into the SYSTEM profile.

### Per-machine app, per-user engine

The Win32 app lands the binaries for the whole device. It does not start
anything. The engine supervisor is a **per-user** Scheduled Task named
`Ion Engine (<SID>)`, registered on that user's first launch of Ion. The name
carries the account's SID because a task name is machine-global: a single
shared `Ion Engine` would be one registration for every account on a
multi-session host. Releases that predate this registered that shared name,
and the first launch after an upgrade retires it for the current user.

So each signed-in user gets their own engine, their own `%USERPROFILE%\.ion`
data directory, and their own loopback port derived from their own SID (in
`51000-54999`). That split is deliberate: conversations, credentials, and logs
are per-user data, and a machine-wide engine would share them across everyone
on the device.

There is **no shared fallback address at any layer**. A fixed port would let a
second user's desktop attach to the first user's engine -- their
conversations, their credentials, their file access -- with nothing on screen
to say so. When the SID cannot be read, the engine refuses to start and the
desktop reports that it has no address, rather than either picking one.

The per-user port is an addressing decision, not an authorization one: it
stops two engines colliding, and it does not stop another signed-in user
scanning the range. Authorization is the engine's, which checks each loopback
peer's process token against its own user and refuses a connection from a
different account.

To check a device, name the exact task or enumerate -- `schtasks /TN` takes an
exact name and has no wildcard syntax:

```powershell
$sid = ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
schtasks /Query /TN "Ion Engine ($sid)" /V /FO LIST
Get-ScheduledTask | Where-Object TaskName -like 'Ion Engine*' | Format-List TaskName, State
```

### Uninstall

The uninstaller removes every Ion Engine scheduled task on the machine, not
just the one belonging to whoever ran it -- tasks live in
`C:\Windows\System32\Tasks` rather than in a profile, so an elevated
uninstall reaches accounts that are signed out and accounts whose profile
container is not mounted. A task is removed only when its name is one Ion
registers **and** its registered action proves it launches Ion from an
installed Ion directory; anything else is skipped and logged.

Nothing in a user profile is touched. `%USERPROFILE%\.ion` holds
conversations, credentials and settings and survives uninstall.
`%ProgramData%\Ion` holds administrator-authored policy and survives too.

If an uninstall ran without sufficient rights, the same code is left on the
device at `%ProgramData%\Ion\Remove-IonEngineTasks.ps1` and an administrator
runs it directly to finish the job. `-Detect` reports what remains without
removing anything, which makes it usable as an Intune remediation-detection
script.

### Pin the version, disable the updater

Same reasoning as the macOS section: a managed fleet owns the version
lifecycle, so the desktop must not self-update. On Windows the kill switch
arrives as registry policy rather than a plist -- through the ADMX
`ConfigJson` setting, or `Set-IonPolicy.ps1`:

```json
{"customFields":{"ion-desktop":{"disableAutoUpdate":true}}}
```

With that set the desktop skips its update check and its install path
entirely, and new versions arrive only when you assign them.

### Deliver policy as its own app

Policy changes more often than the application does, so it ships as a second
Win32 app -- the Ion Enterprise Policy package -- declared as a **dependency**
of Ion Studio with "Automatically install" set to Yes. Intune applies a
dependency before the app that declares it, which is what makes the engine
find its configuration on first launch rather than starting unmanaged. It also
means a scope list changes without redeploying the application, and a policy
change rolls back on its own.

The package writes only the values it declares, records what it owns outside
the policy key, verifies every value by reading it back, and on uninstall
removes only what it placed. It also carries the theme pack the policy's
`themePolicy` locks, installed under `%ProgramData%\Ion\themes\<id>`: a
device that applied a locked theme policy without the pack would fall back to
a built-in theme and still report itself compliant.

Build it with `packaging/windows/intune/policy/New-IonPolicyIntuneWin.ps1`,
which produces the `.intunewin`, the stamped detector and a provenance
manifest in one step. The tool refuses any config carrying a credential
(machine policy under HKLM is readable by every account on the device), an
unfilled placeholder, a missing production field, or a theme pack that is not
the one the policy locks.

### Signature and provenance

Signing is decided before the build, and there is no path that publishes an
unsigned installer while claiming otherwise:

| Configuration | Outcome |
|---|---|
| A code-signing certificate is configured | The installer is signed; a signing failure fails the release. |
| Signing is required and no certificate is configured | The release stops before building. |
| Neither | The build proceeds and every artifact is labelled unsigned in its provenance manifest. |

Every release publishes `Ion-Artifacts-<version>-x64.json` and a matching
`.sha256`. Each artifact's SHA-256 and Authenticode status are read off the
file rather than taken from the build's intent, and a build from a dirty tree
is labelled `test-build` and `reproducible: false`. Verify the hash of what
you received against the manifest before assigning it.

An unsigned installer run by hand still hits SmartScreen. An Intune
System-context install does not prompt either way.

Full step-by-step, including the manual repackaging command and the policy
app's settings: `packaging/windows/intune/README.md`.
