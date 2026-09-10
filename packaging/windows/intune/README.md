# Ion on Windows via Intune

Everything an administrator needs to add Ion Desktop to Microsoft Intune as a
Win32 app, and to deliver Ion Engine enterprise policy alongside it.

## Files here

| File | Purpose |
|------|---------|
| `Detect-Ion.ps1` | Intune detection script for the application. Packaged with a stamped version by `scripts/ci/make-intunewin.ps1`. |
| `Set-IonPolicy.ps1` | Optional Intune platform script that writes enterprise policy to the registry, for tenants not using ADMX ingestion. |
| `policy/New-IonPolicyIntuneWin.ps1` | One command from the tenant's config and theme to an uploadable `.intunewin`, a stamped detector and provenance. **This is the one to run.** |
| `policy/New-IonPolicyPackage.ps1` | Builds the package directory the wrapper wraps. Run it directly only to inspect a payload. |
| `policy/package/` | What that app runs on a device: install, uninstall, detect. |
| `policy/enterprise-config.example.json` | Placeholders only, documenting the required shape. The packaging tool refuses to package it. |

The ADMX/ADML template lives one directory up, in `packaging/windows/policy/`.

## Release assets

Each desktop release publishes, per architecture:

| Asset | What it is |
|-------|------------|
| `Ion-Setup-<version>-x64.exe` | The NSIS installer. x64 is the supported target. |
| `Ion-Setup-<version>-arm64.exe` | **Developer artifact, not a deployment target.** It exists for contributors running Windows on Apple silicon. It is cross-built on an x64 runner and is not exercised by CI. Do not add it to Intune. |
| `Ion-Setup-<version>-x64.intunewin` | The x64 installer wrapped as an Intune Win32 package. |
| `Detect-Ion.ps1` | The detection script, stamped with that release's version. |
| `Ion-PolicyTemplates-<version>.zip` | `IonEngine.admx` plus `en-US/IonEngine.adml`. |
| `latest.yml`, `*.blockmap` | The electron-updater feed. Ignore these for a managed fleet; pin the version instead and disable the in-app updater. |

## Win32 app settings

Upload `Ion-Setup-<version>-x64.intunewin` under Apps > Windows > Add >
Windows app (Win32). One x64 app covers the fleet; there is no ARM64 app,
because ARM64 is a developer build rather than a deployment target.

| Setting | Value |
|---------|-------|
| Install command | `Ion-Setup-<version>-x64.exe /S /allusers` |
| Uninstall command | `"%ProgramFiles%\Ion\Uninstall Ion.exe" /allusers /S` |
| Install behavior | System |
| Device restart behavior | No specific action |
| Return codes | `0` = Success, `2` = Failed, `3` = Failed. See below. |
| Detection rule | Use a custom detection script; upload the stamped `Detect-Ion.ps1`. Run as 32-bit: **No**. Enforce script signature check: **No**. |

`/S` is silent. `/allusers` is redundant now that the installer is built
per-machine only (`build.nsis.perMachine`), but it is kept in the documented
command because it is explicit about intent and costs nothing. Before that
change the flag was load-bearing: without it the NSIS assisted installer would
install per-user into the SYSTEM profile when Intune runs it in System context,
which is not what you want.

The uninstall command above is the `QuietUninstallString` the installer writes
to its uninstall key. Read it back from a test device rather than assuming, if
you have changed the product name:

```powershell
$key = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\7b1e4b3a-5d2c-4c7e-9f0a-2e6d8c1b4a53'
(Get-ItemProperty -Path $key).QuietUninstallString
```

That GUID is pinned in `desktop/package.json` (`build.nsis.guid`) and is stable
across releases, which is what makes both the detection script and the uninstall
command version-independent.

### Return codes

| Code | Meaning |
|------|---------|
| `0` | Installed. |
| `2` | NSIS aborted before installing anything. Almost always the single-instance guard: the installer takes a named mutex on its GUID and aborts immediately if one already exists. A previous installer process still running -- including one hung from an earlier attempt -- makes every later silent install return `2` in under a second, without touching the disk. |
| `3` | The application files did not unpack, so nothing was installed. The installer checks that its own executable is present before writing registry keys or shortcuts, and stops rather than reporting success. |

