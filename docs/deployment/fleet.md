---
title: Fleet
description: Managing many Ion Studio hosts from one machine with ion fleet -- the dashboard, status over SSH or the relay, paired devices, compatibility between hosts, and redeploys built once per platform.
sidebar_position: 5
---

# Fleet

`ion fleet` manages many Studio hosts from one machine (a Mac, a Linux box, or a Windows PC): Studio Server hosts on macOS and Linux, and Macs and Windows PCs running the Ion desktop. It shows each host's installs, engine, load, running conversations, paired devices, relays, and [Format Versions](../architecture/format-versions.md), tells you which hosts can work with which, and redeploys a selection or one host, building each platform once.

Run `ion fleet` with no command for the dashboard. Every view also has a plain command for scripts.

## Setup

The fleet lives in `~/.ion/fleet.json`. Add hosts with `ion fleet add`, or write the file:

```json
{
  "checkout": "/path/to/ion",
  "concurrency": 4,
  "hosts": [
    { "name": "server-1", "ssh": "user@server-1.example.org", "kind": "server", "profile": "relay-psk" },
    { "name": "mac-1", "ssh": "user@mac-1.example.org", "kind": "desktop", "profile": "relay-oidc", "askSudo": true },
    { "name": "this-mac", "ssh": "local", "kind": "desktop" },
    { "name": "win-1", "ssh": "user@win-1.example.org", "kind": "desktop" },
    { "name": "cluster-1", "url": "https://ion.apps.example.org", "kind": "server" }
  ],
  "profiles": {
    "relay-psk": {
      "relay": "wss://relay.example.org",
      "relayKeyCommand": "az keyvault secret show -n relay-api-key --vault-name example-vault --query value -o tsv"
    },
    "relay-oidc": { "relay": "wss://relay.example.org", "relayOidc": true }
  }
}
```

| Field | Meaning |
|---|---|
| `checkout` | Optional. The Ion checkout `--source dev` builds from. `--source PATH` overrides it for one deploy. A release deploy needs none. |
| `concurrency` | How many hosts deploy at once. Default 4. |
| `hosts[].ssh` | `[user@]host` with key auth, or `local` for this machine. |
| `hosts[].url` | Instead of `ssh`: the address of a server deployed outside the fleet, such as a cluster deployment. The fleet only reads it. |
| `hosts[].kind` | `server` (a Studio Server bundle, macOS or Linux) or `desktop` (the Ion desktop app, macOS or Windows). A host with a `url` is a `server`. |
| `hosts[].askSudo` | A Mac whose sudo asks for a password. Its desktop install runs last, alone, on your terminal. |
| `hosts[].buildDir` | Where the host builds when it is a builder: an absolute path, or one under its home. Default `.ion/fleet-build/ion`. |
| `profiles.*.relay` | The relay a deploy or `ion fleet relay set` puts the host on. |
| `profiles.*.relayOidc` | The relay signs the host's operator in. |
| `profiles.*.relayKeyCommand` | A command that prints the relay's pre-shared key. It runs on this machine at each deploy (in `sh`, or PowerShell on Windows). The key reaches the host on ssh's stdin and is never stored or logged. |
| `profiles.*.args` | Extra install options for the profile's hosts, such as `["--backup"]` (`ion fleet deploy --help` lists them). |

## Status

```bash
ion fleet status            # every host
ion fleet status server-1   # one host
ion fleet status --json     # everything, including every format
```

Each host is read over SSH with the host's own `ion studio status --json`. Its paired devices (phones and desktops) come from the host's running server: the DEVICES column reads `2 · 1 on` for two paired, one connected now, and the host detail lists each. The fleet's own pairing is left out. The fleet runs the host's `ion` by full path: the Studio Server bundle's, then the desktop app's, then `~/.ion/bin/ion`.

The fleet learns each host's OS the first time it reaches it: `uname` answers on macOS and Linux, and a Windows host answers in PowerShell (its OpenSSH login shell, PowerShell or cmd). Everything it runs on a Windows host is PowerShell, sent encoded so no shell quoting touches it.

When SSH cannot reach a host, the fleet reads it through the relay instead, with its own read-only pairing. `ion fleet add` pairs with each host (scope `conversations:read`). `ion fleet pair NAME` pairs again after a host is reinstalled. A relay that signs its operator in uses this machine's own sign-in from the local engine. Through the relay the fleet sees the running server and engine, the load, running conversations, paired devices, and formats. It does not see service units, log paths, or versions installed but not yet running.

A host whose `ion` predates the full report still answers. The table marks what it could not say, and a deploy brings it up to date.

