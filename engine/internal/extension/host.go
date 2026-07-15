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

	// Extension name returned from init handshake (or manifest/directory fallback).
	name string

	// version is the extension version read from extension.json at load time.
	// Empty when the manifest is absent or carries no version field.
	// Not updated after load; manifest version is a build-time constant.
	version string

	// Bidirectional RPC: context stack for extension-initiated requests.
	// Supports concurrent tool/hook/async-fire contexts on ClaudeCodeBackend.
	ctxStack ctxStack

	// notifMu guards the callbacks the readLoop reads when dispatching
	// extension-initiated notifications (ext/emit, ext/send_message). Kept
	// separate from h.mu so the readLoop never contends with Load: Load
	// holds h.mu for the entire init handshake, and notifications can
	// arrive mid-handshake before the init response.
	notifMu        sync.RWMutex
	onSendMessage  func(SendPromptPayload)
	persistentEmit func(types.EngineEvent)

	// telemFn is the session-scoped telemetry sink used by callHook to emit
	// per-handler extension.hook_latency events. Set by the session manager
	// alongside persistentEmit (identical injection pattern) when the session
	// has a telemetry collector; left nil otherwise. Guarded by notifMu.
	// A nil sink means callHook emits nothing (telemetry-disabled and pre-wire
	// loads pay only a nil check). The signature matches telemetry.Collector.Event.
	telemFn func(event string, payload, ctx map[string]any)

	// persistentPublishResource is the fallback for ext/publish_resource
	// when no hook/tool context is active (e.g., onComplete callbacks
	// from background dispatches fire after the run exits). Set by the
	// session manager alongside persistentEmit.
	persistentPublishResource func(kind string, delta types.ResourceDelta) error

	// persistentRecall is a session-scoped fallback for ext/recall_agent when
	// no hook/run context is active (i.e. the parent run is idle). The registry
	// outlives runs by design, so recall must work even when ctxStack is empty.
	// Set by the session manager alongside persistentEmit. Guarded by notifMu.
	persistentRecall func(name, reason string) (bool, error)

	// persistentSteer is a session-scoped fallback for ext/steer_dispatch when
	// no hook/run context is active. Guarded by notifMu.
	persistentSteer func(dispatchID, message string) (SteerDispatchResult, error)

	// persistentSteerByName is a session-scoped fallback for
	// ext/steer_dispatch_by_name when no hook/run context is active. Guarded
	// by notifMu.
	persistentSteerByName func(name, message string) (SteerDispatchResult, error)

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

	// lastSpawnReadyMs is the wall-clock (in milliseconds) that the most
	// recent spawnAndInit took from process launch to a successful init
	// handshake. Surfaced via SpawnReadyMs for the extension.coldstart
	// telemetry event (family 4e). Written under h.mu inside spawnAndInit;
	// read under h.mu via SpawnReadyMs.
	lastSpawnReadyMs int64

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

	// childQuestions maps a dispatch-question key (dispatchId + ":" +
	// requestId) to a chan childQuestionReply. When a dispatched child calls
	// AskUserQuestion, the OnChildQuestion callback wired in host_rpc.go
	// stores a channel here, sends a dispatch_child_question notification to
	// the TS SDK, and blocks on the channel. The TS SDK answers via an
	// ext/answer_dispatch_question RPC, whose handler looks up the channel by
	// key and delivers the reply. This mirrors the ext/elicit block-and-resume
	// pattern but lives entirely on the Host because dispatch callbacks fire
	// outside any hook/tool context (background dispatches resolve after the
	// parent run has moved on). sync.Map is used so concurrent dispatches do
	// not contend on a single mutex.
	childQuestions sync.Map

	// boundSessionID and boundConversationID are set when the host is
	// associated with a session, and are stamped on all extension log
	// notifications so cross-surface log correlation works. Guarded by
	// boundMu. See host_session_binding.go for the accessors.
	boundSessionID      string
	boundConversationID string
	boundMu             sync.RWMutex

	// dispatchContextDefaults is the session-level default context policy
	// (level 3 of the dispatch context cascade), set by the extension via
	// ctx.setDispatchContextDefaults. Guarded by dispatchCtxMu. See
	// host_dispatch_context.go for the accessors. Session-scoped state in the
	// same spirit as tool suppression.
	dispatchContextDefaults *ContextPolicy
	dispatchCtxMu           sync.RWMutex
}

// childQuestionReply carries the dispatcher's answer to a child's
// AskUserQuestion, delivered over the per-question channel registered in
// Host.childQuestions. Answer is the text injected as the child's
// AskUserQuestion tool result; Cancelled=true terminates the child run.
type childQuestionReply struct {
	Answer    string
	Cancelled bool
}

// SetPersistentEmit sets a persistent emit function that handles ext/emit
// notifications when no tool or hook context is active (e.g., background tasks).
func (h *Host) SetPersistentEmit(fn func(types.EngineEvent)) {
	h.notifMu.Lock()
	defer h.notifMu.Unlock()
	h.persistentEmit = fn
}

