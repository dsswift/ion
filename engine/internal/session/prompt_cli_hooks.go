package session

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// wirePermissionHookServer wires a Permission Hook server for the CLI backend
// so that hook-driven "ask" decisions surface as engine_permission_request
// events on the desktop and block the subprocess until the user responds.
func (m *Manager) wirePermissionHookServer(s *engineSession, key string, opts *types.RunOptions, permEng *permissions.Engine) {
	if _, isCli := m.backend.(*backend.CliBackend); !isCli {
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
	// engine_permission_request to the desktop and block until the user
	// responds with an option ID.
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
func (m *Manager) wireToolServer(s *engineSession, key string, opts *types.RunOptions, extGroup *extension.ExtensionGroup) {
	if _, isCli := m.backend.(*backend.CliBackend); !isCli {
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
