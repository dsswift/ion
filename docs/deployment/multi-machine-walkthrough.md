---
title: Three machines, start to finish
description: One laptop driving a headless host and a second laptop -- installing each, pairing in one direction, what each machine can see, and moving work between them.
sidebar_position: 5
---

# Three machines, start to finish

This walks one setup from nothing to working. It uses three machines because
three is enough to show every mode at once:

- **Laptop A**, the one you sit at most. It runs the Ion desktop.
- **The headless host**, a Mac or Linux box with no screen that you reach
  over SSH. It runs the Studio Server as a background service.
- **Laptop B**, a second Mac that also runs the Ion desktop, for example one
  that belongs to a different part of your life.

The goal:

```text
Laptop A ──pairs with──▶ headless host
Laptop A ──pairs with──▶ Laptop B

Laptop B ──✕── headless host
Laptop B ──✕── Laptop A
```

From Laptop A you see and drive everything: its own conversations, the
host's, and Laptop B's, in one Inbox. From Laptop B you see only Laptop B.
The arrows do not run backwards, and the rest of this page shows why and how
to check it.

Each machine is an [Environment](../getting-started/concepts.md): a Studio
Server paired with one engine. A desktop install carries its own server, so
Laptop A and Laptop B are Environments too. The reference for everything
below is [Ion Studio Server](studio-server.md).

## 1. Laptop A

Install the desktop ([Desktop](desktop.md)) and open it. Settings →
Environments shows one row, **This Mac**. Nothing else is needed here yet.

## 2. The headless host

Laptop A needs key-based SSH to the host (`ssh-copy-id user@host` if a
password is still asked). On a headless macOS host the account also needs
passwordless `sudo`, because with no GUI session the services are system
LaunchDaemons.

On Laptop A: Settings → Fleet → Add server → **SSH**, type
`user@host`, Add. The desktop installs the server there, pairs with it
through an SSH port forward, and the host appears as a second row. The
dialog streams each stage. Nothing was typed on the host.

