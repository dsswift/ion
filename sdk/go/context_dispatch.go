// context_dispatch.go — agent dispatch, recall, steering, and the context
// policy surface.
//
// Dispatch delegates work to a child agent session. It runs asynchronously by
// default; set WaitForCompletion for foreground terminal output.
//
// Notification routing is keyed by dispatch id first and agent name second.
// Two parallel dispatches of the same agent share a name but not an id, so an
// id-keyed handler is the only way each gets its own terminal callback.
package ion

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
)

// ContextPolicy controls which context files a dispatched child inherits.
// Each field is a pointer so nil means "inherit the session default", distinct
// from an explicit false.
type ContextPolicy struct {
	IncludeGlobalContext  *bool `json:"includeGlobalContext,omitempty"`
	IncludeProjectContext *bool `json:"includeProjectContext,omitempty"`
	ClaudeCompat          *bool `json:"claudeCompat,omitempty"`
}

// DispatchAgentOpts configures a dispatch.
type DispatchAgentOpts struct {
	// Name is the agent to dispatch. Required.
	Name string `json:"name"`
	// Task is what the agent should do. Required.
	Task string `json:"task"`
	// Model overrides the session's model for the child.
	Model string `json:"model,omitempty"`
	// ExtensionDir loads an extension into the child session, giving it the
	// extension's hooks, persona, and tools — including this extension's own
	// dispatch tool, which is what makes n-tier delegation work. Accepts a
	// directory or a direct entry-point path. Pass ctx.Config.ExtensionDir to
	// give the child the same extension as the dispatcher.
	ExtensionDir string `json:"extensionDir,omitempty"`
	// SystemPrompt is the child's persona.
	SystemPrompt string `json:"systemPrompt,omitempty"`
	// ProjectPath overrides the child's working directory.
	ProjectPath string `json:"projectPath,omitempty"`
	// SessionID resumes an existing child session.
	SessionID string `json:"sessionId,omitempty"`
	// MaxTurns caps the child's agent loop. Zero or negative means the
	// engine default.
	MaxTurns int `json:"maxTurns,omitempty"`
	// MaxDispatchDepth caps how deep the child may itself dispatch.
	MaxDispatchDepth int `json:"maxDispatchDepth,omitempty"`
	// PlanMode starts the child in plan mode.
	PlanMode bool `json:"planMode,omitempty"`
	// PlanFilePath is where the child writes its plan.
	PlanFilePath string `json:"planFilePath,omitempty"`
	// PlanModeTools overrides the tools available in the child's plan mode.
	PlanModeTools []string `json:"planModeTools,omitempty"`
	// AllowedTools restricts the child's tool set.
	AllowedTools []string `json:"allowedTools,omitempty"`
	// AllowedSubAgents restricts which agents the child may dispatch.
	AllowedSubAgents []string `json:"allowedSubAgents,omitempty"`
	// SubAgentPolicy decides what an empty AllowedSubAgents means:
	// "allowlist" makes it a hard restriction (an empty list means the child
	// may dispatch NOTHING), "unrestricted" (the engine default) leaves an
	// empty list meaning no restriction at all. A harness that fans out
	// through leaf agents sets "allowlist", because the default lets a leaf
	// agent dispatch anything — including re-dispatching its own lead into
	// the depth cap.
	SubAgentPolicy string `json:"subAgentPolicy,omitempty"`
	// ImplementationPhase marks the child as executing an approved plan.
	ImplementationPhase bool `json:"implementationPhase,omitempty"`
	// SuppressTools removes tools from the child's set.
	SuppressTools []string `json:"suppressTools,omitempty"`
	// ContextPolicy overrides which context files the child inherits.
	ContextPolicy *ContextPolicy `json:"contextPolicy,omitempty"`
	// FallbackChain is the child's model fallback order.
	FallbackChain []string `json:"fallbackChain,omitempty"`
	// DisplayName is the label clients show for this dispatch.
	DisplayName string `json:"displayName,omitempty"`
	// WaitForCompletion is the explicit foreground opt-in. When false,
	// including when omitted, dispatch returns a stub immediately and terminal
	// callbacks observe completion asynchronously.
	WaitForCompletion bool `json:"waitForCompletion,omitempty"`
	// Background remains accepted for compatibility with older engine versions.
	// It no longer selects execution mode; use WaitForCompletion for foreground
	// dispatch.
	// Deprecated: use WaitForCompletion.
	Background bool `json:"background,omitempty"`

	// --- Callbacks. Local only; never serialised. ---

	// OnComplete fires when an asynchronous dispatch finishes successfully.
	OnComplete func(DispatchAgentResult) `json:"-"`
	// OnError fires when an asynchronous dispatch fails.
	OnError func(DispatchError) `json:"-"`
	// OnRecall fires when an asynchronous dispatch is cancelled by
	// [Context.RecallAgent].
	OnRecall func(RecallInfo) `json:"-"`
	// OnEvent receives the child's raw engine events.
	OnEvent func(EngineEvent) `json:"-"`
	// OnToolStart fires as the child begins a tool call.
	OnToolStart func(DispatchToolStartInfo) `json:"-"`
	// OnToolEnd fires when the child's tool call succeeds.
	OnToolEnd func(DispatchToolEndInfo) `json:"-"`
	// OnToolError fires when the child's tool call fails.
	OnToolError func(DispatchToolErrorInfo) `json:"-"`
	// OnUsage fires with per-turn and cumulative token usage.
	OnUsage func(DispatchUsageInfo) `json:"-"`
	// OnTextDelta fires with the child's streaming text.
	OnTextDelta func(DispatchTextDeltaInfo) `json:"-"`
	// OnPlanProposal fires when the child proposes a plan.
	OnPlanProposal func(DispatchPlanProposalInfo) `json:"-"`
	// OnChildQuestion fires when the child asks the operator a question. The
	// child's run blocks until this returns, so answer promptly.
	OnChildQuestion func(DispatchChildQuestionInfo) (answer string, cancelled bool, err error) `json:"-"`
}

