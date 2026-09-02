// context_dispatch_methods.go — the dispatch, recall, steering, and context
// policy CALLS. Split from context_dispatch.go, which retains the option and
// result TYPES, to keep both files under the 800-line Go cap. Same package; no
// API change.
package ion

import (
	"context"
	"fmt"
)

// DispatchAgent runs a child agent session.
//
// Dispatch is asynchronous by default: it returns a stub carrying the dispatch
// ID and the terminal outcome arrives on OnComplete, OnError, or OnRecall. Set
// WaitForCompletion for explicit foreground terminal output.
func (c *Context) DispatchAgent(ctx context.Context, opts DispatchAgentOpts) (DispatchAgentResult, error) {
	if opts.Name == "" {
		return DispatchAgentResult{}, fmt.Errorf("ion: DispatchAgent requires a name")
	}

	router := c.sdk.notifications()
	// Register every callback under the agent name before the RPC goes out. A
	// child can finish before the stub response arrives, so terminal callbacks
	// need the same pre-response race protection as lifecycle callbacks.
	unbindByName := router.bindLifecycle(opts.Name, opts)
	terminal := newTerminalBinding(router, opts.Name, opts, unbindByName)

	wireOpts := opts
	if !wireOpts.WaitForCompletion {
		// Older engines only understand Background. Sending both fields keeps the
		// new default asynchronous when an extension is rebuilt before its engine.
		wireOpts.Background = true
	}

	var out DispatchAgentResult
	err := c.sdk.call(ctx, "ext/dispatch_agent", wireOpts, &out)
	if err != nil {
		terminal.cleanup()
		c.sdk.logger.Error("dispatch failed", map[string]any{"agent": opts.Name, "error": err.Error()})
		return DispatchAgentResult{}, err
	}

	if opts.WaitForCompletion {
		// Foreground: the child is finished, so the streaming handlers have
		// nothing left to deliver.
		terminal.cleanup()
		return out, nil
	}

	// Re-key by dispatch ID without restoring a handler already consumed during
	// the pre-response name-routing window.
	dispatchID := out.DispatchID
	if dispatchID == "" {
		dispatchID = opts.Name
	}
	terminal.bindDispatchID(dispatchID)

	c.sdk.logger.Info("asynchronous dispatch started", map[string]any{
		"agent": opts.Name, "dispatchId": dispatchID,
	})
	return out, nil
}

// RecallAgent retains the published name-addressed dispatch recall API.
// When several live dispatches share a name, the engine selects one match.
// Prefer RecallDispatch when the caller has the exact dispatch ID.
func (c *Context) RecallAgent(ctx context.Context, name, reason string) (bool, error) {
	var out struct {
		Found bool `json:"found"`
	}
	err := c.sdk.call(ctx, "ext/recall_agent", map[string]string{"name": name, "reason": reason}, &out)
	return out.Found, err
}

// RecallDispatch cancels one asynchronous dispatch by exact dispatch ID.
// Names are never accepted because concurrent dispatches can share them.
func (c *Context) RecallDispatch(ctx context.Context, dispatchID, reason string) (bool, error) {
	var out struct {
		Found bool `json:"found"`
	}
	err := c.sdk.call(ctx, "ext/recall_dispatch", map[string]string{"dispatchId": dispatchID, "reason": reason}, &out)
	return out.Found, err
}

// SteerDispatch delivers a message to a running child dispatch, addressed by
// dispatch id.
func (c *Context) SteerDispatch(ctx context.Context, dispatchID, message string) (SteerDispatchResult, error) {
	var out SteerDispatchResult
	err := c.sdk.call(ctx, "ext/steer_dispatch",
		map[string]string{"dispatchId": dispatchID, "message": message}, &out)
	return out, err
}

// SteerDispatchByName delivers a message to a running child dispatch,
// addressed by agent name. Use [Context.SteerDispatch] when several dispatches
// may share the name.
func (c *Context) SteerDispatchByName(ctx context.Context, name, message string) (SteerDispatchResult, error) {
	var out SteerDispatchResult
	err := c.sdk.call(ctx, "ext/steer_dispatch_by_name",
		map[string]string{"name": name, "message": message}, &out)
	return out, err
}

// SteerSelfOpts configures [Context.SteerSelf].
type SteerSelfOpts struct {
	// Kind classifies the injected turn, surfacing on the
	// engine_prompt_injected event and telling a client this turn was
	// authored by machinery rather than typed by the operator.
	//
	// Supply it for any machine-to-machine message; omit it only when the
	// message genuinely is a user turn. A dispatch completion, a scheduled
	// heartbeat, and an agent question are all machine-authored: delivered
	// unclassified they render in the transcript as if the operator had
	// typed them, because every client's suppression check keys on the kind.
	Kind string
}

