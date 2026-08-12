---
title: Machine identity
description: Broker OAuth and cloud workload credentials without exposing them to extensions.
---

# Machine identity

Ion can authenticate headless schedules, webhooks, workers, and pipeline runs without a signed-in operator. Engine acquires and refreshes credentials, authenticates outbound requests, and returns only HTTP status, headers, and body to extensions. Raw OAuth tokens, AWS access keys, client secrets, and projected assertions never cross extension RPC.

## Configuration

`auth.identityProvider` selects one entry under `auth.oauth`. Add `machineIdentity` to make that entry non-interactive. Without this block, existing PKCE/device-code operator login remains unchanged.

```json
{
  "auth": {
    "identityProvider": "workload",
    "oauth": {
      "workload": {
        "clientId": "<client-id>",
        "issuerUrl": "https://login.example.com/<tenant>/v2.0",
        "scopes": ["api://<resource>/.default"],
        "machineIdentity": {
          "source": "client_secret",
          "clientSecretEnv": "ION_WORKLOAD_CLIENT_SECRET"
        }
      }
    }
  }
}
```

Exactly one source is selected.

| Source | Required configuration | Behavior |
|---|---|---|
| `client_secret` | `clientSecretEnv` or `clientSecretFile` | Standard `client_credentials`; env value is captured then removed before child processes start |
| `certificate` | `certificatePath`, optional `certificateKeyPath` | RS256/ES256 `private_key_jwt`; files are re-read for rotation |
| `federated_assertion` | `federatedTokenFile` | Projected JWT is re-read for every grant |
| `azure_managed_identity` | optional `azure.clientId` | Container Apps identity endpoint when present, otherwise VM IMDS |
| `gcp_managed_identity` | optional `gcp.serviceAccount`, `gcp.tokenType` | GCE/GKE metadata access token or audience-bound ID token |
| `aws` | `aws.kind`, plus source-specific settings | Temporary AWS credentials used only for SigV4 requests |
| `credential_process` | absolute `credentialProcess.command` | Trusted executable returns bounded JSON token metadata |

## Azure Managed Identity

Container Apps, App Service, and Functions provide `IDENTITY_ENDPOINT` and `IDENTITY_HEADER`. Ion sends:

```text
GET $IDENTITY_ENDPOINT?resource=<resource>&api-version=2019-08-01
X-IDENTITY-HEADER: $IDENTITY_HEADER
```

VM and VMSS deployments use IMDS with `Metadata: true` and API version `2018-02-01`. Set `azure.clientId` for a user-assigned identity; omit it for system-assigned identity.

Azure accepts resources rather than delegated scopes. Supply `audience`, or use a scope ending in `/.default`, which Ion converts exactly to its resource identifier.

```json
"machineIdentity": {
  "source": "azure_managed_identity",
  "azure": { "clientId": "<optional-user-assigned-client-id>" }
}
```

## GCP workload identity

Compute Engine and GKE Workload Identity expose attached service-account credentials through metadata server. Default mode returns an OAuth access token. Set `tokenType` to `id_token` for an audience-bound identity token.

```json
"machineIdentity": {
  "source": "gcp_managed_identity",
  "gcp": {
    "serviceAccount": "default",
    "tokenType": "access_token"
  }
}
```

For an ID token, pass `audience` in `ctx.http` options. Ion reads expiry from JWT `exp` and caches only until refresh threshold.

## AWS workload identity and SigV4

AWS-native APIs do not accept OAuth bearer tokens. Ion acquires a temporary access-key triple and signs the exact HTTP request with Signature V4. Supported explicit kinds:

- `imds`: EC2 instance profile, IMDSv2 only.
- `ecs`: ECS task role via `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`.
- `eks`: EKS Pod Identity via `AWS_CONTAINER_CREDENTIALS_FULL_URI` and rotating authorization-token file.
- `irsa`: projected service-account token exchanged with STS `AssumeRoleWithWebIdentity`.
- `env`: captures and removes `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN` before subprocess launch.

