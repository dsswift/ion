package backend

// ContextModel enumerates how a backend sources conversation context for a
// run. It is the axis every continuity decision keys on: an engine-owned
// backend loads Ion's canonical transcript itself, while a native-session
// backend delegates to a subprocess that maintains its own session state and
// only ever receives opts.Prompt.
type ContextModel string

const (
	// ContextModelEngineOwned means the backend loads conversation.Messages
	// from Ion's conversation store in-engine on every run. Ion's transcript
	// is fed to the provider directly, so any turn can go to any provider
	// with full fidelity. The ApiBackend is the canonical implementation.
	ContextModelEngineOwned ContextModel = "engine_owned"

	// ContextModelNativeSession means the backend delegates to a CLI
	// subprocess that owns its own session state (claude --resume /
	// codex ThreadResume / ACP session/load). The subprocess receives only
	// opts.Prompt; prior context arrives either via native resume (when a
	// valid cursor exists) or via a bridged text transcript of Ion's
	// conversation (see session/cli_history_seed.go). The native session is
	// a disposable per-provider cache over Ion's transcript — whenever it is
	// stale or absent, the session layer discards it and rebuilds from truth.
	ContextModelNativeSession ContextModel = "native_session"
)

// Resume-handle kinds. Each native-session backend reports the identity space
// of the cursor it hands back on run exit, so consumers (the session layer,
// external harnesses) can reason about what a persisted cursor actually is.
const (
	ResumeHandleClaudeSessionUUID = "claude_session_uuid"
	ResumeHandleCodexThreadID     = "codex_thread_id"
	ResumeHandleAcpSessionID      = "acp_session_id"
)

// BackendCapabilities is a backend's static, self-describing feature
// contract. The session layer consults it at dispatch time to gate
// unsupported feature requests cleanly (emitting a typed
// capability_unsupported event instead of dispatching a run that would fail)
// and to decide between native resume and transcript bridging.
//
// Descriptors are static per backend kind: they describe what the backend's
// protocol supports, not what the live subprocess advertises at runtime.
// Runtime degradation (e.g. an ACP agent whose live session offers no plan
// mode despite a plan-capable spec) is still handled inside the backend with
// the same clean-failure surface.
type BackendCapabilities struct {
	// Kind is the backend's routing kind ("api", "claude-code", "codex",
	// "grok", "cursor"). It is the key the session layer uses for
	// per-provider native-session cursors and the value surfaced on
	// capability_unsupported events.
	Kind string

	// ContextModel declares how the backend sources conversation context.
	ContextModel ContextModel

	// PlanMode reports whether the backend can run a plan-mode turn.
	PlanMode bool

	// Steering reports whether a mid-turn follow-up message can be routed
	// into a running turn (WriteToStdin for the CLI backends, conversation
	// injection for the ApiBackend).
	Steering bool

	// Resume reports whether the backend maintains a resumable native
	// session across runs. Always false for engine-owned backends — they
	// have no native session to resume; Ion's transcript is the session.
	Resume bool

	// ResumeHandleKind names the identity space of the native resume handle
	// this backend reports on run exit ("claude_session_uuid",
	// "codex_thread_id", "acp_session_id"). Empty when Resume is false.
	ResumeHandleKind string
}

// Capabilities implementations for each backend. Each descriptor is a static
// value — cheap to call, safe from any goroutine, no locking required.

// Capabilities describes the ApiBackend: engine-owned context (full-fidelity
// structured turns from Ion's conversation store), plan mode, and mid-turn
// steering via conversation injection. No native session — Ion's transcript
// IS the session, so there is nothing to resume.
func (b *ApiBackend) Capabilities() BackendCapabilities {
	return BackendCapabilities{
		Kind:         "api",
		ContextModel: ContextModelEngineOwned,
		PlanMode:     true,
		Steering:     true,
		Resume:       false,
	}
}

// Capabilities describes the ClaudeCodeBackend: native-session context via
// `claude --resume <uuid>`, plan mode, and mid-turn steering over the
// bidirectional stream-json stdin pipe.
func (b *ClaudeCodeBackend) Capabilities() BackendCapabilities {
	return BackendCapabilities{
		Kind:             "claude-code",
		ContextModel:     ContextModelNativeSession,
		PlanMode:         true,
		Steering:         true,
		Resume:           true,
		ResumeHandleKind: ResumeHandleClaudeSessionUUID,
	}
}

// Capabilities describes the CodexBackend: native-session context via
// ThreadResume, plan mode, and mid-turn steering via turn/steer.
func (b *CodexBackend) Capabilities() BackendCapabilities {
	return BackendCapabilities{
		Kind:             "codex",
		ContextModel:     ContextModelNativeSession,
		PlanMode:         true,
		Steering:         true,
		Resume:           true,
		ResumeHandleKind: ResumeHandleCodexThreadID,
	}
}

// Capabilities describes an ACP backend (grok, cursor): native-session
// context via session/load, no mid-turn steering (ACP has no steer channel),
// and plan mode only when the spec is plan-capable (cursor advertises a
// plan/architect session mode; grok does not).
func (b *AcpBackend) Capabilities() BackendCapabilities {
	return BackendCapabilities{
		Kind:             b.spec.kind,
		ContextModel:     ContextModelNativeSession,
		PlanMode:         b.spec.planCapable,
		Steering:         false,
		Resume:           true,
		ResumeHandleKind: ResumeHandleAcpSessionID,
	}
}

// Capabilities on the HybridBackend answers for the default-routed inner
// backend (the one an empty/unknown model resolves to). Hybrid capabilities
// are inherently per-model — callers that know the model must resolve the
// inner backend first via ResolveFor(model).Capabilities(), which is exactly
// what the session layer's resolvedBackend(model) seam does.
func (h *HybridBackend) Capabilities() BackendCapabilities {
	return h.ResolveFor("").Capabilities()
}
