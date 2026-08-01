package server

import (
	"context"
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

const contextBreakdownTimeout = 30 * time.Second

// startContextBreakdown starts at most one on-demand breakdown per session.
// Renderer polling can enqueue repeated requests while provider-native token
// counting is still running; coalescing prevents duplicate provider calls while
// keeping the socket read loop free for commands.
func (s *Server) startContextBreakdown(key string) {
	s.contextBreakdownMu.Lock()
	select {
	case <-s.done:
		s.contextBreakdownMu.Unlock()
		utils.LogWithFields(utils.LevelDebug, "server", "get context breakdown skipped during shutdown", map[string]any{"session_id": key})
		return
	default:
	}
	if _, active := s.contextBreakdownActive[key]; active {
		s.contextBreakdownMu.Unlock()
		utils.LogWithFields(utils.LevelDebug, "server", "get context breakdown coalesced", map[string]any{"session_id": key})
		return
	}
	s.contextBreakdownActive[key] = struct{}{}
	// Register before releasing admission lock. Stop holds this lock while it
	// closes done and cancels shutdownCtx, so Wait can never miss a worker that
	// passed admission.
	s.contextBreakdownWorkers.Add(1)
	s.contextBreakdownMu.Unlock()

	go func() {
		defer s.contextBreakdownWorkers.Done()
		defer func() {
			s.contextBreakdownMu.Lock()
			delete(s.contextBreakdownActive, key)
			s.contextBreakdownMu.Unlock()
			if r := recover(); r != nil {
				utils.LogWithFields(utils.LevelError, "server", "get context breakdown panicked", map[string]any{"session_id": key, "error": fmt.Sprint(r)})
			}
		}()

		ctx, cancel := context.WithTimeout(s.serveContext(), contextBreakdownTimeout)
		defer cancel()
		utils.LogWithFields(utils.LevelInfo, "server", "get context breakdown started", map[string]any{"session_id": key})
		if err := s.computeContextBreakdown(ctx, key); err != nil {
			level := utils.LevelWarn
			if ctx.Err() != nil {
				level = utils.LevelDebug
			}
			utils.LogWithFields(level, "server", "get context breakdown failed", map[string]any{"session_id": key, "error": err.Error()})
			return
		}
		utils.LogWithFields(utils.LevelInfo, "server", "get context breakdown completed", map[string]any{"session_id": key})
	}()
}
