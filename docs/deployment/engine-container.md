---
title: Engine Container Patterns
description: Container deployment patterns for the Ion Engine.
sidebar_position: 3
---

# Engine Container Patterns

The engine's `FROM scratch` image and zero-dependency binary make it well-suited for container deployments. This page covers three patterns.

## Single-agent container

One engine, one session, one prompt. Useful for batch jobs, CI pipelines, or one-shot tasks.

```yaml
# docker-compose.yml
services:
  agent:
    image: ion-engine:latest
    volumes:
      - ./config.json:/root/.ion/config.json:ro
    environment:
      - ANTHROPIC_API_KEY
    command: ["serve"]
```

Send a prompt over the socket from a second container or a host script:

```bash
docker exec agent sh -c \
  'echo "{\"type\":\"prompt\",\"text\":\"Summarize this file\"}" | \
   socat - UNIX-CONNECT:/root/.ion/engine.sock'
```

For truly ephemeral runs, skip the daemon and use the engine's one-shot mode if available, or start the daemon, send the prompt, and let the container exit when done.

## Sidecar

Engine runs alongside a web API in the same pod or Compose service group. The API sends prompts over the Unix socket. The engine handles LLM calls, tool execution, and streaming.

```yaml
# docker-compose.yml
services:
  api:
    build: ./api
    volumes:
      - ion-sock:/shared

  engine:
    image: ion-engine:latest
    volumes:
      - ion-sock:/root/.ion
    environment:
      - ANTHROPIC_API_KEY

volumes:
  ion-sock:
```

The API connects to `/shared/engine.sock` and speaks the NDJSON protocol. This keeps LLM logic out of the API codebase entirely.

### Kubernetes sidecar

```yaml
spec:
  containers:
    - name: api
      image: your-api:latest
      volumeMounts:
        - name: ion-sock
          mountPath: /shared

    - name: engine
      image: ion-engine:latest
      env:
        - name: ANTHROPIC_API_KEY
          valueFrom:
            secretKeyRef:
              name: llm-keys
              key: anthropic
      volumeMounts:
        - name: ion-sock
          mountPath: /root/.ion
      resources:
        requests:
          memory: "64Mi"
          cpu: "50m"
        limits:
          memory: "256Mi"
          cpu: "500m"

  volumes:
    - name: ion-sock
      emptyDir: {}
```

## Compose with MCP servers

Engine + your application + MCP servers for extended tool capabilities.

```yaml
# docker-compose.yml
services:
  engine:
    image: ion-engine:latest
    volumes:
      - ion-data:/root/.ion
      - ./config.json:/root/.ion/config.json:ro
    environment:
      - ANTHROPIC_API_KEY
    depends_on:
      - mcp-filesystem
      - mcp-postgres

  app:
    build: ./app
    volumes:
      - ion-data:/shared
    depends_on:
      - engine

  mcp-filesystem:
    image: mcp/filesystem:latest
    volumes:
      - ./workspace:/workspace

  mcp-postgres:
    image: mcp/postgres:latest
    environment:
      - DATABASE_URL=postgres://user:pass@db:5432/mydb
    depends_on:
      - db

  db:
    image: postgres:16-alpine
    environment:
      - POSTGRES_USER=user
      - POSTGRES_PASSWORD=pass
      - POSTGRES_DB=mydb

volumes:
  ion-data:
```

The engine config (`config.json`) points at MCP servers via their container hostnames:

```json
{
  "mcp": {
    "servers": {
      "filesystem": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
      },
      "postgres": {
        "url": "http://mcp-postgres:3000/sse"
      }
    }
  }
}
```

## Resource sizing

The engine itself is lightweight. Memory usage depends on conversation length and tool output buffering.

| Workload | Memory request | Memory limit | CPU |
|----------|---------------|--------------|-----|
| Single short session | 32Mi | 128Mi | 50m |
| Multi-session daemon | 64Mi | 256Mi | 100m |
| Heavy tool use (large file reads) | 128Mi | 512Mi | 200m |

Network egress is the primary cost driver -- LLM API calls dominate bandwidth and latency.

## Health checks

The engine socket accepts a `ping` command:

```bash
echo '{"type":"ping"}' | socat - UNIX-CONNECT:/root/.ion/engine.sock
```

For HTTP-based health checks (Kubernetes liveness probes), run a lightweight sidecar or init container that bridges HTTP to the Unix socket.
