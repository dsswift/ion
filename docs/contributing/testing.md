---
title: Testing
description: Test tiers, test helpers, and guidelines for writing tests.
sidebar_position: 3
---

# Testing

Ion Engine uses three test tiers. Unit tests run on every build. Integration tests use mock providers. E2E tests hit live APIs.

## Test tiers

| Tier | Command | Count | Dependencies |
|------|---------|-------|-------------|
| Unit | `go test ./...` | ~269 | None |
| Integration | `go test -tags integration ./tests/integration/...` | ~54 | MockProvider |
| E2E | `go test -tags e2e -v ./tests/e2e/...` | ~5 | API keys + testconfig.json |

### Unit tests

Standard Go tests colocated with source files. No external dependencies, no file I/O (where possible), no network calls.

```bash
cd engine && make test
# or
cd engine && go test ./...
```

### Integration tests

Located in `engine/tests/integration/`. These test cross-package behavior using `MockProvider` for scripted LLM responses and `MockBackend` for RunBackend stubs.

```bash
cd engine && make test-integration
# or
cd engine && go test -tags integration ./tests/integration/...
```

Integration test files:

| File | Coverage |
|------|----------|
| `server_lifecycle_test.go` | Socket start/stop, multi-client connections, stale socket recovery |
| `session_lifecycle_test.go` | Session start/stop, prompt handling, abort, plan mode, event flow |
| `api_backend_test.go` | Agent loop: text responses, tool calls, budget limits, cancellation, hooks |
| `conversation_roundtrip_test.go` | JSONL persistence round-trip, branching, migration, compaction |
| `protocol_contract_test.go` | Wire format validation, NDJSON framing, all 16 command types |
| `normalizer_test.go` | Event normalization pipeline, event round-trip fidelity |
| `tools_test.go` | Real tool execution: Read, Write, Edit, Bash, Grep, Glob |
| `agent_streaming_test.go` | Agent streaming behavior |

### E2E tests

Located in `engine/tests/e2e/`. These hit real LLM APIs and require credentials.

```bash
cd engine && make test-e2e
# or
cd engine && go test -tags e2e -v ./tests/e2e/...
```

#### Configuration

E2E tests load `tests/e2e/testconfig.json` (gitignored). Copy from the example:

```bash
cp tests/e2e/testconfig.example.json tests/e2e/testconfig.json
```

```json
{
  "anthropic": {
    "apiKeyEnv": "ION_API_KEY",
    "baseURL": "https://your-gateway.example.com",
    "testModel": "claude-haiku-4-5-20251001"
  },
  "openai": {
    "apiKeyEnv": "OPENAI_API_KEY",
    "baseURL": "",
    "testModel": "gpt-4.1-mini"
  }
}
```

Resolution order: `apiKey` field (literal key) > `apiKeyEnv` (env var name). Tests skip if no key is found. `baseURL` can point at an AI gateway or be left empty for direct API access.

## Test helpers

All test helpers live in `engine/tests/helpers/`.

### MockProvider

Scripted LLM provider for deterministic testing. Returns pre-configured responses in sequence.

```go
provider := helpers.NewMockProvider(
    helpers.TextResponse("Hello, world!"),
    helpers.ToolCallResponse("read", map[string]any{"path": "/tmp/test.txt"}),
    helpers.TextResponse("File contents look good."),
)
```

### MockBackend

Stub implementation of `RunBackend` for testing session and extension behavior without a real agent loop.

### Event builders

Helper functions for constructing test events:

| Builder | Creates |
|---------|---------|
| `TextResponse(text)` | Simple text response from LLM |
| `ToolCallResponse(name, input)` | Tool call response |
| `MultiTurnResponse(responses...)` | Multi-turn conversation sequence |

## Writing tests

### Unit tests

- Colocate with the source file: `foo.go` -> `foo_test.go`
- Use standard `testing.T`
- No external dependencies
- Use `t.Parallel()` where safe

### Integration tests

- Place in `tests/integration/`
- Use the `integration` build tag: `//go:build integration`
- Use `MockProvider` for LLM calls
- Use `MockBackend` when testing above the backend layer
- Test cross-package interactions, not single-function behavior

### E2E tests

- Place in `tests/e2e/`
- Use the `e2e` build tag: `//go:build e2e`
- Skip gracefully when credentials are missing
- Use cheap models (Haiku, GPT-4.1 Mini) to keep costs low
- Keep assertions loose -- LLM output is nondeterministic

## Desktop tests

```bash
cd desktop && npm test
```

Desktop tests are run as part of `make test`. They use the standard Electron/Node test tooling configured in the desktop package.
