package types

// config_agent_state_emit.go — operator controls for agent-state emission
// cardinality.
//
// engine_agent_state is a complete snapshot: emission N+1 is a total function
// of engine state at that instant and strictly supersedes N. A consumer that
// receives only N+1 ends in exactly the state it would occupy after applying
// N then N+1, so dropping intermediates loses no STATE — only intermediate
// timing. docs/architecture/agent-state.md additionally forbids consumers
// from deriving history from these events ("Do not invent retention rules...
// If you need a 'past dispatches' feature, build it on conversation history"),
// so no conforming consumer can observe the difference.
//
// That is what makes coalescing safe to enable by default rather than a
// behavior change consumers must opt into. Dedup is weaker still: re-sending a
// byte-identical payload is a no-op by definition.
//
// The tunables exist because emission cardinality is nonetheless observable to
// a non-conforming consumer, and an operator who has one needs a way back.

// AgentStateEmitLimits controls dedup and coalescing of agent-state emissions.
//
// Pointers so engine.json can omit the block and inherit the defaults.
type AgentStateEmitLimits struct {
	// CoalesceMs is the rate-limit window in milliseconds. Nil or 0 uses the
	// default; -1 disables coalescing entirely, restoring exactly today's
	// emission cardinality for a consumer that depends on it.
	//
	// This is a leading+trailing rate limiter, not a plain trailing debounce:
	// the first change in an idle window emits immediately, so an isolated
	// update has zero added latency. Only a BURST is collapsed, and the final
	// state is always re-read and emitted when the window closes.
	CoalesceMs *int `json:"coalesceMs,omitempty"`

	// Dedup suppresses emissions whose snapshot is byte-identical to the last
	// one sent. Nil means enabled.
	//
	// Forced emissions bypass this. Heartbeat and reconcile exist precisely to
	// re-assert an unchanged truth to a client that may have missed it, so for
	// them the repeat IS the signal.
	Dedup *bool `json:"dedup,omitempty"`
}

// ResolvedAgentStateEmitLimits is the flattened form the engine uses.
type ResolvedAgentStateEmitLimits struct {
	CoalesceMs int
	Dedup      bool
}

// DefaultAgentStateCoalesceMs is the default rate-limit window.
//
// 250ms is chosen against human perception rather than a throughput target:
// it is short enough that a coalesced burst still reads as immediate, and
// long enough to collapse the 38-emissions-in-one-second bursts observed in
// production down to a couple of frames.
const DefaultAgentStateCoalesceMs = 250

// AgentStateEmitDefaults returns the compiled defaults.
func AgentStateEmitDefaults() ResolvedAgentStateEmitLimits {
	return ResolvedAgentStateEmitLimits{
		CoalesceMs: DefaultAgentStateCoalesceMs,
		Dedup:      true,
	}
}

// Resolved flattens the pointer config against the compiled defaults. A nil
// receiver resolves to defaults, so callers need no nil check.
func (l *AgentStateEmitLimits) Resolved() ResolvedAgentStateEmitLimits {
	out := AgentStateEmitDefaults()
	if l == nil {
		return out
	}
	if l.CoalesceMs != nil && *l.CoalesceMs != 0 {
		out.CoalesceMs = *l.CoalesceMs
	}
	if l.Dedup != nil {
		out.Dedup = *l.Dedup
	}
	return out
}