Map `2` and `3` to **Failed** in the Win32 app's return-code table. Both mean
nothing was installed, and both are worth retrying only after reading the log.

### Reading the install log

Every run appends to `Ion-Setup.log` in the deploying account's `%TEMP%`. An
Intune install runs as SYSTEM, so collect it from:

```
C:\Windows\Temp\Ion-Setup.log
```

A double-click install writes to the user's own temp directory instead.

```
--- Ion 1.82.0 setup ---
init: mode=silent
init: privileges=admin
init: instance=outer
init: installMode=all instdir=C:\Program Files\Ion
init: foundPerMachine=1 foundPerUser=0
extract: ok -- C:\Program Files\Ion\Ion.exe present
install: files placed in C:\Program Files\Ion (installMode=all)
install: ProgramData ACL for C:\ProgramData\Ion exit code 0
install: complete
```

`instdir` is the line to read first when an install "succeeds" but the
detection rule still fails -- it says where the files actually went, which is
not always where the command implied. A run that stops after `init:` never
reached the install section; a run whose last line is `extract: FAILED` unpacked
nothing.

## What a per-machine install actually does

The `.exe` writes the application to `%ProgramFiles%\Ion` for every user. It
does **not** start the engine.

The engine supervisor is a **per-user** scheduled task named `Ion Engine (<SID>)`,
registered on that user's first launch of Ion. The SID is in the name because a
task name is machine-global and two users on one host would otherwise share one
registration. So a device-assigned install lands the binaries at device sync time, and each user who signs in and opens
Ion gets their own engine, their own `%USERPROFILE%\.ion` data directory, and
their own engine on a loopback port derived from their own SID. That split is
deliberate: conversations, credentials, and logs are per-user data, and a
machine-wide engine would share them.

The port is derived rather than fixed because two users can be signed in at
once -- fast user switching on a shared workstation, or an Azure Virtual
Desktop multi-session host. With a single fixed port the second user's engine
cannot bind and their desktop connects to the **first user's** engine instead:
another person's conversations, credentials and file access. A refused bind is
a visible failure; a successful connection to the wrong engine is not.

`ION_SOCKET_PATH` still overrides the address outright for a deployment with
its own port plan.

Verify on a device after the install:

```powershell
Test-Path "$env:ProgramFiles\Ion\Ion.exe"          # True after the app install

# The task is named after the account -- "Ion Engine (<SID>)" -- because a task
# name is machine-global and two users on one host would otherwise share one
# registration. schtasks /TN takes an EXACT name and has no wildcard syntax, so
# either name this user's task or enumerate with PowerShell.
$sid = ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
schtasks /Query /TN "Ion Engine ($sid)" /V /FO LIST
Get-ScheduledTask | Where-Object TaskName -like 'Ion Engine*' | Format-List TaskName, State

# The engine's port is per-user; read it from the log rather than assuming.
Select-String -Path "$env:USERPROFILE\.ion\engine.jsonl" -Pattern 'listening' | Select-Object -Last 1
```

Only that user's own engine is reachable at that port. The port is derived
rather than fixed so two engines cannot collide, and the engine additionally
authorizes every loopback client by peer identity: a connection whose process
token belongs to a different account is refused, so another signed-in user who
scans the port range and connects gets nothing
(`engine/internal/server/peerauth_windows.go`). There is no shared fallback
address at any layer -- when the SID cannot be read, the engine refuses to
start and the desktop reports that it has no address rather than picking one
somebody else is already using.

### There is no per-user install

The installer is built per-machine only (`build.nsis.perMachine`). A user
cannot install their own copy beside the managed one, so a device carries
exactly one Ion and one version -- which is what an MDM-managed fleet, a shared
guest workstation, and a multi-session host all require for different reasons.

electron-builder also removes any pre-existing per-user install when the
per-machine one is made, so a device that carried one from an earlier build is
consolidated on upgrade rather than ending up with both.

A double-click install now prompts for elevation, because writing to
`%ProgramFiles%` requires it. That is the intended trade: on a managed fleet
the install is silent and in System context anyway, and on a developer machine
one UAC prompt is cheaper than a second divergent copy.

Removing the managed install is administrator-gated: the repository's
`make.ps1 uninstall` requires an elevated prompt. A standard user on a managed
device therefore cannot clone the repository and step around their fleet's
copy, while a developer with local administrator rights can reset their own
machine freely.

