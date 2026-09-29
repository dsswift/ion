---
title: Relay Server
description: Deploy the Ion Relay for remote iOS access via WebSocket.
sidebar_position: 4
---

# Relay Server

The relay is a stateless Go WebSocket server that bridges the Ion iOS app to a remote engine instance. It forwards encrypted messages between two peers on a channel without inspecting payloads. Optional APNs integration wakes iOS devices in the background.

## Build

Multi-stage Docker build. The final image is Alpine-based (needs `ca-certificates` for TLS to APNs).

```bash
# From repo root
make relay    # docker build --platform linux/amd64 -t ion-relay:latest

# Or directly
cd relay
docker build --platform linux/amd64 -t ion-relay:latest .
```

### Dockerfile

```dockerfile
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /relay .

FROM alpine:3.19
RUN apk add --no-cache ca-certificates
COPY --from=build /relay /relay
EXPOSE 8443
EXPOSE 5353/udp
ENTRYPOINT ["/relay"]
```

Port 5353/udp is for mDNS LAN discovery. Only relevant when running with `--net=host` or on bare metal.

## Configuration

All configuration is through environment variables.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RELAY_API_KEY` | Yes | -- | Hex secret for Bearer auth. Generate with `openssl rand -hex 32`. |
| `RELAY_PORT` | No | `8443` | Listen port. |
| `APNS_KEY_PATH` | No | -- | Path to APNs `.p8` key file. |
| `APNS_KEY` | No | -- | The `.p8` key's PEM text itself, for a secret injected as an environment variable. Set this or `APNS_KEY_PATH`, never both. |
| `APNS_KEY_ID` | No | -- | APNs key ID from Apple Developer portal. |
| `APNS_TEAM_ID` | No | -- | Apple Developer team ID. |
| `APNS_TOPIC` | With APNs | -- | The iOS app's bundle identifier, sent as the `apns-topic` header. Required when the three APNs variables above are set; the relay refuses to enable push without it. |
| `RELAY_WRITE_TIMEOUT_MS` | No | `10000` | Write timeout in milliseconds when forwarding messages to a peer. |
| `RELAY_PING_INTERVAL_S` | No | `30` | Interval in seconds between WebSocket keepalive pings. |
| `RELAY_PING_TIMEOUT_S` | No | `10` | Maximum seconds to wait for a pong response before closing the connection. |
| `RELAY_MAX_MESSAGE_SIZE` | No | `1048576` (1 MB) | Maximum WebSocket message size in bytes. Messages exceeding this limit cause the connection to close. |
| `RELAY_OIDC_ISSUERS` | No | -- | JSON array of further accepted OIDC issuers, each with its own audience and scope. See [Several tenants on one relay](relay-oidc.md#several-tenants-on-one-relay). |
| `RELAY_TRUSTED_ISSUERS` | No | -- | Comma-separated OIDC issuer URLs the relay trusts for server-announced trust (per-channel issuer override). See [Server-Announced Trust](relay-oidc.md#server-announced-trust). |
| `RELAY_STATE_DIR` | No | -- | Directory for persisted channel-owner bindings. Memory-only when unset (bindings do not survive a relay restart). The relay stores no push addresses; the server sends one with each push. |

APNs is optional. When the key (`APNS_KEY_PATH` or `APNS_KEY`), `APNS_KEY_ID`, `APNS_TEAM_ID`, and `APNS_TOPIC` are set, the relay sends push notifications to wake the iOS app when a message arrives on a channel where the mobile peer is disconnected.

The `.p8` key must come from the Apple Developer team that owns the app's bundle identifier (`APNS_TOPIC`). Apple refuses a push signed by another team's key, so a second relay that pushes to the same build of the app needs that same team's key, not a key from a different organization's account.

Each push goes to the Apple environment that issued the phone's token. A development build (Xcode, `make ios`) registers with the sandbox and a TestFlight or App Store build with production. The relay keeps no push addresses. Each paired phone registers its token and environment with its server (`device.registerPush`, over whatever connection it has), and the server sends them with every push it rings, so one relay serves every build, server, and person at once. The server decides who is rung: a push about a conversation reaches only the devices of the people who may see that conversation. `APNS_PRODUCTION` only picks the environment for a push that arrives without one.

## Local development

```bash
export RELAY_API_KEY=$(openssl rand -hex 32)
cd relay && go run .
```

The relay listens on `:8443` and advertises itself via mDNS on the local network.

## Kubernetes deployment

A reference manifest lives at `relay/deploy/example.yaml`. It includes Namespace, Secret, Deployment, Service, and Ingress resources. Copy and adapt it for your cluster.

### Generate the API key

```bash
openssl rand -hex 32
```

Store it in a Kubernetes Secret:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: ion-relay
  namespace: ion-relay
type: Opaque
stringData:
  RELAY_API_KEY: "your-generated-key-here"
```

