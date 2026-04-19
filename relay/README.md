# Ion Relay

WebSocket relay server for Ion remote control. Forwards encrypted messages
between the Ion desktop app and the iOS companion app. The relay is a
stateless pipe. It never decrypts or inspects message content.

## Build

```bash
make relay
```

This builds `ion-relay:latest` for `linux/amd64`.

## Publish to your registry

Tag the image for your private registry, then push:

```bash
docker tag ion-relay:latest <your-registry>/ion-relay:latest
docker push <your-registry>/ion-relay:latest
```

Examples:

```bash
# Azure Container Registry
docker tag ion-relay:latest myacr.azurecr.io/ion-relay:latest
docker push myacr.azurecr.io/ion-relay:latest

# GitHub Container Registry
docker tag ion-relay:latest ghcr.io/myuser/ion-relay:latest
docker push ghcr.io/myuser/ion-relay:latest
```

## Run locally (for testing)

```bash
export RELAY_API_KEY=$(openssl rand -hex 32)
docker run -p 8443:8443 -e RELAY_API_KEY=$RELAY_API_KEY ion-relay:latest
```

Verify the relay is running:

```bash
curl http://localhost:8443/healthz
# {"status":"ok"}
```

## Deploy to Kubernetes

See `deploy/example.yaml` for a reference manifest. Update the image,
hostname, TLS secret, and API key to match your environment.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `RELAY_API_KEY` | Yes | Shared secret for client authentication. Generate with `openssl rand -hex 32`. |
| `RELAY_PORT` | No | Listen port (default: `8443`). |
| `APNS_KEY_PATH` | No | Path to APNs `.p8` signing key (mount as volume in k8s). |
| `APNS_KEY_ID` | No | APNs key ID from Apple Developer portal. |
| `APNS_TEAM_ID` | No | Apple Developer Team ID. |
| `APNS_PRODUCTION` | No | Set to `1` for production APNs endpoint. Default is sandbox. |

APNs variables are only needed if you want push notifications on iOS when
the app is backgrounded. The relay works without them. You just won't get
lock-screen notifications for permission requests.

## Protocol

The relay exposes a single WebSocket endpoint:

```
GET /v1/channel/{channelId}?role={ion|mobile}
Authorization: Bearer {apiKey}
```

- `channelId`: 32-character hex string derived from the device token
- `role`: identifies which side of the channel this connection represents
- Messages are forwarded to the peer verbatim (opaque encrypted blobs)
- Control frames (`relay:peer-disconnected`, `relay:peer-reconnected`) are
  injected by the relay to notify each side of the other's connection state

## Security

The relay validates the API key on every WebSocket upgrade request. Without
a valid key, connections are rejected with HTTP 401. Even with a valid key,
all message payloads are end-to-end encrypted between Ion and iOS. The
relay cannot read them.