### Upgrading a device that has an install in the wrong place

Builds before the ARM64 install-directory fix put a per-machine ARM64 install
in `C:\Program Files (x86)\Ion`. NSIS records that path and reuses it: the
per-machine branch reads `InstallLocation` from
`HKLM\SOFTWARE\{7b1e4b3a-5d2c-4c7e-9f0a-2e6d8c1b4a53}` and, when it is set,
installs there again rather than recomputing it. A fixed installer therefore
upgrades such a device **in place, still under `(x86)`**, and reports success.

That is correct upgrade behaviour, and it is invisible unless you look -- which
is why the install log prints `instdir` on every run. To move a device onto the
native path, uninstall first so the recorded location goes with it:

```powershell
$guid = '7b1e4b3a-5d2c-4c7e-9f0a-2e6d8c1b4a53'
& "$env:ProgramFiles(x86)\Ion\Uninstall Ion.exe" /allusers /S
```

In Intune, an app supersedence with uninstall-first does the same thing. Only
devices that received a pre-fix ARM64 per-machine build are affected; x64 was
never placed wrongly.

## Pin the version, disable the updater

A managed fleet owns the version lifecycle, so the desktop must not self-update
and fight the assigned version. Set the desktop kill switch as enterprise
policy -- through the ADMX `ConfigJson` setting, or through `Set-IonPolicy.ps1`:

```json
{"customFields":{"ion-desktop":{"disableAutoUpdate":true}}}
```

With that set the desktop skips its update check and its install-on-quit path
entirely, and new versions arrive only when you assign them.

## Policy delivery: four routes

Pick one. All four end at the same registry key or the files it overlays,
`HKLM\SOFTWARE\Policies\IonEngine`.

1. **The Enterprise Policy Win32 app.** The route for a managed rollout, and
   the one documented in full below. Policy is a second Win32 app that Ion
   Studio takes as a dependency, so it is applied before the application it
   configures, changes without redeploying 130 MB, and rolls back on its own.
2. **ADMX ingestion.** Devices > Configuration > Import ADMX, upload
   `IonEngine.admx` and `en-US\IonEngine.adml` from
   `Ion-PolicyTemplates-<version>.zip`, then build a Settings Catalog profile
   from the imported template. This is the route with a real settings UI.
3. **Platform script.** Edit the `$Policy` block in `Set-IonPolicy.ps1`, then
   assign it under Devices > Scripts and remediations > Platform scripts with
   "Run this script using the logged on credentials" set to **No**. It must run
   as SYSTEM to write HKLM.
