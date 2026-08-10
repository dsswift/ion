// context.go — the per-invocation context handed to every handler.
//
// A Context carries the session identity the engine sent with this firing and
// the methods a handler uses to reach back into the engine. Each hook, tool,
// and command invocation gets its own.
//
// # Event batching
//
// Emit has two destinations. Inside a handler it appends to a per-invocation
// buffer that rides out on the hook response, so the engine applies the events
// atomically with the handler's return value. Once the invocation has answered,
// the buffer is sealed and Emit falls through to a standalone ext/emit
// notification.
//
// The TypeScript SDK gets this from being single-threaded: it swaps a module
// global around the await and no other handler can interleave. Go handlers run
// concurrently and may outlive their invocation via a spawned goroutine, so the
// buffer is per-Context and explicitly sealed rather than global.
package ion

import (
	"context"
	"encoding/json"
	"sync"
)

// Context is the per-invocation handle passed to hook, tool, and command
// handlers.
//
// The identity fields are populated from the engine's _ctx envelope. For a
// root session the engine omits Depth and DispatchID entirely, so their zero
// values (0 and "") are the root-session shape, not missing data.
type Context struct {
	// SessionKey identifies the engine session this invocation belongs to.
	SessionKey string
	// ConversationID is the persistent conversation this session is bound to.
	ConversationID string
	// RunID identifies the active prompt-to-completion run. Empty when this
	// invocation has no run (for example, session_start or a schedule delivery).
	RunID string
	// TraceID is the active run's W3C trace-context trace ID. Empty when no run
	// is active.
	TraceID string
	// Depth is the dispatch depth: 0 for the root session, 1 for an agent it
	// dispatched, and so on.
	Depth int
	// DispatchID uniquely identifies this dispatch instance. Empty at the
	// root. Two parallel dispatches of the same agent differ here and only
	// here.
	DispatchID string
	// Cwd is the working directory for this invocation.
	Cwd string
	// Model is the active model reference. Nil means the engine has not resolved
	// a model for this invocation; it is not missing decoded metadata.
	Model *ModelRef
	// Config is the extension configuration from the init handshake.
	Config ExtensionConfig

	sdk *SDK

	// eventsMu guards the buffer and the batching flag together: opening,
	// appending, and sealing race otherwise, and the whole point of the flag
	// is to make the append-or-notify decision atomic.
	//
	// batching is false by default, so a Context emits immediately unless
	// something explicitly opens a batch. Only the hook path does
	// (openEventBatch), because a hook is the only invocation whose response
	// carries an events array. A tool, command, or async fire has nowhere to
	// put a batched event, so buffering one there would drop it.
	eventsMu sync.Mutex
	events   []EngineEvent
	batching bool
}

// ModelRef identifies the active model resolved for an invocation.
type ModelRef struct {
	ID            string `json:"id"`
	ContextWindow int    `json:"contextWindow"`
}

// ctxEnvelope is the wire shape of the _ctx key.
type ctxEnvelope struct {
	SessionKey     string           `json:"sessionKey"`
	ConversationID string           `json:"conversationId"`
	RunID          string           `json:"runId"`
	TraceID        string           `json:"traceId"`
	Depth          int              `json:"depth"`
	DispatchID     string           `json:"dispatchId"`
	Cwd            string           `json:"cwd"`
	Model          *ModelRef        `json:"model"`
	Config         *ExtensionConfig `json:"config"`
}

// newContext builds a Context from an inbound _ctx envelope, filling absent
// fields from the init configuration.
func (s *SDK) newContext(meta json.RawMessage) *Context {
	cfg := s.Config()
	ctx := &Context{sdk: s, Cwd: cfg.WorkingDirectory, Config: cfg}

	if len(meta) == 0 {
		return ctx
	}
	var env ctxEnvelope
	if err := json.Unmarshal(meta, &env); err != nil {
		s.logger.Warn("could not decode _ctx envelope; using defaults",
			map[string]any{"error": err.Error()})
		return ctx
	}

	ctx.SessionKey = env.SessionKey
	ctx.ConversationID = env.ConversationID
	ctx.RunID = env.RunID
	ctx.TraceID = env.TraceID
	ctx.Depth = env.Depth
	ctx.DispatchID = env.DispatchID
	ctx.Model = env.Model
	if env.Cwd != "" {
		ctx.Cwd = env.Cwd
	}
	if env.Config != nil {
		ctx.Config = *env.Config
	}
	return ctx
}

// Log returns the extension's logger. Same destination as [SDK.Log]; exposed
// here so a handler does not have to close over the SDK value.
func (c *Context) Log() *Logger { return c.sdk.logger }

// Emit sends an engine event.
//
// Inside a hook handler the event is buffered and delivered with the handler's
// response, so the engine applies it atomically with the return value.
// Everywhere else — a tool, a command, a webhook or schedule firing, or a
// goroutine that outlived the hook that spawned it — it goes out immediately as
// its own notification.
//
// The distinction is not stylistic: only a hook response has an events array to
// carry a batch. This mirrors the TypeScript runtime, which sets its
// activeEvents global only around a hook invocation.
func (c *Context) Emit(event EngineEvent) {
	c.eventsMu.Lock()
	if c.batching {
		c.events = append(c.events, event)
		c.eventsMu.Unlock()
		return
	}
	c.eventsMu.Unlock()
	c.sdk.transport.notify("ext/emit", event)
}

