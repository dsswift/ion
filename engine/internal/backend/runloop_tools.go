package backend

import (
	"context"
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/sandbox"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
	"golang.org/x/sync/errgroup"
)

// executeTools runs tool calls in parallel using errgroup.
func (b *ApiBackend) executeTools(
	ctx context.Context,
	run *activeRun,
	toolUseBlocks []types.LlmContentBlock,
	cwd string,
) ([]conversation.ToolResultEntry, error) {

	results := make([]conversation.ToolResultEntry, len(toolUseBlocks))
	g, gCtx := errgroup.WithContext(ctx)

	// All per-run configuration lives on run.cfg. Reading it without a lock
	// is safe because cfg is set once at StartRun and never mutated.
	var hooks RunHooks
	var permEng *permissions.Engine
	var sbCfg *sandbox.Config
	var mcpRouter func(string, map[string]interface{}) (string, bool, error)
	var telem TelemetryCollector
	var spawnerFn tools.AgentSpawner
	if run.cfg != nil {
		hooks = run.cfg.Hooks
		permEng = run.cfg.PermEngine
		sbCfg = run.cfg.SandboxCfg
		mcpRouter = run.cfg.McpToolRouter
		telem = run.cfg.Telemetry
		spawnerFn = run.cfg.AgentSpawner
	}
	hookFn := hooks.OnToolCall
	perToolHook := hooks.OnPerToolHook
	fileChangedFn := hooks.OnFileChanged
	permReqFn := hooks.OnPermissionRequest
	permDenyFn := hooks.OnPermissionDenied
	permClassifyFn := hooks.OnPermissionClassify

	// Inject session-scoped agent spawner into context for Agent tool
	if spawnerFn != nil {
		gCtx = tools.WithAgentSpawner(gCtx, spawnerFn)
	}

	for i, block := range toolUseBlocks {
		i, block := i, block
		g.Go(func() error {
			// Permission check (Step 3)
			if permEng != nil {
				// Classify first so the tier flows into the permission engine
				// (for tier_rules matching) and onto the permission_request
				// hook payload (for audit/observation). The classifier may
				// invoke an LLM, so race against gCtx so a hung classifier
				// can't wedge this goroutine.
				var tier string
				if permClassifyFn != nil {
					t, hookErr := runHookCtx(gCtx, func() string {
						return permClassifyFn(block.Name, block.Input)
					})
					if hookErr != nil {
						return hookErr
					}
					tier = t
				}
				checkResult := permEng.Check(permissions.CheckInfo{
					Tool:  block.Name,
					Input: block.Input,
					Cwd:   cwd,
					Tier:  tier,
				})
				if permReqFn != nil {
					payload := map[string]interface{}{
						"tool_name": block.Name,
						"input":     block.Input,
						"decision":  checkResult.Decision,
					}
					if tier != "" {
						payload["tier"] = tier
					}
					if _, hookErr := runHookCtx(gCtx, func() struct{} {
						permReqFn(run.requestID, payload)
						return struct{}{}
					}); hookErr != nil {
						return hookErr
					}
				}
				if checkResult.Decision == "deny" {
					if permDenyFn != nil {
						if _, hookErr := runHookCtx(gCtx, func() struct{} {
							permDenyFn(run.requestID, map[string]interface{}{
								"tool_name": block.Name,
								"input":     block.Input,
								"reason":    checkResult.Reason,
							})
							return struct{}{}
						}); hookErr != nil {
							return hookErr
						}
					}
					results[i] = conversation.ToolResultEntry{
						ToolUseID: block.ID,
						Content:   "Permission denied: " + checkResult.Reason,
						IsError:   true,
					}
					b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
						ToolID:  block.ID,
						Content: results[i].Content,
						IsError: true,
					}})
					return nil
				}
			}

			// Sandbox validation for Bash tool (Step 3)
			if (block.Name == "Bash" || block.Name == "bash") && sbCfg != nil {
				if cmd, ok := block.Input["command"].(string); ok {
					safe, reason := sandbox.ValidateWithConfig(cmd, *sbCfg)
					if !safe {
						results[i] = conversation.ToolResultEntry{
							ToolUseID: block.ID,
							Content:   "Sandbox blocked: " + reason,
							IsError:   true,
						}
						b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
							ToolID:  block.ID,
							Content: results[i].Content,
							IsError: true,
						}})
						return nil
					}
				}
			}

			// After sandbox validation passes, wrap if sandbox config exists
			if (block.Name == "Bash" || block.Name == "bash") && sbCfg != nil {
				if cmd, ok := block.Input["command"].(string); ok {
					if wrapped, err := sandbox.WrapCommand(cmd, *sbCfg, ""); err == nil && wrapped != cmd {
						block.Input["command"] = wrapped
					}
				}
			}

			// Call onToolCall hook (extension hook). Race against gCtx so a
			// hung extension subprocess can't wedge this goroutine; the run's
			// per-tool 5min timeout is the outer backstop.
			if hookFn != nil {
				type hookRet struct {
					result *ToolCallResult
					err    error
				}
				ret, hookErr := runHookCtx(gCtx, func() hookRet {
					r, e := hookFn(ToolCallInfo{
						ToolName: block.Name,
						ToolID:   block.ID,
						Input:    block.Input,
					})
					return hookRet{r, e}
				})
				if hookErr != nil {
					return hookErr
				}
				result, err := ret.result, ret.err
				if err != nil {
					results[i] = conversation.ToolResultEntry{
						ToolUseID: block.ID,
						Content:   "Hook error: " + err.Error(),
						IsError:   true,
					}
					return nil
				}
				if result != nil && result.Block {
					results[i] = conversation.ToolResultEntry{
						ToolUseID: block.ID,
						Content:   "Blocked: " + result.Reason,
						IsError:   true,
					}
					b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
						ToolID:  block.ID,
						Content: "Blocked: " + result.Reason,
						IsError: true,
					}})
					return nil
				}
			}

			// Pre-tool hook
			if perToolHook != nil {
				if _, hookErr := runHookCtx(gCtx, func() struct{} {
					_, _ = perToolHook(block.Name, block.Input, "before")
					return struct{}{}
				}); hookErr != nil {
					return hookErr
				}
			}

			// Telemetry span for tool execution
			var toolSpan Span
			if telem != nil {
				toolSpan = telem.StartSpan("tool.execute", map[string]interface{}{
					"tool": block.Name,
				})
			}

			// Plan mode write gate: only the plan file is writable.
			if run.planMode && (block.Name == "Write" || block.Name == "Edit") {
				if targetPath, ok := block.Input["file_path"].(string); ok {
					if targetPath != run.planFilePath {
						utils.Info("PlanMode", fmt.Sprintf("run=%s blocked=%s target=%s plan_file=%s", run.requestID, block.Name, targetPath, run.planFilePath))
						msg := fmt.Sprintf("Plan mode: cannot write to %s. Only the plan file (%s) is writable.", targetPath, run.planFilePath)
						results[i] = conversation.ToolResultEntry{
							ToolUseID: block.ID,
							Content:   msg,
							IsError:   true,
						}
						b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
							ToolID:  block.ID,
							Content: msg,
							IsError: true,
						}})
						return nil
					}
				}
			}

			// Intercept ExitPlanMode sentinel — only during plan-mode runs.
			// In auto mode the LLM may hallucinate this call from conversation
			// history; let it fall through to "Unknown tool" so it self-corrects.
			if run.planMode && block.Name == tools.ExitPlanModeName {
				utils.Info("PlanMode", fmt.Sprintf("run=%s exit_tool plan_file=%s", run.requestID, run.planFilePath))
				run.mu.Lock()
				run.exitPlanMode = true
				run.permissionDenials = append(run.permissionDenials, types.PermissionDenial{
					ToolName:  block.Name,
					ToolUseID: block.ID,
					ToolInput: map[string]any{"planFilePath": run.planFilePath},
				})
				run.mu.Unlock()
				// Signal to the desktop that plan mode is now exiting.
				b.emit(run, types.NormalizedEvent{Data: &types.PlanModeChangedEvent{Enabled: false, PlanFilePath: run.planFilePath}})
				results[i] = conversation.ToolResultEntry{
					ToolUseID: block.ID,
					Content:   "Plan mode exited.",
					IsError:   false,
				}
				b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
					ToolID:  block.ID,
					Content: "Plan mode exited.",
					IsError: false,
				}})
				return nil
			}

			// Stall detection: emit ToolStalledEvent if the tool hasn't
			// returned within the stall threshold. Informational only.
			// Capture the threshold locally so the goroutine doesn't race
			// with tests that reassign the package-level var.
			stallThreshold := toolStallThreshold
			toolDone := make(chan struct{})
			go func() {
				stallTimer := time.NewTimer(stallThreshold)
				defer stallTimer.Stop()
				select {
				case <-stallTimer.C:
					b.emit(run, types.NormalizedEvent{Data: &types.ToolStalledEvent{
						ToolID:   block.ID,
						ToolName: block.Name,
						Elapsed:  stallThreshold.Seconds(),
					}})
				case <-toolDone:
					// Tool finished before stall threshold; nothing to do.
				}
			}()

			// Route to built-in, extension, or MCP tool (Step 5).
			// Each tool call is bounded by defaultToolTimeout. A tool that
			// observes ctx will cancel cleanly; a tool that ignores ctx will
			// be left running but its result is dropped, and executeTools
			// returns once errgroup's children all return.
			toolCtx, toolCancel := context.WithTimeout(gCtx, defaultToolTimeout)
			defer toolCancel()

			var toolResult *types.ToolResult
			var err error

			if tools.GetTool(block.Name) != nil {
				toolResult, err = tools.ExecuteTool(toolCtx, block.Name, block.Input, cwd)
			} else if mcpRouter != nil {
				// mcpRouter does not yet take ctx; race its return against
				// toolCtx so a hung MCP server cannot wedge the run.
				type mcpRet struct {
					content string
					isErr   bool
					err     error
				}
				resCh := make(chan mcpRet, 1)
				go func() {
					content, isErr, routeErr := mcpRouter(block.Name, block.Input)
					resCh <- mcpRet{content, isErr, routeErr}
				}()
				select {
				case r := <-resCh:
					if r.err != nil {
						err = r.err
					} else {
						toolResult = &types.ToolResult{Content: r.content, IsError: r.isErr}
					}
				case <-toolCtx.Done():
					err = toolCtx.Err()
				}
			} else {
				toolResult = &types.ToolResult{
					Content: fmt.Sprintf("Unknown tool: %s", block.Name),
					IsError: true,
				}
			}

			// Surface per-tool deadline as a tool-result error rather than
			// failing the whole run, so the LLM sees a clear "this tool timed
			// out" message and can adapt.
			if err != nil && toolCtx.Err() == context.DeadlineExceeded {
				err = nil
				toolResult = &types.ToolResult{
					Content: fmt.Sprintf("Error: tool %q exceeded %s deadline. Narrow the request or split it into smaller calls.", block.Name, defaultToolTimeout),
					IsError: true,
				}
			}

			// Signal stall timer that the tool has completed.
			close(toolDone)

			// End tool span
			if toolSpan != nil {
				errStr := ""
				if err != nil {
					errStr = err.Error()
				}
				toolSpan.End(nil, errStr)
			}

			if err != nil {
				results[i] = conversation.ToolResultEntry{
					ToolUseID: block.ID,
					Content:   "Error: " + err.Error(),
					IsError:   true,
				}
			} else {
				results[i] = conversation.ToolResultEntry{
					ToolUseID: block.ID,
					Content:   toolResult.Content,
					IsError:   toolResult.IsError,
				}
			}

			// Fire file_changed hook for write/edit tools
			if fileChangedFn != nil && !results[i].IsError {
				var p string
				var changeKind string
				switch block.Name {
				case "Write", "write":
					if v, ok := block.Input["file_path"].(string); ok {
						p, changeKind = v, "write"
					}
				case "Edit", "edit":
					if v, ok := block.Input["file_path"].(string); ok {
						p, changeKind = v, "edit"
					}
				}
				if p != "" {
					if _, hookErr := runHookCtx(gCtx, func() struct{} {
						fileChangedFn(run.requestID, p, changeKind)
						return struct{}{}
					}); hookErr != nil {
						return hookErr
					}
				}
			}

			// Post-tool hook
			if perToolHook != nil {
				if _, hookErr := runHookCtx(gCtx, func() struct{} {
					_, _ = perToolHook(block.Name, results[i], "after")
					return struct{}{}
				}); hookErr != nil {
					return hookErr
				}
			}

			// Emit tool_result event
			b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
				ToolID:  block.ID,
				Content: results[i].Content,
				IsError: results[i].IsError,
			}})

			return nil
		})
	}

	if err := g.Wait(); err != nil {
		return nil, err
	}
	return results, nil
}