### Hosts deployed outside the fleet

A server in a cluster is deployed by the cluster's own tooling (manifests, a GitOps controller, a pipeline), and the fleet does not change it. Register it by its address so the fleet can watch it:

```bash
ion fleet add cluster-1 --url https://ion.apps.example.org   # add it and sign in
ion fleet pair cluster-1                                      # sign in again later
```

Without a sign-in, the fleet reads what the server publishes to anyone: its name, whether it is ready, its server and engine versions, and every format, so it shows in the compatibility matrices. With a sign-in it also reads the load, running conversations, and your paired devices, over the same Studio connection the desktop's Sign in uses.

The sign-in is the fleet's own, with the server's published client (its `/auth/config`): `ion fleet add` prints a code to enter at the identity provider's device sign-in page. The server's app must allow public-client flows, and your tenant must allow device-code sign-in. The refresh token lives in the fleet's encrypted store beside its pairings, and a rotated one replaces it on every read. This machine's own Ion sign-in is not used: it may be to another tenant.

Deploy, restart, and relay set refuse such a host and say so. Change it where it is deployed.

## Compatibility

```bash
ion fleet compat                            # every compared format, transfer first
ion fleet compat --format transfer-archive  # one format
```

Each matrix reads "rows send to columns". Transfer is the one most often asked: two servers can move a conversation between them only when their transfer archive versions match, whatever their server or engine versions. The Studio wire matrix lists only desktop hosts as rows, because a desktop is the client that connects. A server accepts its own protocol version and the one before it.

The dashboard's table marks a host whose transfer format differs from most of the fleet. Press `c` for the matrices.

## Deploy

```bash
ion fleet deploy server-1 mac-1 --source dev            # build the fleet file's checkout and deploy
ion fleet deploy mac-1 --source .                       # build and ship the checkout you are in
ion fleet deploy server-1 --source release              # install the newest release
ion fleet deploy server-1 mac-1 --source . --dry-run    # print the plan only
ion fleet deploy win-1 --source . --no-build            # install the build fetched last time
ion fleet deploy --to user@mac.local --kind desktop --source . --quit-ion   # one host, fleet file or not
```

`--source` takes `dev`, `release`, or a path to an Ion checkout. A path builds and ships
that folder as it is, whatever branch it holds: `.` from a bench, a worktree, or any
clone. `dev` is the same with the fleet file's `checkout`. The dashboard's deploy
source starts as `ion fleet --source PATH` when given, else `dev` when the fleet file
names a checkout, else the folder you opened it in when that is a checkout; otherwise
it asks.

A host takes the component of its kind:

- **Server host:** the Studio Server bundle. The engine, the server, and Node ship together.
- **Desktop host:** the Ion desktop app, which carries its own server and engine. Ion there quits during the install, so its running conversations stop.

The engine is never deployed on its own: each install pins its own engine.

| Source | Server host | Mac desktop | Windows desktop |
|---|---|---|---|
| `dev` or a path | Builds the bundle once per platform, copies it, and runs the checkout's `scripts/install-studio-server.sh` on the host | Builds the package once per CPU (`make desktop-pkg`), copies it, and installs it with the system installer | Builds the installer once per CPU (`make.ps1 installer`), copies it, and runs it silently for every user |
| `release` | Runs `ion studio update --yes` on the host | Downloads the newest `Ion-<version>.pkg` | Downloads the newest `Ion-Setup-<version>-<cpu>.exe` |

A release download is checked against GitHub's published SHA-256 digest before anything installs it.

### Builds

A dev deploy builds each artifact once and installs it on every host that takes it. It builds on this machine when it can: a macOS server bundle builds on any Mac, a Linux bundle only on Linux of the same CPU, and a desktop only on its own OS and CPU. Otherwise the first target host of that platform with the build tools (`go`, `node`, `npm`, and `make` on a Mac, `tar` and `curl` for a bundle) is its builder: the plan names it. From a Mac, a Windows desktop builds on the first Windows host; from Windows, a Mac desktop builds on the first Mac.

For a builder host, the deploy packs the checkout as it is in the working tree, new files included and ignored files left out, and ships it with a version stamp (`.ion-sync-stamp.json`, the one a `make sync-windows-vm` tree carries), since the host has no git history. The host builds in its `buildDir` (`~/.ion/fleet-build/ion` unless the fleet file says otherwise): each build replaces the tree and keeps its `node_modules`, so `npm ci` runs only when `package-lock.json` changed. On Windows the build folder must be one Microsoft Defender does not scan in real time: electron-builder unpacks Electron there and renames the folder, and the rename fails while Defender holds the fresh files. The plan refuses such a builder before shipping anything and names the fix: point `buildDir` at a folder Defender excludes, or exclude the default one. The result comes back to `~/.ion/fleet/artifacts/<component>-<os>-<cpu>/` here, and goes from here to every host of that platform, the builder included. `--no-build` installs the newest build already there.

