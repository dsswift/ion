package session

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/modelconfig"
	"github.com/dsswift/ion/engine/internal/session/agents"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// wireAgentSpawner installs the AgentSpawner closure on runCfg. The spawner
// runs a child backend synchronously, observes parent context cancellation,
// and updates s.agents with progress so the harness can render an agent
// pill.
//
// The spawner also fires agent_start / agent_end on the parent session's
// extension group, so user-installed observers can pair start+end events
// without resorting to tool_start/tool_end watchdog tricks on the Agent
// tool. Hooks fire on the parent host (not the child) because they are
// documented as "Observe only": the parent observes its children's
// lifecycle. Firing on the parent matches the same direction of travel as
// the engine_agent_state snapshots emitted on capturedKey.
func (m *Manager) wireAgentSpawner(s *engineSession, key string, parentModel string, extGroup *extension.ExtensionGroup, runCfg *backend.RunConfig) {
	capturedModel := parentModel
	capturedKey := key
	capturedExtGroup := extGroup

	runCfg.AgentSpawner = func(ctx context.Context, requestedName, prompt, description, cwd, model string) (string, error) {
		// If the LLM named a specialist, resolve it. Fires capability_match
		// when not registered so a harness extension can promote a draft
		// (via ctx.RegisterAgentSpec) and we resolve on the same call.
		// Falls back to an unnamed agent when the name is not registered,
		// so the model's intent (delegate work) still succeeds.
		var spec types.AgentSpec
		var specMatched bool

		// Fallback: when the LLM didn't pass a name, fire before_agent_start
		// so extensions can inspect the task and supply an agent name. This
		// is the belt-and-suspenders layer behind per-specialist dispatch
		// tools — if the generic Agent tool is called without a name, the
		// extension still gets a chance to resolve the specialist.
		if requestedName == "" && capturedExtGroup != nil && !capturedExtGroup.IsEmpty() {
			basCtx := m.newExtContext(s, capturedKey)
			_, hookName, _ := capturedExtGroup.FireBeforeAgentStart(basCtx, extension.AgentInfo{
				Task: prompt,
			})
			if hookName != "" {
				utils.Log("Session", fmt.Sprintf("before_agent_start resolved agentName=%s key=%s", hookName, capturedKey))
				requestedName = hookName
			}
		}

		if requestedName != "" {
			if matched, ok := m.resolveAgentSpec(s, key, requestedName); ok {
				spec = matched
				specMatched = true
			} else {
				utils.Debug("Session", fmt.Sprintf("agent spec not resolved: name=%q key=%s (continuing as unnamed)", requestedName, key))
			}
			// When resolution fails, continue with an unnamed agent rather
			// than hard-failing. The model's intent was to parallelize work;
			// the name was aspirational, not required.
		}

		// Naming: the engine generates a unique ID per dispatch for internal
		// tracking (state updates, abort, child request routing). The Name
		// field uses the spec name when matched so extensions can correlate
		// with their roster. Extensions own naming policy; the engine
		// provides the mechanism.
		s.agentCounter++
		agentID := fmt.Sprintf("agent-%d", s.agentCounter)
		agentName := agentID
		if specMatched {
			agentID = fmt.Sprintf("%s-%d", spec.Name, s.agentCounter)
			agentName = spec.Name
		}

		displayName := description
		if displayName == "" {
			if specMatched && spec.Description != "" {
				displayName = spec.Description
			} else {
				displayName = agentName
				if len(prompt) > 60 {
					displayName = prompt[:60] + "..."
				} else if len(prompt) > 0 {
					displayName = prompt
				}
			}
			if idx := strings.IndexByte(displayName, '\n'); idx > 0 {
				displayName = displayName[:idx]
			}
		}

		// Use spec model if matched, then call-site model, then parent.
		childModel := model
		if childModel == "" && specMatched {
			childModel = spec.Model
		}
		if childModel == "" {
			childModel = capturedModel
		}

		// Resolve tier aliases (e.g. "standard" → "claude-sonnet-4-6") so child
		// runs get a concrete model ID. Without this, tier names from agent specs
		// pass through as literal model strings and fail provider resolution.
		var childFallbacks []string
		if childModel != "" {
			resolved, fallbacks := modelconfig.ResolveTierChain(childModel)
			if resolved != childModel {
				utils.Log("Session", fmt.Sprintf("agent tier resolved: %s -> %s (fallbacks=%v) name=%s", childModel, resolved, fallbacks, agentName))
				childModel = resolved
			} else {
				utils.Debug("Session", fmt.Sprintf("agent tier passthrough: model=%s name=%s", childModel, agentName))
			}
			childFallbacks = fallbacks
		}

		utils.Debug("Session", fmt.Sprintf("child model resolved: requested=%q spec=%q parent=%q resolved=%q name=%s", model, func() string { if specMatched { return spec.Model }; return "" }(), capturedModel, childModel, agentName))

		start := time.Now()

		// Atomically update an existing specialist entry or append a new
		// one. Using AppendOrUpdate prevents the TOCTOU race where two
		// concurrent dispatches of the same specialist both see "not found"
		// and both append, creating duplicate rows.
		newDispatch := map[string]interface{}{
			"id":        agentID,
			"task":      prompt,
			"model":     childModel,
			"status":    "running",
			"startTime": start.Unix(),
		}
		reused := s.agents.AppendOrUpdate(types.AgentStateUpdate{
			Name:   agentName,
			ID:     agentID,
			Status: "running",
			Metadata: map[string]interface{}{
				"displayName": displayName,
				"type":        "agent",
				"visibility":  "sticky",
				"invited":     true,
				"task":        prompt,
				"model":       childModel,
				"startTime":   start.Unix(),
				"dispatches":  []interface{}{newDispatch},
			},
		}, func(existing *types.AgentStateUpdate) {
			existing.ID = agentID
			existing.Status = "running"
			if existing.Metadata == nil {
				existing.Metadata = map[string]interface{}{}
			}
			existing.Metadata["task"] = prompt
			existing.Metadata["model"] = childModel
			existing.Metadata["startTime"] = start.Unix()
			existing.Metadata["lastWork"] = ""
			delete(existing.Metadata, "elapsed")
			// Append new dispatch entry to the structured dispatches array.
			existingDispatches, _ := existing.Metadata["dispatches"].([]interface{})
			existing.Metadata["dispatches"] = append(existingDispatches, newDispatch)
		})
		snapshot := s.agents.MergedSnapshot()

		utils.Log("Session", fmt.Sprintf("agent_snapshot_emitted key=%s count=%d reason=agent_start name=%s id=%s reuse=%v", capturedKey, len(snapshot), agentName, agentID, reused))
		m.emit(capturedKey, types.EngineEvent{Type: "engine_agent_state", Agents: snapshot})

		// Fire agent_start on the parent extension group so user observers
		// can pair start+end. Observe-only: errors logged inside the group
		// dispatcher, never propagate. Guard mirrors fireBeforeAgentStart
		// in prompt_extensions.go.
		if capturedExtGroup != nil && !capturedExtGroup.IsEmpty() {
			utils.Log("Session", fmt.Sprintf("firing agent_start key=%s name=%s id=%s task_len=%d", capturedKey, agentName, agentID, len(prompt)))
			startCtx := m.newExtContext(s, capturedKey)
			capturedExtGroup.FireAgentStart(startCtx, extension.AgentInfo{
				Name: agentName,
				Task: prompt,
			})
		} else {
			utils.Debug("Session", fmt.Sprintf("agent_start skipped: no extensions key=%s name=%s", capturedKey, agentName))
		}

		child := m.newChildBackend()
		var result string
		var childErr error
		var childDone sync.WaitGroup
		childDone.Add(1)

		// Live progress forwarding: accumulate child text chunks and tool
		// calls, then throttle-emit lastWork updates so the agent pill shows
		// real-time activity instead of a static "responding...".
		var (
			childConvID  string
			progressMu   sync.Mutex
			textAccum    string
			lastEmitTime time.Time
		)
		const progressInterval = 2 * time.Second
		const maxSnippetLen = 100

		emitProgress := func(work string) {
			if len(work) > maxSnippetLen {
				work = work[:maxSnippetLen]
			}
			s.agents.UpdateStateByID(agentID, func(state *types.AgentStateUpdate) {
				if state.Metadata == nil {
					state.Metadata = map[string]interface{}{}
				}
				state.Metadata["lastWork"] = work
			})
			snap := s.agents.MergedSnapshot()
			utils.Debug("Session", fmt.Sprintf("agent_progress id=%s name=%s key=%s work=%q", agentID, agentName, capturedKey, work))
			m.emit(capturedKey, types.EngineEvent{Type: "engine_agent_state", Agents: snap})
		}

		child.OnNormalized(func(_ string, ev types.NormalizedEvent) {
			switch e := ev.Data.(type) {
			case *types.TaskCompleteEvent:
				result = e.Result
				childConvID = e.SessionID

			case *types.TextChunkEvent:
				progressMu.Lock()
				textAccum += e.Text
				now := time.Now()
				shouldEmit := now.Sub(lastEmitTime) >= progressInterval
				snippet := textAccum
				if shouldEmit {
					lastEmitTime = now
					// Keep only the tail for display
					if len(snippet) > maxSnippetLen {
						snippet = snippet[len(snippet)-maxSnippetLen:]
					}
				}
				progressMu.Unlock()
				if shouldEmit {
					emitProgress(snippet)
				}

			case *types.ToolCallEvent:
				progressMu.Lock()
				lastEmitTime = time.Now()
				textAccum = "" // Reset text accumulator on new tool call
				progressMu.Unlock()
				emitProgress(fmt.Sprintf("Using %s...", e.ToolName))

			default:
				utils.Debug("Session", fmt.Sprintf("child event not forwarded: agentID=%s type=%T", agentID, ev.Data))
			}
		})
		child.OnExit(func(_ string, _ *int, _ *string, _ string) {
			childDone.Done()
		})
		child.OnError(func(_ string, err error) {
			childErr = err
		})

		childRequestID := fmt.Sprintf("%s-%s", capturedKey, agentID)
		runOpts := types.RunOptions{
			Prompt:      prompt,
			Model:       childModel,
			ProjectPath: cwd,
			// Mark this as a subagent run so the early-stop continuation
			// gate skips it by default. Sub-agents have tight remits and
			// should not be poked to keep working. The harness can still
			// force-on by setting EarlyStopEnabled to &true on the
			// returned RunOptions before StartRun (not the typical
			// dispatch path, but supported).
			IsSubagent: true,
		}
		runOpts.FallbackChain = childFallbacks
		if specMatched {
			if spec.SystemPrompt != "" {
				runOpts.SystemPrompt = spec.SystemPrompt
			}
			if len(spec.Tools) > 0 {
				runOpts.AllowedTools = spec.Tools
			}
		}
		child.StartRun(childRequestID, runOpts)

		// Wait for child to finish OR parent context to cancel.
		doneCh := make(chan struct{})
		go func() {
			childDone.Wait()
			close(doneCh)
		}()

		cancelled := false
		select {
		case <-doneCh:
		case <-ctx.Done():
			cancelled = true
			child.Cancel(childRequestID)
			<-doneCh
		}

		elapsed := time.Since(start).Seconds()

		var terminalStatus string
		s.agents.UpdateStateByID(agentID, func(state *types.AgentStateUpdate) {
			if state.Metadata == nil {
				state.Metadata = map[string]interface{}{}
			}
			if cancelled {
				state.Status = "cancelled"
			} else if childErr != nil {
				state.Status = "error"
				state.Metadata["lastWork"] = childErr.Error()
			} else {
				state.Status = "done"
				if len(result) > 100 {
					state.Metadata["lastWork"] = result[:100]
				} else {
					state.Metadata["lastWork"] = result
				}
			}
			terminalStatus = state.Status
			state.Metadata["elapsed"] = elapsed
			// Accumulate conversation IDs across dispatches so the
			// desktop can load the full history for this specialist.
			if childConvID != "" {
				existing, _ := state.Metadata["conversationIds"].([]interface{})
				state.Metadata["conversationIds"] = append(existing, childConvID)
				// Keep single-value key for backward compatibility
				state.Metadata["conversationId"] = childConvID
			}
			// Update the current dispatch entry in the structured dispatches array.
			agents.UpdateDispatchEntry(state.Metadata, agentID, state.Status, elapsed, childConvID)
		})
		snapshot2 := s.agents.MergedSnapshot()

		utils.Log("Session", fmt.Sprintf("agent_terminated name=%s id=%s status=%s reason=spawner_exit key=%s elapsed=%.2fs", agentName, agentID, terminalStatus, capturedKey, elapsed))
		utils.Log("Session", fmt.Sprintf("agent_snapshot_emitted key=%s count=%d reason=agent_end name=%s id=%s", capturedKey, len(snapshot2), agentName, agentID))
		m.emit(capturedKey, types.EngineEvent{Type: "engine_agent_state", Agents: snapshot2})

		// Fire agent_end on the parent extension group. Must fire on every
		// terminal path (success, error, cancelled) so observers can pair
		// it 1:1 with agent_start; firing it here -- before the cancellation
		// early-return below -- preserves that invariant.
		if capturedExtGroup != nil && !capturedExtGroup.IsEmpty() {
			utils.Log("Session", fmt.Sprintf("firing agent_end key=%s name=%s status=%s elapsed=%.2fs", capturedKey, agentName, terminalStatus, elapsed))
			endCtx := m.newExtContext(s, capturedKey)
			capturedExtGroup.FireAgentEnd(endCtx, extension.AgentInfo{
				Name: agentName,
				Task: prompt,
			})
		} else {
			utils.Debug("Session", fmt.Sprintf("agent_end skipped: no extensions key=%s name=%s", capturedKey, agentName))
		}

		utils.Debug("Session", fmt.Sprintf("agent spawner returning: name=%s id=%s cancelled=%v err=%v resultLen=%d", agentName, agentID, cancelled, childErr, len(result)))

		if cancelled {
			return "", ctx.Err()
		}
		if childErr != nil {
			return "", childErr
		}
		return result, nil
	}
}
