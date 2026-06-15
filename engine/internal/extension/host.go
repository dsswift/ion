package extension

import (
	"bufio"
	"context"
	"io"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// defaultRPCTimeout is the compiled default for extension RPC calls.
// Zero means no timeout — calls block until the subprocess responds or
// dies. The engine does not impose duration opinions on extension
// operations. Users may override via engine.json timeouts.extensionRpc.
const defaultRPCTimeout = 0

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

	// rpcTimeout is the per-call timeout for extension RPC requests.
	// Defaults to defaultRPCTimeout (30s), overridable via SetRPCTimeout.
	rpcTimeout time.Duration

	// writeMu serialises all writes to h.stdin so concurrent goroutines
	// (send, sendResponse, sendNotification) cannot interleave NDJSON
	// frames. Acquired AFTER snapshotting h.stdin under h.pendMu.
	writeMu sync.Mutex

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

	// Bidirectional RPC: context stack for extension-initiated requests.
	// Supports concurrent tool/hook/async-fire contexts on CliBackend.
	ctxStack ctxStack

	// notifMu guards the callbacks the readLoop reads when dispatching
	// extension-initiated notifications (ext/emit, ext/send_message). Kept
	// separate from h.mu so the readLoop never contends with Load: Load
	// holds h.mu for the entire init handshake, and notifications can
	// arrive mid-handshake before the init response.
	notifMu        sync.RWMutex
	onSendMessage  func(text string)
	persistentEmit func(types.EngineEvent)

	// persistentPublishResource is the fallback for ext/publish_resource
	// when no hook/tool context is active (e.g., onComplete callbacks
	// from background dispatches fire after the run exits). Set by the
	// session manager alongside persistentEmit.
	persistentPublishResource func(kind string, delta types.ResourceDelta) error

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

	// exitDone is closed by captureExitStatus when cmd.Wait completes.
	// The readLoop defer waits briefly on this channel before firing
	// onDeath so the death handler can read actual exit codes.
	exitDone chan struct{}

	// stderrBuf captures the last N lines of subprocess stderr so they
	// can be surfaced in engine_extension_died events. Written by the
	// stderr reader goroutine, read by StderrTail.
	stderrMu  sync.Mutex
	stderrBuf []string

	// Async-trigger plumbing: per-host asyncreg.Registry plus captured
	// session key for resolving "which session does this fire belong
	// to?". Stored as a *asyncHostState pointer so the zero-value Host
	// pays no extra memory; allocation happens on first access via
	// asyncRegistry(). See host_async.go for accessors.
	async     *asyncHostState
	asyncOnce sync.Once

	// pendingInitWebhooks / pendingInitSchedules carry the async
	// declarations the subprocess returned from init. The session
	// manager commits them through the registry after wiring the
	// lifecycle-hook callback so init-time veto handlers can fire.
	// Guarded by async.mu when set; CommitPendingAsyncDecls reads and
	// clears them under the same lock.
	pendingInitWebhooks  []WebhookRoute
	pendingInitSchedules []ScheduleJob

	// pendingInitResources carries resource declarations the subprocess
	// returned from init. The session wires them into the resource broker
	// after the extension is fully loaded. Not guarded by async.mu
	// (resource declarations are pure registration, no veto path).
	pendingInitResources []types.ResourceDeclaration

	// inflightLLMCalls maps an ext/llm_call RPC id to the CancelFunc of the
	// context that drives that call. It lets a TS-side AbortSignal cancel a
	// specific in-flight one-shot via the ext/llm_call_cancel notification
	// (keyed by the same request id), independent of a session-wide abort.
	// Both paths converge on the same derived context: the session root
	// (set on RunOptions.ParentCtx upstream) cancels every call, and this
	// per-call cancel cancels exactly one. Entries are inserted before the
	// call goroutine launches and deleted when it completes. Guarded by
	// inflightLLMMu. See host_llm_call_cancel.go.
	inflightLLMCalls map[int64]context.CancelFunc
	inflightLLMMu    sync.Mutex
}


