---
title: server.json Reference
description: Configure the Ion Studio Server's listeners, identity provider, relays, and pairing defaults.
sidebar_position: 7
---

# server.json Reference

`<ION_DATA_DIR>/server.json` configures the Ion Studio Server (`server/`,
`@ion/server`): which listeners it opens, which OIDC issuer (if any) its
`bearer` credential door trusts, which relays it announces trust on, and the
default scopes a pairing link grants. Every field is optional — an absent
file, or an absent field within a present file, resolves to the documented
default. `config/server-config.ts` is the loader; `config/current.ts` holds
the process-wide loaded value.

`server.json` is not one of the durable state files
(`persistence/state-files.ts` gates `tabs.json` et al. against corruption and
refuses to boot the store on a parse failure); it configures the server
itself, so a corrupt or unreadable `server.json` falls back to defaults,
loudly, rather than refusing to boot.

## Shape

```jsonc
{
  "label": "Josh's Mac",
  "listen": {
    "local": true,
    "lan": true,
    "tcp": { "host": "0.0.0.0", "port": 7331 }
  },
  "oidc": {
    "issuer": "https://login.microsoftonline.com/<tenant>/v2.0",
    "audience": "<server-client-id>",
    "scope": "Studio.Access",
    "rolesToScopes": {
      "Studio.Admin": ["admin", "conversations:read", "conversations:operate", "terminal:operate", "git:write"],
      "Studio.User": ["conversations:read", "conversations:operate", "terminal:operate", "git:write"]
    },
    "defaultScopes": [],
    "allowedSubjects": []
  },
  "relays": [
    { "url": "wss://relay.example.org", "psk": "secretstore:relay-psk" }
  ],
  "pairing": {
    "defaultScopes": ["conversations:read", "conversations:operate", "terminal:operate", "git:write"],
    "advertiseUrl": "http://grover.local:7331"
  },
  "engine": { "minVersion": "0.0.0" },
  "web": { "enabled": false },
  "tenancy": {
    "mode": "isolated",
    "unownedTabs": "hidden"
  },
  "git": {
    "publicOrigin": "https://ion.example.com",
    "credentials": [
      { "subject": "alice@example.com", "host": "github.com", "kind": "ssh", "privateKey": "secretstore:alice-github-key" }
    ],
    "exchange": {
      "ado": { "enabled": true },
      "gitlab": { "baseUrl": "https://gitlab.example.com", "clientId": "<client-id>", "clientSecret": "secretstore:gitlab-secret" },
      "github": { "clientId": "<app-client-id>", "clientSecret": "secretstore:github-secret" }
    }
  },
  "policy": {
    "authPolicy": "default",
    "actionInterceptor": "default",
    "snapshotProjector": "default"
  },
  "logLevel": "DEBUG",
  "logging": {
    "egressTargets": ["otel"],
    "egressOtel": { "endpoint": "https://otlp.example.com/v1/logs" },
    "egressShipSources": ["server"],
    "egressTokenScope": "api://ion/Telemetry.Write"
  }
}
```

## Fields

