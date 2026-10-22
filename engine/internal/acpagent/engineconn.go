package acpagent

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// EngineEvent is one event line as the engine socket delivers it: the
// session key the daemon stamped and the raw EngineEvent payload, decoded
// once into the generic map every translator reads.
type EngineEvent struct {
	Key   string
	Type  string
	Event map[string]any
}

// EngineConn is one persistent connection to the engine socket. Commands
// go out with a requestId and their result comes back on the same
// connection; every event the daemon broadcasts arrives here too and is
// routed to the subscriber for its session key.
type EngineConn struct {
	conn    net.Conn
	writeMu sync.Mutex
	seq     atomic.Int64

	mu      sync.Mutex
	pending map[string]chan map[string]any
	subs    map[string]*eventQueue
	closed  chan struct{}
	err     error
}

// eventQueue is an unbounded per-session event queue. The socket read loop
// appends without blocking so a slow consumer can never stall a command
// result for another session.
type eventQueue struct {
	mu     sync.Mutex
	items  []EngineEvent
	signal chan struct{}
}

func newEventQueue() *eventQueue {
	return &eventQueue{signal: make(chan struct{}, 1)}
}

func (q *eventQueue) push(ev EngineEvent) {
	q.mu.Lock()
	q.items = append(q.items, ev)
	q.mu.Unlock()
	select {
	case q.signal <- struct{}{}:
	default:
	}
}

// Next returns the next queued event, waiting until one arrives, the
// context ends, or the connection closes.
func (q *eventQueue) Next(ctx context.Context, closed <-chan struct{}) (EngineEvent, bool) {
	for {
		q.mu.Lock()
		if len(q.items) > 0 {
			ev := q.items[0]
			q.items = q.items[1:]
			q.mu.Unlock()
			return ev, true
		}
		q.mu.Unlock()
		select {
		case <-q.signal:
		case <-ctx.Done():
			return EngineEvent{}, false
		case <-closed:
			return EngineEvent{}, false
		}
	}
}

// DialEngine connects to the engine at sock over network ("unix" or
// "tcp4") and starts the read loop.
func DialEngine(network, sock string) (*EngineConn, error) {
	conn, err := net.DialTimeout(network, sock, 5*time.Second)
	if err != nil {
		return nil, fmt.Errorf("connect to engine at %s: %w", sock, err)
	}
	c := &EngineConn{
		conn:    conn,
		pending: map[string]chan map[string]any{},
		subs:    map[string]*eventQueue{},
		closed:  make(chan struct{}),
	}
	go c.readLoop()
	utils.LogWithFields(utils.LevelInfo, "acp", "engine connected", map[string]any{"socket": sock})
	return c, nil
}

// Closed is closed when the socket read loop ends.
func (c *EngineConn) Closed() <-chan struct{} { return c.closed }

// Err is the read loop's terminal error, nil before it ends or on EOF.
func (c *EngineConn) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

// Close ends the connection.
func (c *EngineConn) Close() error { return c.conn.Close() }

// Subscribe returns the event queue for a session key, creating it so no
// event is lost between start_session and the first read.
func (c *EngineConn) Subscribe(key string) *eventQueue {
	c.mu.Lock()
	defer c.mu.Unlock()
	if q, ok := c.subs[key]; ok {
		return q
	}
	q := newEventQueue()
	c.subs[key] = q
	return q
}

// Unsubscribe drops a session's queue.
func (c *EngineConn) Unsubscribe(key string) {
	c.mu.Lock()
	delete(c.subs, key)
	c.mu.Unlock()
}

