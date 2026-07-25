# Ion Relay Security

## End-to-End Encryption

The relay is a blind pipe. All message payloads are encrypted between the
Ion desktop app and the iOS companion app using AES-256-GCM before they
reach the relay. The relay forwards opaque bytes and never decrypts or
inspects message content. This is not a configuration option or a
trust-level; it is structural. Even a compromised relay cannot read
conversation content.

## Authentication

### PSK Mode

The shared key (`RELAY_API_KEY`) is compared against the incoming Bearer
token using a constant-time comparison (`subtle.ConstantTimeCompare`). This
prevents timing-based enumeration of the key. No token material is stored
after the comparison.

### OIDC Mode

The relay validates Bearer tokens entirely against the identity provider's
JWKS. No secrets are stored in the relay. Validation checks:

- Signature against the provider's current public keys (fetched via OIDC
  discovery, cached with automatic rotation)
- Algorithm: `RS256`
- Issuer matches `RELAY_OIDC_ISSUER`
- Audience contains `RELAY_OIDC_AUDIENCE`
- Token is not expired
- Scope matches `RELAY_OIDC_REQUIRED_SCOPE` (when configured)

Connections that fail any check are rejected before the WebSocket handshake
completes. The relay does not log token payloads.

## Channel Isolation

In OIDC mode, the first authenticated connection to a channel binds that
channel to the connecting user's subject (`sub` claim from the JWT). All
subsequent connections to the same channel must present a token with the
same subject. A connection from a different subject is rejected with HTTP
403, even if the token is otherwise valid and the user has relay access.

Channel bindings are persisted to disk (when `RELAY_STATE_DIR` is
configured) and survive relay restarts, preventing a user from being evicted
from their channel by a process restart.

In PSK mode there is no per-user isolation — all connections sharing the key
can access any channel. Use PSK only in single-user deployments.

## Token Lifecycle

Tokens are validated at WebSocket handshake time. Once a connection is
established, the relay monitors the token's `exp` claim and closes the
connection with WebSocket close code `4401` when the token expires. Clients
receive `4401`, mint a fresh token from their identity provider, and
reconnect. The relay never holds a token beyond the duration of the
connection.

## Revocation

When an identity provider deactivates a user account, the user's next
attempt to mint a token will fail at the provider. The worst-case access
window after deprovisioning is the remaining lifetime of the most recently
issued token. For Azure AD, token lifetimes are configurable at the
Conditional Access level. For lower revocation latency, shorten the token
lifetime in your provider's access policy.

## Audit Logging

All authentication events are logged as structured JSONL to the relay log:

- Successful connections: method (jwt or psk), subject (OIDC mode only),
  username (OIDC mode only), channel ID.
- Failed connections: reason, remote IP address.

No payload data is logged. Payload logging is structurally impossible: the
relay never decodes the encrypted payloads it forwards.

Log output is controlled by `RELAY_LOG_OUTPUT` and `RELAY_LOG_FILE`. See
[deployment-guide.md](deployment-guide.md) for the full variable reference.

## Browser Blocking

The relay rejects WebSocket connections from browsers. Upgrade requests that
carry an `Origin` header identifying a browser origin are rejected before
authentication. This prevents browser-based cross-site WebSocket hijacking
(CSRF via WebSocket). Native clients (the Ion desktop Electron app and the
iOS app) do not send an `Origin` header.
