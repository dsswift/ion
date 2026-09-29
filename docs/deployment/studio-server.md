---
title: Ion Studio Server
description: Installing and reaching the headless Ion Studio Server -- one-line install, ion studio, the desktop's SSH door, relays, Compose, and Kubernetes.
sidebar_position: 4
---

# Ion Studio Server

The Studio Server is the headless extraction of the desktop's main process (`server/`, the `@ion/server` npm workspace): the Studio wire protocol, auth, worktree/bench orchestration, and every store slice the desktop overlay used to run in Electron's main process, now runnable without Electron at all. It speaks the [Studio wire protocol](../protocol/studio-wire.md) over TCP and a local Unix socket, and connects to an Ion Engine over the engine's own NDJSON socket -- see [Engine standalone](engine-standalone.md) and [Engine containers](engine-container.md) for the engine side.

Two processes, one data directory: the server owns no engine of its own. It resolves the engine's address exactly as the desktop does (`<ION_DATA_DIR>/engine.sock` on macOS/Linux), so the engine and server must share `ION_DATA_DIR` whenever they run as separate processes or containers.

## Install on a host (one line)

On the Mac or Linux box that will host the Environment:

```bash
curl -fsSL https://github.com/dsswift/ion/releases/latest/download/install-studio-server.sh | sh
```

That downloads the Studio server bundle for the host's platform from the
newest `server-v*` release, verifies it against the release's
`checksums.txt`, extracts it under `~/.ion/studio-server/versions/<v>`,
points `~/.ion/studio-server/current` at it, and runs `ion studio install`.
The bundle carries everything: the engine binary, a Node runtime, the built
server and its dependencies. Nothing else needs to be on the host; no
package manager runs there.

