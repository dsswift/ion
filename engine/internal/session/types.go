package session

import (
	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/recorder"
	"github.com/dsswift/ion/engine/internal/session/agents"
	"github.com/dsswift/ion/engine/internal/session/pending"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/watcher"
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

	// fsWatcher is the recursive workspace_file_changed watcher rooted at
	// config.WorkingDirectory. Started in StartSession after extensions are
	// loaded; stopped in stopSession before the extension group is closed.
	// nil when no extensions are loaded, when WorkingDirectory is empty, or
	// when the watcher failed to start (a watcher failure is logged but does
	// not abort session startup).
	fsWatcher *watcher.Watcher

	// Last-known context usage state, carried forward across status
	// emissions so the footer always reflects the most recent data.
	lastContextPct    int
	lastContextWindow int
	lastModel         string
	lastTotalCost     float64

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
}


