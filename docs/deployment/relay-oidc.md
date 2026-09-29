---
title: Relay with OpenID Connect Identity
description: Set up an Ion relay with OIDC identity provider authentication instead of pre-shared keys.
sidebar_position: 5
---

# Relay with OpenID Connect Identity

The Ion relay can authenticate clients using OpenID Connect (OIDC) tokens instead of (or alongside) pre-shared keys. This guide covers the identity-provider-agnostic setup, implementation details, and troubleshooting.

## Architecture: Client and Resource Registrations

OIDC integration in the relay requires two separate registrations in your identity provider:

1. **Client Registration** — represents the Ion desktop and iOS applications
   - Type: public client (mobile + desktop)
   - Redirect URIs: `ionremote://auth` (iOS) and `http://localhost/callback` (desktop PKCE loopback)
   - No client secret (public client)

2. **Resource Registration** — the relay API itself
   - Exposes a scope (e.g. `Relay.Access`) that clients request
   - Returns tokens with `aud` (audience) matching the relay's issuer configuration
   - Defines the `requiredScope` the relay validates

The client registration must be granted permission to request the scope from the resource registration. In Microsoft Entra terms, this is configured via `requiredResourceAccess` on the client; equivalent mechanisms exist in other OIDC providers.

## Identity Provider Support

The relay works with any OIDC-compliant identity provider:

- **Microsoft Entra ID** (Azure Active Directory)
- **Keycloak** (open-source identity platform)
- **Okta** (commercial)
- **Auth0** (commercial)
- **Dex** (open-source, Kubernetes-native)
- Self-hosted OIDC servers

The relay does not require the identity provider to run in the same cloud (Entra does not mandate Azure hosting; the relay runs anywhere and uses standard OIDC discovery + JWKS). The following examples use Entra as a worked reference, but all steps have equivalents in other providers.

## Hard Requirements

### 1. Client Redirect URIs

Register these exact redirect URIs on the client registration:

- `ionremote://auth` — iOS app PKCE callback (via `ASWebAuthenticationSession`)
- `http://localhost/callback` — Engine loopback PKCE callback for desktop (port-agnostic; Entra matches on host + path)

Both use PKCE (Proof Key for Public Clients) for security without a client secret.

### 2. Token Version (Entra-Specific Sharp Edge)

If using Entra, the **resource** registration's token version **must be v2**. In Entra portal: **Expose an API → API version → 2.0**.

Via Azure CLI:

```bash
az ad app update --id <relay-app-id> --set api.requestedAccessTokenVersion=2
```

Why: Entra v1 issues tokens with `iss: https://sts.windows.net/<tenant>/` while the relay is configured with the v2 issuer `https://login.microsoftonline.com/<tenant>/v2.0`. When these don't match exactly, JWT validation fails with "issuer mismatch" and every connection returns 401. See [troubleshooting](#issuer-mismatch-v1-vs-v2) below.

### 3. Scope String Format

Scope follows the Entra convention: `api://<audience>/<requiredScope>`.

- The relay env var `RELAY_OIDC_REQUIRED_SCOPE` is the **bare scope name** (e.g. `Relay.Access`)
- Clients requesting a token compose the full scope as `api://<audience>/<requiredScope>`
- The token's `scp` or `scope` claim carries the bare name; the relay matches it against `RELAY_OIDC_REQUIRED_SCOPE`

Desktop and iOS both compose the scope automatically from the relay's advertised audience and required scope (see [Client Token Acquisition](#client-token-acquisition)).

### 4. Relay Environment Variables

Configure the relay with these OIDC vars (all required for OIDC mode):

