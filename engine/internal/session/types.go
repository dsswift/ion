package session

import (
	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/recorder"
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
type pendingPrompt struct {
	text         string
	model        string
	maxTurns     int
	maxBudgetUsd float64
	extensions   []string
	noExtensions bool
	attachments  []types.ImageAttachment
	// implementationPhase carries the client's
	// ClientCommand.ImplementationPhase flag through the queue so the
	// suppression of EnterPlanMode injection survives queueing on a busy
	// session. Without this, a queued "implement" prompt would lose the
	// flag and the engine would inject EnterPlanMode against the user's
	// already-approved intent.
	implementationPhase bool
}

// engineSession holds the state for a single session managed by the Manager.
type engineSession struct {
	key           string
	config        types.EngineConfig
	requestID     string // empty when no active run
	conversationID string
	agents         *agents.Registry
	extensionName  string // friendly name broadcast by the extension
	suppressedTools    []string
	childPIDs     map[int]struct{}
	planMode           bool
	planModeTools      []string
	planFilePath       string
	planModePromptSent bool
	hasExitedPlanMode  bool // set when ExitPlanMode fires; enables reentry detection
	promptQueue   []pendingPrompt
	maxQueueDepth int // default 32

	// Wired subsystems (populated in StartSession)
	extGroup     *extension.ExtensionGroup
	mcpConns     []*mcp.Connection
	permEngine   *permissions.Engine
	telemetry    *telemetry.Collector
	recorder     *recorder.Recorder
	toolServer   *backend.ToolServer
	procRegistry *extension.ProcessRegistry
	pending      *pending.Broker

	// fsWatcherRelease releases this session's share of the pooled workspace
	// watcher. The underlying watcher closes when the last session sharing
	// the same working directory releases. nil when no watcher is active.
	fsWatcherRelease func()

	// Last-known context usage state, carried forward across status
	// emissions so the footer always reflects the most recent data.
	lastContextPct    int
	lastContextWindow int
	lastModel         string
	lastTotalCost     float64

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
	cliTurnNumber  int  // current turn number for CLI runs
	cliTurnActive  bool // true between turn_start and turn_end

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
}


