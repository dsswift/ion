package extcontext

import (
	"context"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/resource"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// noopPluginMethods provides zero-value implementations of the two plugin
// accessor methods added to SessionAccessor. Embed this in test accessor
// structs to satisfy the interface without duplicating stub code.
type noopPluginMethods struct{}

func (noopPluginMethods) PluginSessionMessages() []types.LlmMessage    { return nil }
func (noopPluginMethods) PluginTurnMessages(_ string) []types.LlmMessage { return nil }

// noopSA is a minimal SessionAccessor used in tests that only care about
// RunOptions fields unrelated to plugins. It satisfies the interface by
// embedding noopPluginMethods and panicking on any other method call,
// making unexpected calls visible immediately.
type noopSA struct{ noopPluginMethods }

func (noopSA) SessionKey() string                                                          { return "" }
func (noopSA) ConversationID() string                                                      { return "" }
func (noopSA) ExtensionName() string                                                       { return "" }
func (noopSA) ExtensionVersion() string                                                    { return "" }
func (noopSA) WorkingDirectory() string                                                    { return "" }
func (noopSA) Emit(_ types.EngineEvent)                                                    {}
func (noopSA) SendAbort()                                                                  {}
func (noopSA) RootContext() context.Context                                                { return context.Background() }
func (noopSA) SendPrompt(_ string, _ string, _ []string) error                             { return nil }
func (noopSA) SteerSelfMainLoop(_ string) bool                                             { return false }
func (noopSA) Elicit(_ extension.ElicitationRequestInfo) (map[string]interface{}, bool, error) {
	return nil, false, nil
}
func (noopSA) SuppressTool(_ string)                                              {}
func (noopSA) CacheExtAgentStates(_ []types.AgentStateUpdate)                     {}
func (noopSA) RegisterAgent(_ string, _ types.AgentHandle)                        {}
func (noopSA) DeregisterAgent(_ string)                                           {}
func (noopSA) RegisterAgentSpec(_ types.AgentSpec)                                {}
func (noopSA) DeregisterAgentSpec(_ string)                                       {}
func (noopSA) LookupAgentSpec(_ string) (types.AgentSpec, bool)                   { return types.AgentSpec{}, false }
func (noopSA) LookupExtDisplayName(_ string) string                               { return "" }
func (noopSA) ExtGroup() *extension.ExtensionGroup                                { return nil }
func (noopSA) ExtConfig() *extension.ExtensionConfig                              { return nil }
func (noopSA) ProcRegistry() *extension.ProcessRegistry                           { return nil }
func (noopSA) NewChildBackend() backend.RunBackend                                { return nil }
func (noopSA) BumpParentProgress()                                                {}
func (noopSA) EmitDispatchCountStatus(_ string)                                   {}
func (noopSA) EngineConfig() *types.EngineRuntimeConfig                           { return nil }
func (noopSA) ClaudeCompat() bool                                                 { return false }
func (noopSA) GetDispatchContextDefaults() *extension.ContextPolicy               { return nil }
func (noopSA) ResolveTier(_ string) string                                        { return "" }
func (noopSA) PermissionCheck(_ string, _ map[string]interface{}) (string, string) { return "", "" }
func (noopSA) McpConnections() []*mcp.Connection                                  { return nil }
func (noopSA) SearchHistory(_ string, _ int) []extension.HistoryMatch             { return nil }
func (noopSA) GetSessionMemory() string                                           { return "" }
func (noopSA) SetSessionMemory(_ string)                                          {}
func (noopSA) TranslateEvent(_ types.NormalizedEvent, _ int) types.EngineEvent   { return types.EngineEvent{} }
func (noopSA) SetPlanMode(_ bool, _ string)                                       {}
func (noopSA) GetPlanModeState() (bool, string)                                   { return false, "" }
func (noopSA) AllocatePlanFilePath() string                                       { return "" }
func (noopSA) AppendOrUpdateAgentState(_ types.AgentStateUpdate) string           { return "" }
func (noopSA) UpdateAgentStateByID(_ string, _ func(*types.AgentStateUpdate))     {}
func (noopSA) EmitAgentSnapshot(_ string)                                         {}
func (noopSA) ResourceBroker() *resource.Broker                                   { return nil }
func (noopSA) GlobalResourceBroker() *resource.Broker                             { return nil }
func (noopSA) BroadcastNotification(_ types.NotifyOpts)                           {}
func (noopSA) BroadcastIntercept(_ extension.InterceptOpts)                       {}
func (noopSA) ListAllSessions() []extension.SessionListEntry                      { return nil }
func (noopSA) SendToSession(_, _, _ string, _ map[string]interface{}) error       { return nil }
func (noopSA) FireSchedule(_, _ string) error                                    { return nil }
func (noopSA) GetScheduleStatus(_, _ string) ([]extension.ScheduleStatusEntry, error) {
	return nil, nil
}
func (noopSA) RunOnceCheck(_ string, _ int64) (bool, string)                      { return true, "" }
func (noopSA) RunOnceComplete(_ string, _ bool)                                   {}
func (noopSA) Telemetry() *telemetry.Collector                                    { return nil }
