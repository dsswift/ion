# Ion Relay Deployment Guide

Ion Relay ships as a single Docker image (`ion-relay:latest`) built for
`linux/amd64`. Two deployment tiers cover different trust and scale needs.

## Deployment Tiers

### Tier 1: Personal (PSK)

Single shared secret. No external identity provider. Suitable for personal
use or small teams where all members share the key out-of-band.

**Quick start**

1. Generate a key:

   ```bash
   export RELAY_API_KEY=$(openssl rand -hex 32)
   ```

2. Run the container:

   ```bash
   docker run -d \
     -p 8443:8443 \
     -e RELAY_API_KEY="$RELAY_API_KEY" \
     ion-relay:latest
   ```

3. Verify it started:

   ```bash
   curl http://localhost:8443/healthz
   # {"status":"ok"}
   ```

4. Open Ion desktop, go to **Settings → Remote**, enter your relay URL and
   the API key. The iOS app pairs automatically once the desktop connects.

---

### Tier 2: Enterprise (OIDC)

Token-based authentication via any standards-compliant OIDC provider (Azure
AD / Entra, Okta, Auth0, Keycloak, etc.). No shared secrets. Channels are
isolated per user identity. Token revocation takes effect within one token
lifetime.

The relay fetches JWKS automatically from the provider's discovery document
(`{issuer}/.well-known/openid-configuration`). No manual key management.

**Quick start**

Set the three required OIDC variables alongside any existing PSK config:

```bash
RELAY_OIDC_ISSUER=https://login.microsoftonline.com/{tenant}/v2.0
RELAY_OIDC_AUDIENCE=api://<relay-app-id>
RELAY_OIDC_REQUIRED_SCOPE=Relay.Access
```

See [entra-setup.md](entra-setup.md) for step-by-step Azure AD / Entra
configuration.

---

### Running Both Modes Simultaneously

PSK and OIDC modes can be active at the same time. This supports migrating
an existing deployment from PSK to OIDC without a hard cutover: bring up
OIDC for new clients while PSK clients continue to work until they migrate.

The relay accepts any valid credential from either mode. A request is
authorized if it passes either check.

---

## Environment Variable Reference

| Variable | Default | Description |
|---|---|---|
| `RELAY_PORT` | `8443` | TCP port the server listens on. |
| `RELAY_API_KEY` | *(unset)* | PSK mode: shared secret. Generate with `openssl rand -hex 32`. At least one of `RELAY_API_KEY` or `RELAY_OIDC_ISSUER`+`RELAY_OIDC_AUDIENCE` must be set. |
| `RELAY_OIDC_ISSUER` | *(unset)* | OIDC issuer URL. Used for discovery and JWKS fetch (`{issuer}/.well-known/openid-configuration`). Required for OIDC mode. |
| `RELAY_OIDC_AUDIENCE` | *(unset)* | Required `aud` claim value in incoming JWTs. Required for OIDC mode. |
| `RELAY_OIDC_REQUIRED_SCOPE` | *(unset)* | Optional scope check. When set, tokens must include this scope in their `scp` or `scope` claim. |
| `RELAY_WRITE_TIMEOUT_MS` | `10000` | WebSocket write deadline in milliseconds. |
| `RELAY_PING_INTERVAL_S` | `30` | Keepalive ping interval in seconds. |
| `RELAY_PING_TIMEOUT_S` | `10` | Pong wait deadline in seconds. |
| `RELAY_MAX_MESSAGE_SIZE` | `12582912` | Maximum WebSocket message size in bytes (12 MB). |
| `RELAY_STATE_DIR` | *(unset)* | Directory for persistent state (channel ownership bindings, APNs token store). If unset, state is in-memory only and lost on restart. Mount a persistent volume in production. |
| `RELAY_LOG_OUTPUT` | `stdout` | Where log lines go: `stdout`, `file`, or `both`. |
| `RELAY_LOG_FILE` | `/var/log/ion/relay.jsonl` | Log file path. Only used when `RELAY_LOG_OUTPUT` is `file` or `both`. |
| `RELAY_LOG_LEVEL` | `info` | Minimum log level: `trace`, `debug`, `info`, `warn`, `error`. |
| `RELAY_LOG_MAX_FILES` | `3` | Number of rotated archive generations to keep alongside the live log file. |
| `APNS_KEY_PATH` | *(unset)* | Path to an APNs `.p8` signing key. Required only for push notifications. Mount as a volume in Kubernetes. |
| `APNS_KEY_ID` | *(unset)* | APNs key ID from the Apple Developer portal. |
| `APNS_TEAM_ID` | *(unset)* | Apple Developer Team ID. |
| `APNS_PRODUCTION` | *(unset)* | Set to `1` to use the APNs production endpoint. Default is sandbox. |

---

## Kubernetes Deployment

The recommended pattern in an enterprise deployment is one Deployment +
Service + Ingress per department. Each department gets its own relay URL and
its own OIDC audience, so channel isolation is enforced at the network
boundary as well as at the token level.

**Example: single-department Deployment with OIDC credentials from a Secret**

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: relay-oidc-engineering
  namespace: ion-relay
type: Opaque
stringData:
  issuer: "https://login.microsoftonline.com/<tenant>/v2.0"
  audience: "api://<relay-app-id>"
  required-scope: "Relay.Access"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: relay-engineering
  namespace: ion-relay
spec:
  replicas: 1
  selector:
    matchLabels:
      app: relay-engineering
  template:
    metadata:
      labels:
        app: relay-engineering
    spec:
      containers:
        - name: relay
          image: <your-registry>/ion-relay:latest
          ports:
            - containerPort: 8443
          env:
            - name: RELAY_OIDC_ISSUER
              valueFrom:
                secretKeyRef:
                  name: relay-oidc-engineering
                  key: issuer
            - name: RELAY_OIDC_AUDIENCE
              valueFrom:
                secretKeyRef:
                  name: relay-oidc-engineering
                  key: audience
            - name: RELAY_OIDC_REQUIRED_SCOPE
              valueFrom:
                secretKeyRef:
                  name: relay-oidc-engineering
                  key: required-scope
            - name: RELAY_LOG_OUTPUT
              value: "stdout"
          volumeMounts:
            - name: relay-state
              mountPath: /var/lib/ion-relay
          env:
            - name: RELAY_STATE_DIR
              value: /var/lib/ion-relay
      volumes:
        - name: relay-state
          persistentVolumeClaim:
            claimName: relay-state-engineering
---
apiVersion: v1
kind: Service
metadata:
  name: relay-engineering
  namespace: ion-relay
spec:
  selector:
    app: relay-engineering
  ports:
    - port: 8443
      targetPort: 8443
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: relay-engineering
  namespace: ion-relay
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
spec:
  tls:
    - hosts:
        - relay-engineering.example.com
      secretName: relay-engineering-tls
  rules:
    - host: relay-engineering.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: relay-engineering
                port:
                  number: 8443
```

Set the ingress proxy timeouts high enough to accommodate long-lived
WebSocket connections (the example above uses 3600 seconds). Without this,
the ingress will close idle connections before the relay's own keepalive has
a chance to fire.
