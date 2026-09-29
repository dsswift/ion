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
| `APNS_KEY` | No | The `.p8` key's PEM text itself, for a secret store that injects values as environment variables (such as a Key Vault reference). Set this or `APNS_KEY_PATH`, never both. |
| `APNS_KEY_ID` | No | APNs key ID from Apple Developer portal. |
| `APNS_TEAM_ID` | No | Apple Developer Team ID. |
| `APNS_TOPIC` | With APNs | The iOS app's bundle identifier. The relay refuses to enable push without it. |
| `APNS_PRODUCTION` | No | Set to `1` to send to production APNs when a push arrives without its token's environment. Default is sandbox. |
| `RELAY_HOST` | No | Device name stamped on every log line as `fields.host` and on shipped records. Default: the OS hostname, which in Kubernetes is the pod name and changes on every rollout. |
| `RELAY_OTLP_ENDPOINT` | No | OTLP/HTTP base URL. When set, the relay also ships its own log lines to `<base>/v1/logs` and `relay.forward` spans to `<base>/v1/traces`. Unset turns shipping off. |
| `RELAY_OTLP_TOKEN_URL` | No | OAuth2 token endpoint for the `client_credentials` grant. In secret mode, unset means exports carry no `Authorization` header. In workload identity mode it defaults to the Entra endpoint for `AZURE_TENANT_ID`. |
| `RELAY_OTLP_CLIENT_ID` | Secret mode | Client ID for the token request. Ignored in workload identity mode. |
| `RELAY_OTLP_CLIENT_SECRET` | Secret mode | Client secret for the token request. Removed from the process environment once read. |
| `RELAY_OTLP_SCOPE` | Workload identity mode | Scope for the token request, such as `api://<app-id>/.default` for Entra. |
| `AZURE_FEDERATED_TOKEN_FILE` | No | Set by the Azure workload identity webhook. When present, the relay mints OTLP tokens with this file's contents as a `jwt-bearer` client assertion instead of a secret, re-reading the file on every fetch. Takes precedence over `RELAY_OTLP_CLIENT_SECRET`. |
| `AZURE_CLIENT_ID` | Workload identity mode | Set by the webhook from the service account annotation. The client the assertion is issued for. |
| `AZURE_TENANT_ID` | Workload identity mode, unless `RELAY_OTLP_TOKEN_URL` is set | Set by the webhook. Builds the token URL with `AZURE_AUTHORITY_HOST` (default `https://login.microsoftonline.com/`). |

APNs variables are only needed if you want push notifications on iOS when
the app is not connected. The relay works without them. You just won't get
lock-screen notifications for permission requests, questions, plans, and
finished conversations.

The `.p8` key must belong to the Apple Developer team that owns the app's
bundle identifier. Apple refuses a push signed by any other team's key, so
every relay that pushes to one build of the app uses that build's team key.
Each push goes to the Apple environment that issued the phone's token. A
development build (Xcode, `make ios`) registers with the sandbox and a
TestFlight or App Store build with production. The relay keeps no push
addresses: each paired phone registers its token and environment with its
server (`device.registerPush`), and the server sends them with every push, so
one relay serves every build, server, and person at once. `APNS_PRODUCTION`
only applies to a push that arrives without an environment.

## Deployment Tiers

Ion Relay supports two deployment models. Both can run simultaneously to
support migration between them.

**Tier 1: Personal (PSK)** — existing model. Single shared secret
(`RELAY_API_KEY`), zero external dependencies, suitable for personal use or
small trusted teams. See [docs/deployment-guide.md](docs/deployment-guide.md)
for quick-start steps.

**Tier 2: Enterprise (OIDC)** — token-based authentication via Azure AD /
Entra, Okta, Auth0, Keycloak, or any OIDC-compliant provider. Channels are
isolated per user identity. No shared secrets stored in the relay. See
[docs/deployment-guide.md](docs/deployment-guide.md) for the full environment
variable reference and Kubernetes deployment pattern, and
[docs/entra-setup.md](docs/entra-setup.md) for Azure AD step-by-step
configuration.

Additional reference:
- [docs/api-reference.md](docs/api-reference.md) — endpoint reference,
  authentication modes, WebSocket close codes
- [docs/security.md](docs/security.md) — encryption model, auth details,
  channel isolation, audit logging

## Using the relay for Studio environments

The same relay carries Ion Studio connections between a desktop and a
remote Ion Studio Server ([Ion Studio Server](../docs/deployment/studio-server.md#relay-backed-environments)).
Run the published image and point the server at it:

```bash
docker run -d -p 8443:8443 -e RELAY_API_KEY=$(openssl rand -hex 32) ghcr.io/dsswift/ion/relay:latest
ion studio install --relay wss://relay.example.org --relay-key <that key>   # on the server host
```

The server opens one channel per paired desktop (`role=ion`, channel id
derived from the pairing secret); a desktop joins the same channel as the
joining side (`role=mobile` -- the relay's name for that side, whatever the
device). Every frame is sealed end to end with the pairing secret; the relay
forwards ciphertext. Pairing itself can cross the relay through a one-time
`pairing:<hex>` channel (`ion studio pair --relay`).

## Protocol

The relay exposes a single WebSocket endpoint:

```
GET /v1/channel/{channelId}?role={ion|mobile}
Authorization: Bearer {apiKey}
```

- `channelId`: 32-character hex string derived from the pairing's shared secret
- `role`: identifies which side of the channel this connection represents (`ion` is the serving side, `mobile` the joining side: an iOS device, or a desktop reaching a remote Studio server)
- Messages are forwarded to the peer verbatim (opaque encrypted blobs)
- Control frames (`relay:peer-disconnected`, `relay:peer-reconnected`) are
  injected by the relay to notify each side of the other's connection state

## Security

The relay validates the API key on every WebSocket upgrade request. Without
a valid key, connections are rejected with HTTP 401. Even with a valid key,
all message payloads are end-to-end encrypted between Ion and iOS. The
relay cannot read them.
