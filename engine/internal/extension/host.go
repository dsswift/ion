package extension

import (
	"bufio"
	"io"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

const rpcCallTimeout = 30 * time.Second

// Host manages extension subprocess lifecycle. It supports both in-process
// extensions (Go functions registered directly on the SDK) and subprocess
// extensions communicating via JSON-RPC 2.0 over stdin/stdout.
type Host struct {
	mu      sync.Mutex
	sdk     *SDK
	process *os.Process
	stdin   io.WriteCloser
	stdout  *bufio.Scanner
	cmd     *exec.Cmd

	// JSON-RPC response routing
	nextID   atomic.Int64
	pending  map[int64]chan *jsonrpcResponse
	pendMu   sync.Mutex
	dead     atomic.Bool
	readerWg sync.WaitGroup

	// deadCh closes when the subprocess dies (readLoop EOF) or the host is
	// disposed. callers that lose the race between the dead.Load() check and
	// the pending-map insert would otherwise wait the full rpcCallTimeout —
	// callWithTimeout selects on deadCh as a third arm to fail fast.
	// deadOnce guards the close so respawn re-init and dispose-on-init-error
	// don't double-close. Both fields are replaced per spawn in spawnAndInit.
	deadCh   chan struct{}
	deadOnce *sync.Once

	// Temp files created by TS transpilation, cleaned up on Dispose.
	tempFiles []string

	// Extension name returned from init handshake.
	name string

	// Bidirectional RPC: context for extension-initiated notifications.
	currentCtx atomic.Pointer[Context]

	// notifMu guards the callbacks the readLoop reads when dispatching
	// extension-initiated notifications (ext/emit, ext/send_message). Kept
	// separate from h.mu so the readLoop never contends with Load: Load
	// holds h.mu for the entire init handshake, and notifications can
	// arrive mid-handshake before the init response.
	notifMu        sync.RWMutex
	onSendMessage  func(text string)
	persistentEmit func(types.EngineEvent)

	// Rate limit for parse-failure WARNs so a misbehaving extension that
	// floods stdout with non-JSON cannot bury other log signal. Holds a
	// nanosecond timestamp of the last logged parse error.
	lastParseErrAt atomic.Int64

	// Set the first time a hook is invoked after the subprocess has died.
	// Used to emit a single engine_error per death rather than one per
	// hook fire (turn_start/turn_end/permission_request/tool_call... all
	// fire many times per second and would flood the UI otherwise).
	deathReported atomic.Bool

	// Cached spawn parameters so Respawn can replay Load without the
	// session manager round-tripping the original extension path.
	loadedPath   string
	loadedConfig *ExtensionConfig

	// Strike budget for auto-respawn. respawnAttempts increments on each
	// respawn within the rolling window starting at respawnWindowStart.
	// Once the host has been alive past lastHealthyAt + 2 min, the next
	// death detection resets attempts to 0 (long-running extension that
	// crashes once is not permanently capped).
	respawnAttempts    atomic.Int64
	respawnWindowStart atomic.Int64 // unix nanos
	lastHealthyAt      atomic.Int64 // unix nanos when last successfully spawned
	respawnPermanent   atomic.Bool

	// onDeath is invoked from a goroutine after readLoop detects the
	// subprocess is dead. Set by the session manager so it can schedule
	// a respawn after the active run finishes.
	onDeath func(*Host)

	// turnInFlightAtDeath records whether a turn was active when the
	// subprocess died. The respawn flow fires turn_aborted on the new
	// instance only when this is true.
	turnInFlightAtDeath atomic.Bool

	// Last exit code/signal observed from the dying subprocess. Surfaced
	// in extension_respawned and engine_extension_died payloads.
	lastExitCode   atomic.Int64 // negative sentinel = "no code"
	lastExitSignal atomic.Pointer[string]
}


// SetPersistentEmit sets a persistent emit function that handles ext/emit
// notifications when no tool or hook context is active (e.g., background tasks).
func (h *Host) SetPersistentEmit(fn func(types.EngineEvent)) {
	h.notifMu.Lock()
	defer h.notifMu.Unlock()
	h.persistentEmit = fn
}

// NewHost creates a new extension host with an empty SDK.
func NewHost() *Host {
	h := &Host{
		sdk:     NewSDK(),
		pending: make(map[int64]chan *jsonrpcResponse),
	}
	// Start IDs at 1 (0 is reserved/unused).
	h.nextID.Store(1)
	// Sentinel value so LastExit can distinguish "no exit observed yet"
	// from a genuine zero exit code.
	h.lastExitCode.Store(-1)
	return h
}

// SDK returns the underlying hook registry for direct registration.
func (h *Host) SDK() *SDK {
	return h.sdk
}

// Name returns the extension's name as reported by the init handshake.
func (h *Host) Name() string {
	return h.name
}

// SetOnSendMessage sets the callback invoked when the extension sends an
// ext/send_message notification. The session manager uses this to queue
// follow-up prompts from extension-initiated messages.
func (h *Host) SetOnSendMessage(fn func(text string)) {
	h.notifMu.Lock()
	defer h.notifMu.Unlock()
	h.onSendMessage = fn
}

// Load starts a subprocess extension from the given file path. The path must
// point directly to an entry point file (.ts, .js, or binary). TypeScript
// Tools returns all registered tool definitions from the SDK.
func (h *Host) Tools() []ToolDefinition {
	return h.sdk.Tools()
}

// Commands returns all registered command definitions from the SDK.
func (h *Host) Commands() map[string]CommandDefinition {
	return h.sdk.Commands()
}