// SetPersistentEmit sets a persistent emit function that handles ext/emit
// notifications when no tool or hook context is active (e.g., background tasks).
func (h *Host) SetPersistentEmit(fn func(types.EngineEvent)) {
	h.notifMu.Lock()
	defer h.notifMu.Unlock()
	h.persistentEmit = fn
}

// SetPersistentPublishResource sets a fallback publish function for
// ext/publish_resource when no hook/tool context is active. This is
// needed because onComplete callbacks from background dispatches fire
// after the run exits, when ctxStack is empty.
func (h *Host) SetPersistentPublishResource(fn func(string, types.ResourceDelta) error) {
	h.notifMu.Lock()
	defer h.notifMu.Unlock()
	h.persistentPublishResource = fn
}

// NewHost creates a new extension host with an empty SDK.
func NewHost() *Host {
	h := &Host{
		sdk:        NewSDK(),
		pending:    make(map[int64]chan *jsonrpcResponse),
		rpcTimeout: defaultRPCTimeout,
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

// SetRPCTimeout overrides the per-call timeout for extension RPC requests.
func (h *Host) SetRPCTimeout(d time.Duration) {
	h.rpcTimeout = d
}

// Name returns the extension's name as reported by the init handshake.
func (h *Host) Name() string {
	return h.name
}

// SetNameForTest sets the host's name without loading an extension.
// Intended for unit tests in other packages that need hosts with
// specific names for grouping/coordination testing.
func (h *Host) SetNameForTest(name string) {
	h.name = name
}

// MarkDeadForTest marks the host as dead without closing any channels.
// Intended for unit tests that need to simulate a dead subprocess.
func (h *Host) MarkDeadForTest() {
	h.dead.Store(true)
}

// ExtensionDir returns the directory containing the extension entry point,
// as resolved during Load. Empty before Load completes.
func (h *Host) ExtensionDir() string {
	if h.loadedConfig != nil {
		return h.loadedConfig.ExtensionDir
	}
	return ""
}

// SetExtensionDir sets the extension directory on the host config. If the
// host has not been loaded yet (loadedConfig is nil), a minimal config is
// initialised. This is primarily useful for tests that need to set the
// extension directory without spawning a subprocess.
func (h *Host) SetExtensionDir(dir string) {
	if h.loadedConfig == nil {
		h.loadedConfig = &ExtensionConfig{}
	}
	h.loadedConfig.ExtensionDir = dir
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

// SetOnCommandsChange wires an observer that fires (outside the SDK lock)
// after any RegisterCommand call on this host. The session manager uses this
// to broadcast an engine_command_registry snapshot when a host's command table
// mutates. Mirror of SDK.SetOnCommandsChange — exposed at the Host level so
// the session never reaches past the host abstraction. Nil clears.
func (h *Host) SetOnCommandsChange(fn func()) {
	h.sdk.SetOnCommandsChange(fn)
}

// Resources returns the resource declarations stashed from the most recent
// init handshake. The session wires them into the resource broker after the
// extension is fully loaded.
func (h *Host) Resources() []types.ResourceDeclaration {
	return h.pendingInitResources
}

// stderrBufMax is the maximum number of stderr lines retained per host.
const stderrBufMax = 50

// StderrTail returns a copy of the last N stderr lines from the subprocess.
func (h *Host) StderrTail() []string {
	h.stderrMu.Lock()
	defer h.stderrMu.Unlock()
	out := make([]string, len(h.stderrBuf))
	copy(out, h.stderrBuf)
	return out
}

// appendStderr adds a line to the stderr ring buffer, evicting the oldest
// line when the buffer is full.
func (h *Host) appendStderr(line string) {
	h.stderrMu.Lock()
	defer h.stderrMu.Unlock()
	if len(h.stderrBuf) >= stderrBufMax {
		h.stderrBuf = h.stderrBuf[1:]
	}
	h.stderrBuf = append(h.stderrBuf, line)
}
