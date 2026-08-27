// context_dispatch_routing.go — notification routing for dispatch callbacks.
//
// Split from context_dispatch.go to keep that file under the 800-line cap; same
// package, no API change.
//
// Routing is keyed by dispatch id first and agent name second. Two parallel
// dispatches of the same agent share a name but not an id, so an id-keyed
// handler is the only way each gets its own terminal callback. The agent-name
// key is the pre-stub fallback: a fast child can complete before the stub
// response reveals its collision-safe dispatch id, and without the name
// binding that terminal callback would be dropped.
package ion

import (
	"context"
	"encoding/json"
	"sync"
	"sync/atomic"
)

// terminalBinding keeps a dispatch's terminal callbacks live under the agent
// name before the stub response reveals its collision-safe dispatch ID. A fast
// child can therefore complete during the response race without being dropped.
type terminalBinding struct {
	router     *notificationRouter
	agentName  string
	opts       DispatchAgentOpts
	unbindName func()

	mu         sync.Mutex
	unbindID   func()
	dispatchID string
	finished   atomic.Bool
}

func newTerminalBinding(r *notificationRouter, agentName string, opts DispatchAgentOpts, unbindName func()) *terminalBinding {
	binding := &terminalBinding{
		router:     r,
		agentName:  agentName,
		opts:       opts,
		unbindName: unbindName,
	}
	binding.bindTerminalKey(agentName)
	return binding
}

