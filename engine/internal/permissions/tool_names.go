package permissions

import "strings"

// tool_names.go owns the one rule for reading a tool name that may have arrived
// through the engine's MCP bridge.
//
// # Why a name can arrive in two shapes
//
// A delegated-CLI run does not execute engine tools in-process. The engine
// exposes them to the subprocess over an MCP server, and MCP names every tool it
// serves as "mcp__<server>__<tool>". So the engine's own Bash tool reaches the
// permission rails as "mcp__ion-extensions__Bash" on a delegated-CLI run and as
// "Bash" on an API run — the same tool, executed by the same code, doing the same
// thing to the same machine.
//
// Every rail in engine.go that recognizes a shell does so by name
// ("bash"/"Bash": the dangerous-pattern check, the safe-command check, the
// classifier hand-off). Without normalization those rails silently stop matching
// the moment the tool is bridged, which is the worst possible failure shape: the
// call still runs, and the rail that was supposed to inspect it reports nothing.
//
// # Why the prefix is pinned to this engine's server, not to "mcp__" generally
//
// Stripping any "mcp__*__" prefix would fold a third-party MCP server's tool
// named "Bash" into the engine's shell rails. That server's Bash is not this
// engine's Bash, its input schema is its own, and inspecting its "command"
// argument under our patterns would be a guess. Only the engine's own bridge is
// unwrapped, because only there is the underlying tool known.

// EngineMcpToolPrefix is the MCP name prefix carried by tools the engine bridges
// into a delegated-CLI subprocess. It must equal "mcp__" + backend.McpServerName
// + "__"; the backend package pins that equality with a test, because the two
// constants cannot see each other (permissions is below backend in the import
// graph and must stay there).
const EngineMcpToolPrefix = "mcp__ion-extensions__"

// NormalizeToolName returns the engine-side tool name for a name that may have
// been observed on the MCP wire. A name carrying the engine's own bridge prefix
// is unwrapped; every other name — bare, or prefixed by another MCP server — is
// returned unchanged.
func NormalizeToolName(name string) string {
	if after, found := strings.CutPrefix(name, EngineMcpToolPrefix); found {
		return after
	}
	return name
}

// IsBashToolName reports whether a tool name denotes a shell call, in either
// casing and in either the bare or engine-bridged form.
func IsBashToolName(name string) bool {
	switch NormalizeToolName(name) {
	case "Bash", "bash":
		return true
	default:
		return false
	}
}
