package server

import (
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

const (
	defaultCommandStallTimeout    = 10 * time.Second
	defaultCommandDispatchTimeout = 25 * time.Second
)

// dispatchLifecycle observes one command from dispatch start until its handler
// returns. A timeout answers the client but deliberately does not release the
// command lane: a later command for the same session must not overtake work
// that can still mutate that session after the timeout response.
type dispatchLifecycle struct {
	server  *Server
	handler func(net.Conn, *protocol.ClientCommand)

	mu       sync.Mutex
	active   map[*protocol.ClientCommand]*dispatchState
	stallFor time.Duration
	limitFor time.Duration
}

type dispatchState struct {
	done      chan struct{}
	responded bool
}

func newDispatchLifecycle(server *Server) *dispatchLifecycle {
	return &dispatchLifecycle{
		server:   server,
		handler:  server.dispatch,
		active:   make(map[*protocol.ClientCommand]*dispatchState),
		stallFor: defaultCommandStallTimeout,
		limitFor: defaultCommandDispatchTimeout,
	}
}

func (dl *dispatchLifecycle) setTimeouts(cfg *types.TimeoutsConfig) {
	dl.mu.Lock()
	dl.stallFor = cfg.CommandStall()
	dl.limitFor = cfg.CommandDispatch()
	dl.mu.Unlock()
}

func (dl *dispatchLifecycle) timeouts() (time.Duration, time.Duration) {
	dl.mu.Lock()
	defer dl.mu.Unlock()
	return dl.stallFor, dl.limitFor
}

func (dl *dispatchLifecycle) dispatch(conn net.Conn, cmd *protocol.ClientCommand) {
	started := time.Now()
	state := &dispatchState{done: make(chan struct{})}

	dl.mu.Lock()
	if cmd.RequestID != "" {
		dl.active[cmd] = state
	}
	dl.mu.Unlock()

	stallFor, limitFor := dl.timeouts()
	if stallFor > 0 || (cmd.RequestID != "" && limitFor > 0) {
		go dl.monitor(conn, cmd, state, started, stallFor, limitFor)
	}

	dl.handler(conn, cmd)

	dl.mu.Lock()
	close(state.done)
	if cmd.RequestID != "" && dl.active[cmd] == state {
		delete(dl.active, cmd)
	}
	dl.mu.Unlock()
}

func (dl *dispatchLifecycle) monitor(
	conn net.Conn,
	cmd *protocol.ClientCommand,
	state *dispatchState,
	started time.Time,
	stallFor time.Duration,
	limitFor time.Duration,
) {
	var stall <-chan time.Time
	var deadline <-chan time.Time
	if stallFor > 0 {
		stall = time.After(stallFor)
	}
	if cmd.RequestID != "" && limitFor > 0 {
		deadline = time.After(limitFor)
	}

	for stall != nil || deadline != nil {
		select {
		case <-state.done:
			return
		case <-stall:
			utils.LogWithFields(utils.LevelWarn, "server", "command dispatch stalled", map[string]any{
				"status":      cmd.Cmd,
				"request_id":  cmd.RequestID,
				"session_id":  cmd.Key,
				"duration_ms": time.Since(started).Milliseconds(),
			})
			stall = nil
		case <-deadline:
			if dl.claimState(state) {
				utils.LogWithFields(utils.LevelWarn, "server", "command dispatch timed out", map[string]any{
					"status":      cmd.Cmd,
					"request_id":  cmd.RequestID,
					"session_id":  cmd.Key,
					"duration_ms": time.Since(started).Milliseconds(),
				})
				line := protocol.SerializeServerResult(protocol.ServerResult{
					RequestID: cmd.RequestID,
					OK:        false,
					Error:     fmt.Sprintf("command dispatch timed out after %dms", limitFor.Milliseconds()),
				})
				dl.server.writeToClient(conn, line)
			}
			deadline = nil
		}
	}
}

func (dl *dispatchLifecycle) claimState(state *dispatchState) bool {
	dl.mu.Lock()
	defer dl.mu.Unlock()
	select {
	case <-state.done:
		return false
	default:
	}
	if state.responded {
		return false
	}
	state.responded = true
	return true
}

// claimResult gives a command request exactly one ServerResult. Calls outside a
// lifecycle-dispatched request keep their historic behavior, which supports
// direct unit tests and relay paths that do not use request IDs.
func (dl *dispatchLifecycle) claimResult(cmd *protocol.ClientCommand) bool {
	if cmd == nil || cmd.RequestID == "" {
		return true
	}

	dl.mu.Lock()
	defer dl.mu.Unlock()
	state, tracked := dl.active[cmd]
	if !tracked {
		return true
	}
	if state.responded {
		return false
	}
	state.responded = true
	return true
}