// SteerSelf delivers a message to the run that owns this context, letting the
// engine choose the mechanism: a live run is steered mid-turn, an idle one
// receives a fresh prompt.
//
// This is how an asynchronous dispatch's completion reaches its dispatching agent
// without polling — a busy parent is steered rather than having the completion
// queue behind its current run.
//
// The engine threads opts.Kind through both arms, so a classified message stays
// classified whether it is steered onto a live run or delivered as a fresh
// prompt to an idle one. An engine that predates the field ignores it and
// delivers unclassified, logging that it did so.
func (c *Context) SteerSelf(ctx context.Context, message string, opts SteerSelfOpts) (SteerDispatchResult, error) {
	var out SteerDispatchResult
	params := map[string]string{"message": message}
	// Send kind only when set: the engine's field is omitempty, and an empty
	// string is not the same as an absent one.
	if opts.Kind != "" {
		params["kind"] = opts.Kind
	}
	err := c.sdk.call(ctx, "ext/steer_self", params, &out)
	return out, err
}

// AnswerDispatchQuestion unblocks a child that asked a question. Normally
// handled for you by DispatchAgentOpts.OnChildQuestion; call it directly only
// when answering out of band.
func (c *Context) AnswerDispatchQuestion(ctx context.Context, dispatchID, requestID, answer string, cancelled bool) error {
	return c.sdk.call(ctx, "ext/answer_dispatch_question", map[string]any{
		"dispatchId": dispatchID,
		"requestId":  requestID,
		"answer":     answer,
		"cancelled":  cancelled,
	}, nil)
}

// AckDispatchLost acknowledges durable delivery of a lost-dispatch notice. The
// acknowledgement is idempotent, so consumers may retry after their own restart.
func (c *Context) AckDispatchLost(ctx context.Context, dispatchID string) error {
	return c.sdk.call(ctx, "ext/ack_dispatch_lost", map[string]string{"dispatchId": dispatchID}, nil)
}

// ListDispatchState returns a snapshot of every in-flight dispatch in this
// session. Returns an empty slice — never nil — when nothing is running.
func (c *Context) ListDispatchState(ctx context.Context) ([]DispatchStateEntry, error) {
	var out struct {
		Dispatches []DispatchStateEntry `json:"dispatches"`
	}
	if err := c.sdk.call(ctx, "ext/list_dispatch_state", map[string]any{}, &out); err != nil {
		return nil, err
	}
	if out.Dispatches == nil {
		return []DispatchStateEntry{}, nil
	}
	return out.Dispatches, nil
}

// DiscoverAgents walks the agent definition roots and returns what it finds.
func (c *Context) DiscoverAgents(ctx context.Context, opts DiscoverAgentsOpts) ([]DiscoveredAgent, error) {
	var out struct {
		Agents []DiscoveredAgent `json:"agents"`
	}
	if err := c.sdk.call(ctx, "ext/discover_agents", opts, &out); err != nil {
		return nil, err
	}
	return out.Agents, nil
}

// RegisterAgentSpec makes an agent visible to the model for this session.
func (c *Context) RegisterAgentSpec(ctx context.Context, spec AgentSpec) error {
	if spec.Name == "" {
		return fmt.Errorf("ion: RegisterAgentSpec requires a name")
	}
	return c.sdk.call(ctx, "ext/register_agent_spec", spec, nil)
}

// DeregisterAgentSpec removes a runtime-registered agent.
func (c *Context) DeregisterAgentSpec(ctx context.Context, name string) error {
	return c.sdk.call(ctx, "ext/deregister_agent_spec", map[string]string{"name": name}, nil)
}

// SetDispatchContextDefaults sets the context policy dispatched children
// inherit when their own opts do not override it.
func (c *Context) SetDispatchContextDefaults(ctx context.Context, policy ContextPolicy) error {
	return c.sdk.call(ctx, "ext/set_dispatch_context_defaults", policy, nil)
}

// WalkContextFiles runs the engine's context-file discovery and returns what
// it found, without loading any of it into the session.
func (c *Context) WalkContextFiles(ctx context.Context, opts WalkContextFilesOpts) ([]DiscoveredContext, error) {
	var out []DiscoveredContext
	if err := c.sdk.call(ctx, "ext/walk_context_files", opts, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Suspend ends the current run without completing it.
//
// Inside a dispatched run the agent's LLM exits cleanly — saving tokens and
// showing as suspended — the parent's OnComplete does not fire, and the child
// waits to be revived by a prompt or by its own awaited dispatches finishing.
// At the root it parks the session on its outstanding background commands and
// resumes when one completes; the engine rejects it when there is nothing
// outstanding to park on.
func (c *Context) Suspend(ctx context.Context) error {
	return c.sdk.call(ctx, "ext/task_suspend", map[string]any{}, nil)
}

// SuspendUntilAll suspends the current run until every named dispatch
// finishes.
func (c *Context) SuspendUntilAll(ctx context.Context, dispatchIDs []string) error {
	return c.sdk.call(ctx, "ext/task_suspend",
		map[string]any{"awaitingDispatchIds": dispatchIDs}, nil)
}
