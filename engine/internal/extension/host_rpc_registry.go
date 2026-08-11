// host_rpc_registry.go — the declared ext/* RPC method registry.
//
// The engine's context surface for extensions is not a Go interface: the
// engine-side Context is a struct of wired func fields, and what an extension
// can actually reach is the set of `ext/*` JSON-RPC methods this host answers.
// That set used to exist only as switch-case labels spread across six files,
// which made it impossible to enumerate mechanically — so no test could assert
// that a client SDK covers the surface, and a method added to the engine could
// silently go unimplemented in every SDK.
//
// These maps are that enumeration. handleExtRequest and handleExtNotification
// are lookups into them, so the registry cannot drift from the dispatch: a
// method that is not in the map is not answered, and a method in the map is
// answered by exactly the handler named beside it. The SDK contract manifest
// (sdk_contract_test.go) reads these keys, which is what lets the Go SDK's
// parity test fail when the engine grows a method the SDK does not implement.
package extension

// extRequestHandler answers an extension-initiated request. It is responsible
// for writing exactly one response for id, on this goroutine or a later one.
// ctx is the current hook context and may be nil (schedules, webhooks, and
// startup-time calls run outside any hook).
type extRequestHandler func(h *Host, ctx *Context, id int64, raw []byte)

// extNotificationHandler consumes an extension-initiated notification. There
// is no id and no response.
type extNotificationHandler func(h *Host, raw []byte)

// extRequestHandlers is the authoritative set of ext/* request methods.
// Anything absent yields JSON-RPC -32601, which client SDKs treat as a
// graceful-degradation signal rather than a fatal error.
var extRequestHandlers = map[string]extRequestHandler{
	// Process registry.
	"ext/register_process":      (*Host).rpcRegisterProcess,
	"ext/deregister_process":    (*Host).rpcDeregisterProcess,
	"ext/list_processes":        (*Host).rpcListProcesses,
	"ext/terminate_process":     (*Host).rpcTerminateProcess,
	"ext/clean_stale_processes": (*Host).rpcCleanStaleProcesses,

	// Agents: discovery, specs, dispatch, recall, steering.
	"ext/discover_agents":               (*Host).rpcDiscoverAgents,
	"ext/register_agent_spec":           (*Host).rpcRegisterAgentSpec,
	"ext/deregister_agent_spec":         (*Host).rpcDeregisterAgentSpec,
	"ext/dispatch_agent":                (*Host).rpcDispatchAgent,
	"ext/recall_agent":                  (*Host).rpcRecallAgent,
	"ext/steer_dispatch":                (*Host).rpcSteerDispatch,
	"ext/steer_dispatch_by_name":        (*Host).rpcSteerDispatchByName,
	"ext/steer_self":                    (*Host).rpcSteerSelf,
	"ext/answer_dispatch_question":      (*Host).rpcAnswerDispatchQuestion,
	"ext/list_dispatch_state":           (*Host).rpcListDispatchState,
	"ext/set_dispatch_context_defaults": (*Host).rpcSetDispatchContextDefaults,

	// Session surface.
	"ext/send_prompt":        (*Host).rpcSendPrompt,
	"ext/call_tool":          (*Host).rpcCallTool,
	"ext/suppress_tool":      (*Host).rpcSuppressTool,
	"ext/elicit":             (*Host).rpcElicit,
	"ext/task_suspend":       (*Host).rpcTaskSuspend,
	"ext/get_context_usage":  (*Host).rpcGetContextUsage,
	"ext/search_history":     (*Host).rpcSearchHistory,
	"ext/get_session_memory": (*Host).rpcGetSessionMemory,
	"ext/set_session_memory": (*Host).rpcSetSessionMemory,
	"ext/walk_context_files": (*Host).rpcWalkContextFiles,
	"ext/list_sessions":      (*Host).rpcListSessions,
	"ext/send_to_session":    (*Host).rpcSendToSession,
	"ext/intercept":          (*Host).rpcIntercept,
	"ext/set_plan_mode":      (*Host).rpcSetPlanMode,
	"ext/get_plan_mode":      (*Host).rpcGetPlanMode,

	// Async triggers: webhooks, schedules, run-once dedup.
	"ext/register_webhook":    (*Host).rpcRegisterWebhookReq,
	"ext/deregister_webhook":  (*Host).rpcDeregisterWebhookReq,
	"ext/register_schedule":   (*Host).rpcRegisterScheduleReq,
	"ext/deregister_schedule": (*Host).rpcDeregisterScheduleReq,
	"ext/fire_schedule":       (*Host).rpcFireSchedule,
	"ext/get_schedule_status": (*Host).rpcGetScheduleStatus,
	"ext/run_once_check":      (*Host).rpcRunOnceCheck,
	"ext/run_once_complete":   (*Host).rpcRunOnceComplete,

	// Resources and notifications.
	"ext/declare_resource": (*Host).rpcDeclareResource,
	"ext/publish_resource": (*Host).rpcPublishResource,
	"ext/notify":           (*Host).rpcNotify,

	// Inference and outbound HTTP.
	"ext/llm_call":     (*Host).rpcLlmCall,
	"ext/http_request": (*Host).rpcHTTPRequest,

	// Sandboxing.
	"ext/sandbox_wrap": (*Host).rpcSandboxWrap,
}

// extNotificationHandlers is the authoritative set of extension-initiated
// notification methods. An unknown method is logged and dropped — a
// notification has no id, so there is nothing to answer with.
var extNotificationHandlers = map[string]extNotificationHandler{
	"ext/emit":            (*Host).rpcEmit,
	"ext/send_message":    (*Host).rpcSendMessage,
	"log":                 (*Host).rpcLogNotification,
	"ext/llm_call_cancel": (*Host).rpcLlmCallCancel,
}

// ExtRequestMethods returns the ext/* request method names this host answers,
// for the SDK contract manifest. Order is unspecified; callers sort.
func ExtRequestMethods() []string {
	out := make([]string, 0, len(extRequestHandlers))
	for m := range extRequestHandlers {
		out = append(out, m)
	}
	return out
}

// ExtNotificationMethods returns the extension-initiated notification method
// names this host consumes, for the SDK contract manifest.
func ExtNotificationMethods() []string {
	out := make([]string, 0, len(extNotificationHandlers))
	for m := range extNotificationHandlers {
		out = append(out, m)
	}
	return out
}
