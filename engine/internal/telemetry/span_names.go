package telemetry

// Span event names. Every operation the engine times is a telemetry span
// event (span_handle.go): a Collector.Event whose payload carries span_id and
// duration_ms. This block, with LlmCall, ToolExecute, Compaction, RunExecute,
// DispatchAgent, and ExtensionHookLatency in telemetry.go, is the by-name
// list docs/observability/log-schema.md § "Span record shapes" cites.
//
// Kinds (payload span_kind, otel_resource.go): the receiving side of a hop
// between processes is SpanKindServer (RunExecute, CommandDispatch), the
// calling side is SpanKindClient (LlmCall, LlmAttempt, McpCall, McpStart,
// ExtensionSpawn, ExtensionHookLatency), everything else is internal.
const (
	// LlmAttempt is one request to the provider under an LlmCall: one per
	// retry or fallback hop. Attributes attempt, model, provider, ttft_ms,
	// outcome.
	LlmAttempt = "llm.attempt"
	// ContextAssemble is the per-turn build of the model context: message
	// sanitizing, ephemeral initial messages, and the stream options.
	ContextAssemble = "context.assemble"
	// ConversationLoad and ConversationPersist time a conversation's read
	// from, and write to, disk.
	ConversationLoad    = "conversation.load"
	ConversationPersist = "conversation.persist"
	// CommandDispatch is one client command, socket accept to reply.
	// Attribute command. It parents the RunExecute of a command that starts
	// a run.
	CommandDispatch = "command.dispatch"
	// SessionStart is a session's creation or reattach, with
	// ConversationLoad, ExtensionSpawn, and McpStart under it.
	SessionStart = "session.start"
	// DaemonStartup is the engine process, start to the socket accepting
	// clients: a trace root with ConfigLoad and ProviderProbe under it.
	DaemonStartup = "daemon.startup"
	ConfigLoad    = "config.load"
	// ProviderProbe is one reachability or discovery pass over providers:
	// attribute probe is "cli" (the delegated-CLI probes) or "models"
	// (HTTP model discovery).
	ProviderProbe = "provider.probe"
	// ExtensionSpawn is one extension subprocess launch through its init
	// handshake. The ExtensionColdstart scalar keeps reporting the same
	// readiness latency as ready_ms for the dashboards that read it.
	ExtensionSpawn = "extension.spawn"
	// McpStart is one MCP server connection through its handshake; McpCall
	// is one tool call to a connected server.
	McpStart = "mcp.start"
	McpCall  = "mcp.call"
	// HookFanout is one hook point fired across every extension host; each
	// host's ExtensionHookLatency is its child.
	HookFanout = "hook.fanout"
	// PermissionDecide is one permission check, classifier through the
	// engine's decision. The PermissionDecision scalar stays beside it.
	PermissionDecide = "permission.decide"
)
