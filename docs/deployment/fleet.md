---
title: Fleet
description: Managing many Ion Studio hosts from one machine with ion fleet -- the dashboard, status over SSH or the relay, paired devices, compatibility between hosts, and redeploys built once per platform.
sidebar_position: 5
---

# Fleet

Your fleet is every Ion Studio server this device is paired with. There is one list. Ion Studio keeps it, and `ion fleet` reads and writes the same one: a server paired in Studio is in the fleet, a host added with `ion fleet add` shows up in Studio, and the server holds one pairing for this device either way.

You manage the fleet from three places:

- **Settings → Fleet** in the desktop, in three tabs. **Quota**: each provider's limits summed over its accounts, and every account with its usage limits. **Servers**: each server's version and load, the CLI accounts signed in on it, who is signed in to its enterprise sign-in, and its custom providers, with restart, update, and deploy. **Compatibility**: which servers can work with which.
- **Settings → Fleet** on the iPhone: the same totals, accounts, and servers for the servers the phone is paired with.
- `ion fleet` in a terminal: the dashboard with no command, and a plain command for every view, for scripts.
- A [Fleet Hub](fleet-hub.md): an always-on page your servers report to, for watching and managing the fleet from any network with no laptop open.

The fleet covers Studio Server hosts on macOS and Linux, and Macs and Windows PCs running the Ion desktop. It shows each host's installs, engine, load, running conversations, paired devices, relays, and [Format Versions](../architecture/format-versions.md), tells you which hosts can work with which, and redeploys a selection or one host, building each platform once.

## Manage-only servers

A server can be in the fleet without being offered for conversations. Such a server is **manage-only**: you watch it, configure it, and deploy to it, and its conversations stay out of the inbox. `ion fleet add` adds a host manage-only unless you pass `--conversations`. Change it later with `ion fleet set NAME --manage-only` or `--conversations`, or with the switch on the server's row in Settings → Fleet.

## Accounts and usage

Each server keeps a ledger of the provider CLI accounts it has seen signed in during the last 30 days, with the usage limits the CLI itself reports: the 5-hour limit, the 7-day limit, and a 7-day limit per model where the provider has one. Ion asks the installed CLI for these numbers. It never sends a subscription token to a provider on its own.

The Quota tab of the Fleet page adds every server's ledger into one row per account, grouped by provider. A server shown solid is signed in to the account now. A server shown gray saw it in the last 30 days. An account that is signed in nowhere keeps the last numbers read for it.

```bash
ion fleet accounts          # every account, its limits, and the hosts it is on
ion fleet accounts --json
```

