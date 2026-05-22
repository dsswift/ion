package session

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// wireAgentSpawner installs the AgentSpawner closure on runCfg. The spawner
// runs a child backend synchronously, observes parent context cancellation,
// and updates s.agents with progress so the harness can render an agent
// pill.
func (m *Manager) wireAgentSpawner(s *engineSession, key string, parentModel string, runCfg *backend.RunConfig) {
	capturedModel := parentModel
	capturedKey := key

	runCfg.AgentSpawner = func(ctx context.Context, requestedName, prompt, description, cwd, model string) (string, error) {
		// If the LLM named a specialist, resolve it. Fires capability_match
		// when not registered so a harness extension can promote a draft
		// (via ctx.RegisterAgentSpec) and we resolve on the same call.
		// Falls back to an unnamed agent when the name is not registered,
		// so the model's intent (delegate work) still succeeds.
		var spec types.AgentSpec
		var specMatched bool
		if requestedName != "" {
			if matched, ok := m.resolveAgentSpec(s, key, requestedName); ok {
				spec = matched
				specMatched = true
			}
			// When resolution fails, continue with an unnamed agent rather
			// than hard-failing. The model's intent was to parallelize work;
			// the name was aspirational, not required.
		}

		s.agentCounter++
		agentName := fmt.Sprintf("agent-%d", s.agentCounter)
		if specMatched {
			agentName = fmt.Sprintf("%s-%d", spec.Name, s.agentCounter)
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

		start := time.Now()
		s.agents.AppendState(types.AgentStateUpdate{
			Name:   agentName,
			Status: "running",
			Metadata: map[string]interface{}{
				"displayName": displayName,
				"type":        "agent",
				"visibility":  "sticky",
				"invited":     true,
				"task":        prompt,
				"model":       childModel,
				"startTime":   start.Unix(),
			},
		})
		snapshot := s.agents.MergedSnapshot()

		utils.Log("Session", fmt.Sprintf("agent_snapshot_emitted key=%s count=%d reason=agent_start name=%s", capturedKey, len(snapshot), agentName))
		m.emit(capturedKey, types.EngineEvent{Type: "engine_agent_state", Agents: snapshot})

		child := m.newChildBackend()
		var result string
		var childErr error
		var childDone sync.WaitGroup
		childDone.Add(1)

		var childConvID string
		child.OnNormalized(func(_ string, ev types.NormalizedEvent) {
			if tc, ok := ev.Data.(*types.TaskCompleteEvent); ok {
				result = tc.Result
				childConvID = tc.SessionID
			}
		})
		child.OnExit(func(_ string, _ *int, _ *string, _ string) {
			childDone.Done()
		})
		child.OnError(func(_ string, err error) {
			childErr = err
		})

		childRequestID := fmt.Sprintf("%s-%s", capturedKey, agentName)
		runOpts := types.RunOptions{
			Prompt:      prompt,
			Model:       childModel,
			ProjectPath: cwd,
		}
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
		s.agents.UpdateState(agentName, func(state *types.AgentStateUpdate) {
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
			if childConvID != "" {
				state.Metadata["conversationId"] = childConvID
			}
		})
		snapshot2 := s.agents.MergedSnapshot()

		utils.Log("Session", fmt.Sprintf("agent_terminated name=%s status=%s reason=spawner_exit key=%s elapsed=%.2fs", agentName, terminalStatus, capturedKey, elapsed))
		utils.Log("Session", fmt.Sprintf("agent_snapshot_emitted key=%s count=%d reason=agent_end name=%s", capturedKey, len(snapshot2), agentName))
		m.emit(capturedKey, types.EngineEvent{Type: "engine_agent_state", Agents: snapshot2})

		if cancelled {
			return "", ctx.Err()
		}
		if childErr != nil {
			return "", childErr
		}
		return result, nil
	}
}
