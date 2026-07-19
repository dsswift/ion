package extcontext

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/resource"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// dispatchContextTestAccessor is a minimal SessionAccessor for exercising
// injectDispatchContext in isolation. It exposes the two dispatch-context
// levers: the engine.json DispatchContext (via engineConfig) and the session
// default (via sessionDefault), plus the session ClaudeCompat flag.
type dispatchContextTestAccessor struct {
	noopPluginMethods
	engineConfig   *types.EngineRuntimeConfig
	sessionDefault *extension.ContextPolicy
	claudeCompat   bool
}

func (a *dispatchContextTestAccessor) SessionKey() string        { return "ctx-test" }
func (a *dispatchContextTestAccessor) ExtensionName() string    { return "" }
func (a *dispatchContextTestAccessor) ExtensionVersion() string { return "" }
func (a *dispatchContextTestAccessor) ConversationID() string    { return "conv-ctx" }
func (a *dispatchContextTestAccessor) WorkingDirectory() string  { return "/tmp" }
func (a *dispatchContextTestAccessor) Emit(ev types.EngineEvent) {}
func (a *dispatchContextTestAccessor) SendAbort()                {}
func (a *dispatchContextTestAccessor) RootContext() context.Context {
	return context.Background()
}
func (a *dispatchContextTestAccessor) SendPrompt(text, model string, bash []string) error {
	return nil
}
func (a *dispatchContextTestAccessor) SendPromptWithKind(_, _ string, _ []string, _ string) error {
	return nil
}
func (a *dispatchContextTestAccessor) SteerSelfMainLoop(message string) bool { return false }
func (a *dispatchContextTestAccessor) Elicit(info extension.ElicitationRequestInfo) (map[string]interface{}, bool, error) {
	return nil, false, nil
}
func (a *dispatchContextTestAccessor) SuppressTool(name string)                            {}
func (a *dispatchContextTestAccessor) CacheExtAgentStates(agents []types.AgentStateUpdate) {}
func (a *dispatchContextTestAccessor) RegisterAgent(name string, handle types.AgentHandle) {}
func (a *dispatchContextTestAccessor) DeregisterAgent(name string)                         {}
func (a *dispatchContextTestAccessor) RegisterAgentSpec(spec types.AgentSpec)              {}
func (a *dispatchContextTestAccessor) DeregisterAgentSpec(name string)                     {}
func (a *dispatchContextTestAccessor) LookupAgentSpec(name string) (types.AgentSpec, bool) {
	return types.AgentSpec{}, false
}
func (a *dispatchContextTestAccessor) LookupExtDisplayName(name string) string  { return "" }
func (a *dispatchContextTestAccessor) ExtGroup() *extension.ExtensionGroup      { return nil }
func (a *dispatchContextTestAccessor) ExtConfig() *extension.ExtensionConfig    { return nil }
func (a *dispatchContextTestAccessor) ProcRegistry() *extension.ProcessRegistry { return nil }
func (a *dispatchContextTestAccessor) NewChildBackend() backend.RunBackend      { return nil }
func (a *dispatchContextTestAccessor) AllocatePlanFilePath(_ string) string             { return "/tmp/.ion/plans/plan.md" }
func (a *dispatchContextTestAccessor) BumpParentProgress()                      {}
func (a *dispatchContextTestAccessor) EmitDispatchCountStatus(_ string)         {}
func (a *dispatchContextTestAccessor) EngineConfig() *types.EngineRuntimeConfig {
	return a.engineConfig
}
func (a *dispatchContextTestAccessor) ClaudeCompat() bool { return a.claudeCompat }
func (a *dispatchContextTestAccessor) GetDispatchContextDefaults() *extension.ContextPolicy {
	return a.sessionDefault
}
func (a *dispatchContextTestAccessor) ResolveTier(name string) string { return name }
func (a *dispatchContextTestAccessor) PermissionCheck(toolName string, input map[string]interface{}) (string, string) {
	return "", ""
}
func (a *dispatchContextTestAccessor) McpConnections() []*mcp.Connection { return nil }
func (a *dispatchContextTestAccessor) SearchHistory(query string, maxResults int) []extension.HistoryMatch {
	return nil
}
func (a *dispatchContextTestAccessor) GetSessionMemory() string        { return "" }
func (a *dispatchContextTestAccessor) SetSessionMemory(content string) {}
func (a *dispatchContextTestAccessor) TranslateEvent(ev types.NormalizedEvent, contextWindow int) types.EngineEvent {
	return types.EngineEvent{}
}
func (a *dispatchContextTestAccessor) SetPlanMode(enabled bool, source string) {}
func (a *dispatchContextTestAccessor) GetPlanModeState() (bool, string)        { return false, "" }
func (a *dispatchContextTestAccessor) AppendOrUpdateAgentState(state types.AgentStateUpdate) string {
	return state.ID
}
func (a *dispatchContextTestAccessor) UpdateAgentStateByID(id string, updater func(*types.AgentStateUpdate)) {
}
func (a *dispatchContextTestAccessor) UpsertAgentStateByID(id string, seed types.AgentStateUpdate, updater func(*types.AgentStateUpdate)) {
}
func (a *dispatchContextTestAccessor) EmitAgentSnapshot(reason string)                 {}
func (a *dispatchContextTestAccessor) ResourceBroker() *resource.Broker                { return nil }
func (a *dispatchContextTestAccessor) GlobalResourceBroker() *resource.Broker          { return nil }
func (a *dispatchContextTestAccessor) BroadcastNotification(opts types.NotifyOpts)     {}
func (a *dispatchContextTestAccessor) BroadcastIntercept(opts extension.InterceptOpts) {}
func (a *dispatchContextTestAccessor) ListAllSessions() []extension.SessionListEntry   { return nil }
func (a *dispatchContextTestAccessor) SendToSession(senderKey, targetKey, kind string, payload map[string]interface{}) error {
	return nil
}

