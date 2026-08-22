// prompt_overrides.go — PromptOverrides type and delivery-ID idempotency
// helpers used by prompt_dispatch.go.

package session

import (
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// PromptOverrides holds per-prompt overrides from the client command.
type PromptOverrides struct {
	Model              string
	MaxTurns           int
	MaxBudgetUsd       float64
	Extensions         []string
	NoExtensions       bool
	AppendSystemPrompt string
	// Attachments are pre-encoded images supplied by the client to be sent
	// to the LLM as native image content blocks alongside the text prompt.
	Attachments []types.ImageAttachment
	// ImplementationPhase forwards the client's
	// ClientCommand.ImplementationPhase flag onto the run's RunOptions so
	// the engine suppresses EnterPlanMode injection. Optional; defaults
	// to false. See the field comment on types.RunOptions for the full
	// rationale.
	ImplementationPhase bool
	// ThinkingEffort forwards the client's ClientCommand.ThinkingEffort onto
	// the run's RunOptions.Thinking for this prompt. One of "low"|"medium"|
	// "high"; "" or "off" means no thinking directive for this prompt
	// (overriding any session default to off). The live per-conversation
	// control: a client changes the level and it applies on the next prompt
	// with no session restart. Mirrors ImplementationPhase's per-prompt
	// override semantics.
	ThinkingEffort string
	// EnterPlanModeDescription forwards the client's harness-supplied
	// description prose for the EnterPlanMode sentinel tool. When
	// non-empty, the engine uses this string verbatim as the tool's
	// description. When empty (the default), the engine falls back to a
	// one-line neutral default. Per ADR-004, the policy prose lives in
	// the harness; the engine ships only the mechanism.
	EnterPlanModeDescription string
	// PlanModeSparseReminder forwards the client's harness-supplied text
	// for the per-turn plan-mode sparse reminder. When non-empty, the
	// engine injects this string instead of buildPlanModeSparseReminder.
	// When empty (the default), the engine builds the reminder from the
	// plan file path. Parallel override to EnterPlanModeDescription;
	// same additive omitempty contract.
	PlanModeSparseReminder string
	// PlanFilePath is the persisted plan file path from the desktop's
	// tab state. When non-empty, the engine restores the session's
	// planFilePath from this value instead of allocating a fresh slug --
	// preserving plan file continuity across desktop restarts. The
	// engine validates that the file exists on disk before using it;
	// if missing it falls back to fresh allocation. Additive optional
	// field; empty by default.
	PlanFilePath string

	// BashAllowlistAdditionsForThisPrompt are per-prompt additions to
	// the plan-mode Bash allowlist. The engine unions these with the
	// session-scoped allowlist (engineSession.planModeAllowedBashCommands)
	// when building the run-time tool list, then drops them at run end --
	// the session-level allowlist is NEVER mutated. Intended carrier:
	// slash-command frontmatter that needs a one-turn permission
	// extension. See types.RunOptions.BashAllowlistAdditionsForThisPrompt
	// for the wire-side contract. Additive optional field; nil/empty
	// for prompts that don't need per-prompt additions.
	BashAllowlistAdditionsForThisPrompt []string
	McpAllowlistAdditionsForThisPrompt  []string

	// CompactTargetPercent overrides the post-compact target as a percentage of
	// the context window. Zero means "use engine default".
	CompactTargetPercent float64

	// CompactMicroKeepTurns overrides the number of recent turns protected
	// from micro-compaction. Zero means "use engine default".
	CompactMicroKeepTurns int

	// CompactEnabled overrides the auto-compact gate. nil means "use engine
	// default"; false disables proactive compaction for this prompt.
	CompactEnabled *bool

	// CompactSummaryEnabled overrides whether LLM-based summarization is used
	// during compaction. nil means "use engine default".
	CompactSummaryEnabled *bool

	// CompactMemoryEnabled overrides whether the background session memory
	// summarizer is active. nil means "use engine default".
	CompactMemoryEnabled *bool

	// ResolveSlash signals that the prompt Text is a slash-command invocation
	// the engine should resolve and expand (see protocol.ClientCommand.ResolveSlash
	// and types.RunOptions.ResolveSlash). When true, SendPrompt resolves the
	// invocation against the conventional roots, rewrites the LLM-visible prompt
	// to the expanded body, and persists the raw invocation as the display turn.
	ResolveSlash bool

	// ClientWorkspaceContext is a per-prompt client-supplied workspace
	// descriptor. When non-nil, the engine uses it instead of its own
	// worktree-registry-derived context for this prompt. Overrides the
	// session-level EngineConfig value. See types.ClientWorkspaceContext.
	ClientWorkspaceContext *types.ClientWorkspaceContext

	// InjectionKind classifies an engine-side injected prompt so the
	// persisted conversation entry carries the semantic type. "agent_completion"
	// marks a machine-to-machine dispatch callback (a child agent's result
	// routed to its parent) rather than a user-authored turn. Empty for
	// ordinary client-submitted prompts. Propagates to
	// MessageData.InjectionKind via appendInboundUserMessage so consumers
	// can classify the turn on historical reload.
	InjectionKind string

	// SteerDegraded marks a prompt that began as a ctx.steerSelf delivery and
	// became a fresh prompt because the owning run was not live. Forwarded onto
	// RunOptions.SteerDegraded so the backend persists the same steer marker
	// drainSteer writes for the live-run path. Orthogonal to InjectionKind --
	// see the RunOptions field comment.
	SteerDegraded bool

	// DeliveryId is a client-supplied idempotency key. When non-empty the
	// dispatch layer checks the persisted conversation for an existing
	// message carrying this ID before calling SendPrompt. A duplicate
	// short-circuits with no run started and no error. The ID is threaded
	// onto the persisted user-message entry via RunOptions so retries are
	// durable across engine restarts. Empty preserves legacy semantics.
	DeliveryId string
}

// ReserveDeliveryID atomically reserves an idempotency key for a prompt. It
// first checks this process's in-flight reservations, then the persisted
// conversation for a prior accepted delivery. A false result means the ID is
// already reserved or persisted and the caller must not start another run.
func (m *Manager) ReserveDeliveryID(key, deliveryID string) bool {
	if deliveryID == "" {
		return true
	}
	m.mu.Lock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.Unlock()
		return true
	}
	if s.acceptedDeliveryIDs == nil {
		s.acceptedDeliveryIDs = make(map[string]struct{})
	}
	if _, reserved := s.acceptedDeliveryIDs[deliveryID]; reserved {
		m.mu.Unlock()
		return false
	}
	convID := s.conversationID
	m.mu.Unlock()

	conv, err := conversation.Load(convID, "")
	if err == nil && conversation.HasDeliveryID(conv, deliveryID) {
		return false
	}
	if err != nil {
		utils.LogWithFields(utils.LevelDebug, "session", "delivery-id persisted check unavailable", map[string]any{
			"key": key, "delivery_id": deliveryID, "conversation": convID, "error": err.Error(),
		})
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok = m.sessions[key]
	if !ok {
		return true
	}
	if s.acceptedDeliveryIDs == nil {
		s.acceptedDeliveryIDs = make(map[string]struct{})
	}
	if _, reserved := s.acceptedDeliveryIDs[deliveryID]; reserved {
		return false
	}
	s.acceptedDeliveryIDs[deliveryID] = struct{}{}
	return true
}

// ReleaseDeliveryID abandons a reservation when prompt dispatch fails before
// acceptance. Persisted entries remain the restart-safe authority after a run
// starts successfully.
func (m *Manager) ReleaseDeliveryID(key, deliveryID string) {
	if deliveryID == "" {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if s, ok := m.sessions[key]; ok {
		delete(s.acceptedDeliveryIDs, deliveryID)
	}
}

// deliveryIDFromOverrides extracts the caller-owned reservation key for a
// dispatch branch that exits before any backend run can persist it.
func deliveryIDFromOverrides(overrides *PromptOverrides) string {
	if overrides == nil {
		return ""
	}
	return overrides.DeliveryId
}
