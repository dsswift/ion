---
title: Enterprise Deployment
description: Enterprise configuration overview -- what enterprise config controls and how to deploy it.
sidebar_position: 1
---

# Enterprise Deployment

Enterprise configuration is the top layer in Ion Engine's four-layer config system. It sits above defaults, user config, and project config. Unlike the other layers, enterprise config is sealed -- values set at this layer cannot be weakened or overridden by lower layers.

Enterprise config is designed for IT admins who need to enforce organizational policies across a fleet of workstations running Ion Engine.

## What enterprise config controls

| Area | Controls | Reference |
|------|----------|-----------|
| Models | Allowlists, blocklists for LLM models | [Compliance](compliance.md) |
| Providers | Restrict which LLM providers can be used | [Compliance](compliance.md) |
| Tools | Allow or deny specific tools | [Compliance](compliance.md) |
| MCP servers | Allowlist/denylist for MCP server connections | [Compliance](compliance.md) |
| Hooks | Require specific hooks to be active in all sessions | [Compliance](compliance.md) |
| Permissions | Set permission mode and rules that cannot be weakened | [Sealed config](sealed-config.md) |
| Sandbox | Require sandbox, prevent disable | [Sealed config](sealed-config.md) |
| Network | Proxy settings, custom CA certificates, TLS config | [Network](network.md) |
| Telemetry | Enforce telemetry collection and export destinations | [Telemetry](telemetry.md) |

## Enterprise config structure

```json
{
  "enterprise": {
    "allowedModels": ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
    "blockedModels": [],
    "allowedProviders": ["anthropic"],
    "requiredHooks": [],
    "mcpAllowlist": ["filesystem", "github"],
    "mcpDenylist": [],
    "toolRestrictions": {
      "allow": [],
      "deny": ["Bash"]
    },
    "permissions": {
      "mode": "ask"
    },
    "telemetry": {
      "enabled": true,
      "targets": ["http"],
      "httpEndpoint": "https://siem.corp.example.com/ingest/ion"
    },
    "network": {
      "proxy": {
        "httpProxy": "http://proxy.corp.example.com:8080",
        "httpsProxy": "http://proxy.corp.example.com:8080",
        "noProxy": "localhost,127.0.0.1,.corp.example.com"
      },
      "customCaCerts": ["/etc/pki/tls/certs/corp-ca.pem"]
    },
    "sandbox": {
      "required": true,
      "allowDisable": false
    },
    "customFields": {}
  }
}
```

## Deployment methods

Enterprise config can be delivered through platform-native management tools or environment variables. The engine checks sources in a defined order and uses the first one it finds.

| Platform | Primary method | Fallback |
|----------|---------------|----------|
| macOS | Managed Preferences (MDM profile) | `ION_ENTERPRISE_CONFIG` env var |
| Windows | Group Policy (registry) | `ION_ENTERPRISE_CONFIG` env var |
| Linux | System config files | `ION_ENTERPRISE_CONFIG` env var |
| All | `ION_ENTERPRISE_CONFIG` env var | -- |

See [MDM deployment](mdm.md) for platform-specific instructions.

## How sealing works

Enterprise config is not merged the same way as other layers. After the three-layer merge (defaults + user + project) completes, the enterprise layer is applied as a constraint:

- Scalar restrictions (model lists, provider lists) filter the merged result.
- Permission mode can only be tightened, never loosened.
- Array fields (MCP lists, dangerous patterns) are unioned with lower layers.
- Telemetry settings, once enabled, cannot be disabled.

See [Sealed config](sealed-config.md) for the full sealing semantics.

## Next steps

- [MDM deployment](mdm.md) -- per-platform deployment instructions
- [Sealed config](sealed-config.md) -- sealing semantics and override prevention
- [Network](network.md) -- proxy, CA certificates, and TLS
- [Telemetry](telemetry.md) -- telemetry targets, OTEL, and privacy
- [Compliance](compliance.md) -- model, provider, tool, and MCP controls
