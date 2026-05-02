package session

import (
	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/recorder"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// pendingPrompt holds a queued prompt waiting for the active run to finish.
type pendingPrompt struct {
	text         string
	model        string
	maxTurns     int
	maxBudgetUsd float64
	extensions   []string
	noExtensions bool
}

// engineSession holds the state for a single session managed by the Manager.
type engineSession struct {
	key           string
	config        types.EngineConfig
	requestID     string // empty when no active run
	conversationID string
	agentRegistry      map[string]types.AgentHandle
	agentSpecs         map[string]types.AgentSpec
	agentStates        []types.AgentStateUpdate
	lastExtAgentStates []types.AgentStateUpdate
	extensionName      string // friendly name broadcast by the extension
	suppressedTools    []string
	childPIDs     map[int]struct{}
	planMode           bool
	planModeTools      []string
	planFilePath       string
	planModePromptSent bool
	promptQueue   []pendingPrompt
	maxQueueDepth int // default 32

	// Wired subsystems (populated in StartSession)
	extGroup       *extension.ExtensionGroup
	mcpConns       []*mcp.Connection
	permEngine     *permissions.Engine
	telemetry      *telemetry.Collector
	recorder       *recorder.Recorder
	toolServer     *backend.ToolServer
	procRegistry   *extension.ProcessRegistry
	pendingDialogs     map[string]chan interface{}
	pendingPermissions map[string]chan string
	pendingElicit      map[string]chan elicitReply

	// Last-known context usage state, carried forward across status
	// emissions so the footer always reflects the most recent data.
	lastContextPct    int
	lastContextWindow int
	lastModel         string
	lastTotalCost     float64

	// CLI backend turn tracking (populated by handleNormalizedEvent)
	cliTurnNumber  int  // current turn number for CLI runs
	cliTurnActive  bool // true between turn_start and turn_end
}

// elicitReply carries a client's response to an engine_elicitation_request event.
type elicitReply struct {
	response  map[string]interface{}
	cancelled bool
}
