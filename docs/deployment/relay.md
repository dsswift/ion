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
| `APNS_KEY_ID` | No | -- | APNs key ID from Apple Developer portal. |
| `APNS_TEAM_ID` | No | -- | Apple Developer team ID. |

APNs is optional. When all three `APNS_*` variables are set, the relay sends push notifications to wake the iOS app when a message arrives on a channel where the mobile peer is disconnected.

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
