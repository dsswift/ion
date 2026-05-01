package session

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/types"
)

// wireAgentSpawner installs the AgentSpawner closure on runCfg. The spawner
// runs a child backend synchronously, observes parent context cancellation,
// and updates s.agentStates with progress so the harness can render an agent
// pill.
func (m *Manager) wireAgentSpawner(s *engineSession, key string, parentModel string, runCfg *backend.RunConfig) {
	capturedModel := parentModel
	capturedKey := key
	var agentCounter int

	runCfg.AgentSpawner = func(ctx context.Context, requestedName, prompt, description, cwd, model string) (string, error) {
		// If the LLM named a specialist, resolve it. Fires capability_match
		// when not registered so a harness extension can promote a draft
		// (via ctx.RegisterAgentSpec) and we resolve on the same call.
		var spec types.AgentSpec
		var specMatched bool
		if requestedName != "" {
			if matched, ok := m.resolveAgentSpec(s, key, requestedName); ok {
				spec = matched
				specMatched = true
			} else {
				return "", fmt.Errorf("agent %q is not registered (capability_match returned no match)", requestedName)
			}
		}
		m.mu.Lock()
		agentCounter++
		agentName := fmt.Sprintf("agent-%d", agentCounter)
		if specMatched {
			agentName = fmt.Sprintf("%s-%d", spec.Name, agentCounter)
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

		s.agentStates = append(s.agentStates, types.AgentStateUpdate{
			Name:   agentName,
			Status: "running",
			Metadata: map[string]interface{}{
				"displayName": displayName,
				"type":        "agent",
				"visibility":  "sticky",
				"invited":     true,
				"task":        prompt,
			},
		})
		snapshot := mergeAgentStates(s.lastExtAgentStates, s.agentStates)
		m.mu.Unlock()

		m.emit(capturedKey, types.EngineEvent{Type: "engine_agent_state", Agents: snapshot})

		start := time.Now()
		child := backend.NewApiBackend()
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

		// Use spec model if matched, then call-site model, then parent.
		childModel := model
		if childModel == "" && specMatched {
			childModel = spec.Model
		}
		if childModel == "" {
			childModel = capturedModel
		}
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
		// Without this select, the goroutine would block on childDone.Wait()
		// even after the parent run is interrupted.
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

		m.mu.Lock()
		for i := range s.agentStates {
			if s.agentStates[i].Name == agentName {
				if s.agentStates[i].Metadata == nil {
					s.agentStates[i].Metadata = map[string]interface{}{}
				}
				if cancelled {
					s.agentStates[i].Status = "cancelled"
				} else if childErr != nil {
					s.agentStates[i].Status = "error"
					s.agentStates[i].Metadata["lastWork"] = childErr.Error()
				} else {
					s.agentStates[i].Status = "done"
					if len(result) > 100 {
						s.agentStates[i].Metadata["lastWork"] = result[:100]
					} else {
						s.agentStates[i].Metadata["lastWork"] = result
					}
				}
				s.agentStates[i].Metadata["elapsed"] = elapsed
				if childConvID != "" {
					s.agentStates[i].Metadata["conversationId"] = childConvID
				}
				break
			}
		}
		snapshot2 := mergeAgentStates(s.lastExtAgentStates, s.agentStates)
		m.mu.Unlock()

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