If you would rather install by hand, run the one-line installer on the host
([Install on a host](studio-server.md#install-on-a-host-one-line)), then
`ion studio pair` there and paste the link into Add server → Pairing
link.

The install belongs to the account you logged in as. Its data is that
account's `~/.ion`, and Laptop A acts on the host as that account
(`local:<username>`). See
[Who a paired device is](studio-server.md#who-a-paired-device-is).

Then, from Laptop A, open the host's row and set it up the same way you
would a new machine: **Git access** mints or reads its SSH key, **Projects**
clones your repositories onto it, and **Providers** stores the API keys on
its engine. Nothing is copied from Laptop A's configuration.

## 3. Laptop B

Laptop B needs the Ion desktop. Two ways to get it there:

- Walk over and install it, the same as Laptop A.
- Push it from Laptop A over SSH, from a checkout:

  ```bash
  make deploy-studio-desktop HOST=user@laptop-b.local ARGS="--ask-sudo --backup"
  ```

  `--ask-sudo` lets Laptop B's `sudo` ask you for its password in your
  terminal. `--backup` first copies Laptop B's `~/.ion` aside and installs
  nothing if the copy is short; use it when Laptop B already has an older
  Ion with conversations on it. Quit Ion on Laptop B first, or it keeps
  running the old version until relaunched. Details:
  [Pushing the desktop to another Mac](studio-server.md#pushing-the-desktop-to-another-mac).

Open Ion on Laptop B once so its server is running.

## 4. Pair Laptop A with Laptop B

Pairing is always started on the machine being joined, and finished on the
machine that joins. Here Laptop B is being joined. Pick one:

- **Pairing link.** On Laptop B: Settings → Servers → This Mac →
  Access & pairing → **Pairing link**. Get the link to Laptop A and paste it
  under Fleet → Add server → **Pairing link**. Treat the link like a password
  until it is used; it works once.
- **Nearby**, when both are on the same local network. On Laptop B:
  Settings → Servers → This Mac → Access & pairing → **Discovery**, make it
  discoverable for 15 minutes. On Laptop A: Fleet → Add server → **Nearby**, pick Laptop B,
  type the code Laptop B is showing. The window closes itself. An
  organization can seal discovery off, in which case the section offers
  nothing and the link is the way
  ([LAN discovery](studio-server.md#lan-discovery)).

Laptop A now lists three rows: This Mac, the host, Laptop B.

Laptop A acts on Laptop B as Laptop B's owner. It sees the conversations
already there and can run Laptop B's Environment page. That is the default
for a desktop's own server, because a desktop is one person's machine; see
[Tenancy](../configuration/server-json.md#tenancy) to change it.

## What each machine sees

| Sitting at | Sees conversations from | Can administer |
| --- | --- | --- |
| Laptop A | Laptop A, the host, Laptop B | all three |
| Laptop B | Laptop B only | Laptop B only |
| The host | has no screen; it serves whoever paired with it | |

On Laptop A every conversation is in one Inbox, marked with its machine.
The same repository on two machines is one project, and the
new-conversation picker shows a chip for each machine that has it. A click
on the row opens the conversation on Laptop A when Laptop A has the
repository; a click on a chip opens it on that machine instead, for that one
conversation.

On Laptop B, Settings → Fleet shows **This Mac** and nothing else.

## Why the arrows only point one way

Pairing gives the joining device a credential for the server it joined. The
server stores that device's public key and a label so it can recognize the
device next time. That is all it gets. In particular, Laptop B never
receives:

- an address or a credential for Laptop A's own server, or
- anything about the other Environments Laptop A has added, including the
  headless host.

So Laptop B cannot open a connection to Laptop A or to the host, and its
Environments list cannot grow by being paired *with*. For Laptop B to see
Laptop A you would have to repeat step 4 in the other direction, on purpose.

To check it rather than trust it:

- On Laptop B, Settings → Fleet lists only This Mac.
- On Laptop A, Settings → Servers → This Mac → **Access & pairing** does not
  list Laptop B. Laptop B has no device row anywhere but its own.
- On Laptop A, the host → **Access & pairing** lists Laptop A and not
  Laptop B.

Two things do cross, and you should know about them:

- **Laptop A's authority on Laptop B is full.** Its default scopes include
  `admin`, so from Laptop A you can mint keys, clone, update, and purge on
  Laptop B. Revoke it from Laptop B under Devices at any time.
- **A moved conversation leaves a marker.** When you transfer a
  conversation away from Laptop B (next section), Laptop B keeps a sealed,
  read-only copy noting that it moved. The note holds the destination's
  internal id, not its name, address, or a way in. Laptop B shows it as
  "Transferred to another environment" with nothing to click.

## Moving work between machines

From Laptop A, a conversation's context menu → **Transfer** moves an idle
conversation between any two of the three. Laptop A carries the data: it
exports from the source over its own connection and imports to the
destination over its own connection. The two ends never talk to each other,
which is why a transfer between the host and Laptop B works even though
those two are not paired.

A conversation in a worktree takes the whole worktree, with every
conversation in it. The machine it left keeps a sealed copy, and **Bring it
back** reverses the move. There is never a second writable copy of a
branch. See
[Transfer moves a worktree whole](studio-server.md#transfer-moves-a-worktree-whole).

The preflight checklist names anything missing on the destination (the
repository, the base branch, the project's setup) and offers the fix.
Uncommitted changes never travel; commit first.

## Away from home

Everything above assumes Laptop A can reach the other two directly: the host
over SSH, Laptop B on the local network. Away from that network:

- Every machine Laptop A should still reach needs to be on a relay. Ion does
  not host one; see
  [Relay-backed environments](studio-server.md#relay-backed-environments).
- Put the host on it with `ion studio relay set` there, or
  `make deploy-studio-server HOST=… ARGS="--relay wss://…"`. The host has
  nobody signed in, so the relay must accept a pre-shared key.
- Put Laptop B on it with
  `make deploy-studio-desktop HOST=… ARGS="--relay wss://… --relay-oidc"`,
  or `ion studio relay set` there. It signs in to the relay as whoever is
  signed in on Laptop B, which may be a different identity tenant than
  Laptop A's when the relay accepts both
  ([Several tenants on one relay](relay-oidc.md#several-tenants-on-one-relay)).
- Connect to each once from home afterwards. That is when Laptop A learns
  the relay; from then on it falls back to it whenever the direct route is
  silent, and returns to the direct route on its own.

## Undoing any of it

- **Stop Laptop A reaching a machine:** on that machine, Devices → Revoke
  Laptop A. Or on Laptop A, remove the Environment, which also offers to
  purge what it put there
  ([Removing an environment](studio-server.md#removing-an-environment)).
- **Remove the host's server:** `ion studio uninstall` on the host.