// DispatchAgentResult is a dispatch's outcome. For an asynchronous dispatch the
// immediate return is a stub carrying DispatchID; the real result arrives via
// OnComplete.
type DispatchAgentResult struct {
	Name         string  `json:"name"`
	Output       string  `json:"output"`
	ExitCode     int     `json:"exitCode"`
	Elapsed      float64 `json:"elapsed"`
	Cost         float64 `json:"cost"`
	InputTokens  int     `json:"inputTokens"`
	OutputTokens int     `json:"outputTokens"`
	// DispatchID identifies this dispatch instance. Use it to steer or recall
	// when several dispatches share an agent name.
	DispatchID               string `json:"dispatchId,omitempty"`
	ThinkingTokens           int    `json:"thinkingTokens,omitempty"`
	CacheReadInputTokens     int    `json:"cacheReadInputTokens,omitempty"`
	CacheCreationInputTokens int    `json:"cacheCreationInputTokens,omitempty"`
	SessionID                string `json:"sessionId,omitempty"`
	PlanFilePath             string `json:"planFilePath,omitempty"`
	PlanExited               bool   `json:"planExited,omitempty"`
	Depth                    int    `json:"depth,omitempty"`
	ParentDispatchID         string `json:"parentDispatchId,omitempty"`
}

// DispatchError is a failed asynchronous dispatch.
type DispatchError struct {
	Name       string  `json:"name"`
	DispatchID string  `json:"dispatchId,omitempty"`
	Message    string  `json:"message"`
	ExitCode   int     `json:"exitCode"`
	Elapsed    float64 `json:"elapsed"`
}

// RecallInfo describes a cancelled asynchronous dispatch.
type RecallInfo struct {
	Name       string  `json:"name"`
	DispatchID string  `json:"dispatchId,omitempty"`
	Reason     string  `json:"reason"`
	Elapsed    float64 `json:"elapsed"`
	ToolCount  int     `json:"toolCount"`
}

// SteerDispatchResult reports whether a steer message reached its target.
// Outcome is "steered" (delivered mid-run), "sent" (the target was idle and
// received a fresh prompt), or "not_found".
type SteerDispatchResult struct {
	Delivered bool   `json:"delivered"`
	Outcome   string `json:"outcome"`
}

// DispatchStateEntry is one in-flight dispatch from
// [Context.ListDispatchState]. Status is always "running": the registry holds
// only live dispatches.
type DispatchStateEntry struct {
	DispatchID       string `json:"dispatchId"`
	Name             string `json:"name"`
	Status           string `json:"status"`
	ParentDispatchID string `json:"parentDispatchId,omitempty"`
	Depth            int    `json:"depth"`
	StartedAt        string `json:"startedAt"`
	ElapsedMs        int64  `json:"elapsedMs"`
}

// DispatchToolStartInfo reports a child beginning a tool call.
type DispatchToolStartInfo struct {
	Name       string `json:"name"`
	DispatchID string `json:"dispatchId,omitempty"`
	ToolName   string `json:"toolName"`
	ToolID     string `json:"toolId"`
}

// DispatchToolEndInfo reports a child's successful tool call.
type DispatchToolEndInfo struct {
	Name       string `json:"name"`
	DispatchID string `json:"dispatchId,omitempty"`
	ToolName   string `json:"toolName"`
	ToolID     string `json:"toolId"`
	Content    string `json:"content"`
}

// DispatchToolErrorInfo reports a child's failed tool call.
type DispatchToolErrorInfo struct {
	Name       string `json:"name"`
	DispatchID string `json:"dispatchId,omitempty"`
	ToolName   string `json:"toolName"`
	ToolID     string `json:"toolId"`
	Content    string `json:"content"`
}

// DispatchUsageInfo reports a child's token usage.
type DispatchUsageInfo struct {
	Name                   string  `json:"name"`
	DispatchID             string  `json:"dispatchId,omitempty"`
	InputTokens            int     `json:"inputTokens"`
	OutputTokens           int     `json:"outputTokens"`
	CumulativeInputTokens  int     `json:"cumulativeInputTokens"`
	CumulativeOutputTokens int     `json:"cumulativeOutputTokens"`
	CumulativeCost         float64 `json:"cumulativeCost"`
}