// SetTelemetrySink sets the session-scoped telemetry sink used by callHook to
// emit per-handler extension.hook_latency events. Mirrors SetPersistentEmit:
// guarded by notifMu, snapshotted under the lock at emit time. Passing nil
// disables emission (the default for sessions without a telemetry collector).
func (h *Host) SetTelemetrySink(fn func(event string, payload, ctx map[string]any)) {
	h.notifMu.Lock()
	defer h.notifMu.Unlock()
	h.telemFn = fn
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

// SetPersistentRecall sets the fallback recall function used when no run
// context is active (parent session is idle between dispatch runs). The
// dispatch registry outlives runs by design, so recall must succeed even when
// ctxStack is empty.
func (h *Host) SetPersistentRecall(fn func(name, reason string) (bool, error)) {
	h.notifMu.Lock()
	defer h.notifMu.Unlock()
	h.persistentRecall = fn
}

// SetPersistentSteer sets the fallback steer function used when no run
// context is active (parent session is idle between dispatch runs).
func (h *Host) SetPersistentSteer(fn func(dispatchID, message string) (SteerDispatchResult, error)) {
	h.notifMu.Lock()
	defer h.notifMu.Unlock()
	h.persistentSteer = fn
}

// SetPersistentSteerByName sets the fallback name-based steer function used
// when no run context is active (parent session is idle between dispatch runs).
func (h *Host) SetPersistentSteerByName(fn func(name, message string) (SteerDispatchResult, error)) {
	h.notifMu.Lock()
	defer h.notifMu.Unlock()
	h.persistentSteerByName = fn
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

// Version returns the extension's version as read from extension.json at load
// time. Returns empty string when the manifest is absent or carries no
// version field.
func (h *Host) Version() string {
	return h.version
}

// SetNameForTest sets the host's name without loading an extension.
// Intended for unit tests in other packages that need hosts with
// specific names for grouping/coordination testing.
func (h *Host) SetNameForTest(name string) {
	h.name = name
}

// SetVersionForTest sets the host's version without loading an extension.
// Intended for unit tests that need to exercise the extension attribution
// telemetry path (correlationCtxExt / buildTelemCtx extension fields).
func (h *Host) SetVersionForTest(version string) {
	h.version = version
}

// MarkDeadForTest marks the host as dead without closing any channels.
// Intended for unit tests that need to simulate a dead subprocess.
func (h *Host) MarkDeadForTest() {
	h.dead.Store(true)
}

// ExecOnSendMessageForTest invokes the onSendMessage callback if one has been
// set via SetOnSendMessage. A no-op when no callback is set. Exposed for unit
// tests that verify SetOnSendMessage wiring without starting a subprocess;
// the production RPC path (ext/send_prompt fallback in host_rpc.go) is the
// only non-test caller.
func (h *Host) ExecOnSendMessageForTest(payload SendPromptPayload) {
	h.notifMu.RLock()
	fn := h.onSendMessage
	h.notifMu.RUnlock()
	if fn != nil {
		fn(payload)
	}
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

// SendPromptPayload is the full set of per-prompt options carried when an
// extension queues a follow-up prompt via ext/send_message (or ext/send_prompt
// without an active hook context). It mirrors the fields the active-hook path
// threads through to PromptOverrides so the two dispatch paths converge on
// identical run-configuration — there is no per-feature divergence between a
// prompt sent from a live hook context and one sent from a timer/scheduler
// background callback.
//
// Carried as a struct (rather than positional callback args) so future
// per-prompt options become struct fields instead of forcing every
// onSendMessage wiring site to re-widen a positional signature. This is the
// same rationale PromptOverrides exists for on the session side.
type SendPromptPayload struct {
	// Text is the prompt text to dispatch. Required.
	Text string
	// Model is an optional per-prompt model override (tier alias or model id).
	// Empty means "use the session's resolved model".
	Model string
	// BashAllowlistAdditions are per-prompt, run-scoped plan-mode Bash command
	// prefixes, unioned with the session allowlist for the single run this
	// prompt starts. Never persisted on the session. Empty/nil is a no-op.
	BashAllowlistAdditions []string
	// Kind classifies the injection for downstream clients. "agent_completion"
	// means this is an internal dispatch callback (a completed child agent's
	// result being routed back to its parent agent) — clients must NOT render
	// these as user-visible bubbles. Empty means a genuine extension-initiated
	// user turn and should be rendered normally. Propagates to
	// PromptInjectedEvent.Kind and the engine_prompt_injected wire field
	// InjectedPromptKind.
	Kind string
}

// SetOnSendMessage sets the callback invoked when the extension sends an
// ext/send_message notification. The session manager uses this to queue
// follow-up prompts from extension-initiated messages. The callback receives
// the full SendPromptPayload (text + model + bash-allowlist additions) so the
// fallback path carries the same run configuration as the active-hook path.
func (h *Host) SetOnSendMessage(fn func(SendPromptPayload)) {
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