func (a *dispatchContextTestAccessor) FireSchedule(_, _ string) error { return nil }
func (a *dispatchContextTestAccessor) GetScheduleStatus(_, _ string) ([]extension.ScheduleStatusEntry, error) {
	return nil, nil
}
func (a *dispatchContextTestAccessor) RunOnceCheck(operationID string, debounceMs int64) (bool, string) {
	return false, ""
}
func (a *dispatchContextTestAccessor) RunOnceComplete(operationID string, failed bool) {}
func (a *dispatchContextTestAccessor) Telemetry() *telemetry.Collector { return nil }

// writeAgents writes an AGENTS.md with the given body into dir and returns its path.
func writeAgents(t *testing.T, dir, body string) string {
	t.Helper()
	p := filepath.Join(dir, "AGENTS.md")
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// TestInjectDispatchContextGroundsChild is the pinning regression test for the
// reported bug: a dispatch with NO policy anywhere must receive its project
// AGENTS.md grounding, prepended AHEAD of the agent persona. On the unfixed
// code (no injection at all) the child received persona-only; this asserts the
// grounding is present and ordered first.
func TestInjectDispatchContextGroundsChild(t *testing.T) {
	dir := t.TempDir()
	agentsPath := writeAgents(t, dir, "UNIVERSAL GROUNDING")

	opts := &extension.DispatchAgentOpts{
		Name:         "child",
		Task:         "do work",
		SystemPrompt: "PERSONA DEFINITION",
	}
	sa := &dispatchContextTestAccessor{}

	injectDispatchContext("child", dir, opts, sa)

	if !strings.Contains(opts.SystemPrompt, "# Context from "+agentsPath) {
		t.Fatalf("expected grounding referencing %q, got:\n%s", agentsPath, opts.SystemPrompt)
	}
	if !strings.Contains(opts.SystemPrompt, "UNIVERSAL GROUNDING") {
		t.Fatalf("expected grounding content, got:\n%s", opts.SystemPrompt)
	}
	// Grounding must precede the persona.
	gi := strings.Index(opts.SystemPrompt, "UNIVERSAL GROUNDING")
	pi := strings.Index(opts.SystemPrompt, "PERSONA DEFINITION")
	if gi < 0 || pi < 0 || gi > pi {
		t.Fatalf("grounding must precede persona; grounding@%d persona@%d prompt:\n%s", gi, pi, opts.SystemPrompt)
	}
}

// TestInjectDispatchContextPerDispatchProjectOff verifies a per-dispatch policy
// disabling the project layer suppresses the project AGENTS.md walk.
func TestInjectDispatchContextPerDispatchProjectOff(t *testing.T) {
	dir := t.TempDir()
	writeAgents(t, dir, "PROJECT ONLY")

	off := false
	opts := &extension.DispatchAgentOpts{
		Name:         "child",
		SystemPrompt: "PERSONA",
		ContextPolicy: &extension.ContextPolicy{
			IncludeGlobalContext:  &off,
			IncludeProjectContext: &off,
		},
	}
	sa := &dispatchContextTestAccessor{}

	injectDispatchContext("child", dir, opts, sa)

	if strings.Contains(opts.SystemPrompt, "PROJECT ONLY") {
		t.Fatalf("both layers off should suppress injection, got:\n%s", opts.SystemPrompt)
	}
	if opts.SystemPrompt != "PERSONA" {
		t.Fatalf("persona should be untouched, got:\n%s", opts.SystemPrompt)
	}
}

// TestInjectDispatchContextEngineConfigGlobalOff verifies the engine.json
// dispatchContext (level 2) applies when no session/per-dispatch policy is set.
// With IncludeProjectContext=false via engine config, the project AGENTS.md is
// not injected.
func TestInjectDispatchContextEngineConfigGlobalOff(t *testing.T) {
	dir := t.TempDir()
	writeAgents(t, dir, "PROJECT VIA ENGINE")

	off := false
	sa := &dispatchContextTestAccessor{
		engineConfig: &types.EngineRuntimeConfig{
			DispatchContext: &types.DispatchContextConfig{
				IncludeGlobalContext:  &off,
				IncludeProjectContext: &off,
			},
		},
	}
	opts := &extension.DispatchAgentOpts{Name: "child", SystemPrompt: "PERSONA"}

	injectDispatchContext("child", dir, opts, sa)

	if strings.Contains(opts.SystemPrompt, "PROJECT VIA ENGINE") {
		t.Fatalf("engine.json both-off should suppress project injection, got:\n%s", opts.SystemPrompt)
	}
}

// TestInjectDispatchContextEmptyProjectPath verifies an empty projectPath is a
// no-op (no panic, persona untouched).
func TestInjectDispatchContextEmptyProjectPath(t *testing.T) {
	opts := &extension.DispatchAgentOpts{Name: "child", SystemPrompt: "PERSONA"}
	sa := &dispatchContextTestAccessor{}
	injectDispatchContext("child", "", opts, sa)
	if opts.SystemPrompt != "PERSONA" {
		t.Fatalf("empty projectPath should be a no-op, got:\n%s", opts.SystemPrompt)
	}
}
