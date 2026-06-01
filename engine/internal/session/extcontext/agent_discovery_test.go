package extcontext

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/types"
)

// agentDiscoveryTestAccessor is a minimal SessionAccessor that exposes a
// test-supplied extension group. Only the surface that
// BuildDiscoverAgentsFunc actually exercises is wired; the rest of the
// methods are zero-value stubs.
type agentDiscoveryTestAccessor struct {
	extGroup *extension.ExtensionGroup
}

func (a *agentDiscoveryTestAccessor) SessionKey() string       { return "test-session" }
func (a *agentDiscoveryTestAccessor) WorkingDirectory() string { return "/tmp" }
func (a *agentDiscoveryTestAccessor) Emit(ev types.EngineEvent) {}
func (a *agentDiscoveryTestAccessor) SendAbort()               {}
func (a *agentDiscoveryTestAccessor) SendPrompt(_, _ string) error { return nil }
func (a *agentDiscoveryTestAccessor) Elicit(_ extension.ElicitationRequestInfo) (map[string]interface{}, bool, error) {
	return nil, false, nil
}
func (a *agentDiscoveryTestAccessor) SuppressTool(_ string)                            {}
func (a *agentDiscoveryTestAccessor) CacheExtAgentStates(_ []types.AgentStateUpdate)   {}
func (a *agentDiscoveryTestAccessor) RegisterAgent(_ string, _ types.AgentHandle)      {}
func (a *agentDiscoveryTestAccessor) DeregisterAgent(_ string)                         {}
func (a *agentDiscoveryTestAccessor) RegisterAgentSpec(_ types.AgentSpec)              {}
func (a *agentDiscoveryTestAccessor) DeregisterAgentSpec(_ string)                     {}
func (a *agentDiscoveryTestAccessor) LookupAgentSpec(_ string) (types.AgentSpec, bool) { return types.AgentSpec{}, false }
func (a *agentDiscoveryTestAccessor) ExtGroup() *extension.ExtensionGroup              { return a.extGroup }
func (a *agentDiscoveryTestAccessor) ExtConfig() *extension.ExtensionConfig            { return nil }
func (a *agentDiscoveryTestAccessor) ProcRegistry() *extension.ProcessRegistry         { return nil }
func (a *agentDiscoveryTestAccessor) NewChildBackend() backend.RunBackend              { return nil }
func (a *agentDiscoveryTestAccessor) EngineConfig() *types.EngineRuntimeConfig         { return nil }
func (a *agentDiscoveryTestAccessor) ResolveTier(_ string) string                      { return "" }
func (a *agentDiscoveryTestAccessor) PermissionCheck(_ string, _ map[string]interface{}) (string, string) {
	return "", ""
}
func (a *agentDiscoveryTestAccessor) McpConnections() []*mcp.Connection             { return nil }
func (a *agentDiscoveryTestAccessor) SearchHistory(_ string, _ int) []extension.HistoryMatch { return nil }
func (a *agentDiscoveryTestAccessor) GetSessionMemory() string                              { return "" }
func (a *agentDiscoveryTestAccessor) SetSessionMemory(_ string)                             {}
func (a *agentDiscoveryTestAccessor) TranslateEvent(_ types.NormalizedEvent, _ int) types.EngineEvent {
	return types.EngineEvent{}
}
func (a *agentDiscoveryTestAccessor) SetPlanMode(_ bool, _ string)     {}
func (a *agentDiscoveryTestAccessor) GetPlanModeState() (bool, string) { return false, "" }
func (a *agentDiscoveryTestAccessor) AppendOrUpdateAgentState(_ types.AgentStateUpdate) string { return "" }
func (a *agentDiscoveryTestAccessor) UpdateAgentStateByID(_ string, _ func(*types.AgentStateUpdate))  {}
func (a *agentDiscoveryTestAccessor) EmitAgentSnapshot(_ string) {}

