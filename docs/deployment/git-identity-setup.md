---
title: Git Identity Setup
description: Operator checklist for per-principal git credentials and repository creation -- Entra app registration, Azure DevOps, GitLab, GitHub, admin-managed credentials, host credentials, and sandbox prerequisites.
sidebar_position: 6
---

# Git Identity Setup

FR-04 (ADR-034) resolves a **per-principal git credential** — which SSH key or token a `git` operation authenticates with — independently of the **per-principal author identity** (name/email) a commit records. This guide is the operator-facing checklist for every external system the credential side depends on: exact portal steps, and the exact `server.json` / `engine.json` keys each step feeds. See [server.json's `git` section](../configuration/server-json.md#git) and [engine.json's `git` section](../configuration/engine-json.md#git) for the config shape reference this guide sets up.

None of these steps block implementation — the mechanism works with zero of them configured (every principal falls through to a user-supplied credential entered in Studio Settings, and then to the [host's own credentials](#host-credentials)). Each step below only blocks the specific credential source it configures from working end-to-end against your own tenant.

## Entra app registration for Studio sign-in

The same public client registration desktop and iOS already use for Studio sign-in (see [Ion Studio Server](studio-server.md) and [Relay with OIDC](relay-oidc.md)) is also where the `email` claim that drives commit authorship comes from.

1. In the Entra app registration, go to **Token configuration → Add optional claim**.
2. Add `email` to both the ID token and the access token.
3. Accept the prompt to consent the `email` Graph permission if offered.
4. Required claims after this: `sub`, `preferred_username`, `name`, and now `email`.

**Fallback when `email` is missing:** the server uses `preferred_username` when it contains an `@` character. When neither is present, commit author email is the bearer token's `sub` (subject), which is rarely a usable email address — configure the optional claim.

## Azure DevOps exchange

Lets a signed-in principal's Azure DevOps git operations authenticate as that principal via an on-behalf-of token exchange, rather than a shared service account.

1. On the **same** app registration as Studio sign-in, add the delegated permission **Azure DevOps / `user_impersonation`** (resource ID `499b84ac-1321-427f-aa17-267ca6975798`).
2. Grant tenant admin consent for this permission.
3. The on-behalf-of exchange needs a confidential-client credential: set `server.json`'s `oidc.clientSecret` (a `secretstore:` reference, resolved the same way as `git.credentials[].privateKey`).
4. Set `server.json`'s `git.exchange.ado.enabled: true`.

**Failure mode:** if admin consent is missing, the exchange fails and the server logs a warning identifying the failed on-behalf-of request; the principal falls through to the next credential source (GitLab exchange, then GitHub exchange, then a user-supplied credential) rather than blocking the operation outright.

## GitLab (self-hosted or SaaS)

1. In **Admin Area → Applications**, register one application.
2. Scopes: `api`. It covers git over HTTPS and creating a project from Studio's New project; GitLab has no narrower scope that can create one. A person who signed in while the application asked for `read_repository write_repository` signs in once more: creating a project with the older token is refused, and Studio says to sign in again.
3. Type: confidential.
4. Redirect URI: `https://<your-server-public-origin>/auth/git/callback?provider=gitlab`.
5. Set `server.json`'s `git.publicOrigin` to your server's own externally-reachable origin — the redirect URI above is built from it.
6. Set `git.exchange.gitlab.baseUrl`, `.clientId`, and `.clientSecret` (a `secretstore:` reference).

If your GitLab instance uses Entra as its own SSO provider, the authorize step is passwordless for a principal already signed into Studio — but that SSO is configured on GitLab's side, not Ion's; Ion only needs the GitLab OAuth application above.

## GitHub App

1. Create a GitHub App (not an OAuth App — the distinction matters for the `Contents`/`Metadata` permission model below).
2. Permissions: **Contents: read & write**, **Metadata: read**. Add **Administration: read & write** to let people create repositories from Studio's New project with this sign-in.
3. Enable **"Request user authorization (OAuth) during installation."**
4. Callback URL: `https://<your-server-public-origin>/auth/git/callback?provider=github`.
5. Install the App on your organization (or the specific repositories it needs). New project offers only the organizations the App is installed on, because a GitHub App's user token cannot act anywhere else; installing it on a person's own account offers that account too.
6. Set `server.json`'s `git.exchange.github.clientId` and `.clientSecret` (a `secretstore:` reference).

User-to-server tokens issued this way expire; the server refreshes them transparently using the stored refresh token — no re-authorization prompt on every session.

## Admin-managed credentials

For a credential the operator wants to provision directly, without any per-principal OAuth flow: `server.json`'s `git.credentials[]` array, one entry per `(subject, host)` pair:

```jsonc
{ "subject": "alice@example.com", "host": "github.com", "kind": "ssh", "privateKey": "secretstore:alice-github-key" }
```

`privateKey` (SSH) or `token` (HTTPS) may be a `secretstore:<key>` reference — resolved from an `ION_SERVER_<KEY>` environment variable first, then `<ION_DATA_DIR>/server-secrets.json`. The server materializes an SSH key to a per-principal, per-host directory under that principal's own storage partition (`principals/<PrincipalDir(subject)>/git/<sanitized-host>/`) with file mode `0600`, and points `GIT_SSH_COMMAND` at it (`-o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`). An HTTPS token materializes as a `GIT_ASKPASS` script (mode `0700`) instead, with `GIT_TERMINAL_PROMPT=0` so a resolver miss fails fast rather than hanging on an interactive prompt. There is no admin action that edits this list from Studio — an operator edits `server.json` directly.

## User-supplied credentials

A person can enter their own credential in **Studio Settings → Servers → the server → Git access** (desktop, browser, and iOS; the phone mints a key, takes a pasted key or token, and opens a git host's OAuth sign-in itself from the `authorizationUrl` the server returns). This is the lowest-precedence source — checked only after admin-managed credentials and every configured OAuth exchange have no match for that `(subject, host)` pair. A server-minted SSH key (Studio's "mint" action) never leaves the server: the private key is generated and stored server-side, and only the public key is ever sent to a client for display or for pasting into a git host's own key-management UI.

## Host credentials

The server's host user usually has git access of their own: SSH keys in `~/.ssh`, and sign-ins to `gh`, `glab`, or `az`. Git already uses those keys whenever a person has no Ion credential for a remote's host, so the Git access page lists them beside the credentials Ion stores. They are read-only there: they belong to the host user's own setup.

A signed-in CLI also serves as the last credential source. Its token answers when no admin-managed, exchanged, or user-supplied credential does, for the two callers that can use a token: a git operation against an HTTPS remote, and a git host's API (New project). An SSH remote never asks a CLI for anything.

| CLI | Hosts it serves | Read from |
| --- | --- | --- |
| `gh` | Every host in `~/.config/gh/hosts.yml` | `gh auth token --hostname <host>` |
| `glab` | Every host in `~/.config/glab-cli/config.yml` that has a user | `glab config get token --host <host>` |
| `az` | `dev.azure.com` and `*.visualstudio.com` | `az account get-access-token` for the Azure DevOps resource |

The token is asked for when it is needed and held in memory for a few minutes. It is never written to the credential store.

**On a shared server, switch this off.** The host user's sign-ins would otherwise answer for every person who connects. Set `server.json`'s `git.hostCredentials: false`: nothing from the host is listed, and no CLI is asked. Git itself still runs as the host user, so its `~/.ssh` keys still apply to an SSH remote unless a person's own Ion credential replaces them.

## Creating repositories

Studio's New project creates a repository on a git host and clones it onto the chosen servers. A server can create on a host when the calling person has a token for it there: any HTTPS token from the sources above, or the host's signed-in CLI. An SSH key cannot call a git host's API.

GitHub, GitLab, and Azure DevOps Services are known without configuration. A self-managed host is named in `server.json`'s `git.hosts[]`:

```jsonc
{ "host": "gitlab.example.com", "provider": "gitlab" }
{ "host": "github.example.com", "provider": "github", "apiBaseUrl": "https://github.example.com/api/v3" }
```

`provider` is `github`, `gitlab`, or `azure-devops`. `apiBaseUrl` defaults to the provider's usual path on the host. The GitLab instance configured under `git.exchange.gitlab` is known already and needs no entry.

What each token needs to create a repository:

- **GitHub:** a personal access token or `gh` sign-in with the `repo` scope, and `read:org` to list organizations. A GitHub App sign-in needs the Administration permission above.
- **GitLab:** the `api` scope, and at least the Developer role in a group whose settings let that role create projects.
- **Azure DevOps:** an Entra token (the on-behalf-of exchange, or `az`), or a personal access token with **Code: Read, write & manage** and **Project and Team: Read**. A repository is created inside an existing project and takes that project's visibility.

Every new repository starts with one commit holding a README, so a worktree can branch from it at once.

## Sandbox prerequisites

Per-principal execution boundary enforcement (ADR-034) relies on the OS-level sandbox (`security.sandbox` in [engine.json](../configuration/engine-json.md#securitysandbox)) as the adversarial boundary for shell execution.

- **Linux:** `bwrap` (bubblewrap) needs either unprivileged user namespaces enabled on the node, or the container/pod must run with `CAP_SYS_ADMIN`. Neither is Ion-specific — this is what `bwrap` itself requires to construct its mount namespace.
- **macOS:** Seatbelt (`sandbox-exec`) needs no special capability; it is a first-party macOS mechanism.
- When the sandbox degrades (the boundary cannot be constructed, e.g. missing user namespaces with no `CAP_SYS_ADMIN` fallback), the engine logs an ERROR-level line naming the specific failure rather than silently running unsandboxed. Search `~/.ion/engine.jsonl` (or the pod's equivalent) for `"level":"ERROR"` entries tagged with the sandbox subsystem if execution boundary enforcement appears not to be taking effect.
- A Kubernetes `securityContext` for a pod that needs `bwrap`: grant `CAP_SYS_ADMIN` explicitly (`securityContext.capabilities.add: ["SYS_ADMIN"]`), or configure the node's kernel to allow unprivileged user namespaces (`kernel.unprivileged_userns_clone=1` where applicable) and drop the extra capability requirement entirely.

## Tenancy and partitioning matrix

`server.json`'s `tenancy.mode` and `engine.json`'s `security.principalPartitioning.enabled` are independent settings that must agree. See [ADR-034](../architecture/adr/034-principal-isolation-and-tenancy.md) for the full rationale.

| `tenancy.mode` | `principalPartitioning.enabled` | Result |
| --- | --- | --- |
| `isolated` (default) | `false` (default) | Valid. Per-connection visibility/ownership gates enforce isolation on the wire; storage stays in the flat, pre-partitioning layout. The common single-tenant-engine, isolated-Studio-view deployment. |
| `isolated` | `true` | Valid. Wire-level isolation AND on-disk storage isolation, the full ADR-034 posture for a genuinely multi-tenant shared engine. |
| `shared` | `false` | Valid. Every connection sees every tab; storage stays flat. The deliberate single-team, no-secrets-between-us deployment. |
| `shared` | `true` | **Invalid — refused at boot.** `/readyz` reports `{ready: false, reason: "tenancy_conflict"}`, and the Studio wire refuses new connections with `studio_refused{reason:'not_ready'}`. Partitioned storage with a shared-visibility UI would show every principal's private data to every other principal — the two settings actively contradict each other, so the server never starts serving traffic in this combination. |

## See also

* [ADR-034: Principal Isolation and Tenancy](../architecture/adr/034-principal-isolation-and-tenancy.md)
* [server.json Reference — `git`](../configuration/server-json.md#git) and [`Tenancy`](../configuration/server-json.md#tenancy)
* [engine.json Reference — `security` and `git`](../configuration/engine-json.md#security)
* [Sealed Configuration](../enterprise/sealed-config.md) for the enterprise-forced variants of these settings
* [Ion Studio Server](studio-server.md) for the Entra two-tier registration this guide's app registration steps extend
