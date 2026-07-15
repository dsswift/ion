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
	var mcpRouter func(context.Context, string, map[string]interface{}) (*types.ToolResult, error)
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

	// Inject session-scoped agent spawner into context for Agent tool.
	// A nil spawner means the Agent tool will return "Agent tool not
	// available" if the LLM invokes it. This should not happen in
	// production: both the main session path (wireAgentSpawner) and the
	// dispatch child path (BuildChildAgentSpawner) wire a spawner. Log
	// loudly so any future nil-spawner regression surfaces as a
	// diagnosable log line instead of an opaque model narration.
	if spawnerFn != nil {
		gCtx = tools.WithAgentSpawner(gCtx, spawnerFn)
	} else {
		utils.LogWithFields(utils.LevelWarn, "backend.runloop", "has nil AgentSpawner: Agent tool will be unavailable. \"+ \"This indicates a wiring gap in the RunConfig assembly path.", map[string]any{
			"run_id": run.requestID,
		})
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
			// Install ambient logging for this child goroutine so every
			// utils.Log/Debug/Info/Warn/Error call inside the tool-execution
			// closure (and inside the tools it dispatches to) auto-stamps
			// session_id/conversation_id. gCtx descends from the run's ctx,
			// which carries the correlation IDs (errgroup.WithContext
			// propagates context values). Without this, child goroutines have
			// distinct goroutine IDs and no ambient entry, so their log lines
			// emit without correlation.
			defer installAmbientLogging(gCtx)()

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
					emitToolFailure(telem, run, toolFailureBlock{Name: block.Name, ID: block.ID}, "permission_denied", checkResult.Reason)
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
					safe, reason, patternSource := sandbox.ValidateWithConfig(cmd, *sbCfg)
					if !safe {
						if telem != nil {
							// R11: event name is carried by Event.Name; payload.kind removed.
							telem.Event("sandbox.block", map[string]any{
								"tool":            block.Name,
								"reason":          reason,
								"pattern_source":  patternSource,
								"command_preview": truncatePreview(cmd, telemPreviewLimit),
							}, buildTelemCtx(run))
						}
						emitToolFailure(telem, run, toolFailureBlock{Name: block.Name, ID: block.ID}, "sandbox_blocked", reason)
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
			// per-tool timeout (TimeoutsConfig.ToolDefault, 60min default) is
			// the outer backstop.
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
					emitToolFailure(telem, run, toolFailureBlock{Name: block.Name, ID: block.ID}, "hook_error", err.Error())
					return nil
				}
				if result != nil && result.Block {
					results[i] = conversation.ToolResultEntry{
						ToolUseID: block.ID,
						Content:   "Blocked: " + result.Reason,
						IsError:   true,
					}
					emitToolFailure(telem, run, toolFailureBlock{Name: block.Name, ID: block.ID}, "hook_blocked", result.Reason)
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
				toolSpan = telem.StartSpanCtx("tool.execute", map[string]interface{}{
					"tool": block.Name,
				}, buildTelemCtx(run))
			}

			// Plan-mode gates (extracted to runloop_plan_mode_gates.go to
			// keep this dispatch loop focused). Each gate either short-
			// circuits this per-tool goroutine (returning handled=true,
			// after setting results[i] and emitting any ToolResultEvent)
			// or proceeds. The Write gate additionally latches
			// planWriteOverwrite for the post-execution overwrite
			// warning that the Write tool-result append below depends on.
			var planWriteOverwrite bool
			var planWriteRedirectNotice string
			var planWriteToCanonical bool
			var planFileHadContentBefore bool
			{
				gateRes := applyPlanModeWriteGate(run, block, results, i, cwd, b.emit)
				if gateRes.handled {
					return nil
				}
				planWriteOverwrite = gateRes.planWriteOverwrite
				planWriteRedirectNotice = gateRes.redirectNotice
				planWriteToCanonical = gateRes.planWriteToCanonical
				planFileHadContentBefore = gateRes.planFileHadContentBefore
				if applyPlanModeBashGate(run, block, results, i, b.emit) {
					return nil
				}
				if interceptExitPlanMode(run, block, results, i, hooks, b.emit) {
					return nil
				}
				if interceptEnterPlanMode(run, block, results, i, hooks, b.emit) {
					return nil
				}
			}

			// Intercept AskUserQuestion sentinel — available in all runs, not
			// just plan mode. Record a PermissionDenial so consumers can surface
			// the question, then terminate the run. The user's answer arrives
			// as the next prompt in the same session.
			if block.Name == tools.AskUserQuestionName {
				utils.LogWithFields(utils.LevelInfo, "backend.runloop", "ask_user", map[string]any{
					"run_id":   run.requestID,
					"question": block.Input["question"],
				})

				// If this run has a ChildElicitFn, it is a dispatched child.
				// Route the question to the dispatcher via elicitation (blocks
				// until answered). This is the "AskUserQuestion symmetrization":
				// dispatched children block-and-resume like elicitations instead
				// of terminating the run.
				if run.cfg != nil && run.cfg.ChildElicitFn != nil {
					question, _ := block.Input["question"].(string)
					utils.LogWithFields(utils.LevelInfo, "backend.runloop", "ask_user routing to dispatcher via ChildElicitFn", map[string]any{
						"run_id": run.requestID,
					})
					answer, cancelled, err := run.cfg.ChildElicitFn(question)
					if err != nil || cancelled {
						// Dispatcher couldn't answer (session torn down or
						// cancelled). Terminate the child run via the standard
						// PermissionDenial path so consumers see a uniform
						// outcome.
						utils.LogWithFields(utils.LevelInfo, "backend.runloop", "ask_user dispatcher unavailable ; terminating", map[string]any{
							"run_id":    run.requestID,
							"cancelled": cancelled,
							"error":     utils.ErrStr(err),
						})
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
							Content:   "Question could not be answered (dispatcher unavailable). Proceeding with best judgment.",
							IsError:   false,
						}
						b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
							ToolID:  block.ID,
							Content: "Question could not be answered (dispatcher unavailable). Proceeding with best judgment.",
							IsError: false,
						}})
						return nil
					}
					// Dispatcher answered. Inject the answer as the tool result.
					// The child run CONTINUES (no PermissionDenial, no terminate).
					content := answer
					if content == "" {
						content = "(no answer provided — proceed with best judgment)"
					}
					utils.LogWithFields(utils.LevelInfo, "backend.runloop", "ask_user dispatcher answered; injecting result and continuing", map[string]any{
						"run_id": run.requestID,
					})
					results[i] = conversation.ToolResultEntry{
						ToolUseID: block.ID,
						Content:   content,
						IsError:   false,
					}
					b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
						ToolID:  block.ID,
						Content: content,
						IsError: false,
					}})
					return nil
				}

				// Standard path: record a PermissionDenial so consumers can
				// surface the question, then terminate the run. The user's
				// answer arrives as the next prompt in the same session.
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
			//
			// The stall advisory is emitted via emitWithoutProgress, NOT emit:
			// it is the engine signalling the *absence* of progress, so it must
			// not bump run.lastProgressAt. If it did, a wedged but deadline-
			// exempt Agent/dispatch tool (see the AgentToolName branch below)
			// would reset the run-progress watchdog clock every tick and never
			// trip the run-stall backstop — the exact incident in conversation
			// 1782012033034-37d617d3d9ab. See emitWithoutProgress in
			// api_backend.go for the full rationale.
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
						b.emitWithoutProgress(run, types.NormalizedEvent{Data: &types.ToolStalledEvent{
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

			// The Agent tool is a long-running child session with cooperative
			// cancellation (parent abort → gCtx cancelled → child cancelled).
			// Wrapping it in the standard tool timeout would kill child agents
			// at the deadline. Use gCtx directly so Agent runs are bounded only
			// by parent lifecycle, not by the tool deadline.
			//
			// All other tools get a finite deadline, but via a DeadlineSuspender
			// rather than a bare context.WithTimeout: an extension tool's
			// execute() may synchronously call ctx.elicit(), which is an
			// indefinite human-wait. The suspender lets that path pause the
			// finite deadline for exactly the span it is blocked on the human,
			// then resume it for the remaining machine work — preserving the
			// indefinite-human-wait guarantee without removing the finite
			// ceiling from machine work. (Permission prompts do not flow through
			// the suspender; they block elsewhere — see DeadlineSuspender's doc.)
			var toolCtx context.Context
			var toolCancel context.CancelFunc
			var toolSuspender *types.DeadlineSuspenderHandle
			if block.Name == tools.AgentToolName {
				toolCtx, toolCancel = context.WithCancel(gCtx)
			} else {
				toolCtx, toolCancel = context.WithCancel(gCtx)
				ds := types.NewDeadlineSuspender(toolTimeout, toolCancel)
				toolSuspender = ds
				toolCtx = types.WithDeadlineSuspender(toolCtx, ds)
			}
			defer toolCancel()
			defer toolSuspender.Stop()

			// Inject timeouts config into context for individual tools to read.
			if run.cfg != nil && run.cfg.Timeouts != nil {
				toolCtx = types.WithTimeouts(toolCtx, run.cfg.Timeouts)
			}

			// Inject shell config so the Bash tool can run commands through the
			// user's login shell when EngineRuntimeConfig.Shell.UseLoginShell
			// is set. Nil-safe: omitted config leaves the default bash -c path.
			if run.cfg != nil && run.cfg.Shell != nil {
				toolCtx = types.WithShellConfig(toolCtx, run.cfg.Shell)
			}

			// Install the per-run touched-path sink so path-bearing tools can
			// record the paths they resolve (drives read-triggered nested
			// context loading). The sink is nil-safe and self-locking; tools
			// call types.RecordTouchedPath(ctx, resolvedPath). Drained between
			// turns by drainNestedContext.
			if run.touchedSink != nil {
				toolCtx = types.WithTouchedPathSink(toolCtx, run.touchedSink)
			}

			var toolResult *types.ToolResult
			var err error

			// Tracks whether a tool.failure telemetry event has already fired for
			// this block on a fall-through path (unknown_tool, deadline_exceeded).
			// Those branches set IsError=true and emit, then fall through to the
			// shared result-assembly block below — the guard stops that block from
			// double-emitting for the same failure.
			failureEmitted := false

			if tools.GetTool(block.Name) != nil {
				toolResult, err = tools.ExecuteTool(toolCtx, block.Name, block.Input, cwd)
			} else if mcpRouter != nil {
				// mcpRouter does not yet take ctx; race its return against
				// toolCtx so a hung MCP server cannot wedge the run.
				type mcpRet struct {
					result *types.ToolResult
					err    error
				}
				resCh := make(chan mcpRet, 1)
				go func() {
					// This inner goroutine has its own goroutine ID, so it
					// needs its own ambient install to keep MCP router log
					// lines correlated. gCtx is captured in the closure.
					defer installAmbientLogging(gCtx)()
					routed, routeErr := mcpRouter(toolCtx, block.Name, block.Input)
					resCh <- mcpRet{routed, routeErr}
				}()
				select {
				case r := <-resCh:
					if r.err != nil {
						err = r.err
					} else if r.result != nil {
						// Consume the full ToolResult directly so Images
						// (vision output from an extension/MCP tool) survive
						// into the ToolResultEntry rather than being flattened
						// to (content, isErr).
						toolResult = r.result
					} else {
						// Nil result with nil error is the empty-successful
						// case: substitute an empty result.
						toolResult = &types.ToolResult{}
					}
				case <-toolCtx.Done():
					err = toolCtx.Err()
				}
			} else {
				toolResult = &types.ToolResult{
					Content: fmt.Sprintf("Unknown tool: %s", block.Name),
					IsError: true,
				}
				emitToolFailure(telem, run, toolFailureBlock{Name: block.Name, ID: block.ID}, "unknown_tool", toolResult.Content)
				failureEmitted = true
			}

			// Surface per-tool deadline as a tool-result error rather than
			// failing the whole run, so the LLM sees a clear "this tool timed
			// out" message and can adapt. Two cases produce the deadline
			// result: a classic WithTimeout ctx (built-in tools) reporting
			// DeadlineExceeded, and the DeadlineSuspender (extension/MCP tools)
			// having fired its own deadline — the suspender cancels via
			// WithCancel, so its ctx.Err() is Canceled, not DeadlineExceeded,
			// and we must consult Fired() to distinguish a deadline from a
			// genuine lifecycle abort.
			deadlineHit := toolCtx.Err() == context.DeadlineExceeded || toolSuspender.Fired()
			if err != nil && deadlineHit {
				err = nil
				toolResult = &types.ToolResult{
					Content: fmt.Sprintf("Error: tool %q exceeded %s deadline. Narrow the request or split it into smaller calls.", block.Name, toolTimeout),
					IsError: true,
				}
				emitToolFailure(telem, run, toolFailureBlock{Name: block.Name, ID: block.ID}, "deadline_exceeded", toolResult.Content)
				failureEmitted = true
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
				emitToolFailure(telem, run, toolFailureBlock{Name: block.Name, ID: block.ID}, "tool_error", err.Error())
			} else {
				results[i] = conversation.ToolResultEntry{
					ToolUseID: block.ID,
					Content:   toolResult.Content,
					IsError:   toolResult.IsError,
					Images:    toolResult.Images,
				}
				// A tool that returns IsError=true with no Go-level error is the
				// dominant real-failure path: Bash non-zero exit, Edit
				// old_string-not-found, missing required args, etc. all return
				// {IsError: true}, nil. Without this emission those failures land in
				// tool.execute but never in tool.failure, so the failure signal is
				// silently lost for every tool that reports failure by result flag
				// rather than by returning an error. Guard against double-emitting
				// for the unknown_tool / deadline_exceeded fall-through paths, which
				// already emitted above. toolResult is non-nil here: this else
				// branch runs only when err == nil, and every path that leaves err
				// nil assigns a non-nil toolResult (the block above dereferences it).
				if toolResult.IsError && !failureEmitted {
					emitToolFailure(telem, run, toolFailureBlock{Name: block.Name, ID: block.ID}, "execution_error", toolResult.Content)
				}
			}

			// Append a warning when Write replaced existing plan content.
			// This nudges the LLM to use Edit for future modifications.
			if planWriteOverwrite && !results[i].IsError {
				results[i].Content += "\n\nWARNING: You used Write to replace the entire plan file. " +
					"Previous plan content was overwritten. If you intended to modify specific sections, " +
					"use the Edit tool next time. If you unintentionally removed existing deliverables, " +
					"re-read the conversation history to recover them."
				utils.LogWithFields(utils.LevelInfo, "backend.plan_mode", "plan_file_overwritten", map[string]any{
					"run_id":    run.requestID,
					"plan_file": run.planFilePath,
				})
			}

			// When applyPlanModeWriteGate rewrote a stray plan-shaped target to
			// the canonical plan file, the physical write already succeeded
			// (block.Input["file_path"] was rewritten in-place so the tool ran
			// against the canonical path). But returning success would leave
			// the model believing its wrong path is valid, causing repeated
			// stray writes on every subsequent turn. Return an error instead:
			// the model treats errors as mistakes requiring correction, reads
			// the canonical path from the message, and retries with it. The
			// content IS on disk; the error is purely a behavioral correction
			// signal, not a data-loss report.
			if planWriteRedirectNotice != "" && !results[i].IsError {
				wrongPath, _ := block.Input["file_path"].(string)
				msg := fmt.Sprintf(
					"Plan mode: %s targeted %q — that path is not the plan file for this session "+
						"and the engine redirected the write to the canonical plan file (%s). "+
						"Do NOT use that path again. Always target %s directly. "+
						"The content was written to the canonical file. Resubmit targeting %s.",
					block.Name, wrongPath, run.planFilePath, run.planFilePath, run.planFilePath)
				results[i].Content = msg
				results[i].IsError = true
				utils.LogWithFields(utils.LevelInfo, "backend.plan_mode", "redirect_as_error", map[string]any{
					"run_id":    run.requestID,
					"wrong":     wrongPath,
					"canonical": run.planFilePath,
				})
			}

			// Emit the plan-file-written marker AFTER a Write/Edit to the
			// canonical plan file. This is the accurate trigger for the
			// "plan created / updated" conversation marker: the file now exists
			// on disk with content, so the marker lands at the true point in
			// the transcript and any link to the plan resolves. The
			// created-vs-updated discriminator comes from the file's prior
			// state captured pre-execution by the gate (planFileHadContentBefore).
			// Plan-mode entry no longer drives this marker — entry happens
			// before any file exists.
			//
			// For redirected writes: the physical file WAS written successfully
			// (the redirect executed the tool against the canonical path), so
			// the marker should still fire — the plan file genuinely changed.
			// The error result above is a behavioral correction signal, not a
			// data-loss indicator. We fire the marker when planWriteToCanonical
			// is set and the underlying tool execution succeeded (no Go-level
			// error), regardless of the IsError flag on the result.
			//
			// For non-redirect errors (the tool itself reported failure — e.g.
			// Edit's old_string-not-found): results[i].IsError is true AND
			// planWriteRedirectNotice is empty, so the marker is correctly skipped.
			markerEligible := planWriteToCanonical && (!results[i].IsError || planWriteRedirectNotice != "")
			if markerEligible {
				op := "created"
				if planFileHadContentBefore {
					op = "updated"
				}
				utils.LogWithFields(utils.LevelInfo, "backend.plan_mode", "plan_file_written", map[string]any{
					"run_id":    run.requestID,
					"op":        op,
					"plan_file": run.planFilePath,
				})
				b.emit(run, types.NormalizedEvent{Data: &types.PlanFileWrittenEvent{
					Operation:    op,
					PlanFilePath: run.planFilePath,
					PlanSlug:     types.PlanSlugFromPath(run.planFilePath),
				}})
				// Persist a plan marker so the "plan created / updated" marker
				// survives reload (PlanFileWrittenEvent is not persisted).
				if run.conv != nil && run.conv.Entries != nil {
					conversation.AppendEntry(run.conv, conversation.EntryPlanMarker, conversation.PlanMarkerData{
						Operation:    op,
						PlanFilePath: run.planFilePath,
						PlanSlug:     types.PlanSlugFromPath(run.planFilePath),
					})
					if err := conversation.Save(run.conv, ""); err != nil {
						utils.LogWithFields(utils.LevelInfo, "backend.runloop", "plan_marker: failed to save", map[string]any{
							"error": utils.ErrStr(err),
						})
					}
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

			// Emit tool_result event. When the tool returned vision images,
			// save each image's bytes to the conversation's images/ directory
			// and carry the FILE PATH (never base64) on both the
			// ToolResultEvent.Images field and a per-image ImageContentEvent.
			// The engine is a pass-through for images — it saves and forwards,
			// never generates.
			var resultImages []types.ToolResultImage
			if len(results[i].Images) > 0 {
				resultImages = b.saveToolResultImages(run, block.ID, results[i].Images)
			}
			b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
				ToolID:  block.ID,
				Content: results[i].Content,
				IsError: results[i].IsError,
				Images:  resultImages,
			}})
			for _, img := range resultImages {
				b.emit(run, types.NormalizedEvent{Data: &types.ImageContentEvent{
					Path:      img.Path,
					MediaType: img.MediaType,
					Source:    "tool",
					ToolID:    block.ID,
				}})
			}

			return nil
		})
	}

	if err := g.Wait(); err != nil {
		return nil, err
	}
	return results, nil
}
