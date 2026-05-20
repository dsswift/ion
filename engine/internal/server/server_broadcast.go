package server

import (
	"fmt"
	"net"
	"sync/atomic"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Queue capacities. State events are low-volume critical state updates
// (agent lifecycle, status transitions); stream events are high-volume
// incremental deltas (text chunks, tool input). Splitting them ensures
// a burst of text deltas can never crowd out state events, even with
// 12+ concurrent engine sessions.
const (
	stateQueueSize  = 64
	streamQueueSize = 1024
)

// clientWriter owns a connected client's outbound queues. Two queues
// separate critical state events from high-volume streaming events.
// The drain goroutine always prefers the state queue so agent-state and
// status events are never blocked behind a burst of text deltas.
type clientWriter struct {
	conn          net.Conn
	stateQueue    chan []byte
	streamQueue   chan []byte
	done          chan struct{}
	stateDropped  int64
	streamDropped int64
}

// listenerHandle wraps a registered broadcast listener with its own
// dual queues and drain goroutine so a slow listener (e.g. a backed-up
// relay) cannot stall delivery to socket clients or to other listeners.
type listenerHandle struct {
	fn            func(line string)
	stateQueue    chan string
	streamQueue   chan string
	done          chan struct{}
	stateDropped  int64
	streamDropped int64
}

// isStateEvent classifies an EngineEvent type as critical (state queue)
// or streaming (stream queue). The default is state — only the two
// highest-volume event types are routed to the stream queue.
func isStateEvent(eventType string) bool {
	switch eventType {
	case "engine_text_delta", "engine_tool_update":
		return false
	}
	return true
}

// OnBroadcast registers a listener that receives every broadcast line.
// Used by relay transport to forward engine events to mobile peers. Each
// listener gets its own bounded dual-queue + drain goroutine so a slow
// listener cannot stall delivery to socket clients or other listeners.
func (s *Server) OnBroadcast(fn func(line string)) {
	lh := &listenerHandle{
		fn:          fn,
		stateQueue:  make(chan string, stateQueueSize),
		streamQueue: make(chan string, streamQueueSize),
		done:        make(chan struct{}),
	}
	s.mu.Lock()
	s.broadcastListeners = append(s.broadcastListeners, lh)
	s.mu.Unlock()
	go s.drainListener(lh)
}

// broadcast delivers line to every connected client and registered
// listener. eventType determines which queue receives the line: state
// events go to the priority state queue; text deltas and tool updates
// go to the larger stream queue. Per-client and per-listener delivery
// is non-blocking; the Server lock is held only for the snapshot read.
func (s *Server) broadcast(line string, eventType string) {
	payload := []byte(line)
	isState := isStateEvent(eventType)

	s.mu.RLock()
	clients := make([]*clientWriter, 0, len(s.clients))
	for _, cw := range s.clients {
		clients = append(clients, cw)
	}
	listeners := make([]*listenerHandle, len(s.broadcastListeners))
	copy(listeners, s.broadcastListeners)
	s.mu.RUnlock()

	for _, cw := range clients {
		q := cw.streamQueue
		dropped := &cw.streamDropped
		if isState {
			q = cw.stateQueue
			dropped = &cw.stateDropped
		}
		select {
		case q <- payload:
			// If events were previously dropped, send notification via
			// state queue (which drains with priority).
			total := atomic.LoadInt64(&cw.stateDropped) + atomic.LoadInt64(&cw.streamDropped)
			if total > 0 {
				select {
				case cw.stateQueue <- eventsDroppedLine(total):
					atomic.StoreInt64(&cw.stateDropped, 0)
					atomic.StoreInt64(&cw.streamDropped, 0)
				default:
				}
			}
		default:
			n := atomic.AddInt64(dropped, 1)
			total := atomic.LoadInt64(&cw.stateDropped) + atomic.LoadInt64(&cw.streamDropped)
			if n == 1 || total%256 == 0 {
				kind := "stream"
				if isState {
					kind = "state"
				}
				utils.Log("Server", fmt.Sprintf("broadcast %s queue full; dropped %d total events for slow client", kind, total))
			}
		}
	}

	for _, lh := range listeners {
		sq := lh.streamQueue
		dropped := &lh.streamDropped
		if isState {
			sq = lh.stateQueue
			dropped = &lh.stateDropped
		}
		select {
		case sq <- line:
			total := atomic.LoadInt64(&lh.stateDropped) + atomic.LoadInt64(&lh.streamDropped)
			if total > 0 {
				select {
				case lh.stateQueue <- string(eventsDroppedLine(total)):
					atomic.StoreInt64(&lh.stateDropped, 0)
					atomic.StoreInt64(&lh.streamDropped, 0)
				default:
				}
			}
		default:
			n := atomic.AddInt64(dropped, 1)
			total := atomic.LoadInt64(&lh.stateDropped) + atomic.LoadInt64(&lh.streamDropped)
			if n == 1 || total%256 == 0 {
				kind := "stream"
				if isState {
					kind = "state"
				}
				utils.Log("Server", fmt.Sprintf("broadcast listener %s queue full; dropped %d total events", kind, total))
			}
		}
	}
}

// drainClient reads from both queues with priority on state, writes to
// the underlying conn under a per-write deadline. A failed write evicts.
func (s *Server) drainClient(cw *clientWriter) {
	write := func(line []byte) bool {
		if err := cw.conn.SetWriteDeadline(time.Now().Add(broadcastWriteDeadline)); err != nil {
			utils.Log("Server", "set write deadline failed: "+err.Error())
		}
		if _, err := cw.conn.Write(line); err != nil {
			total := atomic.LoadInt64(&cw.stateDropped) + atomic.LoadInt64(&cw.streamDropped)
			utils.Log("Server", fmt.Sprintf("broadcast write error (evicting client, %d events dropped): %s", total, err.Error()))
			s.evictClient(cw.conn)
			return false
		}
		return true
	}

	for {
		// Always prefer state events.
		select {
		case line := <-cw.stateQueue:
			if !write(line) {
				return
			}
		case <-cw.done:
			return
		default:
			// No state event pending — drain one stream event or block
			// on both queues plus the done channel.
			select {
			case line := <-cw.stateQueue:
				if !write(line) {
					return
				}
			case line := <-cw.streamQueue:
				if !write(line) {
					return
				}
			case <-cw.done:
				return
			}
		}
	}
}

// drainListener calls the listener fn for each queued line, with
// priority on the state queue. Runs until done is closed.
func (s *Server) drainListener(lh *listenerHandle) {
	for {
		select {
		case line := <-lh.stateQueue:
			lh.fn(line)
		case <-lh.done:
			return
		default:
			select {
			case line := <-lh.stateQueue:
				lh.fn(line)
			case line := <-lh.streamQueue:
				lh.fn(line)
			case <-lh.done:
				return
			}
		}
	}
}

// eventsDroppedLine returns a JSON line notifying the client that
// events were dropped.
func eventsDroppedLine(count int64) []byte {
	return []byte(fmt.Sprintf("{\"type\":\"engine_events_dropped\",\"count\":%d}\n", count))
}
