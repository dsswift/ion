// Package ion is the Go SDK for building Ion Engine extensions as compiled
// single-binary executables.
//
// An extension is a subprocess the engine spawns and speaks JSON-RPC 2.0 to
// over stdin/stdout, one JSON object per line. This package implements that
// protocol so an extension author writes handlers, not framing.
//
// # Quickstart
//
//	package main
//
//	import (
//		"context"
//		"encoding/json"
//
//		ion "github.com/dsswift/ion/sdk/go"
//	)
//
//	func main() {
//		sdk := ion.New(ion.WithName("my-extension"))
//
//		ion.OnHook(sdk, ion.HookSessionStart, func(ctx *ion.Context, _ struct{}) (any, error) {
//			ctx.Log().Info("session started", map[string]any{"key": ctx.SessionKey})
//			return nil, nil
//		})
//
//		sdk.RegisterTool(ion.ToolDef{
//			Name:        "greet",
//			Description: "Say hello",
//			Parameters: map[string]any{
//				"type":       "object",
//				"properties": map[string]any{"who": map[string]any{"type": "string"}},
//			},
//			Execute: func(c context.Context, ctx *ion.Context, input json.RawMessage) (ion.ToolResult, error) {
//				return ion.ToolResult{Content: "hello"}, nil
//			},
//		})
//
//		if err := sdk.Run(); err != nil {
//			panic(err)
//		}
//	}
//
// Build it to a binary named main in the extension directory:
//
//	go build -o main .
//
// # Stdout is the protocol
//
// Every byte written to stdout must be a JSON-RPC frame. A stray fmt.Println
// corrupts the stream and the engine drops the connection. Run redirects fd 1
// to stderr for exactly this reason (see transport_unix.go), so accidental
// prints land in the engine's log instead of the frame stream — but the
// sanctioned channel is [SDK.Log] / [Context.Log], which routes through the
// engine's structured logger.
//
// # Graceful degradation
//
// The protocol has no version negotiation. An engine that does not implement
// an ext/* method answers JSON-RPC -32601, which this package surfaces as
// [ErrMethodNotFound]. Callers that want to work against older engines check
// for it with errors.Is and fall back:
//
//	usage, err := ctx.GetContextUsage(c)
//	if errors.Is(err, ErrMethodNotFound) {
//		usage = nil // this engine build has no context-usage RPC
//	}
package ion

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
)

// SDK is an extension instance: its hook, tool, and command registries plus
// the transport to the engine. Create one with [New], register handlers, then
// call [SDK.Run].
type SDK struct {
	name string

	mu           sync.RWMutex
	hooks        map[string]hookEntry
	tools        map[string]ToolDef
	commands     map[string]CommandDef
	toolRevision int64

	transport *transport
	logger    *Logger

	async     *asyncRegistry
	resources *resourceRegistry

	// notifRouter delivers engine notifications (dispatch lifecycle and
	// terminal callbacks) to the DispatchAgent caller that registered for
	// them. Created on first dispatch — an extension that never dispatches
	// never allocates it.
	notifOnce   sync.Once
	notifRouter *notificationRouter

	// initOnce guards the transition from "queue registrations for the init
	// response" to "send registrations as ext/register_* RPCs". Everything
	// registered before the engine's init request rides the init response;
	// everything after goes out as its own call.
	initOnce sync.Once
	initDone chan struct{}

	// cfg is the ExtensionConfig the engine sent with init. Read by Context
	// construction to fill in defaults the per-invocation _ctx omits.
	cfgMu sync.RWMutex
	cfg   ExtensionConfig
}

// hookEntry is a registered hook handler plus the reflection metadata the
// parity test needs. handler takes the raw payload so the typed wrapper
// installed by [OnHook] can decode it into the handler's own payload type.
type hookEntry struct {
	handler func(ctx *Context, payload json.RawMessage) (any, error)
	info    HookInfo
}

// Option configures an SDK at construction.
type Option func(*SDK)

// WithName sets the extension name reported in the init handshake. The engine
// uses it to tag the extension's log lines and to identify it to peers. When
// unset the engine falls back to the manifest or directory name.
func WithName(name string) Option {
	return func(s *SDK) { s.name = name }
}

// WithOutput overrides the stream frames are written to. Only useful in tests;
// production always writes to stdout.
func WithOutput(w interface{ Write([]byte) (int, error) }) Option {
	return func(s *SDK) { s.transport.out = w }
}

// WithInput overrides the stream frames are read from. Only useful in tests;
// production always reads stdin.
func WithInput(r interface{ Read([]byte) (int, error) }) Option {
	return func(s *SDK) { s.transport.in = r }
}

