// methods.go — the SDK's declared ext/* method registry.
//
// The engine declares the methods it answers (host_rpc_registry.go). This is
// the mirror: the methods this SDK actually issues, each named alongside the
// Go function that issues it.
//
// It exists so parity runs both ways. Without it the SDK could quietly omit a
// capability the engine offers and no test would notice — the same drift the
// engine-side registry prevents, pointed at the client. TestExtMethodsAreClaimed
// compares this map against the engine's manifest in both directions.
//
// The map is hand-maintained by necessity: Go cannot enumerate "every string
// literal passed to sdk.call" without a source analysis pass, and a pass like
// that would be more fragile than the list. The parity test is what keeps the
// list honest — adding a method to the SDK without listing it here, or listing
// one the SDK does not implement, both fail.
package ion

// sdkClaimedMethods maps each ext/* method this SDK issues to the exported Go
// symbol that issues it. The value is documentation for the failure message;
// only the keys are compared.
func sdkClaimedMethods() map[string]string {
	return map[string]string{
		// Process registry.
		"ext/register_process":      "Context.RegisterProcess",
		"ext/deregister_process":    "Context.DeregisterProcess",
		"ext/list_processes":        "Context.ListProcesses",
		"ext/terminate_process":     "Context.TerminateProcess",
		"ext/clean_stale_processes": "Context.CleanStaleProcesses",

		// Agents.
		"ext/discover_agents":               "Context.DiscoverAgents",
		"ext/register_agent_spec":           "Context.RegisterAgentSpec",
		"ext/deregister_agent_spec":         "Context.DeregisterAgentSpec",
		"ext/dispatch_agent":                "Context.DispatchAgent",
		"ext/recall_agent":                  "Context.RecallAgent",
		"ext/recall_dispatch":               "Context.RecallDispatch",
		"ext/steer_dispatch":                "Context.SteerDispatch",
		"ext/steer_dispatch_by_name":        "Context.SteerDispatchByName",
		"ext/steer_self":                    "Context.SteerSelf",
		"ext/answer_dispatch_question":      "Context.AnswerDispatchQuestion",
		"ext/ack_dispatch_lost":             "Context.AckDispatchLost",
		"ext/list_dispatch_state":           "Context.ListDispatchState",
		"ext/set_dispatch_context_defaults": "Context.SetDispatchContextDefaults",

		// Dynamic tools.
		"ext/tool_registry_snapshot": "SDK.SyncTools",

		// Session surface.
		"ext/send_prompt":        "Context.SendPrompt",
		"ext/call_tool":          "Context.CallTool",
		"ext/suppress_tool":      "Context.SuppressTool",
		"ext/elicit":             "Context.Elicit",
		"ext/task_suspend":       "Context.Suspend / Context.SuspendUntilAll",
		"ext/get_context_usage":  "Context.GetContextUsage",
		"ext/search_history":     "Context.SearchHistory",
		"ext/get_session_memory": "Context.GetSessionMemory",
		"ext/set_session_memory": "Context.SetSessionMemory",
		"ext/set_run_recovery":   "Context.SetRunRecovery",
		"ext/walk_context_files": "Context.WalkContextFiles",
		"ext/list_sessions":      "SessionsAPI.List",
		"ext/send_to_session":    "SessionsAPI.Send",
		"ext/intercept":          "Context.Intercept",
		"ext/set_plan_mode":      "Context.EnterPlanMode / Context.ExitPlanMode",
		"ext/get_plan_mode":      "Context.GetPlanMode",

		// Async triggers.
		"ext/register_webhook":    "WebhooksAPI.Register",
		"ext/deregister_webhook":  "WebhookHandle.Unregister",
		"ext/register_schedule":   "ScheduleAPI.Daily / Weekly / Interval / Once",
		"ext/deregister_schedule": "ScheduleHandle.Unregister / ScheduleAPI.Cancel",
		"ext/fire_schedule":       "Context.FireSchedule",
		"ext/get_schedule_status": "Context.GetScheduleStatus",
		"ext/run_once_check":      "Context.RunOnce",
		"ext/run_once_complete":   "Context.RunOnce",

		// Resources and notifications.
		"ext/declare_resource": "ResourcesAPI.Declare",
		"ext/publish_resource": "ResourceHandle.Publish",
		"ext/notify":           "Context.Notify",

		// Inference and outbound HTTP.
		"ext/llm_call":     "Context.LLMCall",
		"ext/http_request": "HTTPAPI.Request",

		// Sandboxing.
		"ext/sandbox_wrap": "Context.SandboxWrap",

		// Notifications this SDK sends (no response).
		"ext/emit":            "Context.Emit (post-hook path)",
		"ext/send_message":    "Context.SendMessage",
		"log":                 "Logger.Debug / Info / Warn / Error",
		"ext/llm_call_cancel": "Context.LLMCall (on context cancellation)",
	}
}