// openEventBatch starts buffering emitted events so they can ride the
// invocation's response. Called only by the hook dispatcher.
func (c *Context) openEventBatch() {
	c.eventsMu.Lock()
	c.batching = true
	c.eventsMu.Unlock()
}

// sealAndTakeEvents closes the batch and drains it in ONE critical section,
// returning the events that belong on the response.
//
// The two steps must be atomic with respect to Emit. Closing and draining
// separately leaves a window in which an escaped goroutine's Emit still sees an
// open batch (so it appends instead of notifying) after the drain has already
// happened — and that event is then never sent by anyone. Holding the lock
// across both closes the window: an Emit either lands in the batch or observes
// the closed batch and goes out as its own notification. Exactly one of the two
// always happens.
func (c *Context) sealAndTakeEvents() []EngineEvent {
	c.eventsMu.Lock()
	defer c.eventsMu.Unlock()
	c.batching = false
	out := c.events
	c.events = nil
	return out
}

// sealEvents closes the batch without draining it, for the error paths where no
// response carries an events array. Anything already buffered is flushed as
// individual notifications rather than dropped, and subsequent Emit calls
// notify directly.
func (c *Context) sealEvents() {
	c.eventsMu.Lock()
	c.batching = false
	pending := c.events
	c.events = nil
	c.eventsMu.Unlock()

	for _, event := range pending {
		c.sdk.transport.notify("ext/emit", event)
	}
}

// SendMessage queues a message back into the session as if the user had typed
// it. Fire-and-forget: the engine acknowledges nothing.
func (c *Context) SendMessage(text string) {
	c.sdk.transport.notify("ext/send_message", map[string]string{"text": text})
}

// SuppressTool removes a tool from the model's visible tool set for the
// remainder of this run.
func (c *Context) SuppressTool(ctx context.Context, name string) error {
	return c.sdk.call(ctx, "ext/suppress_tool", map[string]string{"name": name}, nil)
}

// CallTool invokes an engine or peer-extension tool by name and returns its
// result. The engine runs the tool with the calling session's permissions.
func (c *Context) CallTool(ctx context.Context, name string, input map[string]any) (ToolResult, error) {
	if input == nil {
		input = map[string]any{}
	}
	var out ToolResult
	err := c.sdk.call(ctx, "ext/call_tool", map[string]any{"name": name, "input": input}, &out)
	return out, err
}

// RegisterProcess records a long-running child process in the session's
// process registry so the engine can report and reap it.
func (c *Context) RegisterProcess(ctx context.Context, name string, pid int, task string) error {
	return c.sdk.call(ctx, "ext/register_process",
		map[string]any{"name": name, "pid": pid, "task": task}, nil)
}

// DeregisterProcess removes a process from the registry.
func (c *Context) DeregisterProcess(ctx context.Context, name string) error {
	return c.sdk.call(ctx, "ext/deregister_process", map[string]string{"name": name}, nil)
}

// ListProcesses returns every process in the session's registry.
func (c *Context) ListProcesses(ctx context.Context) ([]ProcessInfo, error) {
	var out []ProcessInfo
	if err := c.sdk.call(ctx, "ext/list_processes", map[string]any{}, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// TerminateProcess signals a registered process to stop.
func (c *Context) TerminateProcess(ctx context.Context, name string) error {
	return c.sdk.call(ctx, "ext/terminate_process", map[string]string{"name": name}, nil)
}

// CleanStaleProcesses reaps registry entries whose process is gone and returns
// how many were removed.
func (c *Context) CleanStaleProcesses(ctx context.Context) (int, error) {
	var out struct {
		Cleaned int `json:"cleaned"`
	}
	if err := c.sdk.call(ctx, "ext/clean_stale_processes", map[string]any{}, &out); err != nil {
		return 0, err
	}
	return out.Cleaned, nil
}

// SandboxWrap wraps a shell command in the platform's sandbox (Seatbelt on
// macOS, bubblewrap on Linux) using the supplied profile.
func (c *Context) SandboxWrap(ctx context.Context, command string, profile *SandboxProfile) (SandboxWrapResult, error) {
	params := map[string]any{"command": command}
	if profile != nil {
		// The engine reads the profile's fields at the top level of params
		// alongside command, so flatten rather than nest.
		data, err := json.Marshal(profile)
		if err != nil {
			return SandboxWrapResult{}, err
		}
		var flat map[string]any
		if err := json.Unmarshal(data, &flat); err != nil {
			return SandboxWrapResult{}, err
		}
		for k, v := range flat {
			params[k] = v
		}
	}
	var out SandboxWrapResult
	err := c.sdk.call(ctx, "ext/sandbox_wrap", params, &out)
	return out, err
}
