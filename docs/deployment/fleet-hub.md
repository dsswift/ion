---
title: Fleet Hub
description: Run a Fleet Hub, the always-on page your servers report to, with Microsoft Entra sign-in, and choose which hubs each server may join.
sidebar_position: 6
---

# Fleet Hub

A Fleet Hub is a small service your servers report to. It shows your whole [Fleet](fleet.md) on one page, from any network, with no laptop left open.

Nothing pairs into your servers. Each server dials out to the hub, sends the same report the Fleet page reads, says when a deploy or an install is under way on it, and runs a short list of actions when the hub asks. The hub is not a device, so it never shows under a server's Devices.

A server can report to more than one hub. A work laptop can report to the company's hub and to your own.

## What the hub can do

The hub's page has the same three views as Settings → Fleet: Quota, Servers, and Compatibility.

Quota shows the usage limits of provider subscriptions. A Fleet that runs only on API keys has none, so turn the view off with `views.quota` in `hub.json`. The page then opens on Servers, and **Refresh usage** is gone from each server's menu.

On a server that lets the hub manage it, the page can:

- read its usage again
- restart it
- update it to the latest release
- remove it from the hub

That list is fixed in the code. A hub cannot run anything else on a server. It never sees conversations or provider credentials.

Deploy from source stays in Studio and `ion fleet`. It needs your checkout and your SSH keys. The hub watches it.

## Deploys and installs

The Servers view shows the newest deploys the hub was told of, above the servers. Each has a row per server with its step, the step's detail, and why it failed when it did.

A deploy is reported by the server on the machine that runs it. `ion fleet deploy` tells that server at every step, and the server passes each record to every hub it reports to. So the hub learns a deploy started the moment it does, as long as the machine running it has a server on a hub. The page says which server reported it. A deploy still marked running that the hub has not heard of for two minutes is shown as lost: the device running it was closed or went offline.

Each server also says, on its own, what its install is doing: requested, downloading, installing, restarting, failed, and back with the version it now runs. That word shows on the server's own row, and under its row in a deploy. A server that is down for its install shows as not connected until it reports again.

A server that connects to the hub partway through is told nothing it missed: it sends the deploys still running and its newest install step as soon as the hub welcomes it.

The hub keeps the newest deploys and each server's last install step in `hub-servers.json`, with the reports.

## Run a hub

The hub ships in the Studio Server container image as `dist/hub.js`, beside the page it serves. It needs no engine.

```bash
docker run -p 7400:7400 -v ion-hub:/data ghcr.io/<owner>/<repo>/studio-server:<version> node dist/hub.js
```

The Studio Server bundle for macOS and Linux carries `dist/hub.js` too, but not the page's files. To run a hub from it, build them with `npm -w desktop run build:web` and point `webDir` at the output.

It reads `hub.json` from the data directory:

```json
{
  "label": "Home fleet",
  "listen": { "port": 7400 },
  "enrollment": { "tokens": ["secretstore:hub-enrollment"] },
  "oidc": {
    "issuer": "https://login.microsoftonline.com/<tenant-id>/v2.0",
    "audience": "<hub-app-id>",
    "scope": "Hub.Access",
    "clientId": "<hub-app-id>",
    "clientSecretRef": "secretstore:hub-client-secret",
    "defaultScopes": ["admin"],
    "allowedSubjects": ["<your-object-id>"]
  }
}
```

| Field | Default | Meaning |
|---|---|---|
| `label` | the host's name | The hub's name, shown on its page and on each server that reports to it. |
| `listen.port` | `7400` | The port the page, the API, and the servers' sockets share. |
| `listen.host` | all interfaces | The address to bind. |
| `enrollment.tokens` | none | Standing tokens that let any number of servers join, for a policy that puts servers on the hub. With none, a server joins with a token made on the hub's page. A `secretstore:` reference resolves from an environment variable or `server-secrets.json`, the same way [server.json](../configuration/server-json.md) resolves one. |
| `enrollment.tokenMinutes` | `30` | How long a token made on the hub's page lets a server join. |
| `oidc` | none | The sign-in. See below. |
| `webDir` | beside the bundle | Where the page's files are, for a layout that keeps them elsewhere. |
| `views.quota` | `true` | Show the Quota view. Set `false` for a Fleet with no provider subscriptions. |

The hub keeps what it knows in the data directory: `hub-servers.json` (each server, its last report, and the hash of each token made on the page that is still unused) and `browser-sessions.json` (who is signed in). Keep that directory on a volume. Run one replica: a sign-in in progress is held in memory.

`/healthz` answers `200` with no sign-in, for a probe.

## Sign-in

With `oidc` set, every page, every file, and every API call needs a signed-in session. Someone who is not signed in gets the sign-in page and nothing else.

With no `oidc`, the hub is open: anyone who can reach it can manage every server that reports to it. That is only for a hub that never leaves a network you trust. The hub says so in its log at boot.