// bindDispatchID adds collision-safe routing after the stub arrives. A terminal
// notification that won the name-key race sets finished first, preventing this
// late re-key from resurrecting callbacks the notification already consumed.
func (b *terminalBinding) bindDispatchID(dispatchID string) {
	if dispatchID == "" || dispatchID == b.agentName {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.finished.Load() {
		return
	}
	b.dispatchID = dispatchID
	b.unbindID = b.router.bindLifecycle(dispatchID, b.opts)
	b.bindTerminalKey(dispatchID)
}

func (b *terminalBinding) bindTerminalKey(key string) {
	complete := decodeIntoOptional(b.router.sdk, b.opts.OnComplete)
	failed := decodeIntoOptional(b.router.sdk, b.opts.OnError)
	recalled := decodeIntoOptional(b.router.sdk, b.opts.OnRecall)

	b.router.mu.Lock()
	b.router.handlers["dispatch_complete:"+key] = func(params json.RawMessage) {
		b.handleTerminal(params, complete)
	}
	b.router.handlers["dispatch_error:"+key] = func(params json.RawMessage) {
		b.handleTerminal(params, failed)
	}
	b.router.handlers["dispatch_recall:"+key] = func(params json.RawMessage) {
		b.handleTerminal(params, recalled)
	}
	b.router.mu.Unlock()
}

func (b *terminalBinding) handleTerminal(params json.RawMessage, fire func(json.RawMessage)) {
	if !b.finished.CompareAndSwap(false, true) {
		return
	}
	b.cleanup()
	if fire != nil {
		fire(params)
	}
}

func (b *terminalBinding) cleanup() {
	b.finished.Store(true)
	b.mu.Lock()
	unbindID := b.unbindID
	dispatchID := b.dispatchID
	b.unbindID = nil
	b.dispatchID = ""
	b.mu.Unlock()

	b.router.mu.Lock()
	for _, key := range []string{b.agentName, dispatchID} {
		if key == "" {
			continue
		}
		for _, method := range []string{"dispatch_complete", "dispatch_error", "dispatch_recall"} {
			delete(b.router.handlers, method+":"+key)
		}
	}
	b.router.mu.Unlock()

	b.unbindName()
	if unbindID != nil {
		unbindID()
	}
}

// notificationRouter routes engine notifications to dispatch callbacks, keyed
// by dispatch id or agent name.
type notificationRouter struct {
	sdk *SDK

	mu       sync.RWMutex
	handlers map[string]func(json.RawMessage)
}

// notifications returns the SDK's notification router, creating it on first
// use.
func (s *SDK) notifications() *notificationRouter {
	s.notifOnce.Do(func() {
		s.notifRouter = &notificationRouter{sdk: s, handlers: make(map[string]func(json.RawMessage))}
	})
	return s.notifRouter
}

// bindLifecycle registers the streaming callbacks under key and returns an
// unbind function.
func (r *notificationRouter) bindLifecycle(key string, opts DispatchAgentOpts) func() {
	bindings := map[string]func(json.RawMessage){}

	bind := func(method string, fn func(json.RawMessage)) {
		if fn != nil {
			bindings[method+":"+key] = fn
		}
	}

	if opts.OnEvent != nil {
		bind("dispatch_event", decodeInto(r.sdk, opts.OnEvent))
	}
	if opts.OnToolStart != nil {
		bind("dispatch_tool_start", decodeInto(r.sdk, opts.OnToolStart))
	}
	if opts.OnToolEnd != nil {
		bind("dispatch_tool_end", decodeInto(r.sdk, opts.OnToolEnd))
	}
	if opts.OnToolError != nil {
		bind("dispatch_tool_error", decodeInto(r.sdk, opts.OnToolError))
	}
	if opts.OnUsage != nil {
		bind("dispatch_usage", decodeInto(r.sdk, opts.OnUsage))
	}
	if opts.OnTextDelta != nil {
		bind("dispatch_text_delta", decodeInto(r.sdk, opts.OnTextDelta))
	}
	if opts.OnPlanProposal != nil {
		bind("dispatch_plan_proposal", decodeInto(r.sdk, opts.OnPlanProposal))
	}
	if opts.OnChildQuestion != nil {
		bind("dispatch_child_question", r.childQuestionHandler(opts.OnChildQuestion))
	}

	r.mu.Lock()
	for k, fn := range bindings {
		r.handlers[k] = fn
	}
	r.mu.Unlock()

	return func() {
		r.mu.Lock()
		for k := range bindings {
			delete(r.handlers, k)
		}
		r.mu.Unlock()
	}
}

// childQuestionHandler answers a child's question by invoking the caller's
// callback and sending the result back, which unblocks the child's run.
func (r *notificationRouter) childQuestionHandler(
	fn func(DispatchChildQuestionInfo) (string, bool, error),
) func(json.RawMessage) {
	return func(params json.RawMessage) {
		var info DispatchChildQuestionInfo
		if err := json.Unmarshal(params, &info); err != nil {
			r.sdk.logger.Error("child question did not decode; the child stays blocked",
				map[string]any{"error": err.Error()})
			return
		}
		answer, cancelled, err := fn(info)
		if err != nil {
			// The child is blocked on an answer, so a handler error must
			// still produce a reply — send a cancellation rather than
			// leaving the run hung.
			r.sdk.logger.Error("child question handler failed; cancelling the question",
				map[string]any{"dispatchId": info.DispatchID, "error": err.Error()})
			answer, cancelled = "", true
		}
		if err := r.sdk.call(context.Background(), "ext/answer_dispatch_question", map[string]any{
			"dispatchId": info.DispatchID,
			"requestId":  info.RequestID,
			"answer":     answer,
			"cancelled":  cancelled,
		}, nil); err != nil {
			r.sdk.logger.Error("could not deliver child question answer",
				map[string]any{"dispatchId": info.DispatchID, "error": err.Error()})
		}
	}
}

// decodeInto adapts a typed callback to the router's raw signature.
func decodeInto[T any](s *SDK, fn func(T)) func(json.RawMessage) {
	return func(params json.RawMessage) {
		var v T
		if err := json.Unmarshal(params, &v); err != nil {
			s.logger.Warn("dispatch notification did not decode", map[string]any{"error": err.Error()})
			return
		}
		fn(v)
	}
}

// decodeIntoOptional is decodeInto for a callback that may be nil.
func decodeIntoOptional[T any](s *SDK, fn func(T)) func(json.RawMessage) {
	if fn == nil {
		return nil
	}
	return decodeInto(s, fn)
}

// route delivers a notification to the best-matching handler. Dispatch id wins
// over agent name, which wins over an unkeyed handler, so parallel dispatches
// of one agent stay separated.
func (r *notificationRouter) route(method string, params json.RawMessage) bool {
	var envelope struct {
		DispatchID string `json:"dispatchId"`
		Name       string `json:"name"`
	}
	// A decode failure just means no routing keys; fall through to the
	// unkeyed handler.
	_ = json.Unmarshal(params, &envelope) //nolint:errcheck // keys are optional

	r.mu.RLock()
	var handler func(json.RawMessage)
	for _, key := range []string{
		method + ":" + envelope.DispatchID,
		method + ":" + envelope.Name,
		method,
	} {
		if envelope.DispatchID == "" && key == method+":" {
			continue
		}
		if h, ok := r.handlers[key]; ok && h != nil {
			handler = h
			break
		}
	}
	r.mu.RUnlock()

	if handler == nil {
		return false
	}
	handler(params)
	return true
}
