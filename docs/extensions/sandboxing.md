# Sandboxing Bash Commands

Ion ships sandbox primitives. The Bash tool does not wrap commands automatically — that would be an opinion. Your harness decides whether commands run inside a sandbox.

This page shows the canonical pattern: a `tool_call` (or `bash_tool_call`) hook that rewrites the command through `ctx.sandboxWrap()` before execution.

## What the SDK gives you

`ctx.sandboxWrap(command, profile?)` returns the wrapped command string. macOS uses Seatbelt (`sandbox-exec`). Linux uses bubblewrap (`bwrap`). Windows uses PowerShell path-restriction checks. The engine validates the command against its dangerous-pattern library (36 patterns covering `rm -rf /`, `curl | sh`, eval, kernel module loading, etc.) and rejects unsafe input before wrapping.

```ts
const { wrapped } = await ctx.sandboxWrap('npm test', {
  fsAllowWrite: [ctx.cwd],          // only the project directory is writable
  netAllowedDomains: ['registry.npmjs.org'],
})
```

The profile is optional. Without one, you still get the dangerous-pattern check, plus a default profile that allows reads everywhere and denies writes everywhere except what you list.

## Canonical pattern: wrap every Bash call

Register a `bash_tool_call` hook. Rewrite `payload.input.command` to the sandbox-wrapped form. Return the modified input.

```ts
import { createIon } from './ion-sdk'

const ion = createIon()

ion.on('bash_tool_call', async (ctx, payload) => {
  const { wrapped } = await ctx.sandboxWrap(payload.input.command, {
    fsAllowWrite: [ctx.cwd],
    fsDenyRead: ['/Users/josh/.ssh', '/Users/josh/.aws'],
    netAllowedDomains: ['api.example.com', 'registry.npmjs.org'],
  })
  return { input: { ...payload.input, command: wrapped } }
})
```

Now every Bash call from the agent runs inside the sandbox. The agent can't read `~/.ssh`, can't reach hosts outside the allowlist, and can only write inside the working directory.

## Tighter profile for risky agents

Sub-agents that run with a smaller model and tighter trust budget can use a stricter profile. Match on `payload.agentName` to apply a different profile per agent.

```ts
ion.on('bash_tool_call', async (ctx, payload) => {
  const profile = payload.agentName === 'untrusted-explorer'
    ? {
        fsAllowWrite: [],                    // read-only filesystem
        netAllowedDomains: [],               // no network
        netBlockedDomains: ['*'],
      }
    : {
        fsAllowWrite: [ctx.cwd],
        netAllowedDomains: ['*.github.com', 'registry.npmjs.org'],
      }

  const { wrapped } = await ctx.sandboxWrap(payload.input.command, profile)
  return { input: { ...payload.input, command: wrapped } }
})
```

## Block instead of wrap

If a command matches a dangerous pattern, `sandboxWrap` rejects with an error. If you want to surface that as a tool block (so the LLM sees a clear refusal instead of an exception), wrap the call.

```ts
ion.on('bash_tool_call', async (ctx, payload) => {
  try {
    const { wrapped } = await ctx.sandboxWrap(payload.input.command, profile)
    return { input: { ...payload.input, command: wrapped } }
  } catch (err: any) {
    return { block: true, reason: `Sandbox rejected command: ${err.message}` }
  }
})
```

## Profile reference

| Field | Behavior |
|-------|----------|
| `fsAllowWrite` | Paths the sandboxed process may write to. macOS: `(allow file-write* (subpath ...))`. Linux: `--bind`. Windows: ignored. |
| `fsDenyWrite` | Paths writes are explicitly blocked. Overrides `fsAllowWrite`. |
| `fsDenyRead` | Paths reads are blocked. Linux uses `--tmpfs` to hide contents. |
| `netAllowedDomains` | Allowlist mode: deny all network, allow named domains. |
| `netBlockedDomains` | Blocklist mode: allow all network, deny named domains. Ignored if `netAllowedDomains` is set. |
| `netAllowLocalBind` | Permit binding to localhost ports (servers, IPC). |
| `extraPatterns` | Additional regex patterns to reject. Each `{ pattern, reason }` is matched against the command before wrapping. |
| `platform` | Override target OS (`darwin`, `linux`, `windows`). Defaults to engine host. |

## When NOT to wrap

The sandbox adds latency (process spawn for `sandbox-exec` / `bwrap`). For low-risk shell calls in trusted code paths, you may choose to skip wrapping. The pattern is to gate by `payload.agentName`, `ctx.config`, or your own policy data — not to skip wrapping globally.

## Extension-initiated tool calls

When an extension uses `ctx.callTool(name, input)` to dispatch a tool itself (not via the LLM), the same permission policy applies — `deny` rules and `ask`-mode tier rules are honored. Two differences from LLM-issued calls are worth knowing:

- **`ask` decisions auto-deny.** The extension's call is synchronous; the engine cannot block it on a user elicitation. Configure an explicit allow rule for the specific tool/extension combination if you need it permitted from extension code.
- **Per-tool hooks (`bash_tool_call`, etc.) and `permission_request` do not fire.** The calling extension would otherwise receive its own hook on its own call — recursion that's hard to reason about. If you want to apply your own `bash_tool_call`-style policy on extension-initiated calls, run that logic inline before invoking `callTool`.

The audit log (configured via `permission` audit hook on the engine) still records every extension-initiated call.

## Related

- [Hook reference: `bash_tool_call`](../hooks/reference.md)
- [Permission engine](../security/index.md)
- Engine source: `engine/internal/sandbox/sandbox.go`