```json
"machineIdentity": {
  "source": "aws",
  "aws": {
    "kind": "irsa",
    "roleArn": "arn:aws:iam::<account>:role/<role>",
    "region": "us-east-1"
  }
}
```

Extension requests declare signing metadata, never credentials:

```typescript
const result = await ctx.http.get('https://<service-endpoint>/<path>', {
  awsService: 'execute-api',
  awsRegion: 'us-east-1',
})
```

MCP forwarding, relay authentication, and authenticated log egress are bearer-header surfaces and cannot use AWS SigV4. They work with operator OAuth and machine bearer sources.

## Certificate and federation

Certificate auth accepts X.509 certificate plus PKCS#8, PKCS#1 RSA, or SEC1 P-256 private keys. Ion creates a five-minute assertion with unique `jti`, token endpoint audience, and certificate `x5t` thumbprint.

Federation accepts any projected assertion trusted by the configured token endpoint, including AKS workload identity, EKS/GKE service-account tokens, and CI OIDC tokens. Assertion files are never persisted by Ion and are read fresh on every grant.

## Credential process

Credential process is part of trusted credential boundary. It is not an extension hook. Command path must be absolute; Ion executes it directly without shell interpolation, with bounded runtime and output. Request arrives as JSON on stdin:

```json
{"version":1,"scope":"<scope>","audience":"<audience>"}
```

Response:

```json
{"Version":1,"AccessToken":"<token>","Expiration":"2030-01-01T00:00:00Z"}
```

Helper receives a minimal environment containing `PATH` plus `ION_TOKEN_SCOPE` and `ION_TOKEN_RESOURCE` compatibility fields; parent credentials and unrelated variables are not inherited.

## Verify before running workloads

Run daemonless verification on target instance:

```bash
ion auth verify --scope 'api://<resource>/.default'
ion auth verify --audience 'https://management.azure.com/'
ion auth verify --aws-service s3 --aws-region us-east-1 --url 'https://s3.us-east-1.amazonaws.com/'
```

Output is one JSON report containing source, token type, expiry, selected JWT claims (`iss`, `aud`, `exp`), and optional probe status. Credential value is never printed. Exit codes distinguish configuration, acquisition, and probe failures.

Operational details appear in `~/.ion/engine.jsonl` under `auth.machine`, `auth.azure`, `auth.gcp`, `auth.aws`, and `auth.credprocess`, without credential values.

## Security boundaries

- Authenticated requests never follow redirects. This prevents bearer leakage and invalid SigV4 replay.
- Metadata calls bypass proxies and target only provider metadata endpoints.
- Managed and federated sources persist no secret.
- Machine access tokens and AWS temporary credentials live in memory only.
- Plain API keys, basic auth, and mTLS remain extension responsibilities.

## E2E cloud tests

`engine/tests/e2e/live_machine_identity_test.go` (build tag `e2e`) acquires real credentials from cloud metadata services and asserts non-empty tokens with future expiry. Tests skip unless the corresponding env var is set:

| Env var | Cloud |
|---|---|
| `ION_E2E_AZURE_MI=1` | Azure VM / Container App managed identity |
| `ION_E2E_GCP=1` | GCE / GKE metadata server |
| `ION_E2E_AWS=1` | EC2 / ECS / EKS instance profile |

Optional: `ION_E2E_AUDIENCE` (custom audience), `ION_E2E_AZURE_CLIENT_ID` (user-assigned identity), `ION_E2E_AWS_KIND` (imds/ecs/eks/irsa/env, default imds).

```bash
ION_E2E_AZURE_MI=1 go test -tags e2e -v -run TestAzureManagedIdentity ./tests/e2e/
ION_E2E_GCP=1      go test -tags e2e -v -run TestGCPMetadata          ./tests/e2e/
ION_E2E_AWS=1       go test -tags e2e -v -run TestAWSCredentials       ./tests/e2e/
```

Credential values are never printed. Tests log only source kind and token or credential expiry.
