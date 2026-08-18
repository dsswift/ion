# Ion Relay API Reference

All endpoints are served over HTTP/HTTPS on `RELAY_PORT` (default `8443`).
WebSocket connections require TLS in production; terminate TLS at your
ingress or load balancer.

---

## Endpoints

### `GET /healthz`

Health check. Always returns `{"status":"ok"}` with HTTP 200 when the
server is running. No authentication required.

**Response**

```json
{"status": "ok"}
```

Use this endpoint for Kubernetes liveness and readiness probes.

---

### `GET /v1/auth/config`

Returns the authentication modes currently active on this relay instance.
No authentication required. Clients use this to decide how to obtain a
token before connecting.

**Response**

```json
{
  "oidc": true,
  "issuer": "https://login.microsoftonline.com/{tenant}/v2.0",
  "audience": "api://<relay-app-id>",
  "requiredScope": "Relay.Access",
  "psk": false,
  "capabilities": {
    "mobileForwardAck": true
  }
}
```

Fields:

| Field | Type | Description |
|---|---|---|
| `oidc` | bool | `true` if OIDC mode is configured and active. |
| `issuer` | string | OIDC issuer URL. Present only when `oidc` is `true`. |
| `audience` | string | Expected `aud` claim. Present only when `oidc` is `true`. |
| `requiredScope` | string | Required scope, if configured. Omitted when no scope check is active. |
| `psk` | bool | `true` if PSK (shared key) mode is active. |
| `capabilities` | object | Relay feature capabilities. Always present. |
| `capabilities.mobileForwardAck` | bool | `true` when the relay sends `relay:forwarded` / `relay:peer-unavailable` ACKs back to mobile peers. |

Both `oidc` and `psk` can be `true` simultaneously when the relay is
running in dual-mode for migration purposes.

---

### `GET /v1/channel/{channelId}?role=ion|mobile`

WebSocket upgrade endpoint. Both sides of a channel — the Ion desktop app
and the iOS companion app — connect here. Messages written by one side are
forwarded verbatim to the other.

**Path parameters**

| Parameter | Description |
|---|---|
| `channelId` | Opaque channel identifier. The desktop derives this from the device pairing token. |

**Query parameters**

| Parameter | Values | Description |
|---|---|---|
| `role` | `ion` or `mobile` | Identifies which side of the channel this connection represents. Required. |

**Authentication**

All connections require a `Bearer` token in the `Authorization` header:

```
Authorization: Bearer <token>
```

In PSK mode, `<token>` is the shared key (`RELAY_API_KEY`). In OIDC mode,
`<token>` is a signed JWT obtained from the identity provider.

**OIDC channel isolation**

When OIDC mode is active, the first successful connection to a channel binds
that channel to the authenticated subject (`sub` claim). All subsequent
connections to the same channel — from both `ion` and `mobile` roles — must
present a token with the same subject. Connections from a different subject
are rejected with HTTP 403, regardless of whether their token is otherwise
valid.

Channel bindings are persisted to `RELAY_STATE_DIR` (when configured) and
survive relay restarts. This prevents a user from being evicted from their
own channel by a restart.

**WebSocket close codes**

| Code | Meaning |
|---|---|
| `4401` | Token expired. The relay closed the connection because the JWT's `exp` claim has passed. Reconnect with a fresh token. |

The Ion desktop app and iOS app handle `4401` automatically by minting a new
token and reconnecting.

**Control frames**

The relay injects two relay-internal control frames (not forwarded as user
data):

| Frame payload | Sent to | Meaning |
|---|---|---|
| `relay:peer-disconnected` | Connected side | The other side disconnected. |
| `relay:peer-reconnected` | Connected side | The other side reconnected. |

---

### `GET /v1/channel/{channelId}/status`

Returns the current connection state of both sides of a channel.

**Authentication**

Same Bearer token requirement as the WebSocket endpoint.

**OIDC access control**

In OIDC mode, only the subject that owns the channel can query its status.
A request from a different subject returns HTTP 403. This prevents presence
leaks across user boundaries.

**Response**

```json
{"ion": true, "mobile": false}
```

| Field | Type | Description |
|---|---|---|
| `ion` | bool | `true` if the Ion desktop side is currently connected. |
| `mobile` | bool | `true` if the iOS side is currently connected. |

---

## Authentication Modes

### PSK (Pre-Shared Key)

The relay compares the Bearer token against `RELAY_API_KEY` using a
constant-time comparison. Tokens that do not match are rejected with HTTP
401. No external dependencies.

### OIDC (JWT Bearer)

The relay validates tokens using the following checks, in order:

1. Token is a syntactically valid JWT.
2. Signature verifies against the provider's current JWKS (fetched from
   `{RELAY_OIDC_ISSUER}/.well-known/openid-configuration`).
3. Algorithm is `RS256`.
4. `iss` claim matches `RELAY_OIDC_ISSUER`.
5. `aud` claim contains `RELAY_OIDC_AUDIENCE`.
6. Token is not expired (`exp` claim).
7. If `RELAY_OIDC_REQUIRED_SCOPE` is set, the token's `scp` or `scope`
   claim contains the required value.

Tokens that fail any check are rejected with HTTP 401. The relay never
stores tokens or secrets from the identity provider.
