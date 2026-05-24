package backend

import (
	"context"
	"fmt"
	"os"
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

	// Inject history searcher scoped to this run's conversation so the
	// SearchHistory tool can find content lost to compaction.
	if run.conv != nil {
		conv := run.conv // capture for closure
		gCtx = tools.WithHistorySearcher(gCtx, func(query string, maxResults int) []conversation.HistoryMatch {
			return conversation.SearchMessages(conv, query, maxResults)
		})
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
			// When the target IS the plan file but the tool is Write (full
			// replacement), check if the file already has content and record
			// that fact so we can append a warning after execution.
			var planWriteOverwrite bool
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
					// Track whether Write is overwriting existing plan content.
					if block.Name == "Write" {
						if info, err := os.Stat(run.planFilePath); err == nil && info.Size() > 50 {
							planWriteOverwrite = true
						}
					}
				}
			}

			// Intercept ExitPlanMode sentinel — only during plan-mode runs.
			// In auto mode the LLM may hallucinate this call from conversation
			// history; let it fall through to "Unknown tool" so it self-corrects.
			if run.planMode && block.Name == tools.ExitPlanModeName {
				utils.Info("PlanMode", fmt.Sprintf("run=%s exit_tool plan_file=%s", run.requestID, run.planFilePath))

				// Fire before_plan_mode_exit hook so extensions can veto.
				exitAllowed := true
				exitReason := ""
				if hooks.OnPlanModeExit != nil {
					exitAllowed, exitReason = hooks.OnPlanModeExit(run.planFilePath)
				}
				if !exitAllowed {
					if exitReason == "" {
						exitReason = "Plan mode exit was declined. Continue planning."
					}
					utils.Info("PlanMode", fmt.Sprintf("run=%s exit_tool denied by hook reason=%q", run.requestID, exitReason))
					results[i] = conversation.ToolResultEntry{
						ToolUseID: block.ID,
						Content:   exitReason,
						IsError:   false,
					}
					b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
						ToolID:  block.ID,
						Content: exitReason,
						IsError: false,
					}})
					return nil
				}

				run.mu.Lock()
				run.exitPlanMode = true
				run.permissionDenials = append(run.permissionDenials, types.PermissionDenial{
					ToolName:  block.Name,
					ToolUseID: block.ID,
					ToolInput: map[string]any{"planFilePath": run.planFilePath},
				})
				run.mu.Unlock()
				// No PlanModeChangedEvent{Enabled:false} emit here. The model
				// calling ExitPlanMode is a *proposal*, not a confirmed mode
				// change — the user must still approve. The run-end signal
				// (task_complete carrying the ExitPlanMode PermissionDenial)
				// is the canonical card-trigger. Consumers flip their mode to
				// 'auto' only when the user approves via their UI chokepoint.
				//
				// Emit the new PlanProposalEvent{Kind:"exit"} as the primary,
				// first-class workflow signal so consumers can listen for a
				// purpose-built event instead of inferring proposal-state from
				// task_complete + permissionDenials. The permission denial
				// path keeps flowing through engine_status for back-compat
				// (the existing approval-card render path keys off it), and
				// task_complete keeps carrying the denial too. The proposal
				// event is additive — consumers can migrate at their own
				// pace. See docs/architecture/adr/003-state-events-vs-workflow-events.md.
				b.emit(run, types.NormalizedEvent{Data: &types.PlanProposalEvent{
					Kind:         "exit",
					PlanFilePath: run.planFilePath,
					PlanSlug:     types.PlanSlugFromPath(run.planFilePath),
				}})
				utils.Info("PlanMode", fmt.Sprintf("run=%s exit_tool emit plan_proposal kind=exit planFile=%s (mode change deferred to user approval)", run.requestID, run.planFilePath))
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

			// Intercept EnterPlanMode sentinel — only during auto-mode runs.
			// In plan mode the LLM should not call this; fall through to "Unknown
			// tool" so it self-corrects if it does.
			if !run.planMode && block.Name == tools.EnterPlanModeName {
				utils.Info("PlanMode", fmt.Sprintf("run=%s enter_tool requested", run.requestID))
				var allowed bool
				var reason string
				var planFilePath string
				if hooks.OnPlanModeEnter != nil {
					allowed, reason, planFilePath = hooks.OnPlanModeEnter()
				} else {
					// No hook wired — auto-approve (default behaviour).
					allowed = true
				}
				if !allowed {
					if reason == "" {
						reason = "Plan mode entry was declined."
					}
					utils.Info("PlanMode", fmt.Sprintf("run=%s enter_tool denied reason=%q", run.requestID, reason))
					results[i] = conversation.ToolResultEntry{
						ToolUseID: block.ID,
						Content:   reason,
						IsError:   false,
					}
					b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
						ToolID:  block.ID,
						Content: reason,
						IsError: false,
					}})
					return nil
				}
				// Allowed: flip the run into plan mode so the write guard and
				// sparse-reminder logic apply on subsequent turns. The plan-mode
				// tool list will be rebuilt on the next call to buildToolDefs.
				// Reset planModeReminderTurn so the first post-entry reminder
				// is not silenced by stale throttle state from a prior plan
				// mode session on this same run.
				run.mu.Lock()
				run.planMode = true
				run.planFilePath = planFilePath
				run.planModeReminderTurn = 0
				run.mu.Unlock()
				// Emit the state-transition event so consumers can mirror the
				// new plan-mode-enabled state.
				b.emit(run, types.NormalizedEvent{Data: &types.PlanModeChangedEvent{
					Enabled:      true,
					PlanFilePath: planFilePath,
					PlanSlug:     types.PlanSlugFromPath(planFilePath),
				}})
				// Build the plan-mode framing so the model knows what to do next.
				// We include it inline in the tool result so it lands in context
				// on this turn, rather than waiting for the next system-prompt rebuild.
				_, err := os.Stat(planFilePath)
				planPrompt := buildPlanModePrompt(planFilePath, err == nil)
				resultContent := fmt.Sprintf("Plan mode entered. Plan file: %s\n\n%s", planFilePath, planPrompt)
				utils.Info("PlanMode", fmt.Sprintf("run=%s enter_tool allowed planFile=%s", run.requestID, planFilePath))
				results[i] = conversation.ToolResultEntry{
					ToolUseID: block.ID,
					Content:   resultContent,
					IsError:   false,
				}
				b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
					ToolID:  block.ID,
					Content: resultContent,
					IsError: false,
				}})
				return nil
			}

			// Intercept AskUserQuestion sentinel — available in all runs, not
			// just plan mode. Record a PermissionDenial so consumers can surface
			// the question, then terminate the run. The user's answer arrives
			// as the next prompt in the same session.
			if block.Name == tools.AskUserQuestionName {
				utils.Info("ApiBackend", fmt.Sprintf("run=%s ask_user question=%v", run.requestID, block.Input["question"]))
				run.mu.Lock()
				run.exitPlanMode = true
				run.permissionDenials = append(run.permissionDenials, types.PermissionDenial{
					ToolName:  block.Name,
					ToolUseID: block.ID,
					ToolInput: block.Input,
				})
				run.mu.Unlock()
				results[i] = conversation.ToolResultEntry{
					ToolUseID: block.ID,
					Content:   "Question sent to user. Awaiting response.",
					IsError:   false,
				}
				b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
					ToolID:  block.ID,
					Content: "Question sent to user. Awaiting response.",
					IsError: false,
				}})
				return nil
			}

			// Stall detection: emit ToolStalledEvent periodically while the
			// tool runs longer than the stall threshold. The first event fires
			// at stallThreshold, then repeats every stallThreshold until the
			// tool completes. Consumers that run liveness watchdogs use these
			// events to distinguish "still working" from "dead" for tabs that
			// are legitimately running long tools.
			// Capture the threshold locally so the goroutine doesn't race
			// with tests that reassign the package-level var.
			stallThreshold := toolStallThreshold
			if run.cfg != nil && run.cfg.Timeouts != nil {
				stallThreshold = run.cfg.Timeouts.ToolStall()
			}
			toolDone := make(chan struct{})
			go func() {
				ticker := time.NewTicker(stallThreshold)
				defer ticker.Stop()
				ticks := 0
				for {
					select {
					case <-ticker.C:
						ticks++
						b.emit(run, types.NormalizedEvent{Data: &types.ToolStalledEvent{
							ToolID:   block.ID,
							ToolName: block.Name,
							Elapsed:  float64(ticks) * stallThreshold.Seconds(),
						}})
					case <-toolDone:
						return
					}
				}
			}()

			// Route to built-in, extension, or MCP tool (Step 5).
			// Each tool call is bounded by the configured tool timeout. A tool
			// that observes ctx will cancel cleanly; a tool that ignores ctx will
			// be left running but its result is dropped, and executeTools
			// returns once errgroup's children all return.
			toolTimeout := defaultToolTimeout
			if run.cfg != nil && run.cfg.Timeouts != nil {
				toolTimeout = run.cfg.Timeouts.ToolDefault()
			}
			toolCtx, toolCancel := context.WithTimeout(gCtx, toolTimeout)
			defer toolCancel()

			// Inject timeouts config into context for individual tools to read.
			if run.cfg != nil && run.cfg.Timeouts != nil {
				toolCtx = types.WithTimeouts(toolCtx, run.cfg.Timeouts)
			}

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
					Content: fmt.Sprintf("Error: tool %q exceeded %s deadline. Narrow the request or split it into smaller calls.", block.Name, toolTimeout),
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
					Images:    toolResult.Images,
				}
			}

			// Append a warning when Write replaced existing plan content.
			// This nudges the LLM to use Edit for future modifications.
			if planWriteOverwrite && !results[i].IsError {
				results[i].Content += "\n\nWARNING: You used Write to replace the entire plan file. " +
					"Previous plan content was overwritten. If you intended to modify specific sections, " +
					"use the Edit tool next time. If you unintentionally removed existing deliverables, " +
					"re-read the conversation history to recover them."
				utils.Info("PlanMode", fmt.Sprintf("run=%s plan_file_overwritten plan_file=%s", run.requestID, run.planFilePath))
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
