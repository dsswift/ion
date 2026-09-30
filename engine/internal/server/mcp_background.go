package server

// mcp_background.go — MCP work that outlives the command that started it.
//
// A login's completion, and the reconnect and probe after an edit, dial the
// server and can run for up to DefaultMetadataTimeout. They run off the
// dispatch, but they belong to this Server: Stop cancels them and waits for
// them, so none keeps reading configuration or credentials after the server
// that started it is gone.

import (
	"context"
	"fmt"

	"github.com/dsswift/ion/engine/internal/utils"
)

// startMcpWork runs fn on its own goroutine under the server's shutdown
// context. It reports false, without running fn, when the server is already
// stopping.
func (s *Server) startMcpWork(task, name string, fn func(ctx context.Context)) bool {
	s.mcpWorkMu.Lock()
	select {
	case <-s.done:
		s.mcpWorkMu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "server.mcp", "background work refused: server stopping", map[string]any{
			"task": task, "server": name,
		})
		return false
	default:
	}
	// Register before releasing the admission lock. Stop holds this lock while
	// it closes done, so its Wait can never miss admitted work.
	s.mcpWorkers.Add(1)
	s.mcpWorkMu.Unlock()

	ctx := s.serveContext()
	go func() {
		defer s.mcpWorkers.Done()
		defer func() {
			if r := recover(); r != nil {
				utils.LogWithFields(utils.LevelError, "server.mcp", "background work panicked", map[string]any{
					"task": task, "server": name, "error": fmt.Sprint(r),
				})
			}
		}()
		fn(ctx)
		if ctx.Err() != nil {
			utils.LogWithFields(utils.LevelInfo, "server.mcp", "background work ended by shutdown", map[string]any{
				"task": task, "server": name,
			})
		}
	}()
	return true
}
