---
title: Vertex AI
description: Anthropic models via Google Cloud Vertex AI.
sidebar_position: 7
---

# Vertex AI

The Vertex AI provider routes Anthropic model calls through Google Cloud's Vertex AI platform. It wraps the Anthropic provider with a Vertex-specific base URL and bearer token authentication.

## Setup

### Project and region

```bash
export GOOGLE_CLOUD_PROJECT="my-project-id"
```

Default region is `us-east5`. Override with `VertexConfig.Region`.

### Access token

The provider resolves an access token in this order:

1. `VertexConfig.AccessToken` (passed directly)
2. `GOOGLE_ACCESS_TOKEN` environment variable
3. `gcloud auth print-access-token` (runs with a 10-second timeout)

If none of these produce a token, initialization fails with an error.

### Configuration

```go
type VertexConfig struct {
    ProjectID   string // or GOOGLE_CLOUD_PROJECT env var
    Region      string // default: "us-east5"
    AccessToken string // or GOOGLE_ACCESS_TOKEN, or gcloud CLI
}
```

## How it works

Vertex AI constructs a base URL in the format:

```
https://{region}-aiplatform.googleapis.com/v1/projects/{project}/locations/{region}/publishers/anthropic
```

It then creates a standard Anthropic provider with this base URL and `bearer` auth header. All streaming and event handling are identical to the direct Anthropic provider.

## Authentication notes

The `gcloud` CLI fallback requires the Google Cloud SDK to be installed and authenticated. The command runs with a 10-second timeout to avoid blocking startup if gcloud is misconfigured.

For automated environments (CI, containers), set `GOOGLE_ACCESS_TOKEN` directly or use a service account token.