### One host: `--to`

`ion fleet deploy --to [user@]HOST --kind desktop|server` deploys one host that need not be in the fleet file; a host the file names keeps its settings. It prints its steps as they run and ends with one line of JSON, the receipt a script reads. Unlike a fleet deploy, it stops when Ion is running on the host unless `--quit-ion` is given. `make deploy-studio-desktop` and `make deploy-studio-server` run it. The install options (`--quit-ion`, `--ask-sudo`, `--backup`, `--open`, `--pair`, `--relay`, and the first-install `--label`, `--advertise`, `--tenancy`, `--system`) work for a fleet deploy too; `ion fleet deploy --help` lists them.

### Windows hosts

A Windows host runs the desktop; there is no Studio Server bundle for Windows. It needs OpenSSH Server with key authentication for an administrator's account, because the installer runs for every user (`/S /allusers`). The deploy quits a running Ion with a second launch carrying `--ion-force-quit` (Windows has no signals), stops one still running after a minute, installs, checks the version the uninstall entry reports, and starts Ion again in the signed-in user's session through a one-shot scheduled task, since a program started from an ssh session never shows on anyone's screen. A restart from the fleet works the same way.

Before it deploys, the command prints its plan and what it changes between hosts:

- which pairs of hosts it breaks or fixes, per format;
- desktops that would drop out of a server's Studio wire window;
- a stored-data format it would lower on a host. This one stops the deploy until you pass `--allow-downgrade`.
- a target it cannot read today: one that is not answering, so the deploy will probably fail there, or one whose Ion is too old to report its formats, so a downgrade cannot be checked.

The plan names only the hosts it deploys. A host outside the deploy that is down is left out: the deploy changes no pair between two hosts it does not touch, and the compatibility matrices judge that host once it answers again. The command reads the fleet once for the plan; the dashboard's deploy uses what the dashboard already read, and reads only a host it has not read yet.

Builds run first, the ones on hosts at the same time. Then hosts deploy in parallel. `askSudo` hosts deploy last, one at a time, on your terminal. Each host writes a log under `~/.ion/fleet/logs/`; a failed host's line names the reason its install stopped, and a desktop that needs a sudo password says to set `askSudo` on it. When every host finishes, the fleet reads each one again to confirm the new versions.

## Running the fleet from Windows or Linux

`ion fleet` needs the OpenSSH client (`ssh`, `scp`) on the machine it runs on, which Windows ships. A host whose `ssh` is `local` is that machine, reached in its own shell (PowerShell on Windows) with no ssh at all. A profile's `relayKeyCommand` runs in the same shell, so on Windows it is a PowerShell command. What this machine cannot build, a builder host does: from Windows, a Mac desktop builds on the first Mac and a macOS server bundle on the first Mac server; from Linux, a desktop always builds on a host.

## Other actions

```bash
ion fleet restart server-1 mac-1    # a desktop's running conversations stop
ion fleet relay set server-1        # the host's profile relay
ion fleet remove mac-1
```

## Dashboard keys

| Key | Does |
|---|---|
| `↑` `↓` | Move |
| `space` / `a` | Select a host / all hosts |
| `enter` | Host detail: each component installed, running, latest release, and checkout version, the paired devices (connected ones first), and every format with its rule |
| `c` | Compatibility matrices (`←` `→` switch format) |
| `d` | Deploy the selection, or the host under the cursor. The deploy screen shows the source; `e` changes it (type `dev`, `release`, or a path to an Ion checkout, `.` and `~` work). With no source known it asks for one first. `D` allows a stored-data downgrade, `y` goes |
| `R` / `L` | Restart / set the relay, after a yes |
| `r` | Read every host and the latest releases now, and forget every back-off |
| `q` | Quit |

The dashboard reads each host on its own schedule, and only while the table or a host's detail is on screen. A host that answers is read again 15 seconds later. A host that does not answer is tried again after a minute, then 2, then 4, and every 5 minutes after that; its REACH cell says when. The latest releases are looked up when the dashboard opens and every 30 minutes, since GitHub allows 60 calls an hour without a token. A deploy plans from what the table already holds, and the reads it makes of its targets when it finishes become their rows. A restart or relay change reads only its host.