4. **Config file.** Drop a JSON file at
   `%ProgramData%\Ion\enterprise-config.json` (or a fragment in
   `enterprise-config.d\`) with the Win32 app or a separate package. Registry
   policy overlays these files, so use one or the other, not both, for the same
   setting.

## The Enterprise Policy Win32 app

### Why it is a separate app

Policy changes far more often than the application does. Carrying it inside
the installer would mean a 130 MB redeploy to change a scope list, and would
tie a policy rollback to an application rollback. Splitting it also fixes the
ordering: Intune applies a Win32 app's dependencies before the app itself, so
declaring the policy package as a dependency of Ion Studio is what guarantees
the engine finds its configuration on first launch rather than starting
unmanaged and picking it up later.

The policy is **machine-wide and sealed**. That is deliberate for this
rollout: one configuration per device, authored by an administrator, not
per-user. (Per-user enterprise policy is tracked separately and is not part of
this package.)

### Build the package

One command, from the tenant's two inputs to the artifacts an administrator
uploads:

```powershell
pwsh -File packaging/windows/intune/policy/New-IonPolicyIntuneWin.ps1 `
  -ConfigPath <path to your enterprise-config.json> `
  -ThemePath  <path to your theme pack's theme.json> `
  -Version 1.0.0 `
  -OutputDir .\out
```

For the dci Marketing rollout the two inputs are, exactly:

```
/Users/Shared/source/dcienterprise/cloudops/projects/dci-orion/artifacts/ion/enterprise-config.json
/Users/Shared/source/dcienterprise/cloudops/projects/dci-orion/themes/dci-marketing/theme.json
```

Those are the canonical copies and they are the ones to point at. **This
repository ships no tenant's values.** `enterprise-config.example.json` is
placeholders only, documents the required shape, and is refused by the
packaging tool -- it exists so a reader can see what is required, never so
anybody retypes a field into it.

It writes, into `-OutputDir`:

| Output | What it is |
|---|---|
| `Ion-Policy-<version>.intunewin` | The upload artifact. |
| `Detect-IonPolicy-<version>.ps1` | The stamped detector, lifted out so it can be uploaded as the detection rule without unpacking the package. |
| `Ion-Policy-<version>/` | The package directory: `IonPolicy.json`, `theme/`, install, uninstall, stamped detect. |
| `Ion-Policy-<version>.json` | Provenance: commit, dirty state, the config's and theme's hashes, each artifact's hash and size. |
| `Ion-Policy-<version>.sha256` | The same hashes in the format `sha256sum -c` speaks. |

The wrapping uses the same pinned, SHA-256-verified Microsoft Win32 Content
Prep Tool the application packaging uses (`scripts/ci/IonContentPrepTool.ps1`,
shared by both so there is one tag and one hash to maintain). Pass
`-IntuneWinAppUtilPath` to use a copy you already have, or `-SkipPackaging` to
do everything except invoke the Windows-only tool -- which is how a non-Windows
host and CI exercise the validation, the hashing and the stamping.

`New-IonPolicyPackage.ps1` builds only the package directory. Run it directly
when you want to read a payload before wrapping it; the wrapper calls it.

### What the theme has to do with policy

The theme pack is a **required** input, not an extra. The policy locks a
`themePolicy.themeId`. A device that received the policy without the pack
applies the policy, cannot find the pack, silently falls back to a built-in
theme, and reports itself compliant -- compliant and wrong, and invisible
until somebody looks at a screen.

So the pack travels inside the package, is validated against the policy that
names it, is installed by the same install command, is compared by the same
detection rule, and is removed by the same uninstall.

For this rollout the pack is `dci-marketing`, version `1.2.0`, and it installs
to exactly:

```
%ProgramData%\Ion\themes\dci-marketing
```

That is the machine-scope pack root the desktop scans
(`desktop/src/main/theme-packs.ts`); a system pack shadows a user pack of the
same id, which is what makes an enterprise theme win.

Only the files the manifest **declares** are packaged: `theme.json` plus the
asset paths its `desktop.assets` and `ios.assets` name. Nothing else in the
source directory ships, so `.DS_Store`, `Thumbs.db`, an old copy somebody left
beside it, and any stray file stay where they are rather than landing in
`%ProgramData%` on every managed device. Each packaged file's SHA-256 is
recorded in the payload; the installer verifies it, and detection compares it.

### What the tool refuses to build

- a config that does not parse as JSON;
- a config that is **incomplete**. Every production field must be present: the
  provider list and each provider's `displayName`, `baseURL` and `authHeader`;
  `auth.identityProvider` and `auth.requireOperatorIdentity`; the Entra
  `issuerUrl`, `authorizationUrl`, `tokenUrl`, `clientId`, `redirectUri`,
  `usePkce` and `scopes`; and the desktop's `disableAutoUpdate` and
  `themePolicy.themeId` / `themePolicy.locked`. A config missing one of these
  installs cleanly and then cannot sign in, days later and far from here;
- any property that is credential-shaped (`apiKey`, `clientSecret`,
  `password`, and the rest). Machine policy under HKLM is readable by every
  account on the device, so a key placed there is published rather than
  deployed. The engine takes per-user API keys from the user's own credential
  store; they never belong in a machine policy;
- any value that still looks like a placeholder (`REPLACE_ME`, an all-zero
  GUID, an `example.com` URL, `<angle brackets>`). `-AllowPlaceholders`
  overrides the placeholder and completeness checks for a throwaway test
  package and warns loudly;
- any value with a shape the engine's registry decoder has no rule for. A
  value the engine cannot decode is ignored, which is a device reporting
  compliant while running unmanaged;
- a theme pack whose `id` is not the `themeId` the config locks, whose `id` is
  not a usable pack directory name, or which declares no version.

Each top-level enterprise key becomes one registry value, in the type the
engine's decoder expects: a string list is `REG_MULTI_SZ`, a boolean is
`REG_DWORD`, an object is `REG_SZ` carrying JSON. Per-key rather than one
opaque blob, so regedit shows what is enforced and an ADMX-delivered value for
a different key can coexist.

### Win32 app settings

| Setting | Value |
|---------|-------|
| Name | Ion Enterprise Policy |
| Install command | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File Install-IonPolicy.ps1` |
| Uninstall command | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File Uninstall-IonPolicy.ps1` |
| Install behavior | System |
| Device restart behavior | No specific action |
| Return codes | `0` = Success. `1` = Failed. |
| Detection rule | Custom detection script. Upload `Detect-IonPolicy-<version>.ps1`. Run script as 32-bit process on 64-bit clients: **No**. Enforce script signature check: **No**. |
| Requirements | Windows 10 1809 or later, x64. |

Then, on the **Ion Studio** Win32 app, add this package under **Dependencies**
with "Automatically install" set to **Yes**. That ordering is the whole point
of the split: Intune applies a Win32 app's dependencies before the app itself,
so the engine finds its configuration and its theme on first launch rather
than starting unmanaged and picking them up later. Without the dependency the
two apps race, and the race is usually lost on a freshly enrolled device where
both are assigned at once.

Assign the policy app to the same device group as Ion Studio. Do not assign it
to users: the policy is machine-wide.

### Detection: what "detected" actually means

Detection compares the **device** against the **payload**, not against a list
of names:

1. The ownership record at `HKLM\SOFTWARE\Ion\PolicyPackage` exists and names
   a version at least as new as this package's.
2. Every value the payload declares is present under
   `HKLM\SOFTWARE\Policies\IonEngine`, carries the registry **type** the
   payload declares, and carries exactly the **data** the payload declares.
3. The theme pack is installed at `%ProgramData%\Ion\themes\<id>` with the
   declared id, the declared version, and each declared file's declared
   SHA-256.

Anything short of all three is "not detected", and Intune reinstalls. The
reasons are written to STDERR, which Intune keeps in the device's app
diagnostics, so a remediating device says which value drifted rather than only
that something did.

An earlier version checked only whether the owned value *names* existed. That
answers "did something write here once" and nothing else: a scope list edited
by hand, a boolean flipped in regedit, a `REG_SZ` where a `REG_MULTI_SZ`
belongs, or a Group Policy refresh that overwrote one value all leave every
name in place. The device reported compliant, Intune never remediated, and the
engine ran a configuration nobody approved.

Values under the policy key that this package does **not** declare are
deliberately not a failure. An ADMX profile or an administrator may enforce a
setting this package has no opinion about.

The expected data is stamped into the detector at packaging time, because
Intune uploads a detection script on its own and runs it with no arguments and
nothing beside it. The identical text also ships in the package directory as
`IonPolicy.json` -- that copy is what an administrator reads and what the
installer applies.

### What each script guarantees

**Install** writes exactly the values the payload declares, reads every one of
them back, and fails when the value **or its registry type** differs from what
it wrote -- a write that reported success and a key that carries the value are
different facts, and only the second one manages a device.

It stages the theme pack in a sibling directory, verifies every file's SHA-256
against the payload there, and only then makes it live with a **rename**. So a
failure part-way leaves the previous pack exactly as it was rather than a
half-written one the desktop would load, and a failed swap restores the pack
the device already had. An update replaces the files this package owns.

It records the value names and the theme id it owns at
`HKLM\SOFTWARE\Ion\PolicyPackage`, a key the engine never reads, so a later
version can converge: values this package no longer declares are removed, the
rest are overwritten. It refuses a payload carrying an `apiKey` even though
the packaging tool already refused one, because a payload can be hand-edited
after packaging.

**Detect** is the comparison described above.

**Uninstall** is the rollback path. It removes exactly the recorded owned
values and the **one** theme directory it recorded as owned, resolved from the
recorded id rather than a recorded path so a tampered record cannot name
somewhere else on the disk. A value an administrator set by hand, one
delivered by ADMX, one from another tool, and every other theme pack under
`%ProgramData%\Ion\themes`: all left where they are. The theme root itself is
never removed. The policy key itself is removed only when this package emptied
it and it has no subkeys. Uninstalling something that was never installed
succeeds, which is what Intune expects.

### Rolling back

Policy is its own app, so a rollback is its own operation and does not touch
Ion Studio:

1. To revert to a previous configuration, build that configuration as a
   package with a **higher** version and assign it. Detection is version-aware,
   so devices reinstall and converge; the install removes values the new
   package no longer declares.
2. To remove the configuration entirely, change the policy app's assignment to
   **Uninstall**. Devices run `Uninstall-IonPolicy.ps1`, which removes only
   what this package placed. Ion Studio keeps running; it runs unmanaged.
3. Removing Ion Studio does **not** remove the policy, and removing the policy
   does not remove Ion Studio. They are independent apps with a dependency
   edge in one direction.

None of the three scripts touches a user profile, `%USERPROFILE%\.ion`,
conversations, credentials, an operator's `~\orion` or `~\.orion`, another
theme pack, or the administrator-authored `enterprise-config.json` /
`enterprise-config.d` files under `%ProgramData%\Ion`. That is asserted by
`packaging/windows/intune/policy/New-IonPolicyPackage.test.ps1`, not just
intended.

### Rolling out to the three hosts

The rollout order per host is the same one the dependency enforces, and the
hosts are done **sequentially** -- one host proven before the next is started,
so a defect in the configuration reaches one machine rather than three:

1. Assign the policy app to the host. Wait for it to report installed.
2. Confirm on the device: the values under
   `HKLM\SOFTWARE\Policies\IonEngine` match, and
   `%ProgramData%\Ion\themes\dci-marketing\theme.json` is present.
3. Assign Ion Studio to the host, with the policy app as its dependency.
4. Sign in as a real user and confirm the engine starts, the sign-in completes
   against the configured provider, and the desktop renders the
   `dci-marketing` theme rather than a built-in one.
5. Only then start the next host.

The full registry contract -- which value names exist, which registry types each
field accepts, and what `ConfigJson` is for -- is in
[`docs/enterprise/mdm.md`](../../../docs/enterprise/mdm.md).

## Rebuilding the package by hand

```powershell
pwsh -File scripts/ci/make-intunewin.ps1 `
  -InstallerPath desktop\release\Ion-Setup-1.83.0-x64.exe `
  -OutputDir desktop\release\intune
```

The script downloads the Microsoft Win32 Content Prep Tool at a pinned tag,
verifies its SHA-256 before running it, stamps `Detect-Ion.ps1` with the
version parsed from the installer filename, and writes both the `.intunewin`
and the stamped detection script to the output directory. Pass
`-IntuneWinAppUtilPath` to use a copy you already have, or `-SkipPackaging` to
stamp the detection script without invoking the Windows-only tool.

## Signature and provenance

Signing is decided before anything is built, by
`scripts/ci/resolve-windows-signing.ps1`, and there are exactly three outcomes:

| Configuration | Outcome |
|---|---|
| A certificate is configured (`WINDOWS_CERT_PFX_BASE64`) | The installer is signed, and a signing failure fails the job. |
| `ION_REQUIRE_WINDOWS_SIGNING=true` and no certificate | The job stops before building. An official release is never published unsigned. |
| Neither | The build proceeds and every artifact is labelled unsigned in its provenance manifest. |

The third outcome is not a policy exception -- it is what lets a contributor
and a pilot build with no certificate -- and it is honest because the manifest
reads each file's real Authenticode status off the file rather than from the
build's intent. An unsigned installer run by hand still shows a SmartScreen
warning; an Intune system-context install does not prompt either way.

Every release publishes `Ion-Artifacts-<version>-x64.json` and a matching
`.sha256`. The JSON records the commit, whether the tree was dirty, the
version, the architecture, and each artifact's byte size, SHA-256 and
signature status. A build from a dirty tree is labelled `test-build` and
`reproducible: false` -- it still gets a manifest, because the most common
local build having no provenance at all is worse than an honest label. Verify
what you received before you assign it:

```powershell
Get-FileHash .\Ion-Setup-<version>-x64.exe -Algorithm SHA256
Get-Content .\Ion-Artifacts-<version>-x64.sha256
```

A local `.\make.ps1 installer` writes the same manifest beside its installer,
and fails the build if it cannot.
