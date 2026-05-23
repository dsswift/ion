package session

import (
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// AbortAgent sends SIGTERM to the named agent process. If subtree is true,
// it walks the parentAgent chain to find all descendant agents and aborts them.
//
// Special case: if agentName is empty and subtree is true, every agent in
// the session is aborted. The user-facing interrupt button uses this when
// the parent run is already dead but dispatched children are still alive.
func (m *Manager) AbortAgent(key, agentName string, subtree bool) {
	if agentName == "" && subtree {
		m.abortAllDescendants(key, "user abort (all)")
		return
	}

	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.RUnlock()
		return
	}
	m.mu.RUnlock()

	var pidsToKill []int

	if subtree {
		all := s.agents.AllHandles()
		for name, handle := range all {
			if name == agentName || s.agents.IsDescendant(name, agentName) {
				pidsToKill = append(pidsToKill, handle.PID)
			}
		}
	} else {
		if handle, exists := s.agents.LookupHandle(agentName); exists {
			pidsToKill = append(pidsToKill, handle.PID)
		}
	}

	for _, pid := range pidsToKill {
		killProcess(pid)
	}
}

// steerable is a local interface satisfied by any backend that can steer
// a running agent loop via an in-process message rather than the stdin
// pipe. Both *backend.ApiBackend and *backend.HybridBackend implement it.
// CliBackend does not — its runs are steered via WriteToStdin (the
// stream-json stdin pipe of the Claude Code subprocess).
//
// Steer returns true if the steer was accepted (and will reach the run
// loop), false otherwise (caller falls back to stdin). For HybridBackend
// this returns false for CLI-routed runs so the fallback covers them.
//
// This local interface is the mechanism that keeps Steer off the public
// RunBackend interface — adding it there would be a contract change.
// See docs/engine-grounding.md §3.
type steerable interface {
	Steer(requestID, message string) bool
}

// SteerAgent sends a message to a running agent's stdin, or steers the main
// session loop if agentName is empty.
func (m *Manager) SteerAgent(key, agentName, message string) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.RUnlock()
		return
	}

	// If agentName is empty, steer the main session loop
	if agentName == "" {
		rid := s.requestID
		m.mu.RUnlock()
		if rid == "" {
			return
		}
		// Try the in-process steer path first (ApiBackend / HybridBackend's
		// API-routed runs). If the backend doesn't implement steerable, or
		// Steer returns false (HybridBackend with a CLI-routed run), fall
		// back to the stdin-pipe path used by Claude Code subprocesses.
		if steer, ok := m.backend.(steerable); ok {
			if steer.Steer(rid, message) {
				return
			}
		}
		// CliBackend (or hybrid CLI-routed): write follow-up message over
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
			utils.Log("Session", "steer via stdin failed: "+err.Error())
		}
		return
	}
	m.mu.RUnlock()

	handle, exists := s.agents.LookupHandle(agentName)
	if !exists {
		return
	}
	if handle.StdinWrite != nil {
		handle.StdinWrite(message)
	}
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
