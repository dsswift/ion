package server

import (
	"net"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/utils"
)

const (
	sessionLaneQueueSize = 64
	processLaneQueueSize = 128
	processLaneWorkers   = 4
	commandLaneWorkers   = 16
)

var sessionLaneIdleTime = 2 * time.Minute

type commandClass int

const (
	classHealth commandClass = iota
	classSession
	classProcess
)

type laneItem struct {
	conn net.Conn
	cmd  *protocol.ClientCommand
}

type sessionLane struct {
	queue  chan laneItem
	stop   chan struct{}
	closed bool
}

type commandLanes struct {
	mu       sync.Mutex
	sessions map[string]*sessionLane
	process  chan laneItem
	health   chan laneItem
	workers  chan struct{}
	done     chan struct{}
	wg       sync.WaitGroup

	dispatchFn func(net.Conn, *protocol.ClientCommand)
	rejectFn   func(net.Conn, *protocol.ClientCommand)

	sessionQueueSize int
	processQueueSize int
}

func newCommandLanes(dispatchFn func(net.Conn, *protocol.ClientCommand), rejectFns ...func(net.Conn, *protocol.ClientCommand)) *commandLanes {
	// Tests which exercise lane scheduling alone do not need wire replies. The
	// real Server always supplies rejectStoppedSessionCommand below.
	rejectFn := func(net.Conn, *protocol.ClientCommand) {}
	if len(rejectFns) > 0 && rejectFns[0] != nil {
		rejectFn = rejectFns[0]
	}

	cl := &commandLanes{
		sessions:         make(map[string]*sessionLane),
		process:          make(chan laneItem, processLaneQueueSize),
		health:           make(chan laneItem, processLaneQueueSize),
		workers:          make(chan struct{}, commandLaneWorkers),
		done:             make(chan struct{}),
		dispatchFn:       dispatchFn,
		rejectFn:         rejectFn,
		sessionQueueSize: sessionLaneQueueSize,
		processQueueSize: processLaneQueueSize,
	}
	for i := 0; i < processLaneWorkers; i++ {
		cl.wg.Add(1)
		go cl.processWorker()
	}
	cl.wg.Add(1)
	go cl.healthWorker()
	return cl
}

func classifyCommand(cmd *protocol.ClientCommand) commandClass {
	switch cmd.Cmd {
	case "health":
		return classHealth

	case "resource_subscribe", "resource_unsubscribe", "resource_publish", "resource_get":
		// Global resources share the manager-level broker, not a session. Even
		// when a client includes a key for correlation, do not serialize them
		// behind that session's command lane.
		if !cmd.ResourceGlobal && cmd.Key != "" {
			return classSession
		}
		return classProcess

	case "start_session", "send_prompt", "abort", "abort_agent", "abort_dispatch",
		"stop_background_task", "steer_agent", "dialog_response", "command", "stop_session",
		"settle_session", "resume_session",
		"fork_session", "set_plan_mode", "branch", "branch_before",
		"rewind_session", "navigate_tree", "get_tree",
		"permission_response", "tool_gate_response",
		"elicitation_response", "early_stop_decision_response",
		"reconcile_state", "query_session_status", "get_agent_state",
		"resolve_permission_denials",
		"get_context_breakdown", "clear_conversation_file":
		if cmd.Key != "" {
			return classSession
		}
		return classProcess

	default:
		return classProcess
	}
}

// submit enqueues a command into the appropriate lane. Returns false when the
// server is shutting down or the target lane's queue is full (backpressure).
func (cl *commandLanes) submit(conn net.Conn, cmd *protocol.ClientCommand) bool {
	select {
	case <-cl.done:
		return false
	default:
	}

	switch classifyCommand(cmd) {
	case classHealth:
		select {
		case cl.health <- laneItem{conn: conn, cmd: cmd}:
			return true
		case <-cl.done:
			return false
		default:
			utils.LogWithFields(utils.LevelWarn, "server", "health lane queue full", map[string]any{"status": cmd.Cmd})
			return false
		}

	case classSession:
		return cl.submitSession(conn, cmd)

	case classProcess:
		return cl.submitProcess(conn, cmd)
	}
	return false
}

func (cl *commandLanes) submitSession(conn net.Conn, cmd *protocol.ClientCommand) bool {
	cl.mu.Lock()
	lane, ok := cl.sessions[cmd.Key]
	if !ok || lane.closed {
		lane = &sessionLane{
			queue: make(chan laneItem, cl.sessionQueueSize),
			stop:  make(chan struct{}),
		}
		cl.sessions[cmd.Key] = lane
		cl.wg.Add(1)
		go cl.sessionWorker(cmd.Key, lane)
	}

	// Keep cl.mu through this non-blocking enqueue. evictSession takes the same
	// lock before closing lane.stop, so a command is either accepted before
	// eviction (and rejected by the worker) or sent to a fresh lane afterward.
	select {
	case lane.queue <- laneItem{conn: conn, cmd: cmd}:
		cl.mu.Unlock()
		return true
	case <-cl.done:
		cl.mu.Unlock()
		return false
	default:
		cl.mu.Unlock()
		utils.LogWithFields(utils.LevelWarn, "server", "session lane queue full", map[string]any{
			"session_id": cmd.Key, "status": cmd.Cmd,
		})
		return false
	}
}

func (cl *commandLanes) submitProcess(conn net.Conn, cmd *protocol.ClientCommand) bool {
	select {
	case cl.process <- laneItem{conn: conn, cmd: cmd}:
		return true
	case <-cl.done:
		return false
	default:
		utils.LogWithFields(utils.LevelWarn, "server", "process lane queue full", map[string]any{
			"status": cmd.Cmd,
		})
		return false
	}
}