// New creates an SDK. Registration calls made on the returned value before
// [SDK.Run] are delivered to the engine in the init handshake.
func New(opts ...Option) *SDK {
	s := &SDK{
		hooks:     make(map[string]hookEntry),
		tools:     make(map[string]ToolDef),
		commands:  make(map[string]CommandDef),
		transport: newTransport(os.Stdin, os.Stdout),
		initDone:  make(chan struct{}),
	}
	s.logger = &Logger{emit: s.transport.notify}
	s.async = newAsyncRegistry(s)
	s.resources = newResourceRegistry(s)
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// Log returns the extension's logger. Every line goes to the engine over the
// log notification and lands in ~/.ion/engine.jsonl tagged with the extension
// name. This is the only sanctioned output channel — see the package doc.
func (s *SDK) Log() *Logger { return s.logger }

// Config returns the ExtensionConfig the engine supplied at init. Zero-valued
// before the handshake completes.
func (s *SDK) Config() ExtensionConfig {
	s.cfgMu.RLock()
	defer s.cfgMu.RUnlock()
	return s.cfg
}

// On registers an untyped hook handler. This is the escape hatch for hooks
// whose payload shape this SDK version does not model; prefer [OnHook], which
// gives the handler a decoded payload and a typed result.
//
// A second registration for the same hook replaces the first, matching the
// TypeScript SDK's Map-set semantics.
func (s *SDK) On(hook string, handler func(ctx *Context, payload json.RawMessage) (any, error)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.hooks[hook] = hookEntry{
		handler: handler,
		info:    HookInfo{Name: hook, Untyped: true},
	}
}

// RegisterTool adds a tool to the extension's registry. Registering before
// [SDK.Run] includes the tool in the init handshake, which is the normal case;
// the engine's tool registry uses replace-on-duplicate semantics.
func (s *SDK) RegisterTool(def ToolDef) {
	s.mu.Lock()
	s.tools[def.Name] = def
	if s.initialized() {
		s.toolRevision++
	}
	s.mu.Unlock()
}

// RegisterCommand adds a slash command to the extension's registry.
func (s *SDK) RegisterCommand(name string, def CommandDef) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.commands[name] = def
}

// Webhooks returns the inbound-webhook registration API.
func (s *SDK) Webhooks() *WebhooksAPI { return &WebhooksAPI{reg: s.async} }

// Schedule returns the scheduled-job registration API.
func (s *SDK) Schedule() *ScheduleAPI { return &ScheduleAPI{reg: s.async} }

// Resources returns the resource declaration and query API.
func (s *SDK) Resources() *ResourcesAPI { return &ResourcesAPI{reg: s.resources} }

// Hooks returns metadata for every registered hook. The parity test uses it to
// check this SDK's coverage against the engine's contract manifest.
func (s *SDK) Hooks() []HookInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]HookInfo, 0, len(s.hooks))
	for _, e := range s.hooks {
		out = append(out, e.info)
	}
	return out
}

// Run serves the engine connection until stdin closes. It blocks.
//
// Before the first frame it hardens fd 1: the framing writer takes a dup of
// the original stdout, then stderr is duped over fd 1, so anything that writes
// to "stdout" afterwards (a stray print, a cgo library, a dependency) lands on
// stderr, which the engine drains into its log. Without this a single stray
// byte would desynchronise the frame stream.
//
// Returns nil on clean EOF (the engine closed the pipe, which is how a normal
// shutdown looks) and an error on a transport failure.
func (s *SDK) Run() error {
	if err := s.transport.hardenStdout(); err != nil {
		// Not fatal: an extension whose stdout is not a real fd (tests,
		// exotic hosts) still speaks the protocol correctly, it just has
		// no guard against stray writes. Log and continue.
		s.logger.Warn("stdout hardening unavailable; stray writes to stdout will corrupt the protocol stream",
			map[string]any{"error": err.Error()})
	}
	return s.transport.serve(s.dispatch)
}

// Shutdown stops the serve loop. Intended for tests and for extensions that
// need to exit on an internal signal; the normal lifecycle is the engine
// closing stdin.
func (s *SDK) Shutdown() { s.transport.close() }

// markInitDone flips the pre-init/post-init switch exactly once. Called from
// the init handler after the pending registrations have been drained.
func (s *SDK) markInitDone() {
	s.initOnce.Do(func() { close(s.initDone) })
}

// initialized reports whether the init handshake has completed. Registration
// calls use it to choose between the pending queue and a live RPC.
func (s *SDK) initialized() bool {
	select {
	case <-s.initDone:
		return true
	default:
		return false
	}
}

// call issues an outbound request to the engine and waits for the response.
// Every RPC-backed method funnels through here.
func (s *SDK) call(c context.Context, method string, params any, out any) error {
	raw, err := s.transport.call(c, method, params)
	if err != nil {
		return err
	}
	if out == nil || len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("%s: decode result: %w", method, err)
	}
	return nil
}
