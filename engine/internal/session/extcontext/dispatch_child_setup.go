package extcontext

import (
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
	if err := childExtHost.Load(opts.ExtensionDir, extCfg); err != nil {
		utils.Log("Session", "child extension load failed: "+err.Error())
		return nil
	}

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

// startChild dispatches the child run on the appropriate backend. This
// centralizes the type-switch logic for ApiBackend/HybridBackend/generic.
func startChild(child backend.RunBackend, reqID string, runOpts types.RunOptions, cfg *backend.RunConfig) {
	switch c := child.(type) {
	case *backend.ApiBackend:
		if cfg != nil {
			c.StartRunWithConfig(reqID, runOpts, cfg)
		} else {
			c.StartRun(reqID, runOpts)
		}
	case *backend.HybridBackend:
		if cfg != nil {
			c.StartRunWithConfig(reqID, runOpts, cfg)
		} else {
			c.StartRun(reqID, runOpts)
		}
	default:
		child.StartRun(reqID, runOpts)
	}
}
