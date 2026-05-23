package extcontext

import (
	"fmt"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// BuildDispatchAgentFunc returns the DispatchAgent closure that creates a
// child session within the engine with optional extension loading, system
// prompt injection, and event streaming.
func BuildDispatchAgentFunc(sa SessionAccessor) func(extension.DispatchAgentOpts) (*extension.DispatchAgentResult, error) {
	return func(opts extension.DispatchAgentOpts) (*extension.DispatchAgentResult, error) {
		start := time.Now()

		// Determine model and project path.
		model := opts.Model
		if model == "" {
			if cfg := sa.EngineConfig(); cfg != nil {
				model = cfg.DefaultModel
			}
		}
		projectPath := opts.ProjectPath
		if projectPath == "" {
			projectPath = sa.WorkingDirectory()
		}

		// Create child backend matching the parent session's backend type.
		child := sa.NewChildBackend()
		var childCfg *backend.RunConfig

		// Load extension if specified.
		var childExtHost *extension.Host
		if opts.ExtensionDir != "" {
			childExtHost = extension.NewHost()
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
				childExtHost = nil
			} else {
				// Fire session_start on child extension.
				childCtx := NewExtContext(sa)
				_ = childExtHost.FireSessionStart(childCtx)

				// Wire before_agent_start for system prompt.
				basCtx := NewExtContext(sa)
				extSysPrompt, _ := childExtHost.FireBeforeAgentStart(basCtx, extension.AgentInfo{
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

				// Wire tool_call hook for damage-control etc.
				childCfg = &backend.RunConfig{
					Hooks: backend.RunHooks{
						OnToolCall: func(info backend.ToolCallInfo) (*backend.ToolCallResult, error) {
							tcCtx := NewExtContext(sa)
							result, _ := childExtHost.FireToolCall(tcCtx, extension.ToolCallInfo{
								ToolName: info.ToolName,
								ToolID:   info.ToolID,
								Input:    info.Input,
							})
							if result != nil && result.Block {
								return &backend.ToolCallResult{Block: true, Reason: result.Reason}, nil
							}
							return nil, nil
						},
					},
				}
			}
		}

		// Track child cost/tokens and forward events to extension callback.
		var totalCost float64
		var totalInputTokens, totalOutputTokens int
		var childSessionID string

		var result string
		var childErr error
		var childDone sync.WaitGroup
		childDone.Add(1)

		child.OnNormalized(func(_ string, ev types.NormalizedEvent) {
			// Translate child events but do NOT broadcast to the parent socket
			// stream. The extension already receives every child event via the
			// private opts.OnEvent channel (dispatch_event JSON-RPC notification)
			// and decides what to surface by calling ctx.emit().
			ee := sa.TranslateEvent(ev, 0)
			if ee.Type != "" {
				if opts.OnEvent != nil {
					opts.OnEvent(ee)
				}
			}
			// Capture final result, cost, and session ID from TaskCompleteEvent.
			if tc, ok := ev.Data.(*types.TaskCompleteEvent); ok {
				result = tc.Result
				totalCost = tc.CostUsd
				if tc.Usage.InputTokens != nil {
					totalInputTokens = *tc.Usage.InputTokens
				}
				if tc.Usage.OutputTokens != nil {
					totalOutputTokens = *tc.Usage.OutputTokens
				}
				if tc.SessionID != "" {
					childSessionID = tc.SessionID
				}
			}
		})
		child.OnExit(func(_ string, _ *int, _ *string, _ string) {
			childDone.Done()
		})
		child.OnError(func(_ string, err error) {
			childErr = err
		})

		runOpts := types.RunOptions{
			Prompt:      opts.Task,
			Model:       model,
			ProjectPath: projectPath,
		}
		if opts.SystemPrompt != "" {
			runOpts.AppendSystemPrompt = opts.SystemPrompt
		}
		if opts.SessionID != "" {
			runOpts.SessionID = opts.SessionID
		}
		if opts.MaxTurns > 0 {
			runOpts.MaxTurns = opts.MaxTurns
		}

		key := sa.SessionKey()
		childReqID := fmt.Sprintf("%s-dispatch-%s", key, opts.Name)
		// HybridBackend's StartRunWithConfig handles its own routing: for
		// API-routed child models it forwards childCfg to the inner
		// *ApiBackend; for CLI-routed child models it falls back to
		// StartRun and drops childCfg (CliBackend wires hooks via flags).
		// This is the only way to ensure non-Claude child models actually
		// pick up the OnToolCall hook attached above.
		switch c := child.(type) {
		case *backend.ApiBackend:
			if childCfg != nil {
				c.StartRunWithConfig(childReqID, runOpts, childCfg)
			} else {
				c.StartRun(childReqID, runOpts)
			}
		case *backend.HybridBackend:
			if childCfg != nil {
				c.StartRunWithConfig(childReqID, runOpts, childCfg)
			} else {
				c.StartRun(childReqID, runOpts)
			}
		default:
			child.StartRun(childReqID, runOpts)
		}
		childDone.Wait()

		elapsed := time.Since(start).Seconds()

		// Cleanup child extension.
		if childExtHost != nil {
			childExtHost.Dispose()
		}

		if childErr != nil {
			return &extension.DispatchAgentResult{
				Output:       childErr.Error(),
				ExitCode:     1,
				Elapsed:      elapsed,
				Cost:         totalCost,
				InputTokens:  totalInputTokens,
				OutputTokens: totalOutputTokens,
				SessionID:    childSessionID,
			}, childErr
		}

		return &extension.DispatchAgentResult{
			Output:       result,
			ExitCode:     0,
			Elapsed:      elapsed,
			Cost:         totalCost,
			InputTokens:  totalInputTokens,
			OutputTokens: totalOutputTokens,
			SessionID:    childSessionID,
		}, nil
	}
}