| Field | Default | Meaning |
| --- | --- | --- |
| `label` | the machine's hostname | The human-readable name a Studio client shows for this server (`studio_welcome.label`, `GET /auth/config.label`). |
| `listen.local` | `true` | Whether the local Unix-socket/named-pipe Studio listener starts. Always local-only — never reachable over TCP. |
| `listen.lan` | `true` | Reserved for a future LAN-advertised Studio listener (typed for forward compatibility; not yet wired to anything). |
| `listen.tcp.host` | `"0.0.0.0"` | Bind address for the TCP Studio listener. |
| `listen.tcp.port` | `7331` | Bind port for the TCP Studio listener and the `/healthz`/`/readyz`/`/versionz`/`/auth/config`/`/auth/pair` HTTP routes. `/versionz` reports the server and running engine versions, `engine.minVersion` and whether the engine meets it, the host app, and every [Format Version](../architecture/format-versions.md); like `/healthz` it needs no credential. |
| `listen.tcp.allowUnsealedPaired` | `false` | Whether a `paired` client may connect over TCP without sealing its frames. The listener speaks plain `ws://`, so a paired client names its pairing at upgrade time (`/studio?client=<clientId>`) and seals every frame with its pairing secret (AES-256-GCM, the same envelope a relay connection uses); without that the whole session crosses the network in cleartext. An unsealed paired hello is refused `unauthorized`. Set `true` only to admit a client that predates sealed frames while it is being updated. A server that seals says so in `/auth/config` (`sealedTcp: true`), which is how a newer client still reaches an older server. |
| `oidc` | `null` | Absent means the server fronts no identity provider: the `bearer` credential door refuses every token (`unauthorized`), and relays are announced with no trust (PSK-mode peers only). See [Bearer (`oidc`)](#bearer-oidc) below. |
| `relays` | `[]` | Relay servers this server maintains a persistent `role=ion` connection to, announcing `oidc` as its trust (manifest C7) when configured. See [Relays](#relays). |
| `pairing.defaultScopes` | `["conversations:read", "conversations:operate", "terminal:operate", "git:write"]` | Scopes a pairing link grants when the caller does not name explicit `scopes` in `auth.createPairingLink`. Never includes `admin` by default — an admin caller can still request `admin` explicitly. |
| `pairing.advertiseUrl` | `null` (derived: `http://<hostname>:<listen.tcp.port>`) | The HTTP base URL a pairing link tells the joining client to dial, as reachable *from the client*. Set it when the server sits behind a proxy or NAT, or when its hostname does not resolve on the LAN (a `.local` mDNS name is usually right on a home network). Must be `http(s)://`; anything else is ignored with a warning. |
| `engine.minVersion` | `"0.0.0"` | Minimum engine version this server requires; `/readyz` reports `engine_incompatible` below this, and `/versionz` reports it with `engineMeetsMin`. |
| `web.enabled` | `false` | Whether the server serves the browser Studio bundle (`server/web/`) on its HTTP listener. When `false`, `/` refuses with `{ "error": "web_disabled" }`. |
| `tenancy.mode` | `"isolated"` | `"isolated"` enforces every per-principal visibility and ownership gate (a tab, conversation, or action is visible/reachable only to the principal that owns it). `"shared"` disables all of them — every connection sees every tab. Refused at boot (`/readyz` reports `tenancy_conflict`) when the connected engine's `security.principalPartitioning.enabled` is also true, since partitioned storage with shared visibility is a leak, not a feature. See [ADR-034](../architecture/adr/034-principal-isolation-and-tenancy.md). |
| `tenancy.unownedTabs` | `"hidden"` when `oidc` is set, else `"visible"` | Visibility of a tab with no recorded `principalSubject` (a pre-partitioning legacy record) in isolated mode. Re-derived live from whether `oidc` is configured unless explicitly set — so enabling OIDC without touching this field still hides legacy unowned tabs from everyone. |
| `tenancy.subjectMoves` | `[]` | `[{ "from": "<old subject>", "to": "<new subject>" }]`. On every boot, everything stored under `from` moves to `to`. See [Tenancy](#tenancy). |
| `git` | see [`git`](#git) below | Per-principal git credential resolution and OAuth exchange configuration. |
| `policy.authPolicy` / `policy.actionInterceptor` / `policy.snapshotProjector` | `"default"` | Named policy overrides (manifest "opinionless mechanics, extensible opinions" — reserved for a future pluggable-policy mechanism; `"default"` is the only implementation today). |
| `logLevel` | `"DEBUG"` | Server log level. Matches the engine's own `logLevel` convention in `~/.ion/engine.json`. A value that is not one of `TRACE`/`DEBUG`/`INFO`/`WARN`/`ERROR` is reported at WARN and the default used. |
| `logging` | absent | Whether this server ships its own log lines off the host, and which files beside it it carries. Absent ships nothing, matching the engine. See [`logging`](#logging) below. |

## `logging`

`server.jsonl` is this server's own log, and nothing collects it unless something
is told to. On a workstation the desktop already ships it (`server` is in its
default source list). A headless server has no desktop, so this block is how it
ships for itself.

| Field | Default | Meaning |
| --- | --- | --- |
| `egressTargets` | `[]` (ship nothing) | `"http"`, `"otel"`, or both. Empty or absent means this server ships nothing. |
| `egressEndpoint` | none | POST URL for the `http` target. Named without it, those records have nowhere to go, and the server says so at WARN. |
| `egressHeaders` | none | Static headers for the `http` target. Non-string values are dropped. |
| `egressOtel` | none | OTLP config (`endpoint`, `headers`, `serviceName`) for the `otel` target. `serviceName` defaults to `ion-server`. |
| `egressBatchSize` | `0` (ticker only) | Records buffered before an automatic flush. |
| `egressFlushIntervalMs` | `5000` | How often the forwarder flushes. |
| `egressSpoolMaxBytes` | 50 MB | Cap on the on-disk spool that holds batches an unreachable sink has not accepted. |
| `egressShipSources` | `["server"]` | This surface's entry in the shipping-responsibility matrix. `server` is its own records, shipped in-process; `engine`, `ios` and `telemetry` are files beside it that it tails. An explicit `[]` means another surface ships on its behalf. |
| `egressTokenScope` | `""` | Mint an Authorization bearer for each flush at this scope, through the engine (`oidc_token`). Empty keeps whatever `egressHeaders` carry. A failed mint ships without authorization rather than dropping the line. |

`ION_LOG_OUTPUT` is separate and environment-only: `file` (default), `stdout`, or
`both`. The Docker image sets `both`, so `docker logs` carries the same lines the
volume's file does.

## Bearer (`oidc`)

When `oidc` is present, a `studio_hello`/`studio_reauth` `{kind:'bearer', token}`
credential is verified with `jose`'s `jwtVerify` against a JWKS resolved by
OIDC discovery from `oidc.issuer` (falling back to
`<issuer>/.well-known/jwks.json` if discovery fails). The resulting scope
grant is the union of `rolesToScopes[role]` for every `role` in the token's
`roles` claim; a token whose roles map to nothing (or that carries no `roles`
claim at all) falls back to `defaultScopes`. `allowedSubjects`, when
non-empty, additionally restricts which `sub` values are accepted regardless
of role. The token's `scp` claim must include `oidc.scope`.

Refusal reasons (logged, never sent on the wire — the Studio wire's
`studio_refused` reason enum has no per-door granularity): `wrong_audience`,
`wrong_issuer`, `token_expired`, `scope` (missing required `scp`),
`unlisted_subject`, `jwks_unavailable` (the issuer's JWKS could not be
fetched — `local` and `paired` doors are unaffected).

## Paired

A `{kind:'paired', clientId, proof}` credential is verified against
`<ION_DATA_DIR>/credentials.json` (`auth/credentials-store.ts`), a Tier-2
encrypted (`utils/secretStore.ts`) registry of clients minted by pairing
(`auth/pairing-links.ts#completePairing`, reached over LAN via `POST
/auth/pair` or over a relay pairing channel). `proof` is an HMAC-SHA256 over
the nonce `GET /auth/config` most recently returned, keyed by the client's
stored shared secret. A revoked client (`auth.revokeClient`) is refused
`credential_revoked`.

## Relays

Each `relays[]` entry is one relay server this Ion Studio Server maintains a
persistent connection to, joining the channel keyed by this server's own
`environmentId` as `role=ion`. `psk` may be a literal value or a
`secretstore:<key>` reference, resolved at load time:

1. An `ION_SERVER_<KEY>` env var (key upper-cased, `-` → `_`) — the pod/
   container path.
2. `<ION_DATA_DIR>/server-secrets.json`, a small Tier-2-encrypted key/value
   file — the local/desktop path (`config/secret-ref.ts`).
3. Unresolved: an empty string, logged at `WARN`.

When `oidc` is configured, every relay connection announces
`{issuer, audience, scope}` as its first frame after the WebSocket upgrade
(manifest C7) — a remote Studio client presenting a matching-audience bearer
can then join the same channel as `role=mobile` without also being enrolled
in the relay's own org-wide OIDC configuration. When `oidc` is absent, no
announce frame is sent at all; the relay validates joins with its own
configured PSK/OIDC, unchanged.

## Tenancy

`tenancy.mode` chooses between the default per-principal isolation and an explicit shared-visibility escape hatch. See [ADR-034: Principal Isolation and Tenancy](../architecture/adr/034-principal-isolation-and-tenancy.md) for the full rationale.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `mode` | `"isolated"` \| `"shared"` | `"isolated"` | `"isolated"` gates every tab, conversation, and `studio_action` by the connection's own principal. `"shared"` disables those gates entirely — every connection sees and can act on every tab, and `list_sessions`-style queries are sent without a subject filter. `principalSubject` is still stamped on every tab/conversation regardless of mode; shared mode only changes who can *see* it. |
| `unownedTabs` | `"visible"` \| `"hidden"` | derived live from whether `oidc` is set (`"hidden"` when set, `"visible"` otherwise) | Governs a tab with no recorded owner in isolated mode only — irrelevant in shared mode, where everything is visible regardless. |
| `subjectMoves` | `{ from: string, to: string }[]` | `[]` | Carries a person whose subject changed to their new one: pairings, git credentials, the principal record, their `principals/<dir>/` directory (their conversations under partitioning), tab and terminal stamps, and their settings overlay. A rewritten `tabs.json` or `studio-terminals.json` is backed up beside itself as `*.pre-subject-move.bak`. |

**A subject can change under a person.** Entra's `sub` is pairwise per app registration, so moving a server's `oidc` to another registration gives everyone on it a new subject, and everything keyed by the old one disappears from their view. Add a `subjectMoves` entry in the same change. A move finds nothing to do once it has run, so it can stay in the file.

**A desktop's own server defaults to `shared`.** A desktop install has no `server.json`, and it is one person's machine, so it starts its built-in server with `ION_STUDIO_PROFILE=personal` ([Environment variables](environment-variables.md#system-configuration)). Under that profile an unset `tenancy.mode` reads as `shared` and `pairing.defaultScopes` includes `admin`, which is what lets a second laptop paired to it see the owner's conversations and run its Environment page. Writing `tenancy.mode` in `server.json` overrides the profile. If the engine partitions storage per principal, the profile's shared default steps back to `isolated` on its own rather than tripping the conflict below; only an explicit `"shared"` does that.

**Boot-time conflict.** A server configured with `tenancy.mode: "shared"` against an engine that reports `principalPartitioning.enabled: true` on `get_host_info` is an intentional-looking misconfiguration: the storage layer is isolating principals from each other while the visibility layer shows everyone everything. `/readyz` reports `{ready: false, reason: "tenancy_conflict"}` rather than starting in a state neither side intended, and the Studio wire refuses new connections with `studio_refused{reason:'not_ready'}` until it's resolved.

**Presence is unaffected by tenancy mode.** Every connected principal's presence (which tab they're focused on, which tab they're driving) is sent to every connection regardless of `tenancy.mode` — presence answers "who else is here," not "what is in this tab," and isolated mode is not designed to hide the former.

## `discovery`

LAN discovery: whether the server announces itself on its local network as `_ion-studio._tcp`, so a desktop lists it under Add server → Nearby. See [LAN discovery](../deployment/studio-server.md#lan-discovery).

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `advertise` | bool | `false` | `true` announces the server for as long as it runs. This is the headless setting (`ion studio install --discoverable` writes it); change it by redeploying the config. `false` keeps the server silent unless a person opens a timed window from a desktop. The enterprise seal `customFields['ion-studio'].lanDiscovery: "disabled"` overrides this field. |

The announcement is only an address (label, environment id, version, port). Pairing still needs a one-time code or a pairing link.

## `git`

Per-principal git credential resolution: which SSH key, token, or OAuth exchange a `git` operation a tool runs authenticates with. Independent of the engine's own `git.identity` (`engine.json`), which resolves the author *name and email* a commit records — see [engine.json's `git` section](engine-json.md#git). Full operator-facing setup steps (Entra app registration, ADO/GitLab/GitHub app configuration) live in [Git identity setup](../deployment/git-identity-setup.md); this section documents the config shape only.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `publicOrigin` | string | `""` | This server's own externally-reachable origin (e.g. `https://ion.example.com`), used to build the `redirect_uri` the GitLab/GitHub OAuth exchange sources present at authorize time (`<publicOrigin>/auth/git/callback?provider=<gitlab\|github>`). Empty means GitLab/GitHub authorize is refused with a clear configuration error. Azure DevOps's on-behalf-of exchange needs no redirect URI and is unaffected. |
| `credentials[]` | array | `[]` | Admin-managed credentials: `{subject, host, kind: "ssh" \| "https-token", privateKey?, publicKey?, token?, username?}`, one entry per `(subject, host)` pair. `privateKey`/`token` may be a `secretstore:<key>` reference, resolved the same way as `relays[].psk` above. There is no action that mutates this list — an operator edits `server.json` directly. |
| `exchange.ado.enabled` | bool | `false` | Enables the Azure DevOps on-behalf-of exchange for every principal authenticated through this server's own `oidc` bearer door. Requires the app registration's `Azure DevOps / user_impersonation` delegated permission with admin consent, and `oidc.clientSecret` (or a cert) for the on-behalf-of token request. |
| `exchange.gitlab` | object \| `null` | `null` | `{baseUrl, clientId, clientSecret}` for a GitLab OAuth application (self-hosted or SaaS). `null` disables the GitLab exchange source entirely. |
| `exchange.github` | object \| `null` | `null` | `{clientId, clientSecret}` for a GitHub App configured for user-to-server OAuth. `null` disables the GitHub exchange source entirely. |

**Credential resolution precedence** (first match wins, sources awaited in order — never raced, so a slower higher-precedence source can never be shadowed by a faster lower-precedence one): `credentials[]` (admin-managed) → Azure DevOps exchange → GitLab exchange → GitHub exchange → a user-supplied credential entered in Studio Settings. Author identity (name + email) resolves separately and is documented under [engine.json's `git.identity`](engine-json.md#git).

## Pairing links and channels

`auth.createPairingLink{scopes?, label}` (requires `admin` scope) mints a
one-time link valid for 5 minutes: `{url, code, expiresAt}`. Requested
`scopes` must be a subset of the caller's own granted scopes (an `admin`
caller may delegate any scope, including `admin`); omitted `scopes` default
to `pairing.defaultScopes`.

`auth.createOwnPairingLink{scopes?, label}` (requires `conversations:read`)
mints the same link for one of the caller's own devices. The link names the
caller's own subject, so the device acts as the caller even when it pairs
without a bearer. Omitted `scopes` default to `pairing.defaultScopes`
narrowed to the scopes the caller holds, and never include `admin` for a
caller without it. It refuses `as` and `relay` (`admin_required`), and a
caller without `admin` on a `shared` install (`shared_tenancy`), where every
paired device acts as the host identity.

The link is `ion-studio://pair?code=<32 hex>&url=<advertised http base>&env=<server label>`
(`auth/pairing-links.ts#formatPairingLink`; parsed on the client by
`@ion/shared/pairing-link`). `url` is [`pairing.advertiseUrl`](#shape) or its
hostname-derived default, and is what makes the link self-contained: the
client dials that address for `POST /auth/pair` and, afterwards, for every
Studio wire connection.

With `relay: true` (or `pair.js --relay`) the server also opens a one-time
relay pairing channel on its first configured relay and the link gains
`relay=<relay url>`, `channel=<32 hex>`, and, for a PSK relay, `relayKey`.
A client that cannot reach `url` joins that channel and completes the same
exchange as a `pair_request`/`pair_response` message pair
(`auth/pairing-channels.ts`). Every pair response, over either door,
carries `relays: [{url, auth}]` -- the relays this server is on and how to
authenticate to each (`auth/relay-advertise.ts`) -- so a client paired on
the LAN can fall back to the relay later without the key ever appearing in
a link. When `relays[]` is empty, the relay set under Access & pairing →
Phone and relay (`settings.json`'s `relayUrl`/`relayApiKey`) is used instead.

**A relay that authenticates with OIDC.** An entry written as
`{ "url": "wss://…", "auth": "oidc" }`, or a desktop relay with no key, has
no `psk`. The server joins it with a token from its own operator's identity:
it reads the issuers the relay accepts (`GET /v1/auth/config`), takes the one
the operator is signed in to, and asks the engine for a token for that
entry's audience and scope. A pair response and every welcome then
advertise the relay as `{ "mode": "relay-oidc", "issuer": "<tenant>" }`,
naming the tenant the server joined with (absent until it has joined). The
relay binds each channel to the first account on it, so the paired client
signs in to that same tenant: the phone reads the relay's issuers and sets
up the matching sign-in, and a desktop signed in to a different tenant does
not join at all. When the client said who it is signed in as at
pairing (`relayIdentity`), the server announces that identity on the
client's relay channel, so the relay admits it even from a different
identity tenant than the server's. See
[Several tenants on one relay](../deployment/relay-oidc.md#several-tenants-on-one-relay).

**Installer defaults.** `ion studio install` writes `pairing.advertiseUrl`
(`http://<hostname>[.local]:7331`) and, for `tenancy.mode: shared`, a
`pairing.defaultScopes` that includes `admin`: a shared host is one person's
lab box, every device they pair is theirs, and `admin` is what lets Settings
→ Providers store keys on that Environment. An `isolated` host keeps the
server's own default (no `admin`) and grants it per link.

**Headless servers.** A server with no Studio client attached has no `admin`
caller to mint a link, so the server ships a CLI that is one: run it *on the
server host*, where it dials the server's own local socket through the
`local` door (every scope, implicit same-machine trust) and prints the link.

```bash
ION_DATA_DIR=/var/lib/ion node dist/pair.js --label "josh laptop"      # prints the link
node dist/pair.js --scopes conversations:read,conversations:operate --json
```

In the desktop, Settings → All servers → Add server → **Pairing link**:
paste the link and Pair. The desktop runs the X25519 exchange against
`POST /auth/pair`, stores the shared secret and the server-registered
`clientId` (encrypted, `desktop-connections.json`) under the server's
`environmentId`, and adds a `{kind:'paired', via:'lan'}` catalog entry. `auth.createPairingChannel{relayUrl}` opens a
one-time relay pairing channel (`'pairing:'+32 hex chars`), also valid for 5
minutes and single-use, torn down by `auth.cancelPairingChannel` or on
expiry. `auth.listClients` and `auth.revokeClient{clientId}` manage the
`credentials.json` registry.

## `GET /auth/config`

Unauthenticated. Returns:

```jsonc
{
  "oidc": { "issuer": "...", "audience": "...", "scope": "Studio.Access" } | null,
  "transports": ["local", "paired", "bearer"],
  "environmentId": "<server-id>",
  "label": "...",
  "protocolVersion": 1,
  "serverVersion": "...",
  "nonce": "..."
}
```

`nonce` is the value a `paired` credential's proof must be computed against.
It rotates every 5 minutes; a proof computed against the immediately
preceding nonce still verifies, so a client that fetched `/auth/config` just
before a rotation is not refused.