// Send writes a command and returns its result envelope. A command with no
// requestId-bearing answer (abort, permission_response, ...) returns once it
// is written: the engine answers those with nothing.
func (c *EngineConn) Send(ctx context.Context, cmd map[string]any) (map[string]any, error) {
	name, _ := cmd["cmd"].(string) //nolint:errcheck // a missing cmd fails at the engine
	reqID := "acp-" + strconv.FormatInt(c.seq.Add(1), 10)
	cmd["requestId"] = reqID
	answers := answered[name]
	var ch chan map[string]any
	if answers {
		ch = make(chan map[string]any, 1)
		c.mu.Lock()
		c.pending[reqID] = ch
		c.mu.Unlock()
	}
	if err := c.write(cmd); err != nil {
		c.forget(reqID)
		return nil, err
	}
	if !answers {
		return nil, nil
	}
	select {
	case res := <-ch:
		if msg, ok := res["error"].(string); ok && msg != "" {
			return res, fmt.Errorf("%s: %s", name, msg)
		}
		return res, nil
	case <-ctx.Done():
		c.forget(reqID)
		return nil, ctx.Err()
	case <-c.closed:
		c.forget(reqID)
		return nil, errors.New("engine connection closed")
	}
}

// answered lists the commands the engine answers with a result envelope.
// Fire-and-forget commands write nothing back, so waiting on them would
// hang until the connection died.
var answered = map[string]bool{
	"start_session": true, "stop_session": true, "send_prompt": true,
	"list_models": true, "load_session_history": true, "set_plan_mode": true,
	"list_sessions": true, "oidc_identity": true, "oidc_begin_login": true,
	"oidc_logout": true,
}

func (c *EngineConn) forget(reqID string) {
	c.mu.Lock()
	delete(c.pending, reqID)
	c.mu.Unlock()
}

func (c *EngineConn) write(v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("marshal engine command: %w", err)
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if _, err := c.conn.Write(append(data, '\n')); err != nil {
		return fmt.Errorf("write engine command: %w", err)
	}
	return nil
}

func (c *EngineConn) readLoop() {
	scanner := bufio.NewScanner(c.conn)
	scanner.Buffer(make([]byte, 0, 64*1024), 64*1024*1024)
	for scanner.Scan() {
		c.dispatch(scanner.Bytes())
	}
	c.mu.Lock()
	if err := scanner.Err(); err != nil {
		c.err = err
	}
	pending := c.pending
	c.pending = map[string]chan map[string]any{}
	c.mu.Unlock()
	for _, ch := range pending {
		close(ch)
	}
	close(c.closed)
	utils.LogWithFields(utils.LevelInfo, "acp", "engine connection ended", map[string]any{"error": utils.ErrStr(c.Err())})
}

// dispatch routes one socket line: a result to its waiter, an event to its
// session's queue. Lines for sessions this process never opened are the
// daemon's other clients' traffic and are dropped.
func (c *EngineConn) dispatch(line []byte) {
	var frame struct {
		RequestID string          `json:"requestId"`
		Cmd       string          `json:"cmd"`
		Key       string          `json:"key"`
		Event     json.RawMessage `json:"event"`
		Type      string          `json:"type"`
	}
	if err := json.Unmarshal(line, &frame); err != nil {
		utils.LogWithFields(utils.LevelWarn, "acp", "non-json line from engine", map[string]any{"error": err.Error()})
		return
	}
	if frame.RequestID != "" && frame.Cmd == "result" {
		var res map[string]any
		if err := json.Unmarshal(line, &res); err != nil {
			return
		}
		c.mu.Lock()
		ch, ok := c.pending[frame.RequestID]
		delete(c.pending, frame.RequestID)
		c.mu.Unlock()
		if ok {
			ch <- res
		}
		return
	}
	var payload map[string]any
	switch {
	case len(frame.Event) > 0:
		if err := json.Unmarshal(frame.Event, &payload); err != nil {
			return
		}
	case frame.Type != "":
		if err := json.Unmarshal(line, &payload); err != nil {
			return
		}
	default:
		return
	}
	typ, _ := payload["type"].(string) //nolint:errcheck // an event without a type is dropped below
	if typ == "" {
		return
	}
	c.mu.Lock()
	q, ok := c.subs[frame.Key]
	c.mu.Unlock()
	if !ok {
		return
	}
	q.push(EngineEvent{Key: frame.Key, Type: typ, Event: payload})
}
