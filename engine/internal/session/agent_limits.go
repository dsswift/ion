package session

// agent_limits.go — resolves the configured agent-state metadata bounds and
// hands them to each session's agent registry.
//
// The registry lives in its own package and has no access to engine config,
// so the Manager resolves the bound here and injects it at construction. That
// keeps the clamp mechanism (agents package) separate from the policy about
// how large is too large (config), which is the split the engine's
// opinionless-mechanics rule asks for.

import (
	"github.com/dsswift/ion/engine/internal/session/agents"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// agentMetadataLimits resolves the effective bounds for a new session's agent
// registry: engine.json first, narrowed by any enterprise ceiling.
//
// Nil-safe on every layer. A Manager with no config at all resolves to the
// compiled defaults rather than to "unbounded" — an absent config file must
// not be a way to switch the bound off.
func (m *Manager) agentMetadataLimits() agents.MetadataLimits {
	resolved := types.AgentStateMetadataDefaults()

	if m != nil && m.config != nil {
		resolved = m.config.Limits.AgentStateMetadata.Resolved()
		if ep := m.config.Enterprise; ep != nil && ep.Limits != nil {
			before := resolved
			resolved = ep.Limits.AgentStateMetadata.ApplyCeiling(resolved)
			if before != resolved {
				utils.LogWithFields(utils.LevelInfo, "session", "agent_metadata_limits: narrowed by enterprise ceiling", map[string]any{
					"value_bytes": resolved.MaxValueBytes, "entry_bytes": resolved.MaxEntryBytes,
					"snapshot_bytes": resolved.MaxSnapshotBytes,
				})
			}
		}
	}

	utils.LogWithFields(utils.LevelDebug, "session", "agent_metadata_limits resolved", map[string]any{
		"value_bytes": resolved.MaxValueBytes, "entry_bytes": resolved.MaxEntryBytes,
		"snapshot_bytes": resolved.MaxSnapshotBytes, "max_depth": resolved.MaxDepth,
	})

	return agents.MetadataLimits{
		MaxValueBytes:    resolved.MaxValueBytes,
		MaxEntryBytes:    resolved.MaxEntryBytes,
		MaxSnapshotBytes: resolved.MaxSnapshotBytes,
		MaxDepth:         resolved.MaxDepth,
	}
}

// newAgentRegistry builds a session's agent registry with the resolved bounds.
func (m *Manager) newAgentRegistry() *agents.Registry {
	return agents.NewRegistryWithLimits(m.agentMetadataLimits())
}
