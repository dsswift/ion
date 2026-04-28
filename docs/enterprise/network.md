---
title: Network Configuration
description: Enterprise proxy settings, custom CA certificates, and TLS configuration.
sidebar_position: 4
---

# Network Configuration

Enterprise network config controls how the engine makes outbound connections. This covers proxy routing, custom certificate authorities, and TLS verification settings.

Network config set at the enterprise layer overrides all lower-layer network settings.

## Configuration

```json
{
  "enterprise": {
    "network": {
      "proxy": {
        "httpProxy": "http://proxy.corp.example.com:8080",
        "httpsProxy": "http://proxy.corp.example.com:8080",
        "noProxy": "localhost,127.0.0.1,.corp.example.com"
      },
      "customCaCerts": [
        "/etc/pki/tls/certs/corp-root-ca.pem",
        "/etc/pki/tls/certs/corp-intermediate-ca.pem"
      ],
      "rejectUnauthorized": true
    }
  }
}
```

## Proxy

The proxy config routes the engine's outbound HTTP and HTTPS traffic through a corporate proxy.

| Field | Type | Description |
|-------|------|-------------|
| `httpProxy` | `string` | Proxy URL for HTTP requests |
| `httpsProxy` | `string` | Proxy URL for HTTPS requests |
| `noProxy` | `string` | Comma-separated list of hosts/domains/CIDRs that bypass the proxy |

### Proxy URL format

Standard proxy URL format: `http://[user:password@]host:port`

Authentication credentials in the URL are supported but not recommended. Use your proxy's native authentication mechanism (NTLM, Kerberos) where possible.

### No-proxy rules

The `noProxy` field accepts:

- Hostnames: `localhost`
- Domain suffixes: `.corp.example.com` (matches `api.corp.example.com`, `git.corp.example.com`)
- IP addresses: `127.0.0.1`, `10.0.0.1`
- CIDR ranges: `10.0.0.0/8`
- Wildcard: `*` (bypass proxy for everything, useful for testing)

Multiple entries are comma-separated with no spaces.

## Custom CA certificates

The `customCaCerts` array contains file paths to PEM-encoded CA certificate files. The engine loads these certificates and adds them to its TLS trust store alongside the system's default CA bundle.

This is required in environments with:

- Corporate TLS inspection proxies that re-sign HTTPS traffic
- Internal certificate authorities not in the system trust store
- Self-signed certificates on internal LLM endpoints

### Certificate file format

Each file must contain one or more PEM-encoded certificates:

```
-----BEGIN CERTIFICATE-----
MIIDxTCCAq2gAwIBAgIQAqxcJmoLQ...
-----END CERTIFICATE-----
```

Bundle files (multiple certificates in one file) are supported.

### Certificate file locations

Common paths by platform:

| Platform | Typical location |
|----------|-----------------|
| macOS | `/etc/pki/tls/certs/`, `/usr/local/share/ca-certificates/` |
| Linux (Debian/Ubuntu) | `/usr/local/share/ca-certificates/`, `/etc/ssl/certs/` |
| Linux (RHEL/Fedora) | `/etc/pki/tls/certs/`, `/etc/pki/ca-trust/source/anchors/` |
| Windows | Certificate store (use `ION_ENTERPRISE_CONFIG` with file paths) |

## TLS verification

The `rejectUnauthorized` field controls whether the engine verifies TLS certificates on outbound connections.

| Value | Behavior |
|-------|----------|
| `true` (default) | TLS certificates must be valid and trusted. Connections to servers with invalid, expired, or self-signed certificates fail. |
| `false` | TLS certificate errors are ignored. **Not recommended for production.** |

Setting `rejectUnauthorized` to `false` disables certificate validation for all outbound connections, including LLM provider API calls. This is a security risk and should only be used for debugging in controlled environments.

When enterprise config sets `rejectUnauthorized` to `true`, lower layers cannot change it to `false`.

## Environment variable interaction

The engine respects standard proxy environment variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`) when no explicit proxy config is set. Enterprise config takes precedence over environment variables.

Priority order:

1. Enterprise `network.proxy` config
2. User/project `network.proxy` config
3. `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` environment variables
4. Direct connection (no proxy)