func (cl *commandLanes) sessionWorker(key string, lane *sessionLane) {
	defer cl.wg.Done()
	idle := time.NewTimer(sessionLaneIdleTime)
	defer idle.Stop()

	for {
		// Prefer eviction over queued work. A command dequeued before this check
		// is in-flight; commands still queued after an explicit stop are rejected.
		select {
		case <-lane.stop:
			cl.rejectQueuedSessionCommands(key, lane)
			return
		default:
		}

		select {
		case item, ok := <-lane.queue:
			if !ok {
				return
			}
			if !idle.Stop() {
				select {
				case <-idle.C:
				default:
				}
			}
			cl.executeSession(lane, item)
			idle.Reset(sessionLaneIdleTime)

		case <-idle.C:
			cl.mu.Lock()
			if len(lane.queue) > 0 {
				cl.mu.Unlock()
				idle.Reset(sessionLaneIdleTime)
				continue
			}
			lane.closed = true
			delete(cl.sessions, key)
			cl.mu.Unlock()
			utils.LogWithFields(utils.LevelDebug, "server", "session lane idle evicted", map[string]any{
				"session_id": key,
			})
			return

		case <-lane.stop:
			cl.rejectQueuedSessionCommands(key, lane)
			return

		case <-cl.done:
			return
		}
	}
}

func (cl *commandLanes) processWorker() {
	defer cl.wg.Done()
	for {
		// Check shutdown before selecting queued work. Once shutdown wins, no
		// process command may begin dispatch, even when work remains buffered.
		select {
		case <-cl.done:
			return
		default:
		}

		select {
		case <-cl.done:
			return
		case item := <-cl.process:
			cl.execute(item)
		}
	}
}

// healthWorker is intentionally independent from worker capacity: liveness
// remains answerable even when every normal command worker is occupied.
func (cl *commandLanes) healthWorker() {
	defer cl.wg.Done()
	for {
		select {
		case item := <-cl.health:
			cl.dispatchFn(item.conn, item.cmd)
		case <-cl.done:
			return
		}
	}
}

func (cl *commandLanes) executeSession(lane *sessionLane, item laneItem) {
	// Acquire worker capacity before checking lane state. The state check is the
	// linearization point: an eviction that wins before it rejects the command;
	// one that follows it sees a command already committed as in-flight.
	select {
	case cl.workers <- struct{}{}:
		defer func() { <-cl.workers }()
	case <-cl.done:
		return
	}

	cl.mu.Lock()
	closed := lane.closed
	cl.mu.Unlock()
	if closed {
		cl.rejectSessionCommand(item)
		return
	}
	cl.dispatchFn(item.conn, item.cmd)
}

func (cl *commandLanes) rejectSessionCommand(item laneItem) {
	cl.rejectFn(item.conn, item.cmd)
}

func (cl *commandLanes) execute(item laneItem) {
	select {
	case cl.workers <- struct{}{}:
		defer func() { <-cl.workers }()
	case <-cl.done:
		return
	}
	// A shutdown can begin while this worker waited for capacity. Do not start
	// buffered process work after that boundary.
	select {
	case <-cl.done:
		return
	default:
	}
	cl.dispatchFn(item.conn, item.cmd)
}

func (cl *commandLanes) rejectQueuedSessionCommands(key string, lane *sessionLane) {
	for {
		select {
		case item := <-lane.queue:
			utils.LogWithFields(utils.LevelInfo, "server", "queued session command rejected after stop", map[string]any{
				"session_id": key,
				"status":     item.cmd.Cmd,
				"request_id": item.cmd.RequestID,
			})
			cl.rejectSessionCommand(item)
		default:
			return
		}
	}
}

// evictSession stops the session lane for the given key and rejects every
// queued command. In-flight work completes normally; commands which have not
// reached the dispatcher never run after their session was torn down.
func (cl *commandLanes) evictSession(key string) {
	cl.mu.Lock()
	lane, ok := cl.sessions[key]
	if ok {
		lane.closed = true
		delete(cl.sessions, key)
		select {
		case <-lane.stop:
		default:
			close(lane.stop)
		}
	}
	cl.mu.Unlock()
}

// evictByPrefix stops every session lane whose key starts with prefix. Used by
// stop_by_prefix after the manager has torn down its matching sessions.
func (cl *commandLanes) evictByPrefix(prefix string) {
	cl.mu.Lock()
	var lanes []*sessionLane
	for key, lane := range cl.sessions {
		if strings.HasPrefix(key, prefix) {
			lane.closed = true
			delete(cl.sessions, key)
			lanes = append(lanes, lane)
		}
	}
	cl.mu.Unlock()

	for _, lane := range lanes {
		select {
		case <-lane.stop:
		default:
			close(lane.stop)
		}
	}
}

// stop shuts down all lanes and waits for active workers to exit. Closing
// cl.done unblocks every worker select; queued commands do not execute after
// shutdown begins. wg.Wait ensures no handler is mid-flight when Server.Stop
// proceeds to tear down the session manager.
func (cl *commandLanes) stop() {
	select {
	case <-cl.done:
		return
	default:
		close(cl.done)
	}
	cl.mu.Lock()
	for key, lane := range cl.sessions {
		lane.closed = true
		delete(cl.sessions, key)
		select {
		case <-lane.stop:
		default:
			close(lane.stop)
		}
	}
	cl.mu.Unlock()
	cl.wg.Wait()
}
