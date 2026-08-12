package session

import (
	"context"
	"sync"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/recorder"
	"github.com/dsswift/ion/engine/internal/resource"
	"github.com/dsswift/ion/engine/internal/session/agents"
	"github.com/dsswift/ion/engine/internal/session/extcontext"
	"github.com/dsswift/ion/engine/internal/session/pending"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// toolMeta stores tool call metadata keyed by tool ID.
type toolMeta struct {
	name  string
	index int
}

// pendingPrompt holds a queued prompt waiting for the active run to finish.
// overrides is a value-copied snapshot of the caller's *PromptOverrides so
// all 19 fields survive the enqueue → dequeue round-trip intact. A nil
// overrides is stored as-is and forwarded as nil to SendPrompt.
type pendingPrompt struct {
	text      string
	overrides *PromptOverrides
}

// rootDispatchCompletion is one root-owned child result awaiting normal prompt
// acceptance. DeliveryID deduplicates retries in memory and identifies logs.
type rootDispatchCompletion struct {
	DeliveryID string
	Text       string
	DispatchID string
	Name       string
	ExitCode   int
}

// engineSession holds the state for a single session managed by the Manager.
type engineSession struct {
	key       string
	config    types.EngineConfig
	requestID string // empty when no active run

	// clampAdvisoryMu guards lastClampAdvisory. Its own lock rather than
	// m.mu: the advisory drain runs inside the emit path, which already takes
	// m.mu.RLock via m.emit, so reusing m.mu risks a lock-order inversion for
	// a concern that touches nothing else.
	clampAdvisoryMu sync.Mutex
	// lastClampAdvisory rate-limits engine_agent_state_clamped per
	// (agent, scope). A wedged payload clamps on every emission — 1,873 times
	// over 15 hours in the incident this guards against — so an unthrottled
	// advisory would flood the wire the clamp exists to protect.
	lastClampAdvisory map[string]clampAdvisoryRecord

	// agentEmitter gates engine_agent_state emissions (dedup + coalesce).
	// Carries its own mutex; see agent_emitter.go for why it does not share
	// m.mu.
	agentEmitter *agentEmitter

	// runIdentityMu serializes extension-context snapshots of requestID and
	// runTraceID with lifecycle writes. Manager-owned readers still use m.mu;
	// writers hold m.mu before this lock, preserving one lock order.
	runIdentityMu sync.RWMutex

	// dispatchingRunID marks the dispatch-in-flight window for a run. It is
	// set to the run's requestID inside SendPrompt, under m.mu, at the same
	// instant s.requestID is assigned, and cleared (run-scoped: only when it
	// still equals that requestID) by SendPrompt's deferred block on every
	// exit path — early aborts, panic unwind, and normal return after the
	// backend Start* call has registered the run.
	//
	// Why it exists. Between the requestID assignment and the backend
	// Start*/StartRunWithConfig call, the run genuinely exists — a prompt is
	// being dispatched — but backend.IsRunning(requestID) still answers
	// false because registration happens inside the backend call, hundreds
	// of milliseconds later (slash resolution, plan-file allocation,
	// capability gates, extension/MCP wiring all run in between). Without
	// this marker, currentSessionStatus's stale-requestID cross-check
	// misfires in that window: any concurrent status computation (heartbeat
	// tick, ReconcileState, QuerySessionStatus) sees "requestID set, backend
	// disclaims" and destructively clears s.requestID. The engine then
	// reports state=idle for the entire run — it never emits running again —
	// and consumers mark the live conversation done while it is actively
	// streaming (the done-group misplacement bug).
	//
	// currentSessionStatus treats dispatchingRunID == requestID as backend
	// ownership: report running, no clear. The original stale-detection is
	// untouched for started runs (marker cleared once Start* returns), so a
	// run that terminates abnormally without flowing through handleRunExit
	// is still recovered to idle.
	//
	// Run-scoped (a string, not a bool) because a fast run can exit and
	// dequeue the next prompt before the first SendPrompt returns; a bool's
	// deferred clear would strip the NEW dispatch's protection. The deferred
	// clear compares against its own requestID and abstains when a newer
	// dispatch owns the marker. Guarded by m.mu.
	dispatchingRunID string

	// rootCtx is the per-session cancellation root. Every cancellable
	// operation spawned on behalf of this session derives its own
	// context.Context from rootCtx — the backend run (via
	// RunOptions.ParentCtx), dispatched child agents, and ad-hoc
	// ctx.llmCall() invocations. Cancelling rootCancel therefore
	// cascades to all in-flight descendants for free (Go context tree),
	// which is what turns the engine's three historically-disconnected
	// abort mechanisms (backend Cancel-by-requestID, child-process kill
	// by PID, orphaned llmCall context) into one unified tree.
	//
	// Lifecycle:
	//   - Created in StartSession (newSessionRootContext), before any run
	//     or dispatch can be launched.
	//   - Cancelled by SendAbort (user abort) and StopSession (teardown).
	//     Both are idempotent: cancelling an already-cancelled context is
	//     a no-op, and rootCancel is nil-guarded for test-constructed
	//     sessions that never called newSessionRootContext.
	//   - OS-process kill (abortAllDescendants → killProcess) remains the
	//     leaf enforcement for child agents that run as separate processes;
	//     you cannot context-cancel another process. The root context is
	//     the in-process tree; process kill is its leaf.
	//
	// rootCtx is NOT a contract surface — it never crosses the wire and is
	// never serialized. It is purely the engine's internal cancellation
	// backbone.
	rootCtx    context.Context
	rootCancel context.CancelFunc

	conversationID string
	// bindingPending is true when this session's conversationID was freshly
	// pre-minted (no backing file existed at StartSession) and therefore its
	// key->conversationId binding has NOT yet been written to the sidecar. The
	// binding is deferred until the conversation is first saved to disk — a
	// session that starts but never completes a turn never leaves a "phantom"
	// binding that a later restart would try (and fail) to resume. Flushed in
	// handleRunExit once conversation.Exists confirms the file landed. For a
	// genuine resume (file already present at StartSession) this is false and
	// the binding is written immediately. (#230/#231 phantom-binding fix)
	bindingPending bool
	// nativeSessions maps a delegated-CLI backend kind ("claude-code",
	// "codex", "grok", "cursor") to the native-session cursor captured from
	// that backend's last run exit (the backend reports its native id via
	// emitExit → handleRunExit). A cursor is the ONLY value ever fed to a
	// native resume (`claude --resume` / ThreadResume / session/load, via
	// RunOptions.CliResumeSessionID), and only while its HeadEntryID still
	// equals the conversation's LeafID — see resolveCliContinuity in
	// native_session.go. Cursors are deliberately kept distinct from
	// conversationID: conversationID is Ion's durable conversation-file
	// identity (`{millis}-{12hex}`) and must never be overwritten with a
	// backend-native id — doing so would break compaction, export, /clear,
	// tree navigation, and the client-facing session id, all of which key on
	// the Ion id. Mirrored to conversation.NativeSessions (the .tree.jsonl
	// header) on capture and rehydrated from it in StartSession, so
	// continuity survives an engine restart. Guarded by m.mu.
	nativeSessions map[string]conversation.NativeSessionCursor
	// runCaps is the capability descriptor of the backend serving the
	// session's active run, recorded at dispatch (prompt_dispatch.go) after
	// the model is final. handleRunExit reads it to decide whether (and
	// under which kind) to capture the backend-reported session id as a
	// native-session cursor. Guarded by m.mu; overwritten on every dispatch.
	runCaps backend.BackendCapabilities
	// pendingCliUserTurn holds the current run's original user prompt (the
	// display text, before any transcript bridging mutated opts.Prompt) when
	// the run is served by a native-session (delegated-CLI) backend. Together
	// with pendingCliAssistantText it is persisted into Ion's conversation
	// store at run exit so the delegated-CLI turn lands in Ion's transcript —
	// the single source of truth. Without this, CLI turns are invisible to
	// Ion and a later cross-provider turn's transcript bridge misses them (the
	// continuity-loss bug). Empty for engine-owned backends, which persist
	// their own turns via the runloop. Guarded by m.mu.
	pendingCliUserTurn string
	// pendingCliAssistantText holds the current run's final assistant text
	// (TaskCompleteEvent.LastText, else Result), captured as the event flows
	// through handleNormalizedEvent, for the same CLI-turn persistence.
	// Guarded by m.mu.
	pendingCliAssistantText string
	// cliRunFailedTerminal marks the current delegated-CLI run as having
	// reported a terminal error (an ErrorEvent from the CLI's result stream —
	// e.g. its autocompactor thrashing until the process gives up). Set in
	// handleNormalizedEvent, consumed in handleRunExit: a terminally-failed
	// CLI run must NOT capture a fresh native-session cursor, and the
	// existing cursor for that kind is invalidated so the next prompt bridges
	// from Ion's transcript instead of `--resume`ing straight back into the
	// same saturated native session. Cleared at dispatch alongside
	// pendingCliUserTurn. Guarded by m.mu.
	cliRunFailedTerminal bool
	// runTraceID is the W3C trace-context trace-id for the CURRENTLY ACTIVE
	// run: 32 lowercase hex chars, minted in SendPrompt under the same m.mu
	// hold that assigns requestID, and cleared wherever requestID is cleared
	// so the two can never disagree. Empty when no run is in flight.
	//
	// Scope is deliberately the run, not the session. A trace is one logical
	// transaction; a session can span hours and hundreds of runs, so a
	// session-scoped trace ID produced a single unusable "trace" and could
	// not serve as an APM operation id. Consumers wanting the old
	// session-wide pivot use session_id, which is on every line already.
	// See docs/observability/log-schema.md § Correlation-ID vocabulary.
	//
	// This IS a wire-contract surface: it is published to extensions on the
	// hook context (Context.TraceID / ctx.traceId) so a consumer can parent
	// its own OTLP spans to the engine's trace, and it is stamped on every
	// log line and telemetry event emitted during the run.
	runTraceID                  string
	agents                      *agents.Registry
	extensionName               string // friendly name broadcast by the extension
	extensionVersion            string // version from extension.json manifest (empty when absent)
	suppressedTools             []string
	childPIDs                   map[int]struct{}
	planMode                    bool
	planModeTools               []string
	planModeAllowedBashCommands []string
	planModeAllowedMcpTools     []string
	planFilePath                string
	planModePromptSent          bool
	// lostDispatches queues the dispatches rehydrateDispatchState resolved as
	// lost (persisted status running/suspended with a fresh, empty registry —
	// they died with the previous engine process). announceLostDispatches
	// drains it in startSession once extensions are loaded, emitting one
	// engine_dispatch_lost + one dispatch_lost hook firing per orphan.
	lostDispatches []conversation.AgentDispatchData
	// compactInFlight is true while an async user-initiated /compact goroutine
	// is running for this session (dispatchCompact Path A). It serves two
	// guards, both read/written under m.mu:
	//   1. Double-run: a second /compact while one is in flight is rejected
	//      (compact_in_progress) rather than launching a concurrent CompactNow
	//      that would clobber the first's load-mutate-save cycle.
	//   2. Busy visibility: the async compaction does NOT set s.requestID (its
	//      synthetic user-compact-<convID> runID is deliberately unregistered
	//      in the backend's activeRuns), so SendPrompt's busy check must also
	//      consult this flag — otherwise a prompt submitted mid-compaction
	//      would start a real run that clobbers the compaction's save. See
	//      dispatchCompact and SendPrompt.
	compactInFlight   bool
	hasExitedPlanMode bool // set when ExitPlanMode fires; enables reentry detection
	promptQueue       []pendingPrompt
	maxQueueDepth     int // default 32
	// rootDispatchCompletions is the FIFO durable outbox for top-level child
	// terminal results. A delivery stays here until a classified prompt is
	// accepted by the normal session path; queue backpressure never drops it.
	rootDispatchCompletions []rootDispatchCompletion

	// Wired subsystems (populated in StartSession)
	extGroup       *extension.ExtensionGroup
	mcpConns       []*mcp.Connection
	permEngine     *permissions.Engine
	telemetry      *telemetry.Collector
	recorder       *recorder.Recorder
	toolServer     *backend.ToolServer
	procRegistry   *extension.ProcessRegistry
	pending        *pending.Broker
	resourceBroker *resource.Broker

	// mcpConnectOnce single-flights the lazy MCP connect for this session, and
	// mcpConnectDone records (under m.mu) that it has run.
	//
	// Connections are deliberately NOT established in StartSession: a desktop
	// rehydrating dozens of tabs calls StartSession once per tab, serially, and
	// each eager connect cost a full network round trip per configured server
	// (~1.7s each against a healthy server, measured 20 tabs × 32s at one
	// rehydration; up to 2×30s metadata timeouts per DEAD server) before the
	// session was usable. Nothing reads mcpConns before the first prompt
	// dispatch — the RunConfig is rebuilt from it per dispatch — so the connect
	// is deferred to ensureMcpConnections at that seam, where its cost lands
	// only on sessions that actually run a prompt.
	//
	// mcpConnectDone exists because a sync.Once cannot be queried:
	// ReconnectMcpServer must skip sessions that never connected (they will
	// pick the refreshed credential up at their own first dispatch), or a
	// post-login sweep would eagerly connect every idle tab and reintroduce
	// the rehydration stall this field exists to prevent.
	mcpConnectOnce sync.Once
	mcpConnectDone bool

	// fsWatcherRelease releases this session's share of the pooled workspace
	// watcher. The underlying watcher closes when the last session sharing
	// the same working directory releases. nil when no watcher is active.
	fsWatcherRelease func()

	// Last-known context usage state, carried forward across status
	// emissions so the footer always reflects the most recent data.
	//
	// lastContextTokens is the absolute occupancy (the numerator);
	// lastContextPct is that figure over lastContextWindow. All three are
	// refreshed together — at session start from the persisted conversation
	// (start_session.go), per turn from the UsageEvent occupancy signal
	// (event_translation.go), and at run exit by refreshContextUsage
	// (context_refresh.go). Cumulative run billing never writes them.
	lastContextPct    int
	lastContextTokens int
	lastContextWindow int
	// modelMu protects lastModel for extension-context construction, which may
	// run without Manager.mu and from paths already holding Manager.mu.
	modelMu       sync.RWMutex
	lastModel     string
	lastTotalCost float64 // run-scoped cost (alias: RunCostUsd)
	lastConvCost  float64 // conversation-scoped cost (alias: ConversationCostUsd)

	// lastPermissionDenials retains the PermissionDenials slice from the
	// most recent TaskCompleteEvent. The slice typically contains
	// AskUserQuestion / ExitPlanMode entries — intercepted tool calls
	// that the session reports as denied but unresolved until the next
	// prompt either supersedes them or answers them. The engine keeps
	// them on the session so ReconcileState can include them on the
	// engine_status snapshot it emits; without this retention, a
	// re-attaching consumer would observe an engine_status that
	// silently drops a field that was authoritative on the last
	// task_complete, while the session itself is still in the same
	// state.
	//
	// Lifecycle:
	//   - Populated in event_translation.go when a TaskCompleteEvent
	//     carries non-empty PermissionDenials.
	//   - Cleared in prompt_dispatch.go when a new prompt is dispatched
	//     (the new prompt supersedes the prior unresolved denial).
	//   - Re-emitted by manager.go ReconcileState as part of the
	//     engine_status snapshot.
	//
	// Engine contract: engine_status is a snapshot of the session's
	// current observable state. PermissionDenials was already part of
	// that contract on the task_complete-derived emission; this field
	// closes the gap so ReconcileState emits it too. Not a new field —
	// already declared on StatusFields, mirrored in TS / Swift.
	lastPermissionDenials []types.PermissionDenial

	// Agent spawner counter – monotonically increasing across runs so
	// agent names are globally unique within the session.
	agentCounter int

	// CLI backend turn tracking (populated by handleNormalizedEvent)
	cliTurnNumber int  // current turn number for CLI runs
	cliTurnActive bool // true between turn_start and turn_end

	// CLI backend message_update text accumulator. TextChunkEvent deltas are
	// appended here; on turn_end the accumulated content fires the
	// message_update extension hook, then the buffer is reset.
	cliTextBuf string

	// CLI backend tool input tracking for firing tool_call hook on Agent
	// dispatch. Maps tool ID → accumulated partial input JSON, and
	// tool ID → tool metadata (name, index) from the ToolCallEvent.
	// Index → tool ID reverse mapping for ToolCallCompleteEvent which
	// only carries an index.
	cliToolInputs  map[string]string
	cliToolMeta    map[string]toolMeta
	cliToolIndexID map[int]string
	// cliLastToolID is the ToolID from the most-recently-started tool call.
	// ToolCallUpdateEvent carries ToolID: "" (content_block_delta has no toolID),
	// so accumulation falls back to this field to key under the correct toolID.
	cliLastToolID string

	// dispatchRegistry tracks active background dispatches for this session.
	// Used by RecallAgent to cancel running background agents, and by the
	// dispatch completion callback to deregister finished dispatches.
	// Initialized in StartSession, nil-safe (code that creates ext contexts
	// passes it through variadic).
	dispatchRegistry *extcontext.DispatchRegistry

	// sessionMemory maintains a background summary of the conversation for
	// zero-cost compaction recovery. Created in StartSession, nil when the
	// feature is not enabled or the session has no conversation ID.
	sessionMemory *SessionMemory

	// pluginSessionMessages holds LlmMessage values (role=user, wrapped in
	// <system-reminder>) from each installed plugin's SessionStart hook output.
	// These are prepended to the provider message slice on every run turn via
	// opts.InitialMessages, giving the plugin instructions full conversational
	// attention weight — matching Claude Code's hook_additional_context injection.
	// Populated in loadAndWirePlugins (plugin_session.go) at session start.
	pluginSessionMessages []types.LlmMessage

	// pluginUserPromptHooks holds the hook commands from all installed plugins'
	// UserPromptSubmit hooks paired with their plugin root path. Fired on each
	// turn via hooks.OnInitialMessages; output is wrapped in <system-reminder>
	// and prepended to the provider message slice (not the system prompt).
	pluginUserPromptHooks []pluginUserPromptCmd

	// pendingSlashInvocation carries the raw command/args for a slash command
	// dispatched via the extension command registry (dispatchCommand). When an
	// extension command handler calls ctx.sendPrompt(expandedBody), the engine's
	// SendPrompt picks up this field so the run loop can persist the raw
	// invocation as the display turn (via AddUserMessageWithInvocation) and
	// attach slashCommand/slashArgs provenance. Consumed (cleared) on the next
	// SendPrompt so it applies exactly once.
	pendingSlashInvocation *conversation.SlashInvocation

	// outstandingBackgroundTasks tracks background bash commands started with
	// notify_on_complete that have not yet reported a terminal state. Keyed by
	// task ID. SESSION-scoped, not run-scoped, and that is the whole point: a
	// model may start commands across several turns and several runs before
	// the session finally parks for them, so this set must outlive any one
	// run. Guarded by Manager.mu like the rest of engineSession.
	//
	// See background_task_registry.go for the accessors and
	// background_task_wake.go for the park/wake cycle that consumes it.
	outstandingBackgroundTasks map[string]outstandingBackgroundTask

	// parked records that this session's run exited at a turn boundary
	// because outstandingBackgroundTasks was non-empty, and is waiting to be
	// woken by a completion. Nil when the session is not parked. Distinct from
	// "idle": a parked session has work in flight and will resume on its own.
	parked *parkedRun

	// pendingBackgroundCompletions holds completions that arrived under the
	// "queue" delivery mode (or while a wake could not start a run). They ride
	// along with the next run the session starts for any other reason.
	pendingBackgroundCompletions []backgroundCompletionPayload
}