`ion studio install` writes a default `server.json` when none exists
(label = the short hostname, LAN listener on, `pairing.advertiseUrl` =
`http://<hostname>[.local]:<port>`, `tenancy.mode: shared` with `admin` in the
default pairing scopes -- see [Server JSON reference](../configuration/server-json.md#pairing-links-and-channels)),
installs both services, and waits on `/readyz`. An install is one account's:
it lives in that account's `~/.ion` and its services run as that account. The
host's first install takes port 7331; a second account's install on the same
host finds that port busy and takes the next free one (or `--port N`), and
every later command reads the install's own port from its `server.json`. On
macOS the services are LaunchAgents when a GUI session exists and system
LaunchDaemons via `sudo` when there is none (a headless Mac over SSH); in the
system domain the labels carry the account name
(`com.ion.studio-server.<user>`), so two accounts' installs never overwrite
each other's plist, and a reinstall retires the older unqualified label when
it pointed at the same data dir. When `sudo` needs a password
and there is no terminal to ask on, the install stops and prints the exact
`ssh -t … ion studio install --system` to run instead. On Linux they are
systemd user units with `loginctl enable-linger`. A machine already running
the desktop's own engine keeps it; only the server service is added.

Environment variables the installer honors: `ION_STUDIO_VERSION` (pin a
server version), `ION_RELEASE_BASE_URL` (a mirror), `ION_DATA_DIR`,
`ION_STUDIO_INSTALL_ARGS` (extra `ion studio install` flags such as
`--label lab --tenancy isolated --relay wss://… --relay-key …`), and
`ION_STUDIO_BUNDLE` (install a local tarball instead of downloading).

### `ion studio`

Everything after the install is one command on the host:

| Command | Does |
|---|---|
| `ion studio status [--json] [--no-latest]` | The whole host: the installed Studio Server bundle and Ion desktop, the engine running against the one installed, CPU and memory, conversations with an agent running now, relays, the owner's paired devices and which are connected now (read from the running server), every [Format Version](../architecture/format-versions.md) installed and running, service states and PIDs, `/readyz`, log paths, and the latest release (`--no-latest` skips that lookup) |
| `ion studio pair [--label L] [--as PERSON] [--scopes a,b] [--relay] [--code] [--json]` | Mints a one-time pairing link (`--relay` also opens a relay pairing channel for a client off the LAN; `--as` names the person the joining device belongs to on an `isolated` host; `--code` mints the short code for a desktop that found this server under Nearby) |
| `ion studio relay list \| set wss://URL (--oidc \| --key-stdin \| --key-file PATH) \| remove wss://URL` | Adds, changes, or removes a relay on an install that already exists, then restarts the services (`--no-restart` to skip). `install --relay` only names one on a first install. A pre-shared key is read from standard input or a file, never the command line |
| `ion studio restart` | Restarts both services and waits on `/readyz` |
| `ion studio update [VERSION] [--yes]` | Downloads and verifies a newer bundle, repoints `current`, asks before the restart that interrupts running agents |
| `ion studio uninstall [--purge-data]` | Removes the services and the bundle; the data directory stays unless purged |

Everything it does is also in `~/.ion/engine.jsonl` under the `studio`
tag.

### From the desktop: Add server → SSH

A host you can reach with key-based SSH needs no host-side step at all.
Settings → All servers → Add server → **SSH**, type `user@host` (or
`host:2222`, or an `~/.ssh/config` alias), Add. The desktop probes the host,
pipes the same installer above into `sh -s` there (pinned to the server
version this desktop shipped with; a desktop built from source, `npm run
dev` or `make desktop` alike, has no release for that version and instead
runs `make package-studio-server` in its own checkout for the host's
platform, streaming the build into the dialog, and ships that bundle),
opens a loopback port forward to the server's port,
mints a pairing link on the host with `ion studio pair`, and completes the
pairing through the forward. Stage transitions and installer lines stream
into the dialog as they happen.

The SSH login proves an account on the host, and the install is that
account's. Before touching anything the door says what the account already
has (an installed server and its port, conversations, git credentials,
projects). When the account already has a Studio Server the door installs
nothing: a laptop on an older build would downgrade it, and the person's
server is not this laptop's to replace. It pairs this desktop to the
existing install on the port its `server.json` names, so a second laptop
with the same SSH key is one more row under Devices and shares the same host
identity, git credentials, and configuration. Update is its own verb on the
Environment page. A different SSH key that lands in a different account is a
different install, on its own port, with its own pairings.

The result is an ordinary paired Environment reached over SSH: every later
connect re-opens the forward first and dials its local end, a dropped
forward is respawned on the same port so the broker's own reconnect finds
it, and disconnecting or quitting closes it. Requirements: key
authentication (a password prompt is refused and the message names
`ssh-copy-id`), and on a headless macOS host passwordless `sudo` for the
system LaunchDaemons. Removing the environment forgets the pairing and
closes the tunnel; the server keeps running on the host until
`ion studio uninstall` there.

### Pushing the desktop to another Mac or Windows PC

A desktop install carries its own Studio Server, so a machine with Ion on it
is an Environment another desktop can pair with. To put Ion on a Mac or a
Windows PC you reach over SSH, from a checkout (`ion fleet deploy --to` does
the work; `ion fleet deploy --help` lists every option):

```bash
make deploy-studio-desktop HOST=user@mac.local                       # build, copy, install, verify
make deploy-studio-desktop HOST=user@mac.local ARGS="--no-build"     # reuse the newest desktop/release/Ion-*.pkg
make deploy-studio-desktop HOST=user@mac.local ARGS="--pkg ./Ion.pkg" # install a package you already have
make deploy-studio-desktop HOST=user@mac.local ARGS="--pair"         # also launch Ion and print a pairing link
make deploy-studio-desktop HOST=user@mac.local ARGS="--ask-sudo --backup" # sudo asks you; ~/.ion is copied aside first
make deploy-studio-desktop HOST=user@mac.local ARGS="--quit-ion"     # Ion is open there: force-quit it, then install
```

It ends with one line of JSON on stdout
(`{"ok":true,"host":…,"version":…,"archs":…,"wasRunning":…,"opened":…,"backup":…,"relay":…,"relayApplied":…,"pairingLink":…}`),
with everything else on stderr, so a playbook can run it per host and read
the receipt. The host needs macOS, key-based SSH, and `sudo` for the system
installer: passwordless for an unattended run, or `--ask-sudo` from a
terminal, which runs the install step on a tty so the host's sudo can ask
for the password. `--backup` first copies the host's `~/.ion` to
`~/.ion-backup-<timestamp>` (a clone on APFS, so it is instant and takes no
extra space), checks that every conversation file made it, and installs
nothing when the copy is short; use it before the first launch of a build
that migrates older data. A package built here is for this machine's CPU:
the deploy refuses a host it would not run on, and verifies the installed
app's architecture afterwards (an Intel package on Apple silicon is fine).
The package will not replace a running Ion, so a host with Ion open is
refused before anything is copied; `--quit-ion` quits it by force and installs
once it is gone. No quit dialog is shown, because nobody is there to answer
it: the deploy sends Ion's main process SIGUSR2, which stops the sessions and
the engine and exits (the same Quit All an update restart performs), and kills
an Ion that is still running after 30 seconds. The package relaunches Ion
itself when someone is logged in to that Mac, so the next deploy to that
host needs `--quit-ion`. The receipt's `wasRunning` reports what was found.
`--relay` writes the relay after that relaunch, and Ion reads it only when it
starts, so a relay that changed restarts the running Ion. The receipt's
`relayApplied` is false only when that restart failed; the relay then takes
effect at Ion's next start.
A Windows host needs an administrator's SSH session, because the installer
runs silently for every user (`/S /allusers`). A running Ion there is quit
by a second launch with `--ion-force-quit`, the same forced quit, since
Windows has no signals; one still running after a minute is stopped. A
silent install does not start Ion, so the deploy starts it again in the
signed-in user's session when it was running, or with `--open`.
`--pair` needs a logged-in GUI session on the
host, because Ion has to be running for its server to mint a link;
otherwise pair later from Settings → Servers → This Mac → Access & pairing there, or make
it discoverable and use Nearby.

### Deploying a development build

`make deploy-studio-server` (`ion fleet deploy --to HOST --kind server`) is
the developer's shortcut around the release path: it packages the same
bundle CI would from the current checkout
(`scripts/package-studio-server.sh`), copies it to the host, and runs the
same installer with `ION_STUDIO_BUNDLE` pointing at the copy. A consumer
gets the identical layout, services, and `server.json`.

```bash
make deploy-studio-server HOST=grover.local                             # package, ship, install, health-check
make deploy-studio-server HOST=grover.local ARGS="--no-build --pair laptop"  # reuse the packaged bundle, mint a link
make package-studio-server GOOS=darwin GOARCH=amd64                     # just the bundle, into build/deploy
```

`node-pty` ships prebuilt binaries for macOS only and compiles on Linux, so
a Linux bundle is packaged on a Linux host of the same architecture (the
release job does) and the packager refuses the combinations that would ship
a bundle with no working terminal.

### Proving the host works before touching the desktop

`scripts/studio-wire-smoke.sh --host grover.local` is a headless Studio
client: it mints a pairing link over ssh, redeems it, connects with the
paired credential, creates a conversation on the host, reads a directory,
asks git, opens a terminal and reads its output back, sends a prompt through
the host's engine to a real completion, requests a fresh snapshot, and
deletes what it created (`--keep` leaves the conversation for the desktop to
find). Every step prints PASS/FAIL with the detail that explains it, so a
broken deploy names its own cause.

### Managing many hosts

`ion fleet` wraps both deploy scripts for many hosts at once: it reads each
host's status (installs, engine, load, running conversations, relays, and
[Format Versions](../architecture/format-versions.md)), shows which hosts can
transfer conversations to which, and redeploys a selection with one build per
platform. See [Fleet](fleet.md).

## Standalone (manual)

Without the bundle, the two processes run by hand from a checkout:

```bash
# Engine, in one terminal
ION_DATA_DIR=/var/lib/ion ion serve

# Server, in another
cd server
npm run build
ION_DATA_DIR=/var/lib/ion node dist/main.js
```

`server.json` (manifest contract C5, see [Server JSON reference](../configuration/server-json.md)) lives at `<ION_DATA_DIR>/server.json` and is optional -- every field defaults sanely for a bare `local`-only, no-OIDC, `web.enabled: false` boot.

## Using a remote Environment from Studio

Once paired (Settings → All servers → Add server, through a pairing
link, Nearby, SSH, or sign-in), the remote server's conversations appear in
the same Inbox as your local ones, live: the desktop stays
connected to every Environment at once. A remote row wears a badge naming
its environment, and hovering the row names it on the Host line with the
same remote mark. Opening a remote conversation shows that server's
transcript, Explorer, Git panel, and terminals, while every other
conversation stays exactly where it was; there is no switching, and the
window's active conversation is its own: nothing another Environment
publishes moves it.

A repository is one project wherever it is checked out. The Inbox files the
same repository on two machines under one project header, with the other
machine's groups labeled by machine, and the project scope selects the
repository rather than one machine's copy of it. The new-conversation
picker likewise lists one row per repository, with a chip per machine that
has it and a "clone" chip per machine that could; the chip picks where the
conversation runs (left and right arrows move it), and choosing a clone
chip clones there first. A picker opened from inside a worktree offers only
that machine, because the directory exists nowhere else. A project with no
origin has no identity to share and stays one project per machine.

Transfer (a conversation's context menu) moves an idle conversation between
any two connected Environments, in either direction.

### Provider keys on a remote environment

Providers and models live on each server's **Providers & models** page
(Settings → Servers → the server). Everything on that page acts on that
server:
the provider list and the models come from that server, an API key you
save is stored on that server's engine, a delegated-CLI sign-in runs on
that server. A remote host therefore gets its keys from the desktop; nothing
is copied from a laptop's config. Two limits are stated in the UI rather
than discovered: a sign-in whose CLI can only complete in a browser on the
host itself (the engine reports this per provider) is refused up front with
"sign in on the host, or use an API key", and a device that paired without
the `admin` scope is told so instead of failing silently. The installer's
default pairing scopes include `admin` for a `shared` host; an `isolated`
host grants it explicitly (`ion studio pair --scopes …,admin`).

### Who a paired device is

A Studio Server install belongs to one account on the host: its data lives
in that account's `~/.ion`, its services run as that account, and the SSH
login that installed it proved that account. Identity is partitioned by the
account on the host, and a device is only ever a device.

- On a `shared` host (the default for the installer and for a desktop's
  own built-in server: one person's install) every paired
  device acts as the host identity, `local:<username>` -- the same principal
  the person has sitting at the machine. Git credentials, engine and model
  configuration, and per-principal state are shared across all of that
  person's devices. Pairing a second laptop adds a row under Devices, not a
  second identity, and a key minted from one laptop is there from the next.
  On boot a shared host folds anything still keyed by a device
  (`paired:*` pairings, git credentials, principal directories, tab stamps)
  into the host identity, so an install that predates this behaves the same.
- On an `isolated` host (several people on one install) the subject is the
  person named on the pairing link: `ion studio pair --as bob` makes every
  device pairing through that link act as `user:bob`, so two of a person's
  devices share one partition while two people do not. A link minted
  with no person keeps the device as its own principal (`paired:<deviceId>`).
  `--as` is refused on a `shared` host, which has exactly one person.
- A person without `admin` pairs their own devices themselves. Signed in
  to a web Studio, they open Settings → the server → Access & pairing →
  Devices and use **Pair a phone** (a QR code) or **Pairing link**. Both
  mint through `auth.createOwnPairingLink`: the link names that person's
  own subject, so the device acts as them even when it does not sign in,
  and it grants only scopes they hold, never `admin`. They see only their
  own devices there; Revoke, discovery codes, and `--as` stay with an
  admin. This works on an `isolated` host only: on a `shared` host every
  device acts as the host identity, so only an admin may pair one.
- A different account on the same host is a different install: log in over
  SSH as that account and Add server installs a second server under it,
  on its own port, with its own pairings.

A server that offers sign-in (`oidc` in `server.json`) names the person by
their sign-in instead, on a `shared` host and an `isolated` one alike. The
desktop and the phone read `GET /auth/config` before they pair. When it
names a sign-in, they sign the person in and send the token with the
pairing: `Authorization: Bearer` on `POST /auth/pair`, or `bearer` on a
relay `pair_request`. The server checks the token before it spends the
code, and the device then acts as the token's subject, the same person a
browser sign-in is. A token the server rejects (`invalid_bearer`) or cannot
check because it has no sign-in configured (`bearer_unverifiable`) refuses
the pairing and leaves the code usable for another try.

Every client signs in as the app the server names (`oidc.clientId` on
`/auth/config`), never as the machine's own identity. Entra gives a person a
different `sub` in every app, so this is what makes the browser, the phone,
and the desktop the same person on the server. The phone and the desktop
open the browser to that app; the desktop's Sign in door keeps the refresh
token (encrypted, per server) and signs in again only when it is refused.

Pairing runs one way. The device that pairs gets a credential for that
server; the server gets nothing that lets it reach back into the device's
own Environment or any other Environment that device has added. See
[Three machines, start to finish](multi-machine-walkthrough.md) for what
that looks like across a laptop, a headless host, and a second laptop.

### The Environment page

Every server this desktop can reach is a row under **Servers** in the
Settings sidebar, the local server included. The row opens into that
server's pages; **All servers** lists them and adds new ones. Add server
lands on the new server's **Overview** with a "finish setting up" notice;
later, the same pages are where a server is reconfigured. Lists are one row
per item; adding, editing, and testing open in a side panel. The pages:

- **Overview.** How the desktop reaches the server, its live phase, Rename,
  Reconnect; server, engine, and bundle versions, host, data directory, and
  uptime; Restart and Update (through the bundle's own `ion studio`, so they
  apply only to a bundle install); Remove.
- **Projects.** The repositories registered on that host, one row each with
  its branch, status, and path. **Add project** offers a folder already on
  the host (browsed by typing a path, hidden folders on `.`), a git URL to
  clone there, or **Copy from another environment**: the repositories your
  other environments have and this one does not, cloned with their remote
  URLs into the base folder. Clones run on the host as jobs (progress,
  cancel, retry) and register the project with its repository identity
  stamped, so Transfer recognises it at once. A clone is registered **not
  trusted**: Ion runs none of its code, neither its `setup` from
  `.ion/worktree.json` nor a worktree's seed builds, until you choose
  **Trust project** from its row menu. Its detail panel names the setup
  command it declares, so you know what trusting it will allow. Trusting it
  also provisions every worktree of it that was left bare while it was
  untrusted. Each row offers Run setup (after trust), Change location
  (worktrees cut from it follow), and Remove; a checkout Ion cloned may also
  be deleted from disk, a folder you pointed Ion at is only forgotten.
- **Git access.** The credentials the host uses to reach your repositories:
  mint an SSH key on the host for a git host (copy the public key into your
  account there), or paste a key or a token. **Test access** runs
  `git ls-remote` from the host with that credential and reports the
  remote's default branch or git's refusal. The commit author is the host's
  global git identity, with a one-click copy from this Mac.
- **Providers & models.** API keys and sign-ins for this server's engine,
  its default models, the default provider, and the model tiers.
- **Agent rules.** Whether the agent may edit settings, the built-in browser
  tools, the Bash commands plan mode allows, engine profiles, and the AI
  workflow prompts.
- **Integrations** and **Workflow.** MCP servers, desktop automations,
  enterprise sign-in; git operation modes, inbox auto-settle, quick tools.
- **Access & pairing.** Every desktop and phone paired to it with its
  scopes, Revoke, **Pairing link**, and **Pair a phone**, which shows the
  eight-character code and a QR of the pairing link together and closes
  itself the moment the pairing lands. Without `admin` on the server,
  Devices lists only your own devices and pairs another as you, with the QR
  code alone ([Who a paired device is](#who-a-paired-device-is)). The row this desktop is connected
  through is marked and cannot be revoked here (its welcome names the
  pairing as `pairedClientId`); Remove the server instead. **Discovery**:
  whether the server announces itself on its local network, the control that
  makes it discoverable for a bounded time, and the one-time code to pair
  with it. See [LAN discovery](#lan-discovery). **Phone and relay**: how the
  server names itself on paired phones, the relay that reaches a phone off
  its network (tested from the server before it is saved), and the
  low-bandwidth toggles. Every server shows it; changing the relay needs
  admin on that server. A paired iPhone shows the same page for any server
  it administers.
- **Health.** CPU, memory, and disk; the Ion processes; which of `git`,
  `go`, `node`, `npm`, `gh` the host has, so a setup that needs a missing
  tool is explained before it fails; telemetry delivery; the tail of
  `engine.jsonl` and `server.jsonl`.

The local environment's Projects section carries the preference-only
extras (default project, profile choice, mounted folders) under each row;
there is no separate Projects tab.

The new-conversation picker lists one row per repository across every
environment, with a chip for each machine that has it. A click on the row
opens the conversation on this machine when this machine has the
repository, and otherwise on the first machine that does. A click on a chip
opens it on that machine. Neither choice is remembered, and the conversation
the window is showing has no bearing on it. A machine that does not have the
repository is not offered: clone the project onto it from that environment's
Projects section first. A server refuses a new conversation for a directory
its machine does not have.

Each row opens its project on one machine, and clicking the row is how you
do it. The row answers two separate questions in two separate places.

**Where it opens** is the machine named in the row's second line
(`grover · /path`), coloured to say which machine it is: this machine in the
accent, any other machine in the informational colour. That colour is what
keeps a row under "Other machines" from reading like a local one.

**Where else it could open** is the control on the right, and it offers only
machines the row is not already using: nothing when no other machine has the
project, one chip when a single other does, and one counted button opening a
menu when several do.

A per-machine section names the machine in its heading, so rows inside it
neither colour it nor offer one -- the sections themselves are how you choose
a machine there.

Two controls above the list decide how it reads. **Sort** is most-used or A
to Z; most used is the default and ranks by how often work has actually
started in each project, which every host records for its own projects and
reports on its listing. **Group** is this-Mac-first, one collapsible section
per machine, or no grouping at all. In the per-machine mode a project checked
out on three machines appears under all three, and opens on the machine whose
section you clicked it in. Both controls are per-device and are not synced.

### LAN discovery

A desktop can find a Studio Server on the local network instead of being
handed a link: Add server → **Nearby** lists the servers that are
discoverable right now. A server is silent by default, so nothing appears
until someone turns discovery on for it.

- **On a desktop**, Settings → Servers → the server → Access & pairing → **Discovery**
  makes it discoverable for 15 minutes or an hour. The window shuts itself
  off. While it is open the section shows a one-time code; type it on the
  other desktop to pair. The code pairs one device, then a fresh one
  replaces it, and it is burned after a handful of wrong guesses.
- **On a headless host**, discovery is a standing configuration:
  `ion studio install --discoverable` (or `discovery.advertise: true` in
  `server.json`) announces the server for as long as it runs, and
  redeploying the config turns it off. There is no screen to show a code
  on, so mint one when you need it with `ion studio pair --code`.
- **An organization can seal it.** With
  `customFields['ion-studio'].lanDiscovery: "disabled"` in the enterprise
  policy, a server never announces itself (whatever its config says, and
  even if the seal arrives after boot), the Discovery section offers
  nothing, and the Nearby door is not shown. Pairing then goes through a
  pairing link or another door.

Finding a server grants nothing. The announcement carries only its label,
environment id, version, and port; the code, like a pairing link, is what
admits a device.

### What a transfer moves

A conversation's **Transfer…** moves just that conversation. If it lives in
a worktree, the dialog asks what moves: **Just this conversation** (the
default) leaves the worktree and its other conversations where they are, so
a bug found in a worktree can be pulled out and worked on elsewhere, even
while the worktree has uncommitted changes. **The whole worktree** moves the
worktree instead.

The dialog then asks where it lands. **Lands in** lists the destination's
checkout of the same repository first, preselected, then every other project
under **Other projects**. Inside the chosen project, **Worktree** offers its
checkout, each of its live worktrees, or **New worktree**, which adds a
**From branch** field that starts on the conversation's own base branch when
the destination has it.

The destination can be the machine the conversation is already on. The
button then reads **Move**: nothing is exported or copied, the conversation
and its live session are pointed at the new checkout or worktree, and a
landing exactly where it already lives is refused.

**Transfer worktree…** on a worktree's row, in the Inbox or the git panel,
moves the worktree whole: the checkout and every conversation in it go to
another machine together. The commits travel as a git bundle cut against
what the destination already has, so a base branch that is behind there
still receives the commits the worktree was cut from, and the destination's
own base branch is left where it is. Uncommitted changes never travel;
commit first, or the move is refused.

A transfer is a move, not a copy. Once the destination has verified what it
received — every file re-hashed against the digest the source recorded — the
machine you left deletes its copy: the conversations, the tab, and, for a
whole-worktree move, the worktree checkout and its branch. There is no sealed copy, no read-only row,
and no second place the conversation might be. Moving it back later is just
a transfer in the other direction.

Nothing is deleted before that verification passes, so an interrupted
transfer always leaves the original where it was. A move that dies part-way
leaves the source marked unfinished: the conversation refuses prompts until
you either finish the move or abandon it, both offered on the tab.

### Transfer preflight

Transfer asks the source what the conversation carries and the destination
whether it can take it, and shows a checklist before anything moves: the
repository is on the destination (else **Clone it there**, using the source
checkout's origin and the matching folder under home). For a whole-worktree
move it also checks that the worktree is clean (else blocked) and that the
base branch is there (else it travels in the bundle, cut against the
commits the destination already has, and is created on import).

When the repository declares code to run (a setup, or worktree build
steps), the clone is where trust is asked. The row names those commands,
read from the source's own checkout, and offers **Clone and trust**, which
clones, trusts the project, and runs its setup the moment the clone lands,
or **Clone only**, which runs none of its code. A repository that declares
nothing offers just **Clone it there**.

A project cloned without trust shows a setup row that names the setup it
declares and offers **Trust and run setup**. Nothing runs until you press
it, and the conversation moves either way. Trusting it later also
provisions any worktree that landed in it meanwhile. A checkout you already
had shows no setup row: Ion cannot tell whether you ran a setup by hand, so
it does not claim you have not.

A worktree that moves whole arrives provisioned like any new worktree: the
destination runs the project's seed and setup once the import succeeds.

### Removing an environment

Remove appraises what Ion left on the host and removes the degree you tick.
Studio Server (the services and bundle) is always removed; git credentials,
the repositories Ion cloned (a dirty one is kept unless you say otherwise),
and all Ion data (conversations, config, pairings) are each a checkbox.
Removal runs on the host through its own `ion studio uninstall`, scheduled
detached because it stops the server that answers. **Forget on this device
only** leaves the host untouched. Adding the host again over SSH reports
what it still has ("Already on the host: 6 conversations…") before
installing, and everything present is kept.

## Pairing a phone with a server

The iOS companion pairs with a server directly, with no desktop in between.
Under **Pair Device** it lists **Ion Studio Servers** found on the network
alongside Ion desktops; tapping one asks for the server's own eight-character
code (`XXXX-XXXX`) — the same code a desktop types under Nearby. Scanning the
QR of a pairing link carries the whole thing instead, so nothing is typed:

```bash
ion studio pair --code          # on the host, or Settings -> Servers -> This Mac -> Access & pairing -> Discovery on a desktop-hosted server
```

The phone then holds its own pairing with that server: its own shared secret,
its own scopes, and its own entry under **Devices**, revocable on its own. It
is not routed through anyone's desktop, and a desktop being asleep or absent
changes nothing.

One thing has to be true on the server: **it is discoverable.**
`ion studio install --discoverable`, or Discovery on a desktop-hosted server.
Finding a server grants nothing — the code is the trust.

There is no second condition and no "accepts phones" switch. A phone is an
ordinary client of the Studio wire and reaches a server on the same port
every other client uses, so a server that can be found can be paired with.
The separate phone listener, its own port, and the `mobile` record in the LAN
announcement are all gone — see [ADR-035](../architecture/adr/035-one-wire.md).

Off the local network, the phone reaches the server through the relay the
pairing response named — `server.json`'s relay on a headless host, or the
Mac's own relay settings on a desktop-hosted one. A pre-shared-key relay needs
nothing further; an OIDC relay asks the person to sign in on the phone. A
server with no relay stays LAN-only, and the phone reconnects when it is back
on the network.

A phone that was paired before the Studio wire carried phones needs no new
pairing. At every start the server copies each such pairing into
`credentials.json` as a `mobile` client under the same id and the same shared
secret, acting as the install's own identity with every scope except `admin`,
so the secret the phone already holds proves itself on the Studio wire. A
pairing whose stored secret cannot be decoded is skipped with a logged reason
and the rest still migrate; a client that was revoked is never brought back.
The server's network announcement also carries the host's machine id
(`machine`), which is the id such a phone stored for its server.

## Relay-backed environments

A paired Environment keeps working off the LAN through a relay
([Ion Relay](../../relay/README.md), the same relay the iOS companion uses).
Ion does not host one; run the published `ghcr.io/dsswift/ion/relay` image
and point the server at it:

```bash
ion studio install --relay wss://relay.example.org --relay-key <psk>   # a first install: writes server.json.relays[]
printf '%s\n' "$KEY" | ion studio relay set wss://relay.example.org --key-stdin   # an install that already exists
ion studio relay set wss://relay.example.org --oidc                     # a relay the host signs in to as its operator
```

From a checkout, both deploy commands take the relay as they go:

```bash
ION_RELAY_KEY=… make deploy-studio-server HOST=host.local ARGS="--relay wss://relay.example.org"
make deploy-studio-desktop HOST=user@mac.local ARGS="--relay wss://relay.example.org --relay-oidc"
```

On a desktop this names the relay its Environment is served through. It does
not change the relay that Mac's own phone uses, so a laptop can stay on one
relay for its phone and be reachable by another desktop through a second.
A headless host has nobody signed in, so it needs a relay that accepts a
pre-shared key.

A desktop that already has a relay under its local environment's Phone &
relay section serves its own
Environment through it with nothing extra: when `server.json.relays[]` is
empty, the local server uses that relay for Studio channels too. That holds
for a relay that authenticates with OIDC as well as one with a key: each
desktop signs in to the relay as itself, and two desktops signed in to
different identity tenants meet on one relay that accepts both
([Several tenants on one relay](relay-oidc.md#several-tenants-on-one-relay)).
A desktop paired before either side ran a build with this support pairs
again once, so the host learns who will be joining.

The server holds one end-to-end encrypted channel per paired desktop on the
relay, keyed by the pairing secret; the relay only ever forwards ciphertext.
Every pairing (LAN, SSH, or relay) tells the desktop which relays the
server is on and how to authenticate to them, so a desktop paired at home
falls back to the relay from anywhere: it dials the LAN address first, uses
the relay when that is silent, and returns to the LAN on its own as soon as
the address answers again. The Environments row says which path is in use.

The server repeats that list on every connect, so a relay added after a
desktop paired is learned the next time that desktop connects on the LAN or
over SSH; nothing is paired again. An Environment added through the SSH
door falls back the same way when its forward cannot open, and returns to
SSH when it can.

Pairing itself can cross the relay. `ion studio pair --relay` opens a
one-time relay pairing channel and names it in the link; a desktop that
cannot reach the LAN address completes the same exchange through the
channel. Treat such a link as a password: it carries the relay's key.

## Docker Compose

`server/docker-compose.yml` runs the engine and the server as two services sharing one `/data` volume -- the same shared-data-directory requirement as the standalone case, expressed as a Docker volume instead of a shell variable.

```bash
cd server
docker compose up -d
curl -fsS localhost:7331/readyz
```

```yaml
# server/docker-compose.yml (abridged -- see the real file for the full
# annotated version, including the host.docker.internal wiring the local
# smoke fixture needs)
services:
  engine:
    build: { context: ../engine, dockerfile: Dockerfile }
    user: '1000:1000' # see below
    volumes:
      - data:/data
      - ./compose/enterprise.json:/etc/ion/config.json:ro
    environment:
      ION_DATA_DIR: /data
      ION_ENTERPRISE_CONFIG: /etc/ion/config.json

  server:
    build: { context: .., dockerfile: server/Dockerfile }
    depends_on: [engine]
    volumes:
      - data:/data
      - ./compose/server.json:/data/server.json:ro
    environment:
      ION_DATA_DIR: /data
      ION_SERVER_RELAY_PSK: ${ION_SERVER_RELAY_PSK:-}
    ports: ['7331:7331']

volumes:
  data:
```

### Why `engine` pins a numeric `user`

`engine/Dockerfile` is `FROM scratch` and always runs as root -- there is no `/etc/passwd` to declare a non-root `USER` against. `server/Dockerfile` runs as the standard `node` user (uid 1000) from the official `node:22-alpine` image. Left unpinned, the engine creates `engine.sock` as `root:root` mode `0755`, which a uid-1000 unix-socket **connect** cannot use (connecting to a domain socket needs *write* permission on the socket file, which `0755`'s "other" bits do not grant). Pinning the engine to `user: '1000:1000'` makes both containers the same uid, so the socket they share is one both can actually use. This was found and fixed by running the real compose stack end to end while building this deployment guide -- not a theoretical concern.

### Enterprise policy and `server.json`

`server/compose/enterprise.json` is a fixture `ION_ENTERPRISE_CONFIG` file (`{"allowedModels": [...]}`) mounted into the **engine** container; the server picks it up over the engine socket's `get_enterprise_policy` RPC and republishes it on every `studio_welcome.enterprisePolicy`. `server/compose/server.json` is the **server's** own config, mounted at `<ION_DATA_DIR>/server.json` inside the server container specifically (layered on top of the shared `/data` volume mount, so only the server container sees it there).

### Static web bundle

When `server.json.web.enabled` is `true`, the server serves `server/web/` (the renderer bundle a separate build step produces) at `/` with `.br`/`.gz` negotiation and content-hash-aware caching. It is `false` by default; `/` then answers `404 {"error":"web_disabled"}`.

## Kubernetes (outline)

The real cluster manifests for this deployment are private (operator infrastructure, not part of this repo). The shape is a standard two-container pod:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: ion-studio
spec:
  containers:
    - name: engine
      image: ghcr.io/dsswift/ion/engine:latest
      securityContext:
        runAsUser: 1000
        runAsGroup: 1000
      env:
        - name: ION_DATA_DIR
          value: /data
        - name: ANTHROPIC_API_KEY
          valueFrom: { secretKeyRef: { name: llm-keys, key: anthropic } }
      volumeMounts:
        - { name: data, mountPath: /data }

    - name: server
      image: ghcr.io/dsswift/ion/studio-server:latest
      env:
        - name: ION_DATA_DIR
          value: /data
        - name: ION_SERVER_RELAY_PSK
          valueFrom: { secretKeyRef: { name: studio-relay, key: psk } }
      ports:
        - { containerPort: 7331 }
      readinessProbe:
        httpGet: { path: /readyz, port: 7331 }
        periodSeconds: 5
      livenessProbe:
        httpGet: { path: /healthz, port: 7331 }
        periodSeconds: 10
      volumeMounts:
        - { name: data, mountPath: /data }
        - { name: server-config, mountPath: /data/server.json, subPath: server.json, readOnly: true }

  volumes:
    - name: data
      emptyDir: {}
    - name: server-config
      configMap: { name: ion-server-config }
```

Notes for a real cluster deployment:

- `/data` as an `emptyDir` loses conversation/tab state on pod restart. A real deployment mounts a PVC instead, matching the desktop's durable-state expectations.
- `readyz` failure modes (manifest C14): `state_file_corrupt` (a `/data` file failed to parse -- the pod should NOT restart-loop; the process stays up for probes and an operator investigates the file), `engine_incompatible` (the engine's reported version is below `server.json.engine.minVersion`), `engine_unreachable` (the engine container/process is down or the socket is gone), `tenancy_conflict` (ADR-034: `server.json`'s `tenancy.mode` is `"shared"` while the engine reports `principalPartitioning.enabled: true` -- fix by picking one; see [Git identity setup's tenancy matrix](git-identity-setup.md#tenancy-and-partitioning-matrix)). Only `engine_unreachable` is expected to resolve itself when the engine sidecar recovers; the readiness probe should not be configured to kill the server pod on any of these -- it should simply stop routing traffic to it.
- `ION_SERVER_RELAY_PSK` and every `secretstore:` reference in `server.json` (including `git.credentials[].privateKey`/`.token` and `git.exchange.*.clientSecret` -- see [Git identity setup](git-identity-setup.md)) should come from a Kubernetes `Secret`, never be baked into the image or the ConfigMap holding `server.json`.
- `NODE_OPTIONS=--max-old-space-size=512` is the server image's default (matching the manifest's nonfunctional resource guidance); override via an env var if the deployment's memory limit differs.
- If `engine.json`'s `security.sandbox.enabled` (or an enterprise `security.sandbox.required`) is set, the engine container's Linux sandbox (`bwrap`) needs either unprivileged user namespaces enabled on the node, or `securityContext.capabilities.add: ["SYS_ADMIN"]` on the engine container. Without one of these the sandbox degrades and the engine logs an ERROR-level line rather than silently running unsandboxed -- see [Git identity setup's sandbox prerequisites](git-identity-setup.md#sandbox-prerequisites).

## Image size

CI logs the built server image's size and fails the gate above 400MB (`quality.yml`'s `server-compose-smoke` job). The multi-stage `server/Dockerfile` runs `npm prune --omit=dev` after the esbuild bundle step specifically to stay under this: an un-pruned `npm ci` at the repo root installs every workspace's devDependencies (TypeScript, ESLint, Vitest, the desktop's Vite toolchain), none of which the running server needs.