| Variable | Example | Description |
|----------|---------|-------------|
| `RELAY_OIDC_ISSUER` | `https://login.microsoftonline.com/<tenant-id>/v2.0` | OIDC issuer URL (Entra v2 format if using Entra). Must match token's `iss` claim exactly. |
| `RELAY_OIDC_AUDIENCE` | `<relay-app-id>` | OAuth2 audience (the relay app registration client ID). Relay validates token's `aud` claim includes this. |
| `RELAY_OIDC_REQUIRED_SCOPE` | `Relay.Access` | Bare scope name. Relay validates token's `scp`/`scope` claim includes this. |
| `RELAY_OIDC_ISSUERS` | `[{"issuer":"https://login.microsoftonline.com/<other-tenant>/v2.0","audience":"<app-id-in-that-tenant>","requiredScope":"Relay.Access"}]` | (optional) Further issuers accepted alongside the one above, as a JSON array. See [Several tenants on one relay](#several-tenants-on-one-relay). |
| `RELAY_OIDC_ADMIN_ROLE` | (optional) | Role name from token's `roles` claim for admin access (Phase 4). |

The relay also supports `RELAY_API_KEY` alongside these for PSK mode. Both can be active simultaneously (see [Coexistence](#coexistence)).

### 5. Relay Validation Behavior

The relay at startup:

1. Fetches OIDC discovery from `<issuer>/.well-known/openid-configuration`
2. Discovers the JWKS endpoint and fetches RSA public keys
3. Caches JWKS with daily background refresh + on-demand refetch (rate-limited to once per 5 minutes when a key ID is unknown)

Per connection:

1. Parses the Authorization Bearer header as a JWT
2. Validates RS256 signature using JWKS keys
3. Validates `iss` (exact match), `aud` (must include relay audience), `scp`/`scope` (must include required scope)
4. Applies 60-second clock leeway for `exp` and `nbf`
5. Extracts identity claims (`oid` or `sub` for subject; `preferred_username` for username; `roles` array)

On validation failure, the relay closes the WebSocket with 4401 (custom close code for "token rejected"). Clients invalidate their cached token and re-acquire via silent refresh or interactive sign-in.

## Client Token Acquisition

### Headless engine

A headless engine can authenticate relay reconnects using any configured machine **bearer** source: client credentials, certificate assertion, workload federation, Azure Managed Identity, or GCP metadata. `relay.useOidc`, `relay.oidcScope`, and `relay.oidcAudience` use the same broker as `ctx.http`; no human sign-in or stored refresh token is required. AWS SigV4 does not apply because relay accepts an OAuth bearer token. See [Machine identity](machine-identity.md).

### Desktop

The Ion engine owns the OIDC token lifecycle:

1. Engine runs the PKCE authorization-code flow (loopback callback server)
2. Desktop opens the authorization URL in the system browser
3. Engine exchanges code → tokens; persists encrypted refresh token
4. Engine mints per-scope access tokens on demand via `oidc_token` requests

The desktop never holds tokens; it orchestrates the browser step and consumes identity/token state via the engine wire.

### iOS

iOS acquires tokens independently when offline from the desktop:

1. **Tier 1: In-memory cache** — if a valid token exists, use it
2. **Tier 2: Silent refresh** — using a Keychain-persisted refresh token, request new tokens without user interaction
3. **Tier 3: Interactive PKCE** — launch `ASWebAuthenticationSession` and have the user sign in

The redirect URI is hardcoded as `ionremote://auth` (custom scheme callback).

iOS always acquires its own token. It signs in as the **client registration** the server it is paired with signs in as: the server names that app as `clientId` on each relay it advertises (`relay-oidc` mode, alongside the tenant `issuer`), read from the server's `engine.json` (`auth.oauth.<identityProvider>.clientId`). The token is for the relay's entry in that tenant (`api://<audience>/<requiredScope>`). The relay's `audience` is never the sign-in app unless the server names none; then iOS keeps the app the pairing already signs in with for that tenant, and only as a last resort tries the relay's registration, which works only when one registration is both the relay API and a client with `ionremote://auth`.

## Configuration Example: Entra

### 1. Create the Client Registration

In Entra portal:

1. **App registrations** → **New registration**
2. **Name**: `Ion (Public Client)`
3. **Supported account types**: Accounts in this organizational directory only (Single tenant)
4. **Redirect URI**: 
   - Platform: **Mobile / Desktop**
   - URI: `ionremote://auth`
   - Then add another: **Web**
   - URI: `http://localhost/callback`
5. Save

In **Authentication**:

- **Allow public client flows**: Yes
- **Default client type**: Treat application as a public client

### 2. Create the Resource Registration

1. **App registrations** → **New registration**
2. **Name**: `Ion Relay API`
3. **Redirect URI**: (leave empty; this is the resource, not a client)
4. Save

In **Expose an API**:

1. **Application ID URI**: Set to `api://<relay-app-id>`
2. Click **Add a scope**
   - **Scope name**: `Relay.Access`
   - **Who can consent**: Admins only (or your preference)
   - **Admin consent display name**: `Access relay`
   - **Description**: `Access Ion relay for remote iOS sessions`
3. Save

In **App roles** (optional, for `RELAY_OIDC_ADMIN_ROLE`):

1. Click **Create app role**
2. **Display name**: `Relay.Admin`
3. **Value**: `Relay.Admin`
4. Save

### 3. Grant Client Access to Resource Scope

1. Go to the **Ion (Public Client)** registration
2. **API permissions** → **Add a permission**
3. **My APIs** → select **Ion Relay API**
4. Check **Relay.Access**
5. Click **Add permissions**

### 4. Configure Relay Environment

```bash
export RELAY_OIDC_ISSUER="https://login.microsoftonline.com/<tenant-id>/v2.0"
export RELAY_OIDC_AUDIENCE="<relay-app-id>"  # Ion Relay API app ID
export RELAY_OIDC_REQUIRED_SCOPE="Relay.Access"
export RELAY_OIDC_ADMIN_ROLE="Relay.Admin"  # optional

# Token version: set to v2
az ad app update --id <relay-app-id> --set api.requestedAccessTokenVersion=2
```

### 5. Configure Desktop and iOS

Both applications seed the client registration ID into their configuration:

- **Desktop** (`~/.ion/engine.json` after first start):
  ```json
  {
    "auth": {
      "identityProvider": "entra",
      "oauth": {
        "entra": {
          "clientId": "<client-registration-app-id>"
        }
      }
    }
  }
  ```

- **iOS** is told the same client registration ID by the server it pairs with (`clientId` on the advertised relay), so it needs no configuration of its own.

## Coexistence: OIDC and PSK

The relay can serve both OIDC and PSK (pre-shared key) authentication simultaneously. At startup:

- If `RELAY_API_KEY` is set, PSK mode is enabled
- If `RELAY_OIDC_ISSUER` + `RELAY_OIDC_AUDIENCE` are set and JWKS discovery succeeds, OIDC mode is enabled
- If neither is configured, the relay fails to start

Per request, a JWT-shaped bearer token routes to OIDC validation; a non-JWT bearer routes to PSK comparison. Both can coexist for phased migration or multi-consumer scenarios.

## Several tenants on one relay

One person can be signed in to different identity tenants on different machines: a personal tenant on one laptop, a work tenant on another. A relay with one `RELAY_OIDC_ISSUER` refuses the second machine outright, because its token names a different issuer. `RELAY_OIDC_ISSUERS` lists the others:

```
RELAY_OIDC_ISSUER=https://login.microsoftonline.com/<personal-tenant>/v2.0
RELAY_OIDC_AUDIENCE=api://<relay-app-in-personal-tenant>
RELAY_OIDC_REQUIRED_SCOPE=Relay.Access
RELAY_OIDC_ISSUERS=[{"issuer":"https://login.microsoftonline.com/<work-tenant>/v2.0","audience":"api://<relay-app-in-work-tenant>","requiredScope":"Relay.Access"}]
```

Each entry carries its own audience and scope, because a token is minted by the tenant the person is signed in to, for a resource registration that exists **in that tenant**. The work entry above names the relay registration the work tenant already has; nothing is registered or consented across tenants. A token is routed to the entry whose `issuer` equals its `iss` claim and is validated against that entry only, so a work token minted for the personal audience is refused.

- The single-issuer variables, when set, are the first entry; the first entry is the **primary**. The list may also stand alone.
- A malformed list, or an entry with no issuer or no audience, stops the relay at startup with the reason. An issuer whose keys cannot be fetched at startup is kept and heals on the first token that names it.
- `GET /v1/auth/config` reports every entry under `issuers[]`, primary first, and repeats the primary in its top-level `issuer`/`audience`/`requiredScope` for a client that reads only those. A client picks the entry whose issuer is the tenant it is signed in to.
- Every configured issuer is also trusted for [server-announced trust](#server-announced-trust), with no second listing in `RELAY_TRUSTED_ISSUERS`.

### Two desktops, two tenants

A desktop serves its own Environment through its relay, and another desktop joins that channel. Each signs in to the relay as itself: it reads `issuers[]`, takes the entry for the tenant it is signed in to, and presents a token for that entry. The hosting desktop owns the channel under its own subject. The joining desktop told the host who it is signed in as when it paired, and the host announces exactly that identity on the channel (see `subject` under [Server-Announced Trust](#server-announced-trust)), so the relay admits that one person from the other tenant and nobody else. The engine reports which issuer signed the operator's identity (`oidcIssuer` on `engine_oidc_identity`), which is how each desktop knows its own.

A desktop's own relay connection, the one its phone reaches it through, resolves its sign-in the same way at every start, and keeps the result only for the relay it was resolved against. Pointing a desktop at a different relay therefore takes that relay's entry for the desktop's tenant, not the previous relay's audience. A relay that accepts a single issuer is used as it is, with no matching.

Channel ownership binds to the bare subject for the primary issuer, so bindings made before a list existed still match, and to `<issuer>|<subject>` for every other entry, because two issuers can hand out the same subject string.

## Subject-Based Channel Ownership (OIDC Only)

When OIDC is enabled, the relay binds channels to identity subjects. A channel belongs to the server that holds the pairing, so only the **ion** role claims one: the first server identity to connect owns it, and any other identity is rejected from then on.

A client (the `mobile` role) never claims a channel. It may join one nobody owns yet, and it must match the owner once there is one. The moment a server claims a channel, a client on it under another identity is closed, because it could not join now.

That split is not cosmetic. While binding happened on any role, a client that reached an unowned channel first took ownership of it: the server that owned the pairing then joined with its own account, was refused on its own channel, and stayed refused, because a binding is persisted and never expires. Recovering meant deleting the channel's `owner-<channelID>.json` from `RELAY_STATE_DIR` by hand.

This prevents one OIDC user from eavesdropping on another's relay sessions. PSK connections (non-authenticated) bypass ownership entirely, so OIDC + PSK coexistence means some sessions are gated by identity and some are not.

## Server-Announced Trust

The org-wide `RELAY_OIDC_ISSUER`/`RELAY_OIDC_AUDIENCE` above validate every peer against ONE Entra tenant registration -- workable for a relay serving one organization, not for a relay hosting Ion Studio Servers whose people are gated by different tenants. Server-announced trust is a per-channel override that lets each server name its OWN issuer, audience, and scope, without requiring every one of its people to also be enrolled in the relay's own org-wide registration.

### How it works

The ion peer (the server) sends, as its very first text frame after the WebSocket upgrade, a `relay_announce` frame:

```json
{"type":"relay_announce","trust":{"issuer":"https://login.microsoftonline.com/<tenant>/v2.0","audience":"api://server-app-id","scope":"Studio.Access"}}
```

The relay stores this per channel, in memory only, replacing any prior announcement for that channel outright. A mobile or client peer that later joins the SAME channel is validated against the ANNOUNCED issuer/audience/scope instead of the relay's own org-wide OIDC -- but only when the announced issuer appears in `RELAY_TRUSTED_ISSUERS` (see below). A channel whose ion peer never announces is validated exactly as before this feature existed: the relay's own org-wide `RELAY_OIDC_ISSUER`, or PSK.

An announcement may also name the one subject allowed to join:

```json
{"type":"relay_announce","trust":{"issuer":"https://login.microsoftonline.com/<joiner-tenant>/v2.0","audience":"api://<app-id>","scope":"Relay.Access","subject":"<joiner-oid>"}}
```

With `subject` set, a valid token for the announced issuer that proves anyone else is refused with `subject_not_announced` (HTTP 403). This is how a channel that belongs to one paired device admits its owner when that person is signed in to a different tenant than the host: the host owns the channel under its own subject, and announces the joiner's. A join that reaches the announced issuer's keys but presents a token they refuse reports `jwt_validation_failed`; `jwks_unavailable` means the keys themselves could not be loaded.

The announcement is scoped to the connection that made it: when the announcing ion peer disconnects, its channel's announcement is cleared. A reconnecting ion peer re-announces (or doesn't) independently on its next connection.

### `RELAY_TRUSTED_ISSUERS`

```
RELAY_TRUSTED_ISSUERS=https://login.microsoftonline.com/tenant-a/v2.0,https://login.microsoftonline.com/tenant-b/v2.0
```

A comma-separated allowlist of issuer URLs the relay is willing to fetch JWKS for and validate an announced-trust bearer against. **JWKS is fetched only for an allowlisted issuer** -- an ion peer announcing an issuer outside this list is refused with `issuer_not_trusted` (HTTP 403) before any network call, so an unlisted issuer can never trigger an outbound fetch from the relay. Leaving this variable unset trusts no issuer at all: every announced-trust join then refuses with `issuer_not_trusted`, which is the safe default (a relay operator who has not populated the allowlist gets a relay that refuses every announced-trust join, not one that silently accepts any issuer an ion peer names).

Each trusted issuer's JWKS is fetched and cached once (same daily-refresh, rate-limited-refetch behavior as the org-wide `RELAY_OIDC_ISSUER` above), independent of how many channels announce that issuer. Two channels announcing the same issuer with different audiences are each validated against their OWN announced audience.

### Pairing channels

A one-time pairing channel is a special announcement used for the initial device-pairing handshake (a phone scanning or entering a code from a server's Studio UI). Its id is prefixed `pairing:` (e.g. `pairing:3f9a2b1c...`, 32 hex characters), and its announcement carries `pairing:true` and an expiry instead of an issuer/audience:

```json
{"type":"relay_announce","trust":{"pairing":true,"expiresAt":1735689600000}}
```

- Valid for 5 minutes from the announcement (or the explicit `expiresAt`, whichever is sooner).
- Single use: the first successful mobile join marks it used; every later join -- even from the same peer -- is refused with HTTP 410 (Gone).
- No bearer token is validated for a pairing channel. Its identity guarantee comes from the DH pairing handshake the two peers run over the forwarded frames after the relay accepts the join, not from anything the relay itself checks.

### `GET /v1/channel/{id}/status`

Status applies the identical announced-trust check as join: a channel with an announcement (including a pairing channel) validates the requester the same way a join would, before revealing any presence information.

### No listing endpoint

There is no endpoint that lists active channels, announced or otherwise. A relay operator (or an attacker) cannot enumerate channels; a channel's existence is only observable by someone who already knows its id.

Ownership is persisted to disk (when `RELAY_STATE_DIR` is configured) and survives relay restarts. Admins can unbind channels manually (Phase 4).

## One iPhone, Multiple Tenants

A single phone can be paired with desktops that authenticate against **different identity tenants through different relays** — a personal tenant on a home relay and a work tenant on a corporate relay, for example. The iOS app holds one OIDC identity **per pairing**, not one per device.

### What is per-pairing

| State | Scope | Where it lives |
|---|---|---|
| Issuer, client ID, scope | Per pairing | `PairedDevice`, from the tenant and sign-in app that server advertises for its relay and the relay's `issuers[]` entry for that tenant |
| Access token (in memory) | Per pairing | One `OIDCTokenManager` per device ID |
| Refresh token | Per pairing | Keychain, keyed `com.ion.oidc.refresh.<deviceId>` |
| Account identity (display) | Per pairing | `PairedDevice`, parsed from that pairing's `id_token` |

Switching desktops in the app switches every one of these together. Signing in to the work tenant never disturbs the personal pairing's credential, and the personal token is still cached when you switch back — no re-prompt.

Each pairing signs in independently. Automatic reconnect uses a cached access token or silent refresh only; it never opens a blind browser sheet. When interaction is required, iOS first names the desktop, issuer/tenant, and prior account, then the user chooses **Continue to Microsoft** or **Not Now**. Not Now hides that desktop's cached data until a later authenticated snapshot proves access again.

A temporary network disconnect is different: cached data remains visible with its last synchronization time while Ion reconnects. An explicit cancellation, sign-out, wrong-account refusal, or pairing rejection hides tabs, conversations, resources, terminals, and desktop settings for that pairing. A successfully authenticated LAN connection is sufficient access even if relay OIDC is unavailable.

### Which account is bound to a desktop

**Settings → Desktops & Connection** lists each paired desktop with the account it is bound to. Tapping a desktop opens its detail sheet, which shows the account, the issuer host, when it was signed in, and two actions:

- **Switch Account** — opens a pairing-context screen first, then signs in interactively and rebinds this pairing to the chosen account. The authorization request sends `prompt=select_account`, so Safari does not silently choose an account from the other tenant.
- **Sign Out** — deletes this pairing's saved credential and immediately hides its cached desktop data. The pairing itself is kept; authentication recovery remains available.

Unpairing a desktop also deletes that pairing's refresh token, so an unpaired work desktop leaves no usable credential behind on the phone.

### "Wrong account for this desktop" (HTTP 403)

The relay binds a channel to the first **server** identity that connects to it (see *Subject-Based Channel Ownership* above) and answers `403 forbidden: channel owned by another identity` to any other subject. On the phone this surfaces as **Wrong account for this desktop** on the pairing, and the app stops reconnecting for it.

That stop is deliberate. A 403 is not an expired credential: refreshing produces a token for the **same** subject, so a retry loop can never succeed and would only drain the battery. Recover with **Switch Account** and pick the account that owns the channel.

Distinguish it from the other two failures:

| Symptom | Meaning | Recovery |
|---|---|---|
| `401` at connect, or close code `4401` mid-session | Token expired or invalid | Automatic silent refresh; iOS explains and asks before interactive sign-in if needed |
| `403` at connect | Channel belongs to a different account | **Switch Account** on that pairing; an authenticated LAN session remains usable |
| Desktop shows offline in the picker, no error | No silent credential for that pairing | Open the desktop recovery screen and sign in; presence polling never prompts |

Presence polling for inactive desktops is silent by design: it uses each pairing's cached or refreshable token and reports *unknown* rather than raising a sign-in sheet you did not ask for.

## Troubleshooting

### 401 / "invalid credential" in Relay Logs

Decode the access token (use [jwt.io](https://jwt.io) or `base64url` the middle segment) and verify:

- **Issuer mismatch**: `iss` in token does not match `RELAY_OIDC_ISSUER`. If using Entra, confirm you set `api.requestedAccessTokenVersion=2` on the resource registration (not the client). v1 tokens have a different issuer URL.

### AADSTS650053 (Entra-specific)

Client requested a bare scope (e.g., `Relay.Access`) instead of the full scope (e.g., `api://<relay-app-id>/Relay.Access`). Desktop and iOS compose the scope automatically; this error signals a manual client or a custom integration composing the scope incorrectly.

### AADSTS50020 (Entra-specific)

The signing-in account is not a member or guest of the tenant that owns the app registrations. Verify the account exists in the tenant. If using an external account, ensure it has been invited as a guest.

### AADSTS500113 (Entra-specific)

The app the client signed in as has no redirect URI. Check which app ID the sign-in page was opened with (`client_id` in the authorization URL) before editing a registration:

- It is the **client registration**: register both redirect URIs in its public-client section, `ionremote://auth` and `http://localhost/callback`.
- It is the relay's **resource registration** (the relay's `audience`): the client was not told the server's sign-in app. The server names it from `engine.json` (`auth.oauth.<identityProvider>.clientId`); check that it is set on the server, then reconnect the phone to that server once on the same network so it receives it. Do not add a redirect URI to the resource registration.

### Relay Never Logs JWT Reason

If the relay rejects a token but does not log the reason (e.g., `issuer: got X, want Y`), the OIDC config did not initialize properly at startup. Check logs for discovery/JWKS errors. The relay can start with a partially-initialized OIDC config (falling back to PSK-only); watch the startup logs.

### iOS Cannot Acquire Token (Silent Refresh / Interactive Fails)

- **Silent refresh fails because the grant is rejected**: iOS deletes the stale refresh token, hides cached desktop data for that pairing, and shows pairing-specific recovery before any browser UI.
- **Interactive sign-in is needed**: iOS first explains which desktop and issuer/tenant needs access. The browser opens only after the user selects **Continue to Microsoft**.
- **Not Now or Apple-sheet cancel**: the pairing remains, but its cached desktop data stays hidden until an authenticated relay or LAN snapshot arrives.
- **Token endpoint timeout / 5xx**: transient network or provider failure. Cached data remains visible with reconnect state; retry continues without opening browser UI.

## Non-Entra OIDC Providers

When using a non-Entra OIDC provider, verify:

1. **Discovery document** is reachable at `<issuer>/.well-known/openid-configuration` and includes `jwks_uri`, `authorization_endpoint`, `token_endpoint`
2. **JWKS endpoint** returns RS256 keys (not ES256 or other algorithms; the relay only supports RS256)
3. **Tokens include required claims**:
   - `iss`: must match `RELAY_OIDC_ISSUER` exactly
   - `aud`: must include `RELAY_OIDC_AUDIENCE`
   - `scp` or `scope`: must include `RELAY_OIDC_REQUIRED_SCOPE`
   - `exp`: token expiry (validated with 60s leeway)
   - `oid` or `sub`: subject claim (used for channel ownership)
4. **Redirect URIs**: ensure the client registration accepts `ionremote://auth` (iOS) and `http://localhost/callback` (desktop)
5. **Scope format**: may differ from Entra's `api://...` convention. Check your provider's scope documentation and adjust the client/relay scope composition accordingly.

## References

- [OIDC Validation in Relay](https://github.com/dsswift/ion/blob/main/relay/oidc.go) — JWT parsing, issuer/audience/scope validation, JWKS caching
- [Desktop OIDC Orchestration](https://github.com/dsswift/ion/blob/main/desktop/src/main/oauth/entra-auth.ts) — engine-owned token lifecycle, browser flow
- [iOS Token Manager](https://github.com/dsswift/ion/blob/main/ios/IonRemote/Networking/OIDCTokenManager.swift) — three-tier token acquisition, single-flight guard
- [Relay Auth Middleware](https://github.com/dsswift/ion/blob/main/relay/auth.go) — PSK + OIDC coexistence
- [Channel Ownership](https://github.com/dsswift/ion/blob/main/relay/channel_owners.go) — subject-based binding, persistence
