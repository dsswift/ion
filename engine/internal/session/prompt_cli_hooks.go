package session

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// wirePermissionHookServer wires a Permission Hook server for the CLI backend
// so that hook-driven "ask" decisions surface as engine_permission_request
// events to consumers and block the subprocess until the user responds.
//
// Under HybridBackend, this only wires when the model resolves to the
// inner *CliBackend. API-routed hybrid runs use the in-process permission
// engine path (identical to plain "backend": "api").
func (m *Manager) wirePermissionHookServer(s *engineSession, key string, opts *types.RunOptions, permEng *permissions.Engine) {
	if _, isCli := m.resolvedBackend(opts.Model).(*backend.CliBackend); !isCli {
		return
	}
	if permEng == nil {
		return
	}

	hookServer, err := backend.NewPermissionHookServer(permEng)
	if err != nil {
		utils.Log("Session", "PermissionHookServer start failed: "+err.Error())
		return
	}
	token := fmt.Sprintf("run-%d", time.Now().UnixMilli())
	hookServer.RegisterToken(token)

	// When the hook server gets an "ask" decision, emit
	// engine_permission_request and block until the user responds with an
	// option ID.
	hookServer.SetOnAsk(func(reqToken string, questionID string, toolName string, toolDesc string, toolInput map[string]any, options []types.PermissionOpt) chan string {
		ch := m.RegisterPendingPermission(key, questionID)
		if ch == nil {
			return nil
		}
		m.emit(key, types.EngineEvent{
			Type:          "engine_permission_request",
			QuestionID:    questionID,
			PermToolName:  toolName,
			PermToolDesc:  toolDesc,
			PermToolInput: toolInput,
			PermOptions:   options,
		})
		result := make(chan string, 1)
		go func() {
			optionID := <-ch
			m.UnregisterPendingPermission(key, questionID)
			result <- optionID
		}()
		return result
	})

	settingsJSON := hookServer.GenerateSettingsJSON(token)

	tmpFile := filepath.Join(os.TempDir(), fmt.Sprintf("ion-settings-%s.json", token))
	if err := os.WriteFile(tmpFile, settingsJSON, 0600); err != nil {
		utils.Log("Session", "failed to write hook settings: "+err.Error())
		hookServer.Close()
		return
	}
	opts.HookSettingsPath = tmpFile
	utils.Log("Session", fmt.Sprintf("hook settings written to %s", tmpFile))
}

// wireToolServer starts a ToolServer for CLI backend when extensions provide
// tools, exposing them via an MCP config that Claude Code subprocess loads.
//
// Under HybridBackend, this only fires when the model resolves to the
// inner *CliBackend. API-routed hybrid runs expose extension tools via
// the in-process tool registry instead.
func (m *Manager) wireToolServer(s *engineSession, key string, opts *types.RunOptions, extGroup *extension.ExtensionGroup) {
	if _, isCli := m.resolvedBackend(opts.Model).(*backend.CliBackend); !isCli {
		return
	}
	if extGroup == nil || extGroup.IsEmpty() {
		return
	}
	extTools := extGroup.Tools()
	if len(extTools) == 0 {
		return
	}
	ts := backend.NewToolServer(key)
	for _, tool := range extTools {
		capturedTool := tool
		ts.RegisterTool(capturedTool.Name, func(input map[string]interface{}) (*types.ToolResult, error) {
			ctx := m.newExtContext(s, key)
			return capturedTool.Execute(input, ctx)
		})
	}
	if err := ts.Start(); err != nil {
		utils.Log("Session", "ToolServer start failed: "+err.Error())
		return
	}
	mcpPath, err := ts.McpConfigPath(key)
	if err != nil {
		utils.Log("Session", "ToolServer MCP config failed: "+err.Error())
		ts.Stop()
		return
	}
	opts.McpConfig = mcpPath
	m.mu.Lock()
	s.toolServer = ts
	m.mu.Unlock()
	utils.Log("Session", fmt.Sprintf("ToolServer started for CLI backend (%d tools)", len(extTools)))
}