The `oidc` block has the same fields as [server.json's](../configuration/server-json.md):

- `allowedSubjects` limits who may sign in. An entry matches a token's `sub` or its `oid`. Entra's `sub` is different for each app, so list a person by their object ID.
- `defaultScopes` and `rolesToScopes` decide what a signed-in person may do. Anyone signed in can read the Fleet. Adding a server, running an action, renaming a server, or removing one needs `admin`.

### Microsoft Entra

1. Register one app for the hub. Add a **Web** redirect URI: `https://<hub address>/auth/callback`.
2. Under **Expose an API**, set the application ID URI to `api://<hub-app-id>` and add a scope named `Hub.Access`. Authorize the app's own client ID for that scope, so nobody is asked to consent.
3. Set the app to issue version 2 tokens: `az ad app update --id <hub-app-id> --set api.requestedAccessTokenVersion=2`. A version 1 token carries a different issuer, and the hub refuses it.
4. Create a client secret and give it to the hub as `clientSecretRef`. Entra requires one to finish a sign-in against a Web redirect URI. With `secretstore:hub-client-secret`, the hub reads it from the `ION_SERVER_HUB_CLIENT_SECRET` environment variable.
5. On the enterprise application, turn on **Assignment required** and assign yourself. Entra then refuses everyone else before the hub sees them.
6. Put your object ID in `allowedSubjects` as a second check.
7. To give some people read-only access, define an app role, map it in `rolesToScopes`, and leave `defaultScopes` empty.

In `hub.json`, `audience` is the bare app ID, with no `api://` in front: a version 2 token carries it that way, and the hub adds `api://` itself when it asks for the scope.

The hub runs the sign-in itself and gives the browser only a session cookie. A token never reaches the page.

## Put a server on a hub

On the hub's page, open **Servers** and choose **Add server**. The page shows the hub's address and a new enrollment token, each with a **Copy** button. The token lets one server join, and it stops working after `enrollment.tokenMinutes`. The hub keeps only its hash, so the page shows it once. Choose **Add server** again for another.

Then, on the server:

- **Desktop.** Settings → Fleet → Servers, open a server's `…` menu, and choose **Fleet hubs**.
- **iPhone.** Open a server from the Fleet screen and tap **Fleet Hubs**, or swipe the server and tap **Fleet Hubs**.

Paste the hub's address and the enrollment token. Leave **Let this hub manage the server** on, or turn it off so the server only reports. The answer says how joining went: reporting, or why the hub refused.

The server uses the token once. The hub then issues the server its own credential, which the server keeps sealed in `fleet-hubs.json`. The server sends a report every `fleet.hubReportSeconds` (default 60) and after each action.

The panel shows how each link stands: reporting, connecting, unreachable, refused, or not allowed. Each server's row on the Fleet page, on the iPhone's Fleet screen, and on a hub's own page also names the hubs that server reports to.

A server joins under the name the device that added the hub knows it by. A server its organization's policy put on a hub joins under its own name, which is its host name unless `label` is set in its `server.json`. Either way, a server's `…` menu on the hub's page has **Rename**, which gives it a name on that hub only.

A server the hub removed does not rejoin by itself. Add the hub on it again, with a new token, to bring it back.

## Limit which hubs a server may join

An organization sets this in the server's enterprise config, under `customFields["ion-server"].fleetHubs`:

```json
{
  "customFields": {
    "ion-server": {
      "fleetHubs": {
        "hubs": [
          { "url": "https://hub.corp.example.org", "enrollmentToken": "secretstore:corp-hub" }
        ],
        "allowedUrls": []
      }
    }
  }
}
```

| Field | Meaning |
|---|---|
| `hubs` | Hubs every server this policy governs reports to. They cannot be removed on the server. `manage: false` makes one report-only. |
| `allowedUrls` | The only hubs a server's admins may add. An empty list means none beyond `hubs`. Leave the field out to let admins add any hub. |

With the policy above, every server reports to the company hub and no other.

The enterprise config is resolved per machine. To let one machine also report to a second hub, give that machine a policy that names it:

```json
"allowedUrls": ["https://hub.home.example.org"]
```

A server checks the policy again whenever it changes. A hub that is no longer allowed is dropped at once and shows as **not allowed**.

## Kubernetes

One Deployment, one replica, one volume, behind your ingress with TLS.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ion-fleet-hub
spec:
  replicas: 1
  strategy: { type: Recreate }
  selector: { matchLabels: { app: ion-fleet-hub } }
  template:
    metadata: { labels: { app: ion-fleet-hub } }
    spec:
      containers:
        - name: hub
          image: ghcr.io/<owner>/<repo>/studio-server:<version>
          command: ["node", "dist/hub.js"]
          ports: [{ containerPort: 7400 }]
          env:
            - name: ION_DATA_DIR
              value: /data
          envFrom:
            - secretRef: { name: ion-fleet-hub }
          readinessProbe:
            httpGet: { path: /healthz, port: 7400 }
          livenessProbe:
            httpGet: { path: /healthz, port: 7400 }
          volumeMounts:
            - { name: data, mountPath: /data }
            - { name: config, mountPath: /data/hub.json, subPath: hub.json }
      volumes:
        - name: data
          persistentVolumeClaim: { claimName: ion-fleet-hub }
        - name: config
          configMap: { name: ion-fleet-hub }
```

The image's own health check targets the Studio Server's port. The probes above replace it.

Your ingress must pass WebSocket upgrades on `/v1/agent` and must not buffer `/api/events`. It must also send `X-Forwarded-Proto` and `X-Forwarded-Host`, which the sign-in uses to build its redirect address.

The servers' sockets on `/v1/agent` are not behind the sign-in. A server proves itself with its enrollment token, then with the credential the hub issued it.
