package extcontext

import (
	"errors"
	"fmt"
	"strings"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ErrSelfDispatch is returned when a dispatched agent attempts to dispatch an
// agent of its OWN name (recursive self-cloning). Blocked by the engine's
// self-dispatch rail unless EngineRuntimeConfig.AllowSelfDispatch is set. The
// caller (typically a harness dispatch tool) surfaces it to the dispatching
// LLM as a tool error so the model self-corrects.
var ErrSelfDispatch = errors.New("agent cannot dispatch itself")

// ErrSubAgentNotAllowed is returned when a dispatch carries a non-empty
// AllowedSubAgents allowlist and the requested agent name is not a member.
// The allowlist is harness-owned (the engine has no opinion on which agents
// may dispatch which); the engine only enforces membership when the list is
// present.
var ErrSubAgentNotAllowed = errors.New("agent not in dispatcher's allowed sub-agents")

// checkDispatchEligibility enforces the two non-depth dispatch guards:
//
//  1. Self-dispatch rail (engine-owned, on by default): a dispatched agent may
//     not dispatch an agent of its OWN name. The dispatcher's name is resolved
//     from currentDispatchId via the DispatchRegistry -- the authoritative
//     source (never parsed out of the id string, since names can contain
//     hyphens). Disabled when EngineRuntimeConfig.AllowSelfDispatch is true.
//
//  2. Sub-agent allowlist (harness-owned, enforced only when present): the
//     allowlist is a CARRY-FORWARD constraint. It is recorded on the dispatcher
//     when ITS dispatch was registered (SetAllowedSubAgents, keyed by the
//     dispatcher's own id) and resolved here from currentDispatchId -- i.e. the
//     requested child must be a member of THE DISPATCHER'S allowed sub-agents.
//     It is NOT the current call's own AllowedSubAgents field (that field
//     describes what the agent BEING dispatched may dispatch next, and is
//     stored for when that agent later dispatches its own children).
//
//     This is why the orchestrator (depth 0, currentDispatchId == "") is
//     structurally unconstrained: it has no dispatcher entry, hence no stored
//     allowlist, so it dispatches the top-tier agents freely. No special "is
//     this a root agent?" check is needed.
//
// Returns nil when the dispatch is allowed; a typed error (ErrSelfDispatch /
// ErrSubAgentNotAllowed) when blocked.
//
// Fail-open on registry miss: a non-empty currentDispatchId that is not found
// in the registry (a race that should not occur, since the dispatcher is
// registered before its child run starts) logs a warning and skips both checks
// rather than blocking a legitimate dispatch.
func checkDispatchEligibility(
	sa SessionAccessor,
	registry *DispatchRegistry,
	currentDispatchId string,
	requestedName string,
) error {
	// The orchestrator (depth 0) and any caller with no dispatcher identity
	// are unconstrained by both the self-rail and the allowlist.
	if currentDispatchId == "" || registry == nil {
		return nil
	}

	// --- Self-dispatch rail ---
	allowSelf := false
	if cfg := sa.EngineConfig(); cfg != nil {
		allowSelf = cfg.AllowSelfDispatch
	}

	if !allowSelf {
		dispatcherName, ok := registry.NameForID(currentDispatchId)
		if !ok {
			utils.LogWithFields(utils.LevelWarn, "server", "eligibility guard: dispatcher not found in registry; skipping self-dispatch check", map[string]any{"current_dispatch_id": currentDispatchId, "session_key": sa.SessionKey()})
		} else if namesEqual(dispatcherName, requestedName) {
			utils.LogWithFields(utils.LevelWarn, "server", "eligibility guard: blocked self-dispatch", map[string]any{"requested_name": requestedName, "current_dispatch_id": currentDispatchId, "session_key": sa.SessionKey()})
			return fmt.Errorf("%w: agent %q may not dispatch itself", ErrSelfDispatch, requestedName)
		}
	}

	// --- Sub-agent allowlist (the DISPATCHER's allowlist, carried forward) ---
	allowedSubAgents, found := registry.AllowedSubAgentsForID(currentDispatchId)
	if !found {
		// Dispatcher not registered (the same race as above) -- fail open.
		utils.LogWithFields(utils.LevelWarn, "server", "eligibility guard: dispatcher not found for allowlist; skipping allowlist check", map[string]any{"current_dispatch_id": currentDispatchId, "session_key": sa.SessionKey()})
		return nil
	}
	if len(allowedSubAgents) > 0 {
		if !nameInList(requestedName, allowedSubAgents) {
			utils.LogWithFields(utils.LevelWarn, "server", "eligibility guard: blocked dispatch not in dispatcher's", map[string]any{"requested_name": requestedName, "allowed_sub_agents": allowedSubAgents, "current_dispatch_id": currentDispatchId, "session_key": sa.SessionKey()})
			return fmt.Errorf("%w: agent %q is not in the dispatcher's allowed sub-agents %v", ErrSubAgentNotAllowed, requestedName, allowedSubAgents)
		}
		utils.LogWithFields(utils.LevelInfo, "server", "eligibility guard: allowed dispatch (in allowedsubagents)", map[string]any{"requested_name": requestedName, "current_dispatch_id": currentDispatchId, "session_key": sa.SessionKey()})
	}

	return nil
}

// namesEqual compares two agent names case-insensitively after trimming
// surrounding whitespace, matching the leniency the rest of the dispatch path
// applies to agent names.
func namesEqual(a, b string) bool {
	return strings.EqualFold(strings.TrimSpace(a), strings.TrimSpace(b))
}

// nameInList reports whether name (case-insensitive, trimmed) is a member of
// list.
func nameInList(name string, list []string) bool {
	for _, candidate := range list {
		if namesEqual(name, candidate) {
			return true
		}
	}
	return false
}

// registerDispatch records a dispatch in the registry with its full
// bookkeeping in one place: the recall entry (RegisterWithID), the child run
// id (SetChildRunID), and the carry-forward allowlist (SetAllowedSubAgents).
// The allowlist is keyed by agentID -- which becomes the currentDispatchId of
// this agent's own children -- so the eligibility guard resolves it from there
// and the allowlist constrains this agent's NESTED dispatches, not the call
// that spawned this agent. Shared by the foreground and background dispatch
// paths so the three registry calls never drift between them. No-op when
// registry is nil.
func registerDispatch(
	registry *DispatchRegistry,
	agentID, name string,
	cancel func(),
	child backend.RunBackend,
	sessionKey, parentDispatchID string,
	childDepth int,
	childRunID string,
	allowedSubAgents []string,
) {
	if registry == nil {
		return
	}
	registry.RegisterWithID(agentID, name, cancel, child, sessionKey, parentDispatchID, childDepth)
	registry.SetChildRunID(agentID, childRunID)
	registry.SetAllowedSubAgents(agentID, allowedSubAgents)
}