A server reads its CLIs on a timer (`fleet.accountPollSeconds` in the server's config). Refresh usage on the Quota tab, or pull down on the iPhone, reads them now.

### Switching the account a server is on

A server's provider CLI is signed in to one account at a time. To put another account there, start from the Fleet:

- **Desktop.** Open the `…` menu of a server, or of an account on it, and choose **Switch account**. The panel lists each provider on that server that signs in through a CLI, with the account it is on. **Switch account** starts that CLI's own sign-in on the server.
- **iPhone.** Swipe a server or an account on the Fleet screen and tap **Switch Account**, then pick the provider.

The sign-in is the same one Providers & models uses. The account that is there stays signed in until the new sign-in finishes, so cancelling leaves the server as it was. For Claude Code from another machine or the iPhone, the sign-in page opens on the device you are holding: sign in to the other account there, approve, copy the code the page shows, and paste it back (the iPhone has a Paste button that also sends it). A sign-in that only finishes in a browser on the server's own host is not offered from another machine. Only a server that is connected now can switch.

### Removing a custom provider

A custom provider is one a server's configuration defines, such as a company gateway. To remove one, start from the Fleet:

- **Desktop.** Open the `…` menu of a server and choose **Custom providers**. Each custom provider on that server has **Remove provider**, which asks once.
- **iPhone.** Swipe a server on the Fleet screen, tap **Custom Providers**, open the provider, and tap **Remove Provider**.

The same control is on each custom provider's panel in Providers & models. Removing a provider deletes its entry from the server's `engine.json`, its saved key, and its models. The server refuses while its default model, or a model tier's model or fallback, is one of the provider's models: choose other models in Providers & models first. The engine's own fallback model in `engine.json` is not one of those; when it names the provider, it is cleared with it. Built-in providers are never listed; their settings are changed in Providers & models. Only a server that is connected now can remove one.

## Spending quota well

Quota that is still unused when a weekly limit resets is gone. Four things on top of the account table help use it.

**Quota about to expire.** On the Quota tab, an account with quota about to expire carries a chip under its name with the share that is unused, and the line at the top counts those accounts. An account is listed when a weekly limit resets within 12 hours and a quarter or more of it is unused. Each server also rings your phone once per window when one of its own accounts gets there. Change the hours and the percent, or turn the alert off with 0 hours, under Settings → Workflow → Usage limits (`quotaExpiryAlertHours`, `quotaExpiryUnusedPercent`).

**Where new work goes.** In the new-conversation picker, set the machine control to **Auto machine**. A project that several servers hold then opens on the one whose signed-in account has the most room, leaning toward an account whose weekly quota is about to reset unused, with the less loaded host winning a near tie. A server at its limit, offline, or manage-only is never picked. Each server on the Servers tab shows its standing under New work, and a server's menu sets how often this device opens new conversations there: prefer, normal, less often, or never. Both choices belong to this device. On the iPhone, the Fleet screen marks the server with the most room; Chat on is how the phone moves there.

**Limited conversations.** When a provider refuses a run because the account's usage limit is reached, the conversation shows **Limited** in the Inbox with the time the limit resets, and your phone rings. From the conversation's menu you can:

- **Resume at reset.** The server holds a resume prompt and sends it by itself once the limit resets, with every app closed. Turn on "Resume when a usage limit resets" under Settings → Workflow → Usage limits to do this for every limited conversation, and set what the prompt says.
- **Snooze until reset.** The conversation leaves the Inbox until then.
- **Move to a server with room.** Opens the Transfer dialog on the other server whose account has the most room.

**Queue for spare quota.** In the composer, Cmd+Shift+Enter (Ctrl on Windows and Linux) hands the prompt to the server to hold. On the iPhone, touch and hold the send button. The server sends it when the conversation's account has weekly quota about to reset unused and can take work. The row says "Queued for spare quota" until then, and its menu can send it now or cancel it.

Automations can react to the same facts: "A usage limit stops a conversation", "A conversation's usage limit resets", and "Weekly quota is about to reset unused" are triggers.

## Setup

Pair a server in Studio (Settings → Fleet → Add server) or add it from a terminal:

```bash
ion fleet add server-1 user@server-1.example.org --kind server --profile relay-psk
ion fleet add mac-1 user@mac-1.example.org --kind desktop --ask-sudo --conversations
ion fleet set win-1 --ssh user@win-1.example.org --kind desktop
ion fleet remove server-1    # revokes this device's pairing on the host, then forgets it
```

How a host is deployed to (its SSH target, kind, profile, sudo, and build folder) is stored on its entry in Studio's server list. `ion fleet set` and the Deploy panel in Settings → Fleet both edit it.

The fleet file `~/.ion/fleet.json` holds only how deploys run:

```json
{
  "checkout": "/path/to/ion",
  "concurrency": 4,
  "profiles": {
    "relay-psk": {
      "relay": "wss://relay.example.org",
      "relayKeyCommand": "az keyvault secret show -n relay-api-key --vault-name example-vault --query value -o tsv"
    },
    "relay-oidc": { "relay": "wss://relay.example.org", "relayOidc": true }
  }
}
```

A fleet file from an earlier version also listed hosts and kept its own pairing with each. `ion fleet migrate` moves each of those hosts into Studio's list, reuses Studio's pairing where one exists, and revokes the fleet's old pairing on the host. It runs by itself before any fleet command while such hosts remain, and a host that does not answer stays in the file until a later run.

| Field | Meaning |
|---|---|
| `checkout` | Optional. The Ion checkout `--source dev` builds from. `--source PATH` overrides it for one deploy. A release deploy needs none. |
| `concurrency` | How many hosts deploy at once. Default 4. |
| A host's SSH target | `[user@]host` with key auth. Optional: a host with none is reached only over its Studio connection. |
| A host's kind | `server` (a Studio Server bundle, macOS or Linux) or `desktop` (the Ion desktop app, macOS or Windows). |
| A host's ask-sudo | A Mac whose sudo asks for a password. An install over SSH runs last, alone, on your terminal. |
| A host's build folder | Where the host builds when it is a builder: an absolute path, or one under its home. Default `.ion/fleet-build/ion`. |
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

A host with an SSH target is read over SSH with the host's own `ion studio status --json`. Its paired devices (phones and desktops) come from the host's running server: the DEVICES column reads `2 · 1 on` for two paired, one connected now, and the host detail lists each. This device's own pairing is left out. The fleet runs the host's `ion` by full path: the Studio Server bundle's, then the desktop app's, then `~/.ion/bin/ion`.

The fleet learns each host's OS the first time it reaches it: `uname` answers on macOS and Linux, and a Windows host answers in PowerShell (its OpenSSH login shell, PowerShell or cmd). Everything it runs on a Windows host is PowerShell, sent encoded so no shell quoting touches it.

A host with no SSH target, or one SSH cannot reach, is read over a Studio connection instead, direct or through the relay, with the same pairing Studio uses. A relay lets several clients share one pairing, so the fleet and Studio can both be connected at once. `ion fleet pair NAME` pairs again after a host is reinstalled. A relay that signs its operator in uses this machine's own sign-in from the local engine. Over a Studio connection the fleet sees the running server and engine, the load, running conversations, paired devices, and formats. It does not see service units, log paths, or versions installed but not yet running.

A host whose `ion` predates the full report still answers. The table marks what it could not say, and a deploy brings it up to date.

### Hosts deployed outside the fleet

A server in a cluster is deployed by the cluster's own tooling (manifests, a GitOps controller, a pipeline), and the fleet does not change it. Register it by its address so the fleet can watch it:

```bash
ion fleet add cluster-1 --url https://ion.apps.example.org   # add it and sign in
ion fleet pair cluster-1                                      # sign in again later
```

Without a sign-in, the fleet reads what the server publishes to anyone: its name, whether it is ready, its server and engine versions, and every format, so it shows in the compatibility matrices. With a sign-in it also reads the load, running conversations, and your paired devices, over the same Studio connection the desktop's Sign in uses.

The sign-in is the fleet's own, with the server's published client (its `/auth/config`): `ion fleet add` prints a code to enter at the identity provider's device sign-in page. The server's app must allow public-client flows, and your tenant must allow device-code sign-in. The refresh token lives in Studio's encrypted connection store beside its pairings, and a rotated one replaces it on every read. This machine's own Ion sign-in is not used: it may be to another tenant.

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
ion fleet deploy mac-1 win-1 --source . --release-for win-1   # win-1 takes the newest release, mac-1 the build
ion fleet deploy win-1 --source . --no-build            # install the build fetched last time
ion fleet deploy --to user@mac.local --kind desktop --source . --quit-ion   # one host, in the fleet or not
```

Set the checkout `dev` builds once, with `ion fleet checkout PATH` (`.` for the folder you are in); `ion fleet checkout` alone prints it. In Settings → Fleet, a server's **Deploy from source…** opens the Deploy panel ([below](#the-deploy-panel)).

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

### A host installs on itself

A macOS or Linux host that is paired and answering installs on itself. The fleet tells it over its Studio connection to restart, to install the newest release, or to install a build the fleet sends it, and the host reports each step back. This needs no SSH, so it works for a server reached only through a relay. Only a build from source sends a file; a release is downloaded by the host.

SSH is used for a first install, for a host whose Ion is down, for a Windows host, and whenever you pass `--over-ssh`. A host with no SSH target that cannot install on itself is refused in the plan, with the reason. A host that starts to install on itself and fails (it refuses, the build does not arrive, or it never comes back) is installed over SSH instead when it has an SSH target, after the other hosts, and the result says why. Ion there was already going to restart, so that SSH install quits a running Ion rather than stopping.

A server installed as system services (`--system`) needs passwordless sudo to install on itself. Without it the host refuses and the plan says to deploy it over SSH. A Mac desktop replaces its own app without a password. An app a package installed belongs to root, which the host's user can set aside but not delete. So after a Mac installs its desktop on itself, a deploy that can reach it over SSH removes the set-aside old app and gives the installed app to the SSH user, with passwordless sudo or, with `--ask-sudo`, the password typed on this terminal last. Without either, the result says the old app was left in place. An install over SSH gives the new app to the SSH user too, so later self-installs replace it outright.

`ion fleet deploy --events` prints the plan, every step, every line of each build and install log, and each result as one JSON object per line. The plan carries each host and each build as data: whether the host can be deployed, and what stops each machine that cannot build. The Deploy panel in Settings → Fleet runs it. Restart and update to the newest release go from the desktop or the iPhone straight to the host.

### A host that cannot be deployed

One host never holds up the others. A host that cannot be deployed is named in the plan under **Not deployed**, with why, and the deploy goes on without it. Its result is failed, with the same reason. That covers a host that does not answer and has no SSH target, a host asked for the wrong component, and a host nothing can build for.

When nothing can build an artifact, the plan lists each machine that was asked and what stops it:

| What stops it | Fix |
|---|---|
| The host lacks build tools | `ion fleet builder HOST --install-tools` |
| Microsoft Defender scans the host's build folder | `ion fleet builder HOST --exclude-build-dir`, or `ion fleet set HOST --build-dir DIR` |
| The host has no SSH target | `ion fleet set HOST --ssh [user@]host` |

Fixing one host is enough: it then builds for every host of its platform. Or leave the build out for those hosts: `--release-for HOST,HOST` has them install the newest release while the others take the build.

`ion fleet builder HOST --install-tools` installs what the host lacks. On Windows it ships the checkout and runs its own `make.ps1 setup`, which installs Go, Node, Python, and Visual Studio Build Tools through winget; the first run is a large download. On macOS and Linux it unpacks Go and Node under `~/.ion/fleet-build/tools` on the host, at the versions the checkout names (`engine/go.mod` and the Node the Studio Server bundle carries), each checked against its publisher's SHA-256. It installs nothing else there and needs no sudo. A host that lacks anything else (`make`, `curl`, `tar`) is told so.

`ion fleet builder HOST --exclude-build-dir` adds the host's build folder to Microsoft Defender's exclusions. The host's SSH user must be an administrator.

### The Deploy panel

In Settings → Fleet, a server's **Deploy from source…** opens the Deploy panel. It asks for the checkout folder, with a Browse button, remembers it on this device, and lets you tick every server the build should go to.

An integration bench is remembered by its repository and branch, not its folder. Ion removes a bench's folder when its last worktree lands, and the work it held is then on the branch. Each check asks this device's server (`fleet.deploy.source`) which folder the bench names now: the bench while it is built, or else the checkout that has the branch. The panel says which one it builds. When neither exists, it says so and starts nothing.

Before anything is deployed, the panel asks the fleet what the deploy would do (a dry run) and says under each ticked server whether it is ready. A server that is not ready is left out, and the button says how many will deploy. For a build nothing can make, the panel lists what stops each server and has a button for each fix above: **Install build tools**, **Exclude from Defender**, and **Build elsewhere…**. Each runs on that server, shows its output, and checks the deploy again when it is done. **Install the latest release instead** has that one server take the release.

Once started, each server has a row with its step and the step's detail, and why it failed when it did. A row opens to show that server's build and install log as it grows. **Stop** ends the deploy; its record closes as stopped.

Closing the panel leaves the deploy running. The Fleet page shows a line above the servers for a deploy that is running or just ended, and **View** opens it again where it now stands, with its log.

### A deploy is reported as it runs

Every deploy, from the panel, the dashboard, or `ion fleet deploy`, keeps a record of itself: what is deployed, and each host's step. It tells the server on its own machine at every step, over that server's local socket, and at least every 30 seconds while it runs. That server:

- publishes the record to Studio, which is what the Deploy panel and the Fleet page draw;
- passes it to every [Fleet Hub](fleet-hub.md) it reports to, so the hub shows the same deploy.

A record that stops arriving while it still says running is shown as lost: the process running the deploy was closed, or its machine went offline. A machine with no Ion server running deploys the same way, unreported.

Each host also speaks for itself. A host that installs on itself tells its clients and its hubs each step: requested, downloading, installing, restarting. A host installed over SSH takes no part in its install, so the deploy tells it first, over its Studio connection when the device is paired with it. Either way the host leaves a marker in its data directory; the server that starts after the install finds it and says the host is back, with the version it now runs.

### Builds

A dev deploy builds each artifact once and installs it on every host that takes it. It builds on this machine when it can: a macOS server bundle builds on any Mac, a Linux bundle only on Linux of the same CPU, and a desktop only on its own OS and CPU. Otherwise a host of the fleet is its builder, and the plan names it: the first host that can build that platform and has the build tools (`go`, `node`, `npm`, and `make` on a Mac, `tar` and `curl` for a bundle). The deploy's own targets are asked first, then every other host of the fleet with an SSH target; a host that only builds installs nothing and is not restarted. From a Mac, a Windows desktop builds on a Windows host; from Windows, a Mac desktop builds on a Mac.

For a builder host, the deploy packs the checkout as it is in the working tree, new files included and ignored files left out, and ships it with a version stamp (`.ion-sync-stamp.json`, the one a `make sync-windows-vm` tree carries), since the host has no git history. The host builds in its `buildDir` (`~/.ion/fleet-build/ion` unless its deploy settings say otherwise): each build replaces the tree and keeps its `node_modules`, so `npm ci` runs only when `package-lock.json` changed. On Windows the build folder must be one Microsoft Defender does not scan in real time: electron-builder unpacks Electron there and renames the folder, and the rename fails while Defender holds the fresh files. The plan passes over such a builder before shipping anything and names the fix ([above](#a-host-that-cannot-be-deployed)). The result comes back to `~/.ion/fleet/artifacts/<component>-<os>-<cpu>/` here, and goes from here to every host of that platform, the builder included. `--no-build` installs the newest build already there.

### One host: `--to`

### Desktop hosts open at login

A desktop host is only in the fleet while Ion is running on it, and nothing reopens Ion after a restart unless it is set to open at login. A deploy to a desktop host turns on **Open Ion at login** there (Settings → Behavior → Startup) where nobody on the host has chosen. A person who turned it off keeps it off: the deploy leaves a choice alone. Pass `--no-open-at-login`, or put it in a profile's `args`, to leave the setting untouched.

On Windows the deploy also starts Ion afterwards when the setting is on, even if Ion was not running before. A Mac's package reopens Ion itself.

A Mac that installs on itself, with nothing run over SSH, gets the setting only when it has an SSH target. Otherwise turn it on in its Settings.

On the host itself, `ion studio open-at-login on|off` sets it from a terminal.

`ion fleet deploy --to [user@]HOST --kind desktop|server` deploys one host that need not be in the fleet; a host that is in it keeps its settings. It prints its steps as they run and ends with one line of JSON, the receipt a script reads. Unlike a fleet deploy, it stops when Ion is running on the host unless `--quit-ion` is given. `make deploy-studio-desktop` and `make deploy-studio-server` run it. The install options (`--quit-ion`, `--ask-sudo`, `--backup`, `--open`, `--no-open-at-login`, `--pair`, `--relay`, and the first-install `--label`, `--advertise`, `--tenancy`, `--system`) work for a fleet deploy too; `ion fleet deploy --help` lists them.

### Windows hosts

A Windows host runs the desktop; there is no Studio Server bundle for Windows. It needs OpenSSH Server with key authentication for an administrator's account, because the installer runs for every user (`/S /allusers`). The deploy quits a running Ion with a second launch carrying `--ion-force-quit` (Windows has no signals), stops one still running after a minute, installs, checks the version the uninstall entry reports, and starts Ion again in the signed-in user's session through a one-shot scheduled task, since a program started from an ssh session never shows on anyone's screen. The task may start on battery, so a laptop off its charger relaunches too, and the deploy waits until Ion is running: a launch Windows never starts, or an Ion that is not up 30 seconds later, is reported, not counted as opened. A restart from the fleet works the same way.

Before it deploys, the command prints its plan and what it changes between hosts:

- which pairs of hosts it breaks or fixes, per format;
- desktops that would drop out of a server's Studio wire window;
- a stored-data format it would lower on a host. This one stops the deploy until you pass `--allow-downgrade`.
- a target it cannot read today: one that is not answering, so the deploy will probably fail there, or one whose Ion is too old to report its formats, so a downgrade cannot be checked.

The plan names only the hosts it deploys. A host outside the deploy that is down is left out: the deploy changes no pair between two hosts it does not touch, and the compatibility matrices judge that host once it answers again. The command reads the fleet once for the plan; the dashboard's deploy uses what the dashboard already read, and reads only a host it has not read yet.

Builds run first, the ones on hosts at the same time. Then hosts deploy in parallel. `askSudo` hosts deploy last, one at a time, on your terminal. Each host writes a log under `~/.ion/fleet/logs/`. Every line of a build or install log starts with the time and the time since that step began (`[15:33:38 +1m30s]`), and a step that runs long adds a line every 30 seconds saying how long it has run and how long it has printed nothing, so a slow build and a hung one look different. A host's `askSudo` install types the password into one terminal session: sudo checks it first, then Ion quits, then the installer runs, so a password that never arrives leaves the host's Ion running. That session sends keepalives, so a tunnel or jump host does not drop it while you type. A failed host's line names the reason its install stopped and how long it ran, and a desktop that needs a sudo password says to set `askSudo` on it. When every host finishes, the fleet reads each one again to confirm the new versions.

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
