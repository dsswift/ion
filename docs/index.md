---
title: Ion Engine
description: Headless, multi-provider AI agent runtime. Single binary, zero dependencies.
sidebar_position: 1
---

# Ion Engine

Ion is a headless AI agent runtime. Single Go binary (~7.8MB), zero runtime dependencies. It runs as a daemon on a Unix socket or TCP port, speaks NDJSON, and executes LLM-driven agent loops with tool use, branching conversations, and a 55-hook extension system.

14+ LLM providers via raw HTTP (no SDKs). 14 core tools. 4-layer config merge with enterprise sealing. Extensions in any language via JSON-RPC 2.0.

## Who is this for?

### IT Admins and Platform Engineers

Deploy Ion across teams with enterprise configuration, MDM policy enforcement, and sealed provider settings. Control which models, tools, and extensions are available.

- [Enterprise configuration](enterprise/)
- [Security model](security/)
- [Configuration reference](configuration/)

### Harness Engineers

Build agent behavior on top of the engine using hooks, tools, and extensions. The engine executes; your harness decides what happens.

- [Getting started](getting-started/install.md)
- [Quickstart](getting-started/quickstart.md)
- [Core concepts](getting-started/concepts.md)
- [Extension hooks](hooks/)
- [Extension SDK](extensions/)

### Contributors

Work on the engine, providers, tools, or protocol.

- [Architecture](architecture/)
- [Contributing](contributing/)
- [Protocol reference](protocol/)

## Quick links

| Topic | Link |
|-------|------|
| Install | [getting-started/install.md](getting-started/install.md) |
| Quickstart | [getting-started/quickstart.md](getting-started/quickstart.md) |
| CLI reference | [cli/reference.md](cli/reference.md) |
| Hooks reference | [hooks/](hooks/) |
| Configuration | [configuration/](configuration/) |
| Protocol | [protocol/](protocol/) |
| Providers | [providers/](providers/) |
