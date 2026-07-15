package extcontext

import (
	"context"
	"fmt"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// loadChildExtension loads the child extension if specified in opts. Returns
// the Host (nil if no extension or load failed). Modifies opts.SystemPrompt
// in-place if the extension provides additional system prompt content.
// childDepth and childDispatchId are passed through so extension contexts
// built for this child carry the correct dispatch ancestry. It fires
// session_start and before_agent_start so the child's system prompt is
// composed before the run begins.
//
// Split out of dispatch_agent.go (same package) to keep that file under the
// 800-line cap; see dispatch_lifecycle_callbacks.go for the same rationale.
func loadChildExtension(sa SessionAccessor, registry *DispatchRegistry, opts *extension.DispatchAgentOpts, model, projectPath string, childDepth int, childDispatchId string) *extension.Host {
	if opts.ExtensionDir == "" {
		return nil
	}

	childExtHost := extension.NewHost()
	if cfg := sa.EngineConfig(); cfg != nil && cfg.Timeouts != nil {
		childExtHost.SetRPCTimeout(cfg.Timeouts.ExtensionRpc())
	}
	extCfg := &extension.ExtensionConfig{
		ExtensionDir:     opts.ExtensionDir,
		Model:            model,
		WorkingDirectory: projectPath,
	}
	// Make nested dispatch working-directory resolution observable: the child
	// extension is configured with the resolved projectPath here, so log it
	// alongside the dispatch id and depth for the child.
	utils.LogWithFields(utils.LevelDebug, "server", "dispatch child setup", map[string]any{"model": opts.Name, "project_path": projectPath, "child_dispatch_id": childDispatchId, "child_depth": childDepth, "session_key": sa.SessionKey()})
	if err := childExtHost.Load(opts.ExtensionDir, extCfg); err != nil {
		utils.LogWithFields(utils.LevelInfo, "session", "child extension load failed", map[string]any{"error": err.Error()})
		return nil
	}

	// Wire sendPrompt on the child host so background lifecycle callbacks
	// (e.g. onChildQuestion → bubbleToParent → ctx.sendPrompt) can reach the
	// root session's prompt queue at any dispatch depth. Without this, the child
	// host's ext/send_prompt fallback path reads h.onSendMessage — which is nil
	// on child hosts (only the root host gets it wired in start_session.go) —
	// and returns "sendPrompt not available: no active session", silently
	// dropping the delivery and leaving the child run blocked until timeout.
	// Mirrors the root wiring in start_session.go exactly: route through
	// sa.SendPrompt so the delivery lands on the root session's run loop.
	capturedSA := sa
	childExtHost.SetOnSendMessage(func(payload extension.SendPromptPayload) {
		_ = capturedSA.SendPrompt(payload.Text, payload.Model, payload.BashAllowlistAdditions)
	})

	// Fire session_start on child extension.
	childCtx := NewExtContext(sa, ExtContextOpts{
		Depth:      childDepth,
		DispatchId: childDispatchId,
		Registry:   registry,
	})
	_ = childExtHost.FireSessionStart(childCtx)

	// Wire before_agent_start for system prompt.
	basCtx := NewExtContext(sa, ExtContextOpts{
		Depth:      childDepth,
		DispatchId: childDispatchId,
		Registry:   registry,
	})
	extSysPrompt, _, _ := childExtHost.FireBeforeAgentStart(basCtx, extension.AgentInfo{
		Name: opts.Name,
		Task: opts.Task,
	})
	if extSysPrompt != "" {
		if opts.SystemPrompt != "" {
			opts.SystemPrompt = opts.SystemPrompt + "\n\n" + extSysPrompt
		} else {
			opts.SystemPrompt = extSysPrompt
		}
	}

	return childExtHost
}

// wireChildExtensionTools attaches the child extension's registered tools to
// the child RunConfig so the child's LLM can call them (ExternalTools) and
// route their execution back to the child extension host (McpToolRouter).
//
// This is the dispatch-path analogue of Manager.wireExternalTools
// (prompt_runconfig.go), which performs the same wiring for root sessions.
// Without it, loadChildExtension composed the child's persona and fired its
// hooks but the extension's tools never reached the child's tool list — the
// gap that silently broke every harness whose dispatched leads delegate via a
// harness-registered dispatch tool.
//
// Tool execute contexts carry the child's depth and dispatch ID so a
// harness dispatch tool invoked from inside the child produces grandchildren
// with correct ancestry (depth+1 chains, allowlist carry-forward).
//
// MCP connections are intentionally NOT wired here: MCP servers belong to the
// root session's lifecycle. Only extension-registered tools are forwarded.
func wireChildExtensionTools(
	sa SessionAccessor,
	registry *DispatchRegistry,
	childExtHost *extension.Host,
	childCfg *backend.RunConfig,
	childDepth int,
	childDispatchId string,
) {
	extTools := childExtHost.Tools()
	if len(extTools) == 0 {
		utils.LogWithFields(utils.LevelInfo, "session.extcontext", "child extension tools: none registered", map[string]any{"child_dispatch_id": childDispatchId, "child_depth": childDepth, "session_key": sa.SessionKey()})
		return
	}

	toolDefs := make([]types.LlmToolDef, 0, len(extTools))
	for _, tool := range extTools {
		utils.LogWithFields(utils.LevelInfo, "session.extcontext", "child extension tool wired", map[string]any{"model": tool.Name, "child_dispatch_id": childDispatchId, "child_depth": childDepth, "session_key": sa.SessionKey()})
		toolDefs = append(toolDefs, types.LlmToolDef{
			Name:         tool.Name,
			Description:  tool.Description,
			InputSchema:  tool.Parameters,
			PlanModeSafe: tool.PlanModeSafe,
		})
	}
	childCfg.ExternalTools = toolDefs

	capturedHost := childExtHost
	capturedSA := sa
	capturedRegistry := registry
	capturedDepth := childDepth
	capturedDispatchId := childDispatchId
	childCfg.McpToolRouter = func(ctx context.Context, name string, input map[string]interface{}) (*types.ToolResult, error) {
		for _, tool := range capturedHost.Tools() {
			if tool.Name != name {
				continue
			}
			// Build a depth-aware extension context so tools that dispatch
			// (the harness's dispatch_agent) mint grandchildren at depth+1
			// under this child's dispatch ID. The accessor carries no
			// per-tool DeadlineSuspender (that is a root-session Manager
			// facility); an Elicit reached through a child tool waits under
			// session lifecycle only, the same as hook-path elicits.
			_ = ctx
			extCtx := NewExtContext(capturedSA, ExtContextOpts{
				Depth:      capturedDepth,
				DispatchId: capturedDispatchId,
				Registry:   capturedRegistry,
			})
			result, err := tool.Execute(input, extCtx)
			if err != nil {
				return &types.ToolResult{Content: err.Error(), IsError: true}, nil
			}
			if result == nil {
				return &types.ToolResult{}, nil
			}
			return result, nil
		}
		return nil, fmt.Errorf("extension tool %q not found in child host", name)
	}
}

// suspendableBackend is satisfied by backends that can park an in-flight run
// without cancelling it (the suspend primitive). Both *ApiBackend and any
// backend that wraps it implement this. CliBackend does not; dispatch children
// always use ApiBackend via HybridBackend, so this is always resolvable for
// dispatched children.
type suspendableBackend interface {
	SignalSuspend(requestID string, awaitingDispatchIDs []string) bool
}

// configurableBackend is satisfied by any backend that can accept a per-run
// RunConfig. Detection is by interface assertion (not a concrete type switch)
// so that any backend implementing StartRunWithConfig — the production
// *ApiBackend and *HybridBackend, plus test stubs that opt in — threads the
// config through. The prior concrete type switch silently dropped the
// RunConfig for any other backend type (a wrapped backend, a test stub),
// which lost DefaultModel threading and the AgentSpawner. Mirrors the
// session-package startChildRun in backend_helpers.go.
type configurableBackend interface {
	StartRunWithConfig(requestID string, options types.RunOptions, cfg *backend.RunConfig)
}

// startChild dispatches the child run on the appropriate backend. When a
// RunConfig is supplied and the backend can accept it, the config is threaded
// through (carrying DefaultModel, the AgentSpawner for nested dispatch, hooks,
// etc.); otherwise the run degrades to the plain StartRun path.
func startChild(child backend.RunBackend, reqID string, runOpts types.RunOptions, cfg *backend.RunConfig) {
	if cfg != nil {
		if cb, ok := child.(configurableBackend); ok {
			cb.StartRunWithConfig(reqID, runOpts, cfg)
			return
		}
	}
	// CliBackend, generic test stubs, or any backend that doesn't carry
	// RunConfig fall through to the plain interface method.
	child.StartRun(reqID, runOpts)
}

// logDispatchWorkdir emits the resolved working directory for a dispatch,
// including which branch supplied it (source=opts when the caller passed
// ProjectPath, source=fallback when it was inherited from the parent session).
// This closes the dispatch cwd logging gap: the root session logs its cwd at
// start (start_session.go), but a dispatched child's resolved cwd was
// previously never logged. Lives here (rather than inline in dispatch_agent.go)
// to keep that file under the 800-line cap; it is a pure log addition.
func logDispatchWorkdir(agentName, projectPath, source, dispatchID string, depth int, sessionKey string) {
	utils.LogWithFields(utils.LevelInfo, "session.extcontext", "dispatch working directory resolved", map[string]any{
		"model": agentName, "path": projectPath, "source": source, "run_id": dispatchID, "count": depth, "session_id": sessionKey,
	})
}
