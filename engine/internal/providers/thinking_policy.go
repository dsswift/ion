package providers

import (
	"sync/atomic"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// thinking_policy.go — the engine-wide operator kill switch for extended
// thinking.
//
// Why this exists. Extended thinking is a per-run consumer choice
// (types.ThinkingConfig, carried on every prompt), but "may models reason at
// all on this install" is an OPERATOR decision that no per-run config can
// express: a client that never sends a ThinkingConfig still gets reasoning from
// an adaptive model (see the self-engaged display-only directive in
// anthropic.go), and a client that sends Enabled:true would otherwise override
// the operator. So the switch lives above the run, in engine.json
// (EngineRuntimeConfig.ThinkingPolicy.Disabled), optionally sealed by enterprise
// policy, and is installed into this package once at daemon startup.
//
// The mechanism is engine-owned and generic; the decision is the operator's
// opinion. The engine has NO opinion on how a consumer renders the result — it
// reports capability truthfully and each consumer decides what to draw. That
// separation is why the switch is carried by the EXISTING per-model capability
// projection (ModelEntry.thinkingMode / thinkingEfforts / supportsThinking)
// rather than by a new wire field: a disabled install reports models that
// declare no reasoning capability, which is exactly what every consumer
// already knows how to interpret.
//
// Storage follows the SetStreamIdleTimeout precedent in sse_idle.go: a
// package-level atomic with a setter, so the hot provider paths read a plain
// bool rather than threading operator config through every Stream signature
// (which would be a contract change). The setter is called from daemon startup
// while provider goroutines may already be reading, hence the atomic.

// thinkingDisabled is the installed operator policy. The zero value (false)
// means thinking is PERMITTED, which is deliberate and load-bearing: an engine
// that has never had a policy installed — a fresh install with no engine.json,
// an embedding consumer that never calls the setter, a unit test that
// constructs a provider directly — must behave exactly as it did before this
// switch existed. Thinking works out of the box; disabling it is the explicit
// act. Pinned by TestThinkingPolicyZeroValuePermitsThinking.
var thinkingDisabled atomic.Bool

// SetThinkingDisabled installs the engine-wide operator thinking policy. Call
// once at daemon startup from the merged EngineRuntimeConfig (after enterprise
// enforcement, so a sealed policy cannot be weakened by a lower layer).
//
// disabled=true means no model on this install reports reasoning capability and
// no provider request carries a thinking directive. disabled=false restores the
// default permitted behavior.
func SetThinkingDisabled(disabled bool) {
	prev := thinkingDisabled.Swap(disabled)
	utils.LogWithFields(utils.LevelInfo, "Thinking", "install engine-wide thinking policy", map[string]any{
		"status": !disabled, "reason": "operator config", "changed": prev != disabled,
	})
}

// ThinkingPermitted reports whether the operator permits extended thinking on
// this engine. True unless an operator (or enterprise policy) explicitly
// disabled it.
func ThinkingPermitted() bool {
	return !thinkingDisabled.Load()
}

// applyThinkingPolicyToEntries scrubs declared reasoning capability from a
// model listing when the operator has disabled thinking. It is the projection
// half of the switch: consumers render availability from what the engine
// reports about each model, so a disabled install must report models that
// declare no reasoning mechanism and no effort levels.
//
// All three capability fields are cleared together. Clearing only the effort
// set would leave `thinkingMode: "adaptive"` on the wire, which asserts "this
// model reasons by default" — a statement that is false on a disabled install,
// and one a consumer would reasonably render as an active reasoning floor.
//
// Returns the input unchanged (no copy, no allocation) when thinking is
// permitted, which is the default path.
func applyThinkingPolicyToEntries(entries []types.ModelEntry) []types.ModelEntry {
	if ThinkingPermitted() {
		utils.LogWithFields(utils.LevelDebug, "Thinking", "list models thinking permitted capability reported as declared", map[string]any{"count": len(entries)})
		return entries
	}
	scrubbed := 0
	for i := range entries {
		if !entries[i].SupportsThinking && entries[i].ThinkingMode == "" && len(entries[i].ThinkingEfforts) == 0 {
			continue
		}
		scrubbed++
		entries[i].SupportsThinking = false
		entries[i].ThinkingMode = ""
		entries[i].ThinkingEfforts = nil
	}
	utils.LogWithFields(utils.LevelInfo, "Thinking", "list models thinking disabled by operator capability withheld", map[string]any{
		"count": len(entries), "scrubbed": scrubbed,
	})
	return entries
}