// DispatchTextDeltaInfo carries a child's streaming text.
type DispatchTextDeltaInfo struct {
	Name        string `json:"name"`
	DispatchID  string `json:"dispatchId,omitempty"`
	Delta       string `json:"delta"`
	Accumulated string `json:"accumulated"`
}

// DispatchPlanProposalInfo reports a plan a child proposed.
type DispatchPlanProposalInfo struct {
	Name          string `json:"name"`
	AgentID       string `json:"agentId"`
	PlanFilePath  string `json:"planFilePath"`
	PlanSlug      string `json:"planSlug"`
	PlanRequested bool   `json:"planRequested"`
}

// DispatchChildQuestionInfo is a question from a child. The child's run is
// blocked until the answer arrives.
type DispatchChildQuestionInfo struct {
	Name       string `json:"name"`
	DispatchID string `json:"dispatchId"`
	RequestID  string `json:"requestId"`
	Question   string `json:"question"`
	Depth      int    `json:"depth"`
}

// AgentSpec declares an LLM-visible agent at runtime. Mirrors an agent
// markdown file's frontmatter. Specs live for the session; persisting them is
// the harness's job.
type AgentSpec struct {
	Name         string   `json:"name"`
	Description  string   `json:"description,omitempty"`
	Model        string   `json:"model,omitempty"`
	Tools        []string `json:"tools,omitempty"`
	Parent       string   `json:"parent,omitempty"`
	SystemPrompt string   `json:"systemPrompt,omitempty"`
}

// DiscoverAgentsOpts scopes [Context.DiscoverAgents].
type DiscoverAgentsOpts struct {
	// Sources filters by origin: "extension", "user", "project", "extra".
	Sources []string `json:"sources,omitempty"`
	// ExtraDirs adds directories to the walk.
	ExtraDirs []string `json:"extraDirs,omitempty"`
	// BundleName scopes to one extension bundle.
	BundleName string `json:"bundleName,omitempty"`
	// Recursive walks subdirectories. Nil uses the engine default.
	Recursive *bool `json:"recursive,omitempty"`
}

// DiscoveredAgent is one agent found by [Context.DiscoverAgents].
type DiscoveredAgent struct {
	Name         string   `json:"name"`
	Path         string   `json:"path"`
	Source       string   `json:"source"`
	Parent       string   `json:"parent,omitempty"`
	Description  string   `json:"description,omitempty"`
	Model        string   `json:"model,omitempty"`
	Tools        []string `json:"tools,omitempty"`
	SystemPrompt string   `json:"systemPrompt,omitempty"`
	// Meta holds frontmatter keys the engine does not itself consume.
	Meta map[string]string `json:"meta,omitempty"`
}

// DiscoveredContext is one context file found by [Context.WalkContextFiles].
type DiscoveredContext struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	// Source is "global", "project", "parent", or "include".
	Source string `json:"source"`
	// Level is the directory distance from cwd: 0 is cwd, 1 its parent.
	Level int `json:"level"`
}

// WalkContextFilesOpts scopes [Context.WalkContextFiles]. The pointer fields
// distinguish "not specified" from an explicit false.
type WalkContextFilesOpts struct {
	Cwd            string `json:"cwd,omitempty"`
	IncludeGlobal  *bool  `json:"includeGlobal,omitempty"`
	IncludeProject *bool  `json:"includeProject,omitempty"`
	ClaudeCompat   *bool  `json:"claudeCompat,omitempty"`
}

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

// RecallAgent cancels a running asynchronous dispatch. Reports whether a
// matching dispatch was found.
func (c *Context) RecallAgent(ctx context.Context, name, reason string) (bool, error) {
	var out struct {
		Found bool `json:"found"`
	}
	err := c.sdk.call(ctx, "ext/recall_agent", map[string]string{"name": name, "reason": reason}, &out)
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

// --- Notification routing ---

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

// bindTerminal registers terminal callbacks under a dispatch ID. New dispatch
// calls use terminalBinding to also protect the pre-stub name-routing window;
// this helper remains available for callers that already hold an ID.
func (r *notificationRouter) bindTerminal(dispatchID string, opts DispatchAgentOpts, cleanup func()) {
	var once sync.Once
	terminal := func(fire func(json.RawMessage)) func(json.RawMessage) {
		return func(params json.RawMessage) {
			once.Do(func() {
				r.mu.Lock()
				for _, m := range []string{"dispatch_complete", "dispatch_error", "dispatch_recall"} {
					delete(r.handlers, m+":"+dispatchID)
				}
				r.mu.Unlock()
				cleanup()
			})
			if fire != nil {
				fire(params)
			}
		}
	}

	r.mu.Lock()
	r.handlers["dispatch_complete:"+dispatchID] = terminal(decodeIntoOptional(r.sdk, opts.OnComplete))
	r.handlers["dispatch_error:"+dispatchID] = terminal(decodeIntoOptional(r.sdk, opts.OnError))
	r.handlers["dispatch_recall:"+dispatchID] = terminal(decodeIntoOptional(r.sdk, opts.OnRecall))
	r.mu.Unlock()
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