// writeAgentFile creates a minimal .md agent file in dir/agents/<name>.md
// with valid frontmatter.
func writeAgentFile(t *testing.T, dir, name, description string) {
	t.Helper()
	agentsDir := filepath.Join(dir, "agents")
	if err := os.MkdirAll(agentsDir, 0o755); err != nil {
		t.Fatalf("MkdirAll %s: %v", agentsDir, err)
	}
	content := "---\nname: " + name + "\ndescription: " + description + "\n---\nYou are a test agent."
	path := filepath.Join(agentsDir, name+".md")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile %s: %v", path, err)
	}
}

func TestDiscoverAgents_ExtensionSource_SingleHost(t *testing.T) {
	tmpDir := t.TempDir()
	writeAgentFile(t, tmpDir, "test-agent", "A test agent")

	host := extension.NewHost()
	host.SetExtensionDir(tmpDir)

	group := extension.NewExtensionGroup()
	group.Add(host)

	sa := &agentDiscoveryTestAccessor{extGroup: group}
	discover := BuildDiscoverAgentsFunc(sa)

	result, err := discover(extension.DiscoverAgentsOpts{
		Sources: []string{"extension"},
	})
	if err != nil {
		t.Fatalf("DiscoverAgents returned error: %v", err)
	}
	if result == nil {
		t.Fatal("DiscoverAgents returned nil result without error")
	}
	if len(result.Agents) != 1 {
		t.Fatalf("expected 1 agent, got %d: %+v", len(result.Agents), result.Agents)
	}
	agent := result.Agents[0]
	if agent.Name != "test-agent" {
		t.Errorf("agent.Name = %q, want %q", agent.Name, "test-agent")
	}
	if agent.Source != "extension" {
		t.Errorf("agent.Source = %q, want %q", agent.Source, "extension")
	}
	if agent.Description != "A test agent" {
		t.Errorf("agent.Description = %q, want %q", agent.Description, "A test agent")
	}
}

func TestDiscoverAgents_ExtensionSource_MultipleHosts(t *testing.T) {
	tmpDir1 := t.TempDir()
	tmpDir2 := t.TempDir()
	writeAgentFile(t, tmpDir1, "agent-alpha", "Alpha agent")
	writeAgentFile(t, tmpDir2, "agent-beta", "Beta agent")

	host1 := extension.NewHost()
	host1.SetExtensionDir(tmpDir1)
	host2 := extension.NewHost()
	host2.SetExtensionDir(tmpDir2)

	group := extension.NewExtensionGroup()
	group.Add(host1)
	group.Add(host2)

	sa := &agentDiscoveryTestAccessor{extGroup: group}
	discover := BuildDiscoverAgentsFunc(sa)

	result, err := discover(extension.DiscoverAgentsOpts{
		Sources: []string{"extension"},
	})
	if err != nil {
		t.Fatalf("DiscoverAgents returned error: %v", err)
	}
	if result == nil {
		t.Fatal("DiscoverAgents returned nil result without error")
	}
	if len(result.Agents) != 2 {
		t.Fatalf("expected 2 agents, got %d: %+v", len(result.Agents), result.Agents)
	}

	found := make(map[string]extension.DiscoveredAgent)
	for _, a := range result.Agents {
		found[a.Name] = a
	}

	alpha, ok := found["agent-alpha"]
	if !ok {
		t.Fatal("agent-alpha not found in discovered agents")
	}
	if alpha.Source != "extension" {
		t.Errorf("agent-alpha.Source = %q, want %q", alpha.Source, "extension")
	}
	if alpha.Description != "Alpha agent" {
		t.Errorf("agent-alpha.Description = %q, want %q", alpha.Description, "Alpha agent")
	}

	beta, ok := found["agent-beta"]
	if !ok {
		t.Fatal("agent-beta not found in discovered agents")
	}
	if beta.Source != "extension" {
		t.Errorf("agent-beta.Source = %q, want %q", beta.Source, "extension")
	}
	if beta.Description != "Beta agent" {
		t.Errorf("agent-beta.Description = %q, want %q", beta.Description, "Beta agent")
	}
}