### Resource requirements

The relay is lightweight. It holds WebSocket connections and forwards messages but does not buffer or process payloads.

| Resource | Request | Limit |
|----------|---------|-------|
| Memory | 64Mi | 128Mi |
| CPU | 50m | 200m |

### Health checks

The relay exposes `GET /healthz` which returns `{"status":"ok"}` with a 200 status code.

```yaml
livenessProbe:
  httpGet:
    path: /healthz
    port: 8443
  initialDelaySeconds: 5
  periodSeconds: 30

readinessProbe:
  httpGet:
    path: /healthz
    port: 8443
  initialDelaySeconds: 2
  periodSeconds: 10
```

### Ingress and TLS

WebSocket connections require long timeouts. Without explicit configuration, most ingress controllers close idle connections after 60 seconds.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ion-relay
  namespace: ion-relay
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - relay.example.com
      secretName: relay-tls
  rules:
    - host: relay.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ion-relay
                port:
                  number: 8443
```

Use cert-manager or your own TLS provisioning to populate the `relay-tls` secret. The relay itself does not terminate TLS -- that is handled by the ingress controller.

## Keepalive

The relay sends WebSocket ping frames at a configurable interval (default 30 seconds) to detect dead connections. If a pong response is not received within the timeout (default 10 seconds), the connection is closed and the peer is removed from the channel.

This is important for public internet deployments where NAT gateways, load balancers, and mobile network switches can silently drop idle TCP connections. The defaults are suitable for most deployments; adjust `RELAY_PING_INTERVAL_S` and `RELAY_PING_TIMEOUT_S` if your network has specific requirements.

## Compression

The relay offers `permessage-deflate` WebSocket compression. Clients that support it (the Ion Engine client and iOS `URLSessionWebSocketTask` both do) negotiate compression automatically during the WebSocket handshake. Clients that do not support compression receive uncompressed frames — no configuration needed.

Compression reduces bandwidth for the repetitive JSON structures in streaming events, which is beneficial for public internet deployments.

## Protocol reference

### Connection

```
GET /v1/channel/{channelId}?role={ion|mobile}
Authorization: Bearer <RELAY_API_KEY>
Upgrade: websocket
```

Each channel supports exactly two peers: one with `role=ion` (the engine) and one with `role=mobile` (the iOS app). Messages from one peer are forwarded to the other. The relay never inspects or modifies message content.

### Security model

- **API key validation**: every WebSocket upgrade request must include a valid Bearer token matching `RELAY_API_KEY`.
- **Origin check**: the relay rejects browser cross-origin WebSocket requests to prevent CSRF-style attacks from web pages.
- **End-to-end encryption**: all message payloads are encrypted by the clients before transmission. The relay forwards opaque byte sequences. It cannot read, modify, or replay message content.
- **No persistence**: the relay stores nothing to disk. Channel state exists only in memory for the duration of both peer connections.

## OpenID Connect Authentication

As an alternative to pre-shared keys, the relay can authenticate clients using OIDC tokens from any identity provider (Microsoft Entra, Keycloak, Okta, Auth0, Dex, etc.). Both authentication modes can be active simultaneously.

For full setup, configuration examples, and troubleshooting: see [Relay with OpenID Connect Identity](./relay-oidc.md).

OIDC mode requires:
- `RELAY_OIDC_ISSUER` — the OIDC issuer URL
- `RELAY_OIDC_AUDIENCE` — the relay's OAuth2 audience (app registration ID)
- `RELAY_OIDC_REQUIRED_SCOPE` — the scope name clients must request (e.g., `Relay.Access`)

Clients (desktop and iOS) mint tokens via their identity provider's token endpoint. The relay validates tokens by fetching JWKS keys from the issuer and verifying RS256 signatures.
