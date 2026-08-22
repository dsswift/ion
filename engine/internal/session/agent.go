package session

import (
	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// SteerOutcome reports how a SteerAgent call was resolved. It is an internal
// Go signal (NOT a wire/SDK contract — SteerAgent is called only from the
// server dispatch switch and tests, never exposed over the protocol or SDK),
// so it is free to evolve. Its purpose is to eliminate the historical
// silent-drop: every SteerAgent call now returns a non-void, loggable verdict
// so a steer can never disappear without a trace. See docs/engine-grounding.md
// §7 (logging is part of the contract).
type SteerOutcome int

const (
	// SteerOutcomeUnknown is the zero value; it should never be returned by a
	// completed SteerAgent call and exists only so an uninitialized variable
	// reads as obviously-wrong rather than as a real outcome.
	SteerOutcomeUnknown SteerOutcome = iota
	// SteerDelivered: the steer was accepted by the backend's in-process steer
	// path (buffered on the run's steer channel) and will be injected at the
	// next drainSteer checkpoint in the run loop.
	SteerDelivered
	// SteerDeliveredViaStdin: the steer was written to the backend's stdin
	// pipe (ClaudeCodeBackend / hybrid CLI-routed runs).
	SteerDeliveredViaStdin
	// SteerDeliveredToAgent: a named (non-main-loop) agent received the steer
	// over its stdin-write handle.
	SteerDeliveredToAgent
	// SteerRejectedNoRun: there is no active run to steer (no session, no
	// in-flight requestID, no live backend run, or the named agent does not
	// exist). The steer was NOT delivered.
	SteerRejectedNoRun
	// SteerRejectedChannelFull: the backend's steer channel was full after a
	// reasonable buffer, so the steer could not be queued. The steer was NOT
	// delivered.
	SteerRejectedChannelFull
)

// String renders a SteerOutcome for logs.
func (o SteerOutcome) String() string {
	switch o {
	case SteerDelivered:
		return "delivered"
	case SteerDeliveredViaStdin:
		return "delivered_via_stdin"
	case SteerDeliveredToAgent:
		return "delivered_to_agent"
	case SteerRejectedNoRun:
		return "rejected_no_run"
	case SteerRejectedChannelFull:
		return "rejected_channel_full"
	default:
		return "unknown"
	}
}

// Delivered reports whether the outcome represents a steer that reached a
// run (channel, stdin, or named agent). Callers use it to decide whether to
// surface a rejection to the user.
func (o SteerOutcome) Delivered() bool {
	switch o {
	case SteerDelivered, SteerDeliveredViaStdin, SteerDeliveredToAgent:
		return true
	default:
		return false
	}
}

// steerable is a local interface satisfied by any backend that can steer
// a running agent loop via an in-process message rather than the stdin
// pipe. Both *backend.ApiBackend and *backend.HybridBackend implement it.
// ClaudeCodeBackend does not — its runs are steered via WriteToStdin (the
// stream-json stdin pipe of the Claude Code subprocess).
//
// SteerWithReason returns a typed backend.SteerResult so the session layer can
// tell apart "no active run / not API-routed" (fall back to stdin) from
// "channel full" (a genuine rejection that must surface to the caller). The
// older Steer(...) bool method is still defined on the backends for any
// boolean-only caller; the session layer uses the richer method so no steer
// outcome is ever collapsed into an unexplained false.
//
// SteerWithKind additionally carries the injection kind, so a machine-
// originated steer is persisted as the machine-to-machine turn it is rather
// than as an unclassified user turn.
//
// This local interface is the mechanism that keeps the steer methods off the
// public RunBackend interface — adding them there would be a contract change.
// See docs/engine-grounding.md §3.
type steerable interface {
	SteerWithReason(requestID, message string) backend.SteerResult
	SteerWithKind(requestID, message, kind string) backend.SteerResult
}

// steerableWithClientID is the optional extension of steerable that also
// accepts a client correlation id. Asserted separately (rather than folded
// into steerable) so a backend or test double that predates the correlation-id
// feature keeps compiling and falls back to the kind-only path — the
// correlation id is purely additive UX, never required for a steer to deliver.
type steerableWithClientID interface {
	SteerWithClientID(requestID, message, kind, clientMessageID string) backend.SteerResult
}

type backgroundWorkSteerable interface {
	SteerWithBackgroundWork(requestID, message, kind string, work types.BackgroundWorkInfo) backend.SteerResult
}

// SteerAgent sends a message to a running agent's stdin, or steers the main
// session loop if agentName is empty. It returns a SteerOutcome describing how
// the steer was resolved so the caller (and the logs) can never lose track of
// a steer: previously this method was void and a steer that could not be
// delivered vanished without a trace. Every branch logs the attempt and its
// outcome (engine-grounding §7).
func (m *Manager) SteerAgent(key, agentName, message string) SteerOutcome {
	return m.SteerAgentWithKind(key, agentName, message, "")
}

// SteerAgentWithBackgroundWork steers completion metadata into an API-backed run.
func (m *Manager) SteerAgentWithBackgroundWork(key, agentName, message, kind string, work types.BackgroundWorkInfo) SteerOutcome {
	if agentName != "" {
		return m.SteerAgentWithKind(key, agentName, message, kind)
	}
	m.mu.RLock()
	s, ok := m.sessions[key]
	rid := ""
	if ok {
		rid = s.requestID
	}
	m.mu.RUnlock()
	if !ok || rid == "" {
		return SteerRejectedNoRun
	}
	steer, ok := m.backend.(backgroundWorkSteerable)
	if !ok {
		return m.SteerAgentWithKind(key, agentName, message, kind)
	}
	switch steer.SteerWithBackgroundWork(rid, message, kind, work) {
	case backend.SteerResultDelivered:
		return SteerDelivered
	case backend.SteerResultChannelFull:
		return SteerRejectedChannelFull
	default:
		return SteerRejectedNoRun
	}
}

// SteerAgentWithKind is the classification-carrying variant of SteerAgent.
//
// kind is a types.InjectionKind wire value naming who authored the message.
// Empty — what SteerAgent passes — means a client-originated steer, a human
// typing into a running turn. A machine originator passes its own kind so the
// persisted turn records that no user authored it.
func (m *Manager) SteerAgentWithKind(key, agentName, message, kind string) SteerOutcome {
	return m.SteerAgentWithClientID(key, agentName, message, kind, "")
}

// SteerAgentWithClientID is the correlation-id-carrying variant of
// SteerAgentWithKind. clientMessageID is only meaningful for the main-loop
// (agentName == "") API-steer path — a named-agent stdin steer and the
// stdin-pipe main-loop fallback have no channel to echo a confirmation
// through, so the id is accepted but has no effect on those paths.
func (m *Manager) SteerAgentWithClientID(key, agentName, message, kind, clientMessageID string) SteerOutcome {
	utils.LogWithFields(utils.LevelInfo, "session", "steeragent: attempt", map[string]any{"session_id": key, "agent_name": agentName, "count": len(message), "kind": kind, "client_message_id": clientMessageID})

	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.RUnlock()
		utils.LogWithFields(utils.LevelWarn, "session", "steeragent: rejected, no such session", map[string]any{"session_id": key, "agent_name": agentName, "count": len(message), "steer_rejected_no_run": SteerRejectedNoRun})
		return SteerRejectedNoRun
	}

	// If agentName is empty, steer the main session loop
	if agentName == "" {
		rid := s.requestID
		m.mu.RUnlock()
		if rid == "" {
			utils.LogWithFields(utils.LevelWarn, "session", "steeragent: rejected, no active run for main loop", map[string]any{"session_id": key, "count": len(message), "steer_rejected_no_run": SteerRejectedNoRun})
			return SteerRejectedNoRun
		}
		// Try the in-process steer path first (ApiBackend / HybridBackend's
		// API-routed runs). The typed result distinguishes a genuine
		// rejection (channel full) from "this backend/run is not
		// API-steerable" (no run), the latter falling through to the stdin
		// pipe path used by Claude Code subprocesses.
		if steerCID, ok := m.backend.(steerableWithClientID); ok {
			switch res := steerCID.SteerWithClientID(rid, message, kind, clientMessageID); res {
			case backend.SteerResultDelivered:
				utils.LogWithFields(utils.LevelInfo, "session", "steeragent: delivered to main loop via channel", map[string]any{"session_id": key, "rid": rid, "count": len(message), "client_message_id": clientMessageID, "steer_delivered": SteerDelivered})
				return SteerDelivered
			case backend.SteerResultChannelFull:
				utils.LogWithFields(utils.LevelWarn, "session", "steeragent: rejected, steer channel full", map[string]any{"session_id": key, "rid": rid, "count": len(message), "steer_rejected_channel_full": SteerRejectedChannelFull})
				return SteerRejectedChannelFull
			default:
				utils.LogWithFields(utils.LevelInfo, "session", "steeragent: backend not api-steerable, falling back to stdin", map[string]any{"res": res, "session_id": key, "rid": rid})
			}
		} else if steer, ok := m.backend.(steerable); ok {
			switch res := steer.SteerWithKind(rid, message, kind); res {
			case backend.SteerResultDelivered:
				utils.LogWithFields(utils.LevelInfo, "session", "steeragent: delivered to main loop via channel", map[string]any{"session_id": key, "rid": rid, "count": len(message), "steer_delivered": SteerDelivered})
				return SteerDelivered
			case backend.SteerResultChannelFull:
				// A live API-backed run whose steer buffer is full after a
				// reasonable buffer. This is a genuine, loud rejection — do
				// NOT fall through to stdin (a no-op for ApiBackend) and
				// silently drop it.
				utils.LogWithFields(utils.LevelWarn, "session", "steeragent: rejected, steer channel full", map[string]any{"session_id": key, "rid": rid, "count": len(message), "steer_rejected_channel_full": SteerRejectedChannelFull})
				return SteerRejectedChannelFull
			default:
				// SteerResultNoRun: not API-routed (CLI/hybrid-CLI) or the
				// backend's run map disclaims the id. Fall through to stdin.
				utils.LogWithFields(utils.LevelInfo, "session", "steeragent: backend not api-steerable (), falling back to stdin", map[string]any{"res": res, "session_id": key, "rid": rid})
			}
		} else {
			utils.LogWithFields(utils.LevelInfo, "session", "steeragent: backend does not implement steerable, using stdin path", map[string]any{"session_id": key, "rid": rid})
		}
		// ClaudeCodeBackend (or hybrid CLI-routed): write follow-up message over
		// stdin pipe of the Claude Code subprocess.
		stdinMsg := map[string]interface{}{
			"type": "user",
			"message": map[string]interface{}{
				"role": "user",
				"content": []map[string]interface{}{
					{"type": "text", "text": message},
				},
			},
		}
		if err := m.backend.WriteToStdin(rid, stdinMsg); err != nil {
			utils.LogWithFields(utils.LevelWarn, "session", "steeragent: stdin write failed", map[string]any{"session_id": key, "rid": rid, "count": len(message), "error": err.Error(), "steer_rejected_no_run": SteerRejectedNoRun})
			return SteerRejectedNoRun
		}
		utils.LogWithFields(utils.LevelInfo, "session", "steeragent: delivered to main loop via stdin", map[string]any{"session_id": key, "rid": rid, "count": len(message), "steer_delivered_via_stdin": SteerDeliveredViaStdin})
		return SteerDeliveredViaStdin
	}
	m.mu.RUnlock()

	handle, exists := s.agents.LookupHandle(agentName)
	if !exists {
		utils.LogWithFields(utils.LevelWarn, "session", "steeragent: rejected, no such agent", map[string]any{"session_id": key, "agent_name": agentName, "count": len(message), "steer_rejected_no_run": SteerRejectedNoRun})
		return SteerRejectedNoRun
	}
	if handle.StdinWrite == nil {
		utils.LogWithFields(utils.LevelWarn, "session", "steeragent: rejected, agent has no stdin-write handle", map[string]any{"session_id": key, "agent_name": agentName, "count": len(message), "steer_rejected_no_run": SteerRejectedNoRun})
		return SteerRejectedNoRun
	}
	handle.StdinWrite(message)
	utils.LogWithFields(utils.LevelInfo, "session", "steeragent: delivered to agent stdin", map[string]any{"session_id": key, "agent_name": agentName, "count": len(message), "steer_delivered_to_agent": SteerDeliveredToAgent})
	return SteerDeliveredToAgent
}

// resolveAgentSpec resolves an agent name to a registered spec. If the name
// is not in the session's spec registry, fires the capability_match hook so
// extensions can promote a draft (typically via ctx.RegisterAgentSpec) and
// retries resolution on the same call. Returns (spec, true) on success, or
// (zero, false) when no match is registered after the hook runs.
func (m *Manager) resolveAgentSpec(s *engineSession, key, name string) (types.AgentSpec, bool) {
	if spec, ok := s.agents.LookupSpec(name); ok {
		return spec, true
	}

	if s.extGroup == nil {
		return types.AgentSpec{}, false
	}

	known := s.agents.AllSpecNames()

	extCtx := m.newExtContext(s, key)
	for _, h := range s.extGroup.Hosts() {
		_ = h.SDK().FireCapabilityMatch(extCtx, extension.CapabilityMatchInfo{
			Input:        name,
			Capabilities: known,
		})
	}

	// Retry — handler may have called ctx.RegisterAgentSpec.
	return s.agents.LookupSpec(name)
}
