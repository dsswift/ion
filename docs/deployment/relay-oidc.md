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

When the desktop is reachable, it pushes tokens to iOS via `desktop_relay_config`, and iOS uses those instead of acquiring its own. When offline, iOS falls back to the three-tier flow.

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

- **iOS** receives `relayOidcClientId` via `desktop_relay_config` when the desktop is reachable.

## Coexistence: OIDC and PSK

The relay can serve both OIDC and PSK (pre-shared key) authentication simultaneously. At startup:

- If `RELAY_API_KEY` is set, PSK mode is enabled
- If `RELAY_OIDC_ISSUER` + `RELAY_OIDC_AUDIENCE` are set and JWKS discovery succeeds, OIDC mode is enabled
- If neither is configured, the relay fails to start

Per request, a JWT-shaped bearer token routes to OIDC validation; a non-JWT bearer routes to PSK comparison. Both can coexist for phased migration or multi-consumer scenarios.

## Subject-Based Channel Ownership (OIDC Only)

When OIDC is enabled, the relay binds channels to identity subjects. The first identity to connect to a channel owns it; subsequent connections from a different identity are rejected.

This prevents one OIDC user from eavesdropping on another's relay sessions. PSK connections (non-authenticated) bypass ownership entirely, so OIDC + PSK coexistence means some sessions are gated by identity and some are not.

Ownership is persisted to disk (when `RELAY_STATE_DIR` is configured) and survives relay restarts. Admins can unbind channels manually (Phase 4).

## Troubleshooting

### 401 / "invalid credential" in Relay Logs

Decode the access token (use [jwt.io](https://jwt.io) or `base64url` the middle segment) and verify:

- **Issuer mismatch**: `iss` in token does not match `RELAY_OIDC_ISSUER`. If using Entra, confirm you set `api.requestedAccessTokenVersion=2` on the resource registration (not the client). v1 tokens have a different issuer URL.

### AADSTS650053 (Entra-specific)

Client requested a bare scope (e.g., `Relay.Access`) instead of the full scope (e.g., `api://<relay-app-id>/Relay.Access`). Desktop and iOS compose the scope automatically; this error signals a manual client or a custom integration composing the scope incorrectly.

### AADSTS50020 (Entra-specific)

The signing-in account is not a member or guest of the tenant that owns the app registrations. Verify the account exists in the tenant. If using an external account, ensure it has been invited as a guest.

### AADSTS500113 (Entra-specific)

The redirect URI is missing from the client registration's public-client section. Verify both redirect URIs are registered:
- `ionremote://auth`
- `http://localhost/callback`

### Relay Never Logs JWT Reason

If the relay rejects a token but does not log the reason (e.g., `issuer: got X, want Y`), the OIDC config did not initialize properly at startup. Check logs for discovery/JWKS errors. The relay can start with a partially-initialized OIDC config (falling back to PSK-only); watch the startup logs.

### iOS Cannot Acquire Token (Silent Refresh / Interactive Fails)

- **Silent refresh fails**: Refresh token is missing or stale. Prompt interactive sign-in.
- **Interactive blocked by user-cancel cooldown**: iOS suppresses re-launching the sign-in sheet for 5 minutes after the user dismisses it, to avoid pestering.
- **Token endpoint timeout**: Network issue or IdP is slow. Retry with backoff.

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