// wireAgentToolServer registers an ion_agent tool on the ToolServer for CLI
// backend sessions.
//
// Under HybridBackend, this only fires when the model resolves to the
// inner *CliBackend. API-routed hybrid runs expose ion_agent via the
// in-process agent spawner path (wired in buildRunConfig).
func (m *Manager) wireAgentToolServer(s *engineSession, key string, opts *types.RunOptions) {
	if _, isCli := m.resolvedBackend(opts.Model).(*backend.CliBackend); !isCli {
		return
	}

	m.mu.Lock()
	ts := s.toolServer
	m.mu.Unlock()

	needsStart := false
	if ts == nil {
		ts = backend.NewToolServer(key)
		needsStart = true
	}

	ts.RegisterTool("ion_agent", m.buildAgentToolHandler(s, key))

	if needsStart {
		if err := ts.Start(); err != nil {
			utils.Log("Session", "ToolServer start failed (agent tool): "+err.Error())
			return
		}
		mcpPath, err := ts.McpConfigPath(key)
		if err != nil {
			utils.Log("Session", "ToolServer MCP config failed (agent tool): "+err.Error())
			ts.Stop()
			return
		}
		opts.McpConfig = mcpPath
		m.mu.Lock()
		s.toolServer = ts
		m.mu.Unlock()
	}

	utils.Log("Session", "ion_agent tool registered on ToolServer for CLI backend")
}

// buildAgentToolHandler returns a ToolHandler closure that resolves ion agent
// specs and runs child agents synchronously.
func (m *Manager) buildAgentToolHandler(s *engineSession, key string) backend.ToolHandler {
	return func(input map[string]interface{}) (*types.ToolResult, error) {
		prompt, _ := input["prompt"].(string)
		name, _ := input["name"].(string)
		description, _ := input["description"].(string)
		model, _ := input["model"].(string)

		if prompt == "" {
			return &types.ToolResult{Content: "error: prompt is required", IsError: true}, nil
		}

		// Resolve agent spec by name if provided.
		var spec types.AgentSpec
		var specMatched bool
		if name != "" {
			if matched, ok := m.resolveAgentSpec(s, key, name); ok {
				spec = matched
				specMatched = true
			}
			// When resolution fails, continue with an unnamed agent rather
			// than hard-failing. The model's intent was to parallelize work;
			// the name was aspirational, not required.
		}

		// Determine model: explicit > spec > parent config default.
		childModel := model
		if childModel == "" && specMatched {
			childModel = spec.Model
		}
		if childModel == "" && m.config != nil {
			childModel = m.config.DefaultModel
		}

		cwd := s.config.WorkingDirectory

		runOpts := types.RunOptions{
			Prompt:      prompt,
			Model:       childModel,
			ProjectPath: cwd,
		}
		if specMatched {
			if spec.SystemPrompt != "" {
				runOpts.AppendSystemPrompt = spec.SystemPrompt
			}
			if len(spec.Tools) > 0 {
				runOpts.AllowedTools = spec.Tools
			}
		}
		if description != "" && !specMatched {
			runOpts.AppendSystemPrompt = description
		}

		child := m.newChildBackend()
		var result string
		var childErr error
		var childDone sync.WaitGroup
		childDone.Add(1)

		child.OnNormalized(func(_ string, ev types.NormalizedEvent) {
			if tc, ok := ev.Data.(*types.TaskCompleteEvent); ok {
				result = tc.Result
			}
		})
		child.OnExit(func(_ string, _ *int, _ *string, _ string) {
			childDone.Done()
		})
		child.OnError(func(_ string, err error) {
			childErr = err
		})

		childRequestID := fmt.Sprintf("%s-ion-agent-%s-%d", key, name, time.Now().UnixMilli())
		child.StartRun(childRequestID, runOpts)
		childDone.Wait()

		if childErr != nil {
			errParts := []string{"agent"}
			if name != "" {
				errParts = append(errParts, name)
			}
			return &types.ToolResult{
				Content: fmt.Sprintf("%s failed: %s", strings.Join(errParts, " "), childErr.Error()),
				IsError: true,
			}, nil
		}

		return &types.ToolResult{Content: result, IsError: false}, nil
	}
}
