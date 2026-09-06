package backend

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/permissions"
)

// cli_async_gate.go refuses the CLI-native tool modes whose promise the
// subprocess cannot keep, and names the engine tool that can.
//
// # The lifetime problem, stated once
//
// A delegated CLI subprocess IS the turn. It starts when the prompt arrives and
// exits when the model stops. Several of its tools are built for a different
// lifetime: they return immediately and undertake to call the model back later,
// which the host does by re-invoking the model after the turn ends. Under Ion
// there is nothing left to re-invoke — the process that owned the task, the
// registry entry and the child process is gone. The work is killed mid-run and
// the callback never happens, so the model waits for a message that cannot
// arrive and the operator has to type "continue".
//
// # Why a gate on the mode rather than removal of the tool
//
// Removing the whole tool with --disallowedTools was the first attempt and it
// was too blunt. Foreground Bash is not broken; it is the single most-used tool
// there is, the model reaches for it by reflex, and the CLI's refusal for a
// removed tool ("Bash is disabled for this session") is terminal-sounding and
// not ours to reword. The model reads it as "there is no shell" and stops.
//
// The PreToolUse hook is argument-level, so it can refuse the async MODE and let
// everything else through untouched. That keeps the native tools available and
// makes them behave the way the harness decides — and unlike a removed tool, the
// refusal is ours, so it carries the name of the replacement.
//
// This became possible only when the hook file was corrected to the shape the
// CLI reads (permission_hook_server.go). Before that no hook ever fired, which
// is why removal looked like the only option.

// asyncModeDenial reports whether a native CLI tool call asks for an async mode
// this backend cannot honor, and the reason the model should be given.
//
// The reason is written for the model: it says what was refused, why the
// promise cannot be kept here, and the exact tool name to call instead. A
// refusal without a replacement is one the model can only retry.
func asyncModeDenial(toolName string, input map[string]any) (reason string, denied bool) {
	engineTool := func(name string) string { return permissions.EngineMcpToolPrefix + name }

	// Match the name EXACTLY as the CLI sent it — do not normalize the MCP bridge
	// prefix away here. This is the one place in the engine where normalization
	// would be wrong, and wrong in the worst way: the engine's own shell arrives
	// as mcp__ion-extensions__Bash, background work is its entire purpose, and a
	// normalized match would refuse it with a message telling the model to call
	// it. The model would follow that advice and be refused again, forever.
	//
	// The permission rails normalize because they ask "what kind of tool is this,
	// so I can apply policy". This gate asks "whose tool is this, and can that
	// owner keep the promise" — and the answer differs precisely by the prefix.
	switch toolName {
	case "Bash", "bash":
		if !truthy(input["run_in_background"]) {
			return "", false
		}
		return fmt.Sprintf(
			"Background mode is not available on this Bash tool: its task would be killed when this turn ends, and the completion notice it promises can never be delivered. "+
				"Use %s instead, with run_in_background and notify_on_complete. That shell runs outside the turn, so the command survives and its result is delivered back to this conversation when it finishes. "+
				"Foreground Bash is unaffected — keep using it for everything else.",
			engineTool("Bash")), true

	case "Agent", "agent":
		if !truthy(input["run_in_background"]) {
			return "", false
		}
		return fmt.Sprintf(
			"Background mode is not available on this Agent tool: the subagent would be killed when this turn ends and its result could never be delivered. "+
				"Use %s instead — it dispatches asynchronously and its result is delivered back to this conversation. "+
				"A foreground Agent call is unaffected.",
			engineTool("ion_agent")), true

	case "Monitor", "monitor":
		// Monitor has no synchronous mode to preserve: watching for events and
		// reporting them as they happen IS delivery after the turn ends.
		return fmt.Sprintf(
			"Monitor is not available on this backend: it delivers events after the turn ends, which this run cannot do. "+
				"To wait for a command to finish, start it with %s using run_in_background and notify_on_complete — the result is delivered when it exits. "+
				"To watch a condition that needs judgement, use %s.",
			engineTool("Bash"), engineTool("Poll")), true
	}
	return "", false
}

// truthy reads a JSON boolean argument tolerantly. A hook payload is decoded
// into map[string]any, so a boolean arrives as bool — but a model that emits
// "true" as a string should still be refused rather than quietly allowed
// through into the mode this gate exists to close.
func truthy(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case string:
		return t == "true" || t == "True"
	default:
		return false
	}
}
